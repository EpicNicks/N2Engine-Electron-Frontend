// Agent sessions (design 5.2): the bridge's own record of what an agent changed, kept in the bridge process (never on the
// host). A session holds
//   - a JOURNAL of every write (tool, a short scrubbed summary, the undo step's label, the files written),
//   - the labels of its own undo steps that are still done (`live`) and those it undid (`undone`), which bound
//     n2_undo / n2_redo / n2_session_revert to the agent's own steps,
//   - the counters of the write budgets,
//   - BACKUPS of the previous text of every file it overwrote, in a 0600 file in a private temp folder (memory when that
//     can't be made), deleted when the bridge exits unless the operator asked to keep them.
// Nothing here talks to the host: the tools do, and tell the session what happened.
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { BridgeError } from "./errors"
import * as limits from "./limits"

export const ImplicitSessionId = "implicit"

/** A file the agent wrote through a text asset tool */
export interface FileWrite {
  /** The res:// path */
  path: string
  /** The file did not exist before: there is no previous text to restore (the host cannot delete files) */
  created: boolean
  /** Where the previous text is kept (BackupStore id); absent for a created file */
  backupId?: string
  /** SHA-256 of the text written: a revert restores only a file that still holds it */
  hash: string
  /** A revert put the previous text back */
  restored?: boolean
}

export interface JournalEntry {
  seq: number
  /** Unix milliseconds */
  at: number
  tool: string
  /** One scrubbed line (arguments summarised, never the whole text of a file) */
  summary: string
  /** The undo step's label when the call made one */
  label?: string
  stepAdded: boolean
  revision?: number
  created?: string[]
  destroyed?: string[]
  modified?: string[]
  file?: FileWrite
  /** The scene file was saved, a scene was opened or created, or the project settings changed */
  saved?: boolean
  scene?: "open" | "new"
  settings?: boolean
  /** An irreversible operation was allowed: "elicited" (the person said yes) or "operator" (--allow-irreversible) */
  confirmed?: "elicited" | "operator"
  /** n2_undo / n2_redo / the revert moved this many of the session's steps */
  undid?: number
  redid?: number
}

export interface BackupStore {
  /** Keeps a text and answers the id to load it with */
  save(text: string): string
  load(id: string): string | undefined
  /** Where the files are, or null (memory only): for tests and the README */
  readonly directory: string | null
  dispose(): void
}

/** Backups in a private temp folder, falling back to memory when files can't be made */
export function createBackupStore(options: { tempRoot?: string; keep?: boolean } = {}): BackupStore {
  let dir: string | null = null
  let failed = false
  let counter = 0
  const memory = new Map<string, string>()
  const ensureDir = (): string | null => {
    if (dir !== null || failed) return dir
    try {
      dir = fs.mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), "n2-mcp-journal-"))
      try {
        fs.chmodSync(dir, 0o700)
      } catch {
        // Windows has no such modes
      }
    } catch {
      failed = true
      dir = null
    }
    return dir
  }
  return {
    get directory() {
      return dir
    },
    save(text) {
      const id = `b${++counter}`
      const folder = ensureDir()
      if (folder !== null) {
        try {
          fs.writeFileSync(path.join(folder, `${id}.bak`), text, { mode: 0o600, encoding: "utf8" })
          return id
        } catch {
          // falls back to memory
        }
      }
      memory.set(id, text)
      return id
    },
    load(id) {
      const kept = memory.get(id)
      if (kept !== undefined) return kept
      if (dir === null || !/^b\d+$/.test(id)) return undefined
      try {
        return fs.readFileSync(path.join(dir, `${id}.bak`), "utf8")
      } catch {
        return undefined
      }
    },
    dispose() {
      if (dir !== null && options.keep !== true) {
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch {
          // best effort
        }
      }
      memory.clear()
    },
  }
}

export class Session {
  readonly journal: JournalEntry[] = []
  /** Labels of the session's undo steps that are done, oldest first */
  live: string[] = []
  /** Labels of the session's steps it undid, in the order they were undone (the last is the next redo) */
  undone: string[] = []
  /** A scene was opened or created through the bridge: the host cleared its history, earlier steps can't be undone */
  historyClearedAt: number | null = null
  writes = 0
  textWrites = 0
  backupBytes = 0
  /** Entries dropped from the journal's start because it was full */
  droppedEntries = 0
  private nextSeq = 1
  lastUsed: number

  constructor(
    readonly id: string,
    readonly label: string,
    readonly createdAt: number,
    private readonly maxWrites: number
  ) {
    this.lastUsed = createdAt
  }

  /** Counts n host write commands against the budget; refuses (counting nothing) when they would pass it */
  spend(n: number): void {
    if (this.writes + n > this.maxWrites) {
      throw new BridgeError(
        "budget_exceeded",
        `This session has used ${this.writes} of its ${this.maxWrites} host write commands; this call needs ${n} more.`,
        "Stop making changes, or ask the operator to start the bridge with a higher --max-writes. n2_end_session gives the person a summary."
      )
    }
    this.writes += n
  }

