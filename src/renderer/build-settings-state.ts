// The Build Settings panel's state, without a DOM (build targets stage 3): the targets n2build knows and what each needs
// on this machine (doctor), the project's per-target settings (project.n2proj's build.targets) with the user's unsent
// edits, and the build itself: progress, log, result, cancel. Given its pieces (or fakes), so it is unit tested in Node;
// the panel (build-settings-panel.tsx) only draws it.
//
// The rules it keeps:
//  - settings are written with SetBuildTargets as a minimal merge patch (an emptied field removes its key); a viewer,
//    a read-only host, or a host before protocol 1.29.0 cannot change them;
//  - a target turned off (enabled: false) is hidden from the list until "Show turned-off targets";
//  - n2build reads the saved project, so a target with unapplied edits is not built until they are applied or reverted;
//  - with a remote host there is no Build button: builds run on this machine, from the project folder on its disk;
//  - no field here is ever a secret: signing is a profile's name, resolved by n2build from the user's own settings.
import { computed, effect, signal, type ReadonlySignal } from "@preact/signals-core"
import type { ProjectInfoResponse } from "../protocol/protocol.generated"
import type {
  BuildApi,
  BuildEvent,
  BuildRequest,
  BuildState,
  BuildTargetInfo,
  BuildUpdate,
  DoctorReport,
  JsonObject,
  N2BuildLocation,
} from "../shared/api"
import { InitialBuildState, errorTextOf } from "../shared/api"
import type { HostRole } from "./store"

/** The capability a host lists in Hello when it has SetBuildTargets (protocol 1.29.0) */
export const BuildTargetsCapability = "buildTargets"

export const RemoteBuildNote =
  "Builds run on this machine, from the project folder on its disk. This editor is connected to a remote host, so there is no Build button here: build on the machine that has the project."
export const OldHostNote = "This host is older than protocol 1.29.0 (no buildTargets capability): the settings can be read but not changed."
export const UnappliedNote = "Apply or revert this target's changes first: n2build builds from the saved project."

/** At most this many log lines are kept (the oldest go first) */
export const MaxLogLines = 5000

/** The fields of a target's form. Text in the form; "" means "not set" (the key is removed on Apply). */
export const BuildFields = [
  "enabled",
  "displayName",
  "appId",
  "version",
  "buildNumber",
  "config",
  "orientation",
  "renderer",
  "icon",
  "modules.physics3d",
  "modules.physics2d",
  "modules.particles",
  "modules.softbodies",
  "signing.profile",
] as const
export type BuildField = (typeof BuildFields)[number]

export const Choices: Partial<Record<BuildField, readonly string[]>> = {
  enabled: ["true", "false"],
  config: ["debug", "release"],
  orientation: ["any", "landscape", "portrait"],
  renderer: ["auto", "software", "opengl", "vulkan", "webgpu"],
  "modules.physics3d": ["none", "physx", "jolt", "both"],
  "modules.physics2d": ["true", "false"],
  "modules.particles": ["true", "false"],
  "modules.softbodies": ["true", "false"],
}

const BooleanFields = new Set<BuildField>(["enabled", "modules.physics2d", "modules.particles", "modules.softbodies"])

/** The rules SetBuildTargets applies (engine IO::BuildTargets), checked before sending so the form can say what is wrong */
export function fieldError(field: BuildField, text: string): string | null {
  if (text === "") return null
  const choices = Choices[field]
  if (choices && !choices.includes(text)) return `One of: ${choices.join(", ")}`
  switch (field) {
    case "displayName":
      // eslint-disable-next-line no-control-regex
      return text.length > 64 || /[\u0000-\u001f\u007f]/.test(text) ? "1 to 64 characters, no control characters" : null
    case "appId":
      return text.length <= 150 && /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(text)
        ? null
        : "A reverse-domain id such as com.example.game: two or more parts of letters, digits and _, each starting with a letter"
    case "version":
      return /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(text) ? null : "major.minor.patch, each part 1 to 5 digits"
    case "buildNumber": {
      const n = Number(text)
      return /^\d{1,10}$/.test(text) && n >= 1 && n <= 2100000000 ? null : "A whole number from 1 to 2100000000"
    }
    case "icon":
      return /^res:\/\/.+\.png$/i.test(text) ? null : "A res:// path to a .png in the assets folder"
    case "signing.profile":
      return /^[A-Za-z0-9._-]{1,64}$/.test(text) ? null : "A profile's name from your n2build.json (letters, digits, . _ -), never the key itself"
    default:
      return null
  }
}

type Json = unknown
const isObject = (v: Json): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v)

