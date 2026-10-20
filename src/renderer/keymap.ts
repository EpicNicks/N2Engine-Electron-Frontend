// The editor's keyboard shortcuts: a registry of NAMED ACTIONS with default chords and a scope, and ONE dispatcher at
// the document that turns a key press into the action it names. Framework-free (the DOM types only), so it is tested
// under jsdom without the panels.
//
// How a key press is dispatched (Keymap.dispatch):
//   1. It is ignored when something already took it (defaultPrevented: a component's own handler, the game view that
//      forwards keys to the game, the viewport's fly keys) or while an input method is composing.
//   2. The actions whose chord it is are the candidates; the scope of the focus (the nearest ancestor of the event's
//      target with data-keymap-scope, else none) orders them: the focused scope's actions first, then the global ones.
//      An action of another scope is never a candidate.
//   3. A dialog open (isModalOpen) stops everything. While a text field has the focus (isTextEntry) only actions marked
//      allowInText are candidates, so no shortcut fires while typing.
//   4. The action's handler runs (the handler registered for it whose `within` element contains the target; the most
//      recent one). A handler that returns false did not take the key: the next candidate gets it. Anything else took it,
//      and the key's default is prevented.
// A component that handles a key itself and wants the keymap to leave it alone calls preventDefault: that is how the
// viewport's fly keys (held while the right button is down) keep their priority over any shortcut.
//
// Chords are written "Mod+Shift+Z": modifiers Mod (Ctrl or Cmd, whichever the key press has: as the editor's undo and
// save always accepted both), Ctrl, Cmd (Meta), Alt, Shift, then one key: a KeyboardEvent.key ("ArrowDown", "Delete",
// "F2", "z") or a KeyboardEvent.code ("KeyF", which keeps its place on a keyboard layout other than QWERTY). Modifiers
// are matched exactly. Mod shows as Cmd on macOS and Ctrl elsewhere.
//
// Users can rebind actions: overrides ({ actionId: [chords] }) replace an action's default chords (an empty list
// unbinds it), are validated, checked for conflicts (the same chord on two actions of the same scope) and kept in the
// user-scope pref "keymap.overrides". There is no UI for it yet.
import { PrefDef, PrefScopeView, definePref, isRecord, v } from "./prefs"
import { isTextEntry } from "./edit-actions"

export type KeymapScope = "global" | "viewport" | "hierarchy" | "assets" | "console" | "text"

export const KeymapScopes: readonly KeymapScope[] = ["global", "viewport", "hierarchy", "assets", "console", "text"]

/** What the scopes are called in the shortcuts list */
export const ScopeTitles: Readonly<Record<KeymapScope, string>> = {
  global: "Everywhere",
  viewport: "Viewport",
  hierarchy: "Hierarchy",
  assets: "Assets",
  console: "Console",
  text: "Text editor",
}

/** The attribute that makes an element's subtree a scope (data-keymap-scope="viewport") */
export const ScopeAttribute = "data-keymap-scope"

export interface ActionDef {
  /** "area.verb", never changed once released (overrides are stored under it) */
  readonly id: string
  /** What the shortcuts list calls it */
  readonly title: string
  readonly scope: KeymapScope
  /** The chords it has unless the user rebinds it */
  readonly chords: readonly string[]
  /** Fires while a text field has the focus too (Ctrl+S saves from a field; Ctrl+Z there is the field's own undo) */
  readonly allowInText?: boolean
}

