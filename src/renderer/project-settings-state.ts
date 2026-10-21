// The project settings panel's state, without a DOM: the host's answer to GetProjectInfo, the user's unsent edits per
// section, and Apply, Revert and "restore the previous values". Given its pieces (or fakes), so it is unit tested in
// Node; the panel (project-settings-panel.tsx) only draws it.
//
// The rules it keeps:
//  - an Apply sends only the keys that changed (the section's logic builds the minimal merge patch);
//  - the determinism block is never sent by a user who is not an admin (the host refuses it, forbidden), by any section,
//    Raw JSON included; a forbidden answer to it disables the section for the rest of the connection;
//  - the host refuses a patch whole (it rolls back): its message is shown under the section and the edits are kept;
//  - settings are not in the host's undo history: the one way back is "restore the previous values" (the values before
//    the last Apply, loaded as edits to Apply again).
import { computed, effect, signal, type ReadonlySignal } from "@preact/signals-core"
import type { ProjectInfoResponse } from "../protocol/protocol.generated"
import { errorCodeOf, errorTextOf } from "../shared/api"
import type { HostRole } from "./store"
import type { SectionBuildContext, SectionGate, SectionRegistry, SettingsSectionDef } from "./project-settings-registry"
import {
  NothingBuilt,
  patchTouchesDeterminism,
  settingsOf,
  type BuiltSection,
  type JsonObject,
} from "./project-settings-schema"

export interface ProjectSettingsDeps {
  /** GetProjectInfo */
  getProjectInfo(): Promise<ProjectInfoResponse>
  /** SetProjectSettings: a merge patch */
  setProjectSettings(patch: JsonObject): Promise<ProjectInfoResponse>
  /** SetStartupScene ("" clears it) */
  setStartupScene(path: string): Promise<ProjectInfoResponse>
  connected: ReadonlySignal<boolean>
  /** EditorStore.readOnlyReason: why nothing can be written (a play session, a read-only host, a viewer), or null */
  readOnlyReason: ReadonlySignal<string | null>
  /** EditorStore.hostRole */
  role: ReadonlySignal<HostRole | null>
  /** EditorStore.projectChangeCount: project.n2proj was saved (by anyone), so it is read again */
  projectChangeCount: ReadonlySignal<number>
  confirm(message: string, okLabel: string): Promise<boolean>
  /** Restarts the local host (asks about unsaved scene changes itself); null for a remote host, which can't be restarted from here */
  restartHost: (() => Promise<void>) | null
}

/** What "restore the previous values" puts back: the edit keys of the last Apply and their text before it */
export interface PreviousValues {
  keys: string[]
  texts: Record<string, string>
}

export const NotInTheHistoryNote =
  "Settings are saved to project.n2proj as soon as they are applied and are not part of the undo history: Undo (Ctrl+Z) does not take them back. After an Apply, Restore previous values loads the values from before it."

export class ProjectSettingsModel {
  /** What the host said last; null until read, and when not connected */
  readonly info = signal<ProjectInfoResponse | null>(null)
  /** Why GetProjectInfo failed, until it works */
  readonly loadError = signal<string | null>(null)
  /** The unsent edits: section id, then edit key, then the text. A key is there only once the user changed it. */
  readonly edits = signal<Readonly<Record<string, Readonly<Record<string, string>>>>>({})
  /** The host's (or the guard's) refusal of the last Apply of a section, shown under it until the next try */
  readonly errors = signal<Readonly<Record<string, string>>>({})
  /** The section whose Apply is on its way */
  readonly applying = signal<string | null>(null)
  /** Per section, the fields applied in this connection that the engine reads only at Init: a restart is needed */
  readonly restartPending = signal<Readonly<Record<string, readonly string[]>>>({})
  readonly previous = signal<Readonly<Record<string, PreviousValues>>>({})
  /** The host refused a determinism change with forbidden on this connection (whatever the role said) */
  readonly determinismDenied = signal(false)

