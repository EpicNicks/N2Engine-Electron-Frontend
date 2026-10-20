// The editor's preferences: typed keys with a default and a validator, kept in the page's localStorage (per machine;
// nothing here leaves it) in two scopes: "user" (global to this machine) and "project" (named by the project's id, the
// one GetProjectInfo gives, so a remote host's project has its own scope here too). Framework-free, so it is tested
// without a DOM.
//
// What it promises:
//   - Every storage access is guarded: storage can be missing, full or blocked, and then a value is simply not
//     remembered. Nothing here throws.
//   - A value that is corrupt, of the wrong type or from a newer version of the store is never used: the key's default
//     applies. A corrupt or wrong-typed entry is removed from storage; an entry a newer editor wrote is left alone.
//   - Writes are debounced (flush() or { immediate: true } writes at once; flushOnUnload does it when the window goes).
//   - Subscribers hear every change of a key (a remove too: the default).
//   - No secrets: a key whose name looks like one (token, secret, password, credential, api key, auth) can't be
//     defined, so there is no way to store one (connection tokens stay in the main process; see the README).
//
// One localStorage entry per key: "n2.prefs.user.<key>" or "n2.prefs.project.<projectId>.<key>", holding
// {"version":1,"value":<the value>}. A key can name a legacy entry (PrefDef.legacyKey) an older release wrote: it is read
// when the new entry is absent, never written, and removed together with the new one.

/** The least a store has to do; every method may fail without the caller noticing (reads give null) */
export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

/** The page's localStorage, guarded; reads give null and writes do nothing when it is unavailable */
export function browserStore(): KeyValueStore {
  const storage = (): Storage | null => {
    try {
      return typeof localStorage === "undefined" ? null : localStorage
    } catch {
      return null
    }
  }
  return {
    get(key) {
      try {
        return storage()?.getItem(key) ?? null
      } catch {
        return null
      }
    },
    set(key, value) {
      try {
        storage()?.setItem(key, value)
      } catch {
        // not remembered; the value still applies for this session
      }
    },
    remove(key) {
      try {
        storage()?.removeItem(key)
      } catch {
        // nothing to remove, or nothing that can be
      }
    },
  }
}

/** The localStorage key a value is kept under: "n2.prefs.user.<key>", or "n2.prefs.project.<projectId>.<key>" */
export function prefStorageKey(def: PrefDef<unknown>, scopeId: string | null = null): string {
  return def.scope === "user" ? `n2.prefs.user.${def.key}` : `n2.prefs.project.${scopeId}.${def.key}`
}

/** The version entries are written with; an entry of a newer version is not read (and not overwritten) */
export const PrefsVersion = 1

export type PrefScope = "user" | "project"

/** Turns a raw value (parsed JSON) into the key's value, or undefined when it is not a valid one */
export type Validator<T> = (raw: unknown) => T | undefined

/** What a key is: its name, scope, default and validator, and (optionally) where an older release kept it */
export interface PrefDef<T, S extends PrefScope = PrefScope> {
  readonly key: string
  readonly scope: S
  readonly default: T
  readonly validate: Validator<T>
  /** The localStorage key an older release wrote this value under (raw JSON, no version wrapper), given the project id (null for user scope) */
  readonly legacyKey?: (scopeId: string | null) => string
}

/** A key name that looks like it names a secret: refused */
const SecretLooking = /token|secret|passw|passphrase|credential|api[-_.]?key|private[-_.]?key|auth|bearer|session[-_.]?id/i

/** A key name is dotted lowercase words ("keymap.overrides", "layout.default") */
const KeyName = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/

const defined = new Set<string>()

/**
 * Defines a key. Throws (a programming error, found by the first test or run) for a name that is malformed, looks like
 * a secret's, or is defined already in the same scope. (The default need not be a valid stored value: null for "none".)
 */
export function definePref<T, S extends PrefScope>(def: PrefDef<T, S>): PrefDef<T, S> {
  if (!KeyName.test(def.key)) throw new Error(`Preference key "${def.key}" is not dotted words`)
  if (SecretLooking.test(def.key)) throw new Error(`Preference key "${def.key}" looks like a secret; secrets are never stored here`)
  const id = `${def.scope}:${def.key}`
  if (defined.has(id)) throw new Error(`Preference key "${def.key}" is defined twice in the ${def.scope} scope`)
  defined.add(id)
  return def
}

/** The names of the keys defined so far (a test reads them to check none looks like a secret) */
export function definedPrefKeys(): string[] {
  return [...defined]
}