/** project.n2proj's build.targets ({} when absent) */
export function targetsOf(info: ProjectInfoResponse | null): JsonObject {
  const build = (info?.project as unknown as { build?: Json } | undefined)?.build
  const targets = isObject(build) ? build.targets : undefined
  return isObject(targets) ? targets : {}
}

/** A field's saved value as the form's text ("" when not set) */
export function savedText(settings: JsonObject, field: BuildField): string {
  const [head, tail] = field.split(".") as [string, string | undefined]
  let value: Json = settings[head]
  if (tail !== undefined) value = isObject(value) ? value[tail] : undefined
  if (value === undefined || value === null) return ""
  return typeof value === "string" ? value : JSON.stringify(value)
}

/** The form's text as the JSON value to send: null removes the key */
export function fieldValue(field: BuildField, text: string): Json {
  if (text === "") return null
  if (BooleanFields.has(field)) return text === "true"
  if (field === "buildNumber") return Number(text)
  return text
}

export interface BuiltPatch {
  /** The merge patch for this target ({displayName: "X", modules: {physics3d: null}}), or null when nothing changed */
  patch: JsonObject | null
  changed: BuildField[]
  errors: Partial<Record<BuildField, string>>
}

/** The minimal merge patch of a target's edits against its saved settings */
export function buildPatch(saved: JsonObject, edits: Readonly<Partial<Record<BuildField, string>>>): BuiltPatch {
  const patch: JsonObject = {}
  const changed: BuildField[] = []
  const errors: Partial<Record<BuildField, string>> = {}
  for (const field of BuildFields) {
    const text = edits[field]
    if (text === undefined || text === savedText(saved, field)) continue
    const error = fieldError(field, text)
    if (error) errors[field] = error
    changed.push(field)
    const [head, tail] = field.split(".") as [string, string | undefined]
    const value = fieldValue(field, text)
    if (tail === undefined) {
      patch[head] = value
    } else if (head === "signing") {
      // signing holds the profile and nothing else: removing the profile removes signing
      patch.signing = value === null ? null : { profile: value }
    } else {
      const inner = isObject(patch[head]) ? (patch[head] as JsonObject) : {}
      inner[tail] = value
      patch[head] = inner
    }
  }
  return { patch: changed.length > 0 ? patch : null, changed, errors }
}

/** One line of the build log, as the panel shows it */
export interface LogLine {
  kind: "out" | "err" | "step" | "warning" | "result"
  text: string
}

/** What an n2build event adds to the log (doctor and targets events add nothing) */
export function logLineOf(event: BuildEvent): LogLine | null {
  switch (event.type) {
    case "log":
      return { kind: event.stream === "stderr" ? "err" : "out", text: event.text }
    case "step":
      return { kind: "step", text: `==> ${event.title}` }
    case "warning":
      return { kind: "warning", text: `warning: ${event.text}` }
    case "result":
      if (!event.ok) return { kind: "result", text: `Failed: ${event.error ?? "n2build reported a failure"}` }
      if (event.url) return { kind: "result", text: `Serving at ${event.url}` }
      return { kind: "result", text: `Done: ${event.output ?? ""}${event.archive ? ` (archive: ${event.archive})` : ""}` }
    default:
      return null
  }
}

/** A target in the list: what n2build knows here, the project's settings for it, or both */
export interface TargetRow {
  name: string
  displayName: string
  /** n2build knows it on this machine */
  known: boolean
  buildableHere: boolean
  hostSystems: string[]
  enabled: boolean
}

export interface BuildSettingsDeps {
  build: Pick<BuildApi, "state" | "onUpdate" | "list" | "doctor" | "start" | "cancel">
  getProjectInfo(): Promise<ProjectInfoResponse>
  setBuildTargets(patch: JsonObject): Promise<ProjectInfoResponse>
  connected: ReadonlySignal<boolean>
  /** EditorStore.readOnlyReason: why nothing can be written, or null */
  readOnlyReason: ReadonlySignal<string | null>
  role: ReadonlySignal<HostRole | null>
  projectChangeCount: ReadonlySignal<number>
  /** The host is remote: no builds from here */
  remote: ReadonlySignal<boolean>
  /** The host lists the buildTargets capability (protocol 1.29.0) */
  supported: ReadonlySignal<boolean>
}