// The actions that exist today. Names the roadmap reserves for the viewport toolbar and the gizmo modes (FE3, FE4), to
// be added when those exist, not before: gizmo.translate (W), gizmo.rotate (E), gizmo.scale (R), gizmo.none (Q),
// gizmo.toggleSpace (X), gizmo.togglePivot (Z); camera bookmarks (Ctrl+Shift+1..9, Shift+1..9).
export const DefaultActions: readonly ActionDef[] = [
  { id: "file.save", title: "Save the scene", scope: "global", chords: ["Mod+S"], allowInText: true },
  { id: "edit.undo", title: "Undo", scope: "global", chords: ["Mod+Z"] },
  { id: "edit.redo", title: "Redo", scope: "global", chords: ["Mod+Shift+Z", "Mod+Y"] },
  { id: "hierarchy.rename", title: "Rename the selected object", scope: "hierarchy", chords: ["F2"] },
  { id: "hierarchy.delete", title: "Delete the selected objects", scope: "hierarchy", chords: ["Delete"] },
  { id: "hierarchy.duplicate", title: "Duplicate the selected objects", scope: "hierarchy", chords: ["Mod+D"] },
  { id: "hierarchy.next", title: "Select the next object", scope: "hierarchy", chords: ["ArrowDown"] },
  { id: "hierarchy.previous", title: "Select the previous object", scope: "hierarchy", chords: ["ArrowUp"] },
  { id: "hierarchy.extendNext", title: "Extend the selection down", scope: "hierarchy", chords: ["Shift+ArrowDown"] },
  { id: "hierarchy.extendPrevious", title: "Extend the selection up", scope: "hierarchy", chords: ["Shift+ArrowUp"] },
  { id: "hierarchy.search", title: "Search the hierarchy", scope: "hierarchy", chords: ["Mod+F"] },
  { id: "hierarchy.expand", title: "Expand the object", scope: "hierarchy", chords: ["ArrowRight"] },
  { id: "hierarchy.collapse", title: "Collapse the object", scope: "hierarchy", chords: ["ArrowLeft"] },
  { id: "viewport.frame", title: "Frame the selection", scope: "viewport", chords: ["KeyF"] },
  { id: "viewport.cancel", title: "Cancel the move in progress", scope: "viewport", chords: ["Escape"] },
  { id: "assets.applySettings", title: "Apply the import settings", scope: "assets", chords: ["Mod+S"], allowInText: true },
  { id: "text.save", title: "Save the text file", scope: "text", chords: ["Mod+S"], allowInText: true },
]

// ==================== Chords ====================

export interface Chord {
  /** Ctrl or Cmd, whichever the key press has */
  mod: boolean
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  /** A KeyboardEvent.key or .code */
  key: string
}

const ModifierNames: Readonly<Record<string, "mod" | "ctrl" | "meta" | "alt" | "shift">> = {
  mod: "mod",
  ctrl: "ctrl",
  control: "ctrl",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  alt: "alt",
  option: "alt",
  shift: "shift",
}

/** A chord from text ("Mod+Shift+Z"); null when it is not one: no key, an unknown modifier, two keys, a repeated modifier */
export function parseChord(text: string): Chord | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 40) return null
  const parts = text.split("+")
  const chord: Chord = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key: "" }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim()
    if (part === "") return null
    if (i < parts.length - 1) {
      const name = ModifierNames[part.toLowerCase()]
      if (name === undefined || chord[name]) return null
      chord[name] = true
    } else {
      // The key: not a modifier by itself
      if (ModifierNames[part.toLowerCase()] !== undefined) return null
      chord.key = part
    }
  }
  return chord.key === "" ? null : chord
}

/** The key as it is compared: KeyF, F and f are one key; named keys ("ArrowDown") are as they are */
function normalizeKey(key: string): string {
  const letter = /^Key([A-Z])$/.exec(key)
  if (letter) return letter[1].toLowerCase()
  const digit = /^Digit(\d)$/.exec(key)
  if (digit) return digit[1]
  return key.length === 1 ? key.toLowerCase() : key
}

/** One text for chords that are the same ("mod+shift+z"), to find conflicts */
export function canonicalChord(chord: Chord): string {
  const names = [chord.mod && "Mod", chord.ctrl && "Ctrl", chord.meta && "Cmd", chord.alt && "Alt", chord.shift && "Shift"]
  return [...names.filter((n): n is string => n !== false), normalizeKey(chord.key)].join("+")
}

/** The key press as far as a chord looks at it (a KeyboardEvent has these) */
export interface KeyPress {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export function chordMatches(chord: Chord, e: KeyPress): boolean {
  if (chord.mod) {
    if (!(e.ctrlKey || e.metaKey)) return false
  } else if (chord.ctrl !== e.ctrlKey || chord.meta !== e.metaKey) {
    return false
  }
  if (chord.alt !== e.altKey || chord.shift !== e.shiftKey) return false
  // A code names a physical key (KeyF); a key names what it types (z) or is (ArrowDown)
  if (e.code === chord.key || e.key === chord.key) return true
  const wanted = normalizeKey(chord.key)
  return wanted.length === 1 && e.key.length === 1 && e.key.toLowerCase() === wanted
}

const KeyLabels: Readonly<Record<string, string>> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Delete: "Del",
  Escape: "Esc",
  " ": "Space",
}