// ---- Validators for the common shapes ----

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const v = {
  boolean: ((raw) => (typeof raw === "boolean" ? raw : undefined)) as Validator<boolean>,
  string:
    (maxLength = 1000): Validator<string> =>
    (raw) =>
      typeof raw === "string" && raw.length <= maxLength ? raw : undefined,
  number:
    (min = -Infinity, max = Infinity): Validator<number> =>
    (raw) =>
      typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max ? raw : undefined,
  oneOf:
    <T extends string>(allowed: readonly T[]): Validator<T> =>
    (raw) =>
      typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined,
  /** An array of at most maxLength items, each valid (an invalid one makes the whole value invalid) */
  arrayOf:
    <T>(item: Validator<T>, maxLength = 1000): Validator<T[]> =>
    (raw) => {
      if (!Array.isArray(raw) || raw.length > maxLength) return undefined
      const out: T[] = []
      for (const entry of raw) {
        const checked = item(entry)
        if (checked === undefined) return undefined
        out.push(checked)
      }
      return out
    },
  /** An object that is any JSON object (the caller validates inside, as the layout's parseLayout does) */
  object: ((raw) => (isRecord(raw) ? raw : undefined)) as Validator<Record<string, unknown>>,
}

// ---- The store ----

/** How the store waits: a function that runs a callback later and returns how to cancel it (setTimeout by default) */
export type Schedule = (callback: () => void, milliseconds: number) => () => void

const defaultSchedule: Schedule = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds)
  return () => clearTimeout(timer)
}

/** After the last change, wait this long before writing (a slider or a splitter changes a value on every pointer move) */
export const WriteDelayMilliseconds = 300

/** A project id names a stored entry only when it is made of what a UUID is made of */
export function isScopeId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-zA-Z-]{1,64}$/.test(id)
}

interface Entry {
  readonly storageKey: string
  readonly def: PrefDef<unknown>
  readonly scopeId: string | null
  value: unknown
  /** Read from storage (or known to be absent) */
  loaded: boolean
  /** Changed in memory and not written yet; null: nothing to write, "set": write the value, "remove": remove the entry */
  pending: null | "set" | "remove"
  /** A newer editor wrote the stored entry: it is left alone (the value lives in memory only) */
  locked: boolean
  readonly listeners: Set<(value: unknown) => void>
}

export class PrefsStore {
  private readonly entries = new Map<string, Entry>()
  private cancelWrite: (() => void) | null = null

  constructor(
    private readonly storage: KeyValueStore,
    private readonly schedule: Schedule = defaultSchedule,
    private readonly delay: number = WriteDelayMilliseconds
  ) {}

  /** The user scope: global to this machine */
  readonly user: PrefScopeView<"user"> = new PrefScopeView(this, "user", null)

  /** A project's scope. An id that is not a project id gives a view that remembers nothing (reads give the defaults) */
  project(projectId: string): PrefScopeView<"project"> {
    return new PrefScopeView(this, "project", isScopeId(projectId) ? projectId : null)
  }

  /** @internal */
  entry<T>(def: PrefDef<T>, scopeId: string | null): Entry | null {
    if (def.scope === "project" && scopeId === null) return null
    const storageKey = prefStorageKey(def, scopeId)
    let entry = this.entries.get(storageKey)
    if (!entry) {
      entry = {
        storageKey,
        def: def as PrefDef<unknown>,
        scopeId,
        value: def.default,
        loaded: false,
        pending: null,
        locked: false,
        listeners: new Set(),
      }
      this.entries.set(storageKey, entry)
    }
    return entry
  }

  /** @internal */
  read(entry: Entry): unknown {
    if (!entry.loaded) {
      entry.loaded = true
      this.load(entry)
    }
    return entry.value
  }

  private load(entry: Entry): void {
    const { def, storageKey } = entry
    let text: string | null = null
    try {
      text = this.storage.get(storageKey)
    } catch {
      return
    }
    if (text !== null) {
      const stored = this.parseStored(entry, text)
      if (stored === "used" || stored === "locked") return
      // Corrupt, or of the wrong type: forgotten (the older release's entry may still have the value)
      this.drop(entry)
    }
    // No entry of ours: an older release's, if the key has one (read, never written)
    if (def.legacyKey) {
      try {
        const legacy = this.storage.get(def.legacyKey(entry.scopeId))
        if (legacy !== null) {
          const checked = safely(def.validate, JSON.parse(legacy))
          if (checked !== undefined) entry.value = checked
        }
      } catch {
        // an unreadable legacy entry is the same as none
      }
    }
  }