export class BuildSettingsModel {
  readonly info = signal<ProjectInfoResponse | null>(null)
  readonly loadError = signal<string | null>(null)
  readonly targets = signal<BuildTargetInfo[]>([])
  readonly location = signal<N2BuildLocation | null>(null)
  readonly listError = signal<string | null>(null)
  readonly selected = signal<string | null>(null)
  readonly showDisabled = signal(false)
  /** Doctor reports by target (null while asked), and why asking failed */
  readonly doctor = signal<Readonly<Record<string, DoctorReport | null>>>({})
  readonly doctorErrors = signal<Readonly<Record<string, string>>>({})
  readonly edits = signal<Readonly<Record<string, Readonly<Partial<Record<BuildField, string>>>>>>({})
  readonly applying = signal(false)
  readonly applyError = signal<string | null>(null)
  readonly buildState = signal<BuildState>(InitialBuildState)
  readonly log = signal<readonly LogLine[]>([])
  /** Why the last Build or Cancel was refused before n2build started */
  readonly startError = signal<string | null>(null)
  readonly config = signal<"" | "debug" | "release">("")
  readonly archive = signal<"" | "zip" | "7z">("")

  private reads = 0
  private disposer: (() => void) | null = null
  private listening = false

  constructor(private readonly deps: BuildSettingsDeps) {}

  /** The project's build.targets */
  readonly saved: ReadonlySignal<JsonObject> = computed(() => targetsOf(this.info.value))

  /** n2build's targets, then the project's own (a private target this machine lacks), with turned-off ones hidden */
  readonly rows: ReadonlySignal<TargetRow[]> = computed(() => {
    const saved = this.saved.value
    const rows: TargetRow[] = this.targets.value.map((t) => ({
      name: t.name,
      displayName: t.displayName,
      known: true,
      buildableHere: t.buildableHere,
      hostSystems: t.hostSystems,
      enabled: !(isObject(saved[t.name]) && (saved[t.name] as JsonObject).enabled === false),
    }))
    for (const name of Object.keys(saved).sort()) {
      if (rows.some((r) => r.name === name)) continue
      const s = saved[name]
      rows.push({ name, displayName: name, known: false, buildableHere: false, hostSystems: [], enabled: !(isObject(s) && s.enabled === false) })
    }
    return rows
  })
  readonly visibleRows: ReadonlySignal<TargetRow[]> = computed(() =>
    this.showDisabled.value ? this.rows.value : this.rows.value.filter((r) => r.enabled)
  )
  readonly hiddenCount: ReadonlySignal<number> = computed(() => this.rows.value.filter((r) => !r.enabled).length)
  readonly current: ReadonlySignal<TargetRow | null> = computed(() => {
    const rows = this.visibleRows.value
    return rows.find((r) => r.name === this.selected.value) ?? rows[0] ?? null
  })

  /** Why the settings can't be changed now, or null */
  readonly settingsLockedReason: ReadonlySignal<string | null> = computed(() => {
    if (!this.deps.connected.value) return "Not connected"
    if (this.info.value === null) return "The project is not read yet"
    const readOnly = this.deps.readOnlyReason.value
    if (readOnly !== null) return `Read-only: ${readOnly}`
    if (this.deps.role.value === "viewer") return "Read-only: a viewer cannot change the project"
    if (!this.deps.supported.value) return OldHostNote
    return null
  })

  get isRemote(): boolean {
    return this.deps.remote.value
  }