/** The chord as it is shown: "Ctrl+Shift+Z" (Cmd on macOS), "F", "Del" */
export function formatChord(chord: Chord, mac = false): string {
  const key = normalizeKey(chord.key)
  const shown = key.length === 1 ? key.toUpperCase() : (KeyLabels[key] ?? key)
  const parts: string[] = []
  if (chord.mod) parts.push(mac ? "Cmd" : "Ctrl")
  if (chord.ctrl) parts.push("Ctrl")
  if (chord.meta) parts.push("Cmd")
  if (chord.alt) parts.push(mac ? "Option" : "Alt")
  if (chord.shift) parts.push("Shift")
  parts.push(shown)
  return parts.join("+")
}

// ==================== The registry and the dispatcher ====================

/** What runs an action: false means it did not take the key (the next candidate gets it) */
export type ActionHandler = (e: KeyboardEvent) => boolean | void

/** The chords two or more actions of one scope share */
export interface Conflict {
  chord: string
  scope: KeymapScope
  actions: string[]
}

export interface BindResult {
  ok: boolean
  /** Why not: chords that don't parse, an action that doesn't exist, chords another action of the scope has */
  problems: string[]
  conflicts: Conflict[]
}

/** One line of the shortcuts list */
export interface ShortcutRow {
  id: string
  title: string
  scope: KeymapScope
  scopeTitle: string
  /** The current chords, as shown ("Ctrl+Z"); empty when unbound */
  chords: string[]
}

interface Registration {
  handler: ActionHandler
  within: Element | null
}

export interface InstallOptions {
  /** A dialog is open: no shortcut acts */
  isModalOpen?: () => boolean
}

export class Keymap {
  private readonly defs = new Map<string, ActionDef>()
  private readonly parsedDefaults = new Map<string, Chord[]>()
  private overrides = new Map<string, Chord[]>()
  private overrideTexts: Record<string, string[]> = {}
  private readonly handlers = new Map<string, Registration[]>()
  private detach: (() => void) | null = null
  private prefs: { view: PrefScopeView<"user">; unsubscribe: () => void } | null = null

  constructor(
    actions: readonly ActionDef[] = DefaultActions,
    /** Whether chords are shown for macOS (Cmd) */
    private mac = false
  ) {
    for (const def of actions) {
      if (this.defs.has(def.id)) throw new Error(`Action "${def.id}" is defined twice`)
      const chords = def.chords.map((text) => {
        const parsed = parseChord(text)
        if (!parsed) throw new Error(`Action "${def.id}" has a chord that does not parse: "${text}"`)
        return parsed
      })
      this.defs.set(def.id, def)
      this.parsedDefaults.set(def.id, chords)
    }
  }

  setMac(mac: boolean): void {
    this.mac = mac
  }

  // ---- What there is ----

  has(id: string): boolean {
    return this.defs.has(id)
  }

  actions(): ActionDef[] {
    return [...this.defs.values()]
  }

  /** The chords an action has now: the user's, else the defaults */
  chordsOf(id: string): Chord[] {
    return this.overrides.get(id) ?? this.parsedDefaults.get(id) ?? []
  }

  /** The chords as shown for an action ("Ctrl+Z") */
  formatted(id: string): string[] {
    return this.chordsOf(id).map((chord) => formatChord(chord, this.mac))
  }

  /** The label with its first chord, "Rename (F2)"; the label alone when the action has none */
  withChord(label: string, id: string): string {
    const first = this.formatted(id)[0]
    return first ? `${label} (${first})` : label
  }

  /** The shortcuts list: every action with its current chords, by scope in the order of KeymapScopes */
  describe(): ShortcutRow[] {
    const rows: ShortcutRow[] = []
    for (const scope of KeymapScopes) {
      for (const def of this.defs.values()) {
        if (def.scope === scope) {
          rows.push({ id: def.id, title: def.title, scope, scopeTitle: ScopeTitles[scope], chords: this.formatted(def.id) })
        }
      }
    }
    return rows
  }

  // ---- Conflicts ----

  /** The chords more than one action of the same scope has now (an action of the focused scope shadows a global one on purpose: that is not one) */
  conflicts(): Conflict[] {
    return this.findConflicts((id) => this.chordsOf(id))
  }