  private reads = 0
  private disposer: (() => void) | null = null

  constructor(
    private readonly deps: ProjectSettingsDeps,
    readonly registry: SectionRegistry<unknown>
  ) {}

  /** The settings object ({} before the host answered, or when the project has none) */
  readonly settings: ReadonlySignal<JsonObject> = computed(() => settingsOf(this.info.value?.project))
  /** A host without roles (no tokens file, or before 1.12) counts as admin */
  readonly isAdmin: ReadonlySignal<boolean> = computed(() => this.deps.role.value === "admin")
  readonly gate: ReadonlySignal<SectionGate> = computed(() => ({
    role: this.deps.role.value,
    isAdmin: this.isAdmin.value,
    determinismDenied: this.determinismDenied.value,
  }))
  get isConnected(): boolean {
    return this.deps.connected.value
  }
  /** Whether the local host can be restarted from here (the restart note offers the button) */
  get canRestartHost(): boolean {
    return this.deps.restartHost !== null
  }

  /** Reads the project and follows its changes; returns what stops it (the panel unmounting) */
  start(): () => void {
    if (this.disposer) return this.disposer
    const stop = effect(() => {
      this.deps.projectChangeCount.value // what this runs on
      const connected = this.deps.connected.value
      if (!connected) {
        this.reads++
        this.info.value = null
        this.loadError.value = null
        // A new host starts from the file: nothing waits for a restart any more, and its refusals are its own
        this.restartPending.value = {}
        this.determinismDenied.value = false
        return
      }
      void this.refresh()
    })
    this.disposer = () => {
      stop()
      this.disposer = null
    }
    return this.disposer
  }

  /** GetProjectInfo; the newest read wins */
  async refresh(): Promise<void> {
    const read = ++this.reads
    try {
      const info = await this.deps.getProjectInfo()
      if (read !== this.reads) return
      // Another project: its drafts and history are not this one's
      if (this.info.value !== null && this.info.value.project.projectId !== info.project.projectId) this.resetDrafts()
      this.info.value = info
      this.loadError.value = null
    } catch (e) {
      if (read !== this.reads) return
      console.error("Failed to get the project info:", e)
      this.loadError.value = errorTextOf(e)
    }
  }

  private resetDrafts(): void {
    this.edits.value = {}
    this.errors.value = {}
    this.previous.value = {}
    this.restartPending.value = {}
  }

  // ---- reading a section

  /** Why a section can't be changed now (not connected, read-only, or its own reason), or null */
  disabledReason(id: string): string | null {
    if (!this.deps.connected.value) return "Not connected"
    if (this.info.value === null) return "The project is not read yet"
    const readOnly = this.deps.readOnlyReason.value
    if (readOnly !== null) return `Read-only: ${readOnly}`
    return this.registry.get(id)?.requires?.(this.gate.value) ?? null
  }

  canWrite(id: string): boolean {
    return this.disabledReason(id) === null
  }

  private contextFor(id: string): SectionBuildContext | null {
    const info = this.info.value
    if (info === null) return null
    return { settings: this.settings.value, edits: this.edits.value[id] ?? {}, isAdmin: this.isAdmin.value, info }
  }

  /** The patch of a section's edits (nothing built before the host answered, or for a section without logic) */
  built(id: string): BuiltSection {
    const logic = this.registry.get(id)?.logic
    const ctx = this.contextFor(id)
    return logic && ctx ? logic.build(ctx) : NothingBuilt
  }

  /** The text of an edit key: the user's edit, else what the host has */
  textOf(id: string, key: string): string {
    const edited = this.edits.value[id]?.[key]
    if (edited !== undefined) return edited
    const logic = this.registry.get(id)?.logic
    const ctx = this.contextFor(id)
    return logic?.textOf && ctx ? logic.textOf(ctx, key) : ""
  }