  /** Takes the value of a stored entry: used (entry.value is it), locked (a newer editor's) or invalid */
  private parseStored(entry: Entry, text: string): "used" | "locked" | "invalid" {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return "invalid"
    }
    if (!isRecord(parsed) || typeof parsed.version !== "number" || !Number.isInteger(parsed.version) || parsed.version < 1) {
      return "invalid"
    }
    if (parsed.version > PrefsVersion) {
      // A newer editor's: not understood, and not to be overwritten by this one
      entry.locked = true
      return "locked"
    }
    const checked = safely(entry.def.validate, parsed.value)
    if (checked === undefined) return "invalid"
    entry.value = checked
    return "used"
  }

  /** A stored value that can't be used is forgotten, in storage too */
  private drop(entry: Entry): void {
    entry.value = entry.def.default
    try {
      this.storage.remove(entry.storageKey)
    } catch {
      // not removable: it is read as invalid again next time, with the same result
    }
  }

  /** @internal */
  write(entry: Entry, value: unknown, immediate: boolean): boolean {
    const checked = safely(entry.def.validate, value)
    if (checked === undefined) return false
    this.read(entry) // so a locked entry is known as one
    entry.value = checked
    entry.pending = "set"
    this.notify(entry)
    this.afterChange(immediate)
    return true
  }

  /** @internal */
  clear(entry: Entry, immediate: boolean): void {
    this.read(entry)
    entry.value = entry.def.default
    entry.pending = "remove"
    this.notify(entry)
    this.afterChange(immediate)
  }

  private notify(entry: Entry): void {
    for (const listener of [...entry.listeners]) {
      try {
        listener(entry.value)
      } catch {
        // a listener's failure is its own
      }
    }
  }

  private afterChange(immediate: boolean): void {
    this.cancelWrite?.()
    this.cancelWrite = null
    if (immediate) return this.flush()
    this.cancelWrite = this.schedule(() => {
      this.cancelWrite = null
      this.flush()
    }, this.delay)
  }

  /** Writes what is waiting now */
  flush(): void {
    this.cancelWrite?.()
    this.cancelWrite = null
    for (const entry of this.entries.values()) {
      const pending = entry.pending
      if (pending === null) continue
      entry.pending = null
      try {
        if (pending === "remove") {
          // The legacy entry goes too, or it would be read as the value again
          if (!entry.locked) this.storage.remove(entry.storageKey)
          if (entry.def.legacyKey) this.storage.remove(entry.def.legacyKey(entry.scopeId))
        } else if (!entry.locked) {
          this.storage.set(entry.storageKey, JSON.stringify({ version: PrefsVersion, value: entry.value }))
        }
      } catch {
        // not remembered
      }
    }
  }

  /** Writes what is waiting when the window is hidden, closed or reloaded; returns the detach */
  flushOnUnload(target: EventTarget): () => void {
    const save = () => this.flush()
    target.addEventListener("pagehide", save)
    target.addEventListener("beforeunload", save)
    return () => {
      target.removeEventListener("pagehide", save)
      target.removeEventListener("beforeunload", save)
    }
  }
}

function safely<T>(validate: Validator<T>, raw: unknown): T | undefined {
  try {
    return validate(raw)
  } catch {
    return undefined
  }
}

/** One scope of the store: typed reads, writes and subscriptions for the keys of that scope */
export class PrefScopeView<S extends PrefScope> {
  constructor(
    private readonly store: PrefsStore,
    readonly scope: S,
    /** The project's id (project scope); null for user scope, and for a project id that isn't one */
    readonly scopeId: string | null
  ) {}

  get<T>(def: PrefDef<T, S>): T {
    const entry = this.store.entry(def as PrefDef<unknown>, this.scopeId)
    return entry ? (this.store.read(entry) as T) : def.default
  }

  /** Sets a value; false (and nothing changes) when it is not valid for the key, or the scope has no project */
  set<T>(def: PrefDef<T, S>, value: T, options: { immediate?: boolean } = {}): boolean {
    const entry = this.store.entry(def as PrefDef<unknown>, this.scopeId)
    return entry ? this.store.write(entry, value, options.immediate === true) : false
  }

  /** Forgets the value: the default applies again */
  remove<T>(def: PrefDef<T, S>, options: { immediate?: boolean } = {}): void {
    const entry = this.store.entry(def as PrefDef<unknown>, this.scopeId)
    if (entry) this.store.clear(entry, options.immediate === true)
  }

  /** Calls listener with the new value after every change of the key; returns the unsubscribe */
  subscribe<T>(def: PrefDef<T, S>, listener: (value: T) => void): () => void {
    const entry = this.store.entry(def as PrefDef<unknown>, this.scopeId)
    if (!entry) return () => {}
    const wrapped = listener as (value: unknown) => void
    entry.listeners.add(wrapped)
    return () => void entry.listeners.delete(wrapped)
  }
}

let shared: PrefsStore | null = null

/** The page's store, over its localStorage: what the layout and the keymap share */
export function appPrefs(): PrefsStore {
  return (shared ??= new PrefsStore(browserStore()))
}