  private findConflicts(chordsOf: (id: string) => Chord[]): Conflict[] {
    const seen = new Map<string, { chord: string; scope: KeymapScope; actions: string[] }>()
    for (const def of this.defs.values()) {
      const own = new Set<string>()
      for (const chord of chordsOf(def.id)) {
        const canonical = canonicalChord(chord)
        if (own.has(canonical)) continue
        own.add(canonical)
        const key = `${def.scope}|${canonical}`
        const found = seen.get(key)
        if (found) found.actions.push(def.id)
        else seen.set(key, { chord: canonical, scope: def.scope, actions: [def.id] })
      }
    }
    return [...seen.values()].filter((c) => c.actions.length > 1)
  }

  // ---- Overrides ----

  /** The user's chords by action id, as text (what is stored) */
  getOverrides(): Record<string, string[]> {
    return Object.fromEntries(Object.entries(this.overrideTexts).map(([id, chords]) => [id, [...chords]]))
  }

  /**
   * Replaces all the overrides (what was stored): an unknown action, or a chord that doesn't parse, is skipped, so a
   * bad entry never costs the good ones. Conflicts between overrides are kept (conflicts() reports them).
   */
  setOverrides(raw: Record<string, readonly string[]>): void {
    const parsed = new Map<string, Chord[]>()
    const texts: Record<string, string[]> = {}
    for (const [id, chords] of Object.entries(raw)) {
      if (!this.defs.has(id) || !Array.isArray(chords)) continue
      const list: Chord[] = []
      const kept: string[] = []
      for (const text of chords) {
        const chord = typeof text === "string" ? parseChord(text) : null
        if (chord) {
          list.push(chord)
          kept.push(text)
        }
      }
      parsed.set(id, list)
      texts[id] = kept
    }
    this.overrides = parsed
    this.overrideTexts = texts
  }

  /**
   * Gives an action chords of the user's: all or nothing. Not applied (and reported) when an action doesn't exist, a
   * chord doesn't parse, or another action of the same scope has a chord already.
   */
  bind(id: string, chords: readonly string[]): BindResult {
    const def = this.defs.get(id)
    if (!def) return { ok: false, problems: [`There is no action "${id}"`], conflicts: [] }
    const parsed: Chord[] = []
    const problems: string[] = []
    for (const text of chords) {
      const chord = parseChord(text)
      if (chord) parsed.push(chord)
      else problems.push(`"${text}" is not a chord`)
    }
    if (problems.length > 0) return { ok: false, problems, conflicts: [] }
    const trial = (other: string): Chord[] => (other === id ? parsed : this.chordsOf(other))
    const conflicts = this.findConflicts(trial).filter((c) => c.actions.includes(id))
    if (conflicts.length > 0) {
      return {
        ok: false,
        problems: conflicts.map((c) => `${c.chord} is also ${c.actions.filter((a) => a !== id).join(", ")}`),
        conflicts,
      }
    }
    this.overrides.set(id, parsed)
    this.overrideTexts[id] = [...chords]
    this.persist()
    return { ok: true, problems: [], conflicts: [] }
  }

  /** Gives an action its default chords again */
  reset(id: string): void {
    if (!this.overrides.has(id)) return
    this.overrides.delete(id)
    delete this.overrideTexts[id]
    this.persist()
  }

  resetAll(): void {
    this.overrides = new Map()
    this.overrideTexts = {}
    this.persist()
  }

  /**
   * Keeps the overrides in the user preferences: reads them now and when they change, writes them when they do.
   * Returns the detach. (One at a time: attaching again detaches the first.)
   */
  attachPrefs(view: PrefScopeView<"user">): () => void {
    this.prefs?.unsubscribe()
    const apply = (stored: Record<string, string[]>) => this.setOverrides(stored)
    apply(view.get(KeymapOverridesPref))
    const unsubscribe = view.subscribe(KeymapOverridesPref, (stored) => {
      // What this keymap wrote itself comes back as the same overrides: nothing to do
      if (JSON.stringify(stored) !== JSON.stringify(this.overrideTexts)) apply(stored)
    })
    const current = { view, unsubscribe }
    this.prefs = current
    return () => {
      unsubscribe()
      if (this.prefs === current) this.prefs = null
    }
  }

  private persist(): void {
    this.prefs?.view.set(KeymapOverridesPref, this.getOverrides())
  }