  /** Whether a section has edits that differ from the host's */
  isDirty(id: string): boolean {
    return this.built(id).changed.length > 0
  }

  /** Whether the edit key differs from the host's (a dirty mark on a field) */
  isKeyDirty(id: string, key: string): boolean {
    return this.built(id).changed.includes(key)
  }

  hasPrevious(id: string): boolean {
    return this.previous.value[id] !== undefined
  }

  // ---- editing

  setEdit(id: string, key: string, text: string): void {
    this.edits.value = { ...this.edits.value, [id]: { ...(this.edits.value[id] ?? {}), [key]: text } }
  }

  /** Drops a section's edits and its last error */
  revert(id: string): void {
    const { [id]: _edits, ...edits } = this.edits.value
    this.edits.value = edits
    this.clearError(id)
  }

  /** Loads the values from before the last Apply as edits (to review and Apply): the way back, since Undo has none */
  restorePrevious(id: string): void {
    const previous = this.previous.value[id]
    if (!previous) return
    this.edits.value = { ...this.edits.value, [id]: { ...previous.texts } }
    this.clearError(id)
  }

  private clearError(id: string): void {
    const { [id]: _error, ...errors } = this.errors.value
    this.errors.value = errors
  }

  // ---- applying

  /** Sends a section's changes: the minimal patch, or SetStartupScene. The edits are kept when the host refuses. */
  async apply(id: string): Promise<boolean> {
    const def: SettingsSectionDef | undefined = this.registry.get(id)
    const ctx = this.contextFor(id)
    if (!def?.logic || !ctx || this.applying.value !== null || this.disabledReason(id) !== null) return false
    const built = def.logic.build(ctx)
    if (Object.keys(built.errors).length > 0) return false
    if (built.patch === null && built.startupScene === undefined) return false
    // The host refuses it to everyone but an admin: it is not even sent (the sections hide it, this is the guard)
    if (built.patch !== null && patchTouchesDeterminism(built.patch) && !this.isAdmin.value) {
      this.errors.value = { ...this.errors.value, [id]: "The determinism block can only be changed by an admin; nothing was sent" }
      return false
    }
    if (def.logic.confirm && !(await this.deps.confirm(def.logic.confirm.message, def.logic.confirm.okLabel))) return false
    this.clearError(id)
    this.applying.value = id
    // What "restore" will put back: the texts before this Apply, for the keys it changes
    const before: PreviousValues = { keys: built.changed, texts: {} }
    if (def.logic.textOf) for (const key of built.changed) before.texts[key] = def.logic.textOf(ctx, key)
    try {
      let answer: ProjectInfoResponse | undefined
      if (built.startupScene !== undefined) answer = await this.deps.setStartupScene(built.startupScene)
      if (built.patch !== null) answer = await this.deps.setProjectSettings(built.patch)
      if (answer) {
        this.info.value = answer
        this.loadError.value = null
      }
      const { [id]: _done, ...edits } = this.edits.value
      this.edits.value = edits
      if (def.logic.textOf) this.previous.value = { ...this.previous.value, [id]: before }
      if (built.restart.length > 0) {
        const pending = new Set([...(this.restartPending.value[id] ?? []), ...built.restart])
        this.restartPending.value = { ...this.restartPending.value, [id]: [...pending] }
      }
      return true
    } catch (e) {
      console.error("Failed to apply the project settings:", e)
      // The host refused the determinism change whatever the role said: it stays disabled until the connection ends
      if (errorCodeOf(e) === "forbidden" && built.patch !== null && patchTouchesDeterminism(built.patch)) {
        this.determinismDenied.value = true
      }
      this.errors.value = { ...this.errors.value, [id]: errorTextOf(e) }
      return false
    } finally {
      this.applying.value = null
    }
  }

  /** Restarts the local host (the restart note's button); the reads follow the reconnect */
  async restartHost(): Promise<void> {
    await this.deps.restartHost?.()
  }
}