  /** Adds an entry (seq and time are the session's) and returns it */
  record(entry: Omit<JournalEntry, "seq" | "at">, now: number): JournalEntry {
    const full: JournalEntry = { seq: this.nextSeq++, at: now, ...entry }
    this.journal.push(full)
    if (this.journal.length > limits.MaxJournalEntries) {
      this.journal.shift()
      this.droppedEntries++
    }
    return full
  }

  /** The aggregate the summary shows */
  summary(): SessionSummary {
    const created = new Set<string>()
    const destroyed = new Set<string>()
    const modified = new Set<string>()
    const files: Array<{ path: string; created: boolean; restored: boolean }> = []
    let lastEdit = 0
    let lastSave = 0
    let settingsChanged = false
    let scenes = 0
    for (const e of this.journal) {
      for (const id of e.created ?? []) created.add(id)
      for (const id of e.destroyed ?? []) destroyed.add(id)
      for (const id of e.modified ?? []) modified.add(id)
      if (e.file) files.push({ path: e.file.path, created: e.file.created, restored: e.file.restored === true })
      if (e.stepAdded) lastEdit = e.seq
      if (e.saved) lastSave = e.seq
      if (e.settings) settingsChanged = true
      if (e.scene) scenes++
    }
    // Created and then destroyed in the same session: neither
    for (const id of [...created]) {
      if (destroyed.has(id)) {
        created.delete(id)
        destroyed.delete(id)
      }
    }
    const cap = (set: Set<string>): { count: number; ids: string[] } => ({ count: set.size, ids: [...set].slice(0, 200) })
    return {
      steps: this.live.length,
      undone: this.undone.length,
      writes: this.writes,
      maxWrites: this.maxWrites,
      entities: { created: cap(created), destroyed: cap(destroyed), modified: cap(modified) },
      files,
      sceneSavedAfterLastEdit: lastSave > 0 && lastSave >= lastEdit,
      projectSettingsChanged: settingsChanged,
      scenesOpenedOrCreated: scenes,
      historyCleared: this.historyClearedAt !== null,
      journalEntries: this.journal.length + this.droppedEntries,
    }
  }
}

export interface SessionSummary {
  steps: number
  undone: number
  writes: number
  maxWrites: number
  entities: { created: { count: number; ids: string[] }; destroyed: { count: number; ids: string[] }; modified: { count: number; ids: string[] } }
  files: Array<{ path: string; created: boolean; restored: boolean }>
  sceneSavedAfterLastEdit: boolean
  projectSettingsChanged: boolean
  scenesOpenedOrCreated: number
  historyCleared: boolean
  journalEntries: number
}

export interface SessionManagerOptions {
  maxWrites?: number
  now?: () => number
  store?: BackupStore
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly now: () => number
  private readonly maxWrites: number
  private stepCounter = 0
  readonly store: BackupStore

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? Date.now
    this.maxWrites = options.maxWrites ?? limits.MaxWritesPerSession
    this.store = options.store ?? createBackupStore()
  }

  /** A new undo label that no other step of this process has: "AI: n2_set_transform #17" (cut to the host's 100 bytes) */
  nextLabel(tool: string): string {
    const text = `AI: ${tool} #${++this.stepCounter}`
    return Buffer.byteLength(text) <= limits.EditLabelBytes ? text : text.slice(0, limits.EditLabelBytes)
  }

  private purge(): void {
    const t = this.now()
    for (const [id, s] of this.sessions) if (id !== ImplicitSessionId && t - s.lastUsed > limits.SessionIdleMs) this.sessions.delete(id)
  }

  begin(label: string): Session {
    this.purge()
    // The implicit session doesn't count against the limit: a client that never begins one still works
    const explicit = [...this.sessions.keys()].filter((id) => id !== ImplicitSessionId).length
    if (explicit >= limits.MaxSessions) {
      throw new BridgeError("budget_exceeded", `${limits.MaxSessions} sessions are open.`, "End a session you no longer need with n2_end_session, then begin again.")
    }
    const session = new Session(randomUUID(), label, this.now(), this.maxWrites)
    this.sessions.set(session.id, session)
    return session
  }

  /** The session an id names, or the implicit one for no id; its idle clock restarts */
  resolve(id: string | undefined): Session {
    this.purge()
    let session: Session | undefined
    if (id === undefined || id === ImplicitSessionId) {
      session = this.sessions.get(ImplicitSessionId)
      if (!session) {
        session = new Session(ImplicitSessionId, "implicit session", this.now(), this.maxWrites)
        this.sessions.set(ImplicitSessionId, session)
      }
    } else {
      session = this.sessions.get(id)
    }
    if (!session) {
      throw new BridgeError(
        "unknown_session",
        "No session has that id (it was ended, or it expired after 24 hours without use).",
        "Call n2_begin_session for a new one, or leave sessionId out to use the implicit session."
      )
    }
    session.lastUsed = this.now()
    return session
  }

  /** A scene was opened or created: the host cleared its undo history, so no session's steps can be undone any more */
  historyCleared(): void {
    const at = this.now()
    for (const s of this.sessions.values()) {
      s.live = []
      s.undone = []
      s.historyClearedAt = at
    }
  }

  end(session: Session): void {
    this.sessions.delete(session.id)
  }

  /** The sessions now, for the status */
  get count(): number {
    return this.sessions.size
  }

  dispose(): void {
    this.sessions.clear()
    this.store.dispose()
  }
}