  // ---- Handlers ----

  /**
   * Registers what runs an action; returns the unregister. `within`: only for key presses inside that element (a
   * panel's own instance of the action). Several handlers may be registered; the most recent whose element contains
   * the target runs. An action that does not exist is a programming error.
   */
  handle(id: string, handler: ActionHandler, options: { within?: Element | null } = {}): () => void {
    if (!this.defs.has(id)) throw new Error(`There is no action "${id}"`)
    const registration: Registration = { handler, within: options.within ?? null }
    const list = this.handlers.get(id) ?? []
    list.push(registration)
    this.handlers.set(id, list)
    return () => {
      const at = list.indexOf(registration)
      if (at >= 0) list.splice(at, 1)
    }
  }

  // ---- Dispatching ----

  /** The scope the focus is in: the nearest ancestor (or the element itself) with data-keymap-scope; null for none */
  scopeOf(target: EventTarget | null): KeymapScope | null {
    const element = target as Element | null
    const holder = typeof element?.closest === "function" ? element.closest(`[${ScopeAttribute}]`) : null
    const value = holder?.getAttribute(ScopeAttribute)
    return value && (KeymapScopes as readonly string[]).includes(value) ? (value as KeymapScope) : null
  }

  /** Handles a key press (the document's keydown listener calls this); returns whether an action took it */
  dispatch(e: KeyboardEvent, options: InstallOptions = {}): boolean {
    if (e.defaultPrevented || e.isComposing) return false
    const matching = [...this.defs.values()].filter((def) => this.chordsOf(def.id).some((chord) => chordMatches(chord, e)))
    if (matching.length === 0) return false
    if (options.isModalOpen?.()) return false
    const target = e.target
    const focus = this.scopeOf(target)
    const text = isTextEntry(target as Element | null)
    const ordered = [
      ...(focus !== null && focus !== "global" ? matching.filter((def) => def.scope === focus) : []),
      ...matching.filter((def) => def.scope === "global"),
    ]
    for (const def of ordered) {
      if (text && !def.allowInText) continue
      const registration = this.registrationFor(def.id, target)
      if (!registration) continue
      let taken: boolean | void
      try {
        taken = registration.handler(e)
      } catch (error) {
        // A handler that throws took the key (it was meant to act) and must not break the page's other listeners
        console.error(`The action ${def.id} failed:`, error)
        taken = true
      }
      if (taken === false) continue
      e.preventDefault()
      return true
    }
    return false
  }

  private registrationFor(id: string, target: EventTarget | null): Registration | null {
    const list = this.handlers.get(id)
    if (!list) return null
    for (let i = list.length - 1; i >= 0; i--) {
      const within = list[i].within
      if (within === null || (target !== null && within.contains(target as Node))) return list[i]
    }
    return null
  }

  /**
   * Installs THE dispatcher: one keydown listener on the target (the document). Installing again, on this or another
   * target, removes the first, so there is never more than one. Returns the removal.
   */
  install(target: EventTarget, options: InstallOptions = {}): () => void {
    this.detach?.()
    const listener = (e: Event) => void this.dispatch(e as KeyboardEvent, options)
    target.addEventListener("keydown", listener)
    const detach = () => {
      target.removeEventListener("keydown", listener)
      if (this.detach === detach) this.detach = null
    }
    this.detach = detach
    return detach
  }

  /** Removes the dispatcher, if one is installed */
  uninstall(): void {
    this.detach?.()
  }

  get installed(): boolean {
    return this.detach !== null
  }
}

// ==================== The page's keymap and its stored overrides ====================

/** The user's rebinding: { actionId: [chords] }; an entry that is not a list of text is skipped, the rest is kept */
export const KeymapOverridesPref: PrefDef<Record<string, string[]>, "user"> = definePref({
  key: "keymap.overrides",
  scope: "user",
  default: {},
  validate: (raw) => {
    if (!isRecord(raw)) return undefined
    const out: Record<string, string[]> = {}
    for (const [id, chords] of Object.entries(raw)) {
      const list = v.arrayOf(v.string(40), 8)(chords)
      if (list !== undefined && id.length <= 80) out[id] = list
    }
    return out
  },
})

/** The editor's keymap: the default actions; the panels register what runs them */
export const keymap = new Keymap(DefaultActions)