  /** Reads the project and n2build's targets and follows the build; returns what stops it (the panel unmounting) */
  start(): () => void {
    if (this.disposer) return this.disposer
    if (!this.listening) {
      // window.build has no "off": the model listens once for its life (the panel keeps one model)
      this.listening = true
      this.deps.build.onUpdate((update) => this.onBuildUpdate(update))
    }
    this.buildState.value = this.deps.build.state()
    const stop = effect(() => {
      this.deps.projectChangeCount.value
      if (!this.deps.connected.value) {
        this.reads++
        this.info.value = null
        this.loadError.value = null
        return
      }
      void this.refresh()
    })
    void this.refreshTargets()
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
      if (this.info.value !== null && this.info.value.project.projectId !== info.project.projectId) {
        this.edits.value = {}
        this.doctor.value = {}
        this.doctorErrors.value = {}
      }
      this.info.value = info
      this.loadError.value = null
    } catch (e) {
      if (read !== this.reads) return
      this.loadError.value = errorTextOf(e)
    }
  }

  /** n2build list (where n2build is, and its targets) */
  async refreshTargets(): Promise<void> {
    try {
      const list = await this.deps.build.list()
      this.location.value = list.location
      this.targets.value = list.targets
      this.listError.value = null
    } catch (e) {
      this.listError.value = errorTextOf(e)
    }
  }

  /** n2build doctor for a target (the remote case asks nothing: doctor checks this machine for this project) */
  async checkTarget(name: string): Promise<void> {
    if (this.isRemote) return
    this.doctor.value = { ...this.doctor.value, [name]: null }
    const { [name]: _old, ...errors } = this.doctorErrors.value
    this.doctorErrors.value = errors
    try {
      const report = await this.deps.build.doctor(name)
      this.doctor.value = { ...this.doctor.value, [name]: report }
    } catch (e) {
      const { [name]: _pending, ...reports } = this.doctor.value
      this.doctor.value = reports
      this.doctorErrors.value = { ...this.doctorErrors.value, [name]: errorTextOf(e) }
    }
  }

  select(name: string): void {
    this.selected.value = name
  }

  // ---- settings

  savedOf(name: string): JsonObject {
    const s = this.saved.value[name]
    return isObject(s) ? s : {}
  }

  textOf(name: string, field: BuildField): string {
    return this.edits.value[name]?.[field] ?? savedText(this.savedOf(name), field)
  }

  setEdit(name: string, field: BuildField, text: string): void {
    this.edits.value = { ...this.edits.value, [name]: { ...(this.edits.value[name] ?? {}), [field]: text } }
  }

  built(name: string): BuiltPatch {
    return buildPatch(this.savedOf(name), this.edits.value[name] ?? {})
  }

  isDirty(name: string): boolean {
    return this.built(name).changed.length > 0
  }

  revert(name: string): void {
    const { [name]: _edits, ...rest } = this.edits.value
    this.edits.value = rest
    this.applyError.value = null
  }

  /** SetBuildTargets with this target's minimal patch; the edits are kept when the host refuses */
  async apply(name: string): Promise<boolean> {
    if (this.applying.value || this.settingsLockedReason.value !== null) return false
    const built = this.built(name)
    if (built.patch === null || Object.keys(built.errors).length > 0) return false
    this.applying.value = true
    this.applyError.value = null
    try {
      const info = await this.deps.setBuildTargets({ [name]: built.patch })
      this.info.value = info
      this.revert(name)
      return true
    } catch (e) {
      this.applyError.value = errorTextOf(e)
      return false
    } finally {
      this.applying.value = false
    }
  }

  /** Turns a target on or off (enabled), at once */
  async setEnabled(name: string, enabled: boolean): Promise<boolean> {
    if (this.applying.value || this.settingsLockedReason.value !== null) return false
    this.applying.value = true
    this.applyError.value = null
    try {
      // On is the default: the key is removed rather than written as true
      this.info.value = await this.deps.setBuildTargets({ [name]: { enabled: enabled ? null : false } })
      return true
    } catch (e) {
      this.applyError.value = errorTextOf(e)
      return false
    } finally {
      this.applying.value = false
    }
  }

  // ---- building

  /** Why this target can't be built from here now, or null */
  buildBlockedReason(name: string): string | null {
    if (this.isRemote) return RemoteBuildNote
    const location = this.location.value
    if (location === null) return this.listError.value ?? "Looking for n2build..."
    if (location.problem !== null) return location.problem
    const row = this.rows.value.find((r) => r.name === name)
    if (!row || !row.known) return `n2build on this machine has no ${name} target`
    if (!row.buildableHere) return `${row.displayName} builds on ${row.hostSystems.join(", ") || "another system"} only`
    if (this.isDirty(name)) return UnappliedNote
    if (this.buildState.value.status === "running") return "A build is running"
    return null
  }

  async build(name: string, run: boolean): Promise<void> {
    if (this.buildBlockedReason(name) !== null) return
    const request: BuildRequest = { target: name, run }
    if (this.config.value !== "") request.config = this.config.value
    if (!run && this.archive.value !== "") request.archive = this.archive.value
    this.startError.value = null
    try {
      this.buildState.value = await this.deps.build.start(request)
    } catch (e) {
      this.startError.value = errorTextOf(e)
    }
  }

  async cancel(): Promise<void> {
    try {
      this.buildState.value = await this.deps.build.cancel()
    } catch (e) {
      this.startError.value = errorTextOf(e)
    }
  }

  /** An update from the main process: a new build starts a new log; its lines are appended, the oldest dropped */
  onBuildUpdate(update: BuildUpdate): void {
    const previous = this.buildState.value
    this.buildState.value = update.state
    let lines = update.state.id !== previous.id ? [] : [...this.log.value]
    for (const event of update.events) {
      const line = logLineOf(event)
      if (line) lines.push(line)
    }
    // The end of a build without a result line (cancelled, or n2build died), said once: when it stops running
    const ended = update.state.status !== "running" && (previous.status === "running" || update.state.id !== previous.id)
    if (ended && update.state.status !== "idle" && !update.state.result) {
      lines.push({ kind: "result", text: update.state.status === "cancelled" ? "Cancelled" : `Failed: ${update.state.message ?? "n2build ended"}` })
    }
    if (lines.length > MaxLogLines) lines = lines.slice(lines.length - MaxLogLines)
    if (update.state.id !== previous.id || update.events.length > 0 || lines.length !== this.log.value.length) this.log.value = lines
  }
}
