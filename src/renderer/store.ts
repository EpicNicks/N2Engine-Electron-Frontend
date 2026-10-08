// The editor's state, as signals the panels read, and the actions that change it. No DOM: it is given the page's
// API (window.engine, window.host, window.project) or a fake, so it is unit tested in Node.
import { Signal, batch, computed, signal } from "@preact/signals-core"
import type {
  CreateProjectResult,
  EngineApi,
  HostApi,
  HostLocation,
  HostState,
  OpenProjectResult,
  ProjectApi,
  ServerInfo,
} from "../shared/api"
import type { EditResultResponse, EditorEvent, SceneInfoResponse } from "../protocol/protocol.generated"
import { EmptyHistoryStatus, HistoryStatus, historyStatusOf } from "../protocol/edit-history"
import {
  AssetsChangedEvent,
  SceneChange,
  hasUnsavedChanges,
  mergeSceneChange,
  parseStateEvent,
  sceneChangeOf,
} from "../protocol/editor-events"
import { AutosaveChoice, describeAutosave, sceneKey, shouldOfferAutosave } from "./autosave"
import { ConsoleStore, ConsoleStoreOptions } from "./console-store"
import { basename, normalizeScenePath, scenePathProblem } from "./paths"

/** Questions the store asks the user (the page's dialogs; a fake in tests) */
export interface Dialogs {
  /** A line of text; null when cancelled */
  prompt(title: string, value: string): Promise<string | null>
  /** Whether the user agreed */
  confirm(message: string, okLabel: string): Promise<boolean>
  /** What to do with unsaved changes before something discards them: save them, drop them, or not go on */
  unsaved(message: string, discardLabel: string): Promise<UnsavedChoice>
  /** What to do with the autosave a crash left (the message says which scene, when and how large): see autosave.ts */
  autosave(message: string): Promise<AutosaveChoice>
  /** Closes the autosave question if one is on screen, as "decide later" (the connection it was about is gone) */
  dismissAutosave(): void
}

export type UnsavedChoice = "save" | "discard" | "cancel"

/** The parts of the page's API the store uses */
export interface StoreApi {
  engine: Pick<
    EngineApi,
    | "isConnected"
    | "serverInfo"
    | "onConnectionChange"
    | "pollEvents"
    | "getOpenScene"
    | "openScene"
    | "newScene"
    | "saveSceneToFile"
    | "getHistory"
    | "getAutosave"
    | "restoreAutosave"
    | "discardAutosave"
  >
  host: HostApi
  project: Pick<
    ProjectApi,
    "openDialog" | "openRecent" | "openFolder" | "pickNewFolder" | "create" | "getRecent" | "removeRecent" | "close"
  >
  dialogs: Dialogs
}

/** Why Create New Project is unavailable, or null when it is available */
export function createUnavailableReason(location: HostLocation | null): string | null {
  if (!location || location.path === null || location.problem !== null) return "N2EditorHost isn't set"
  if (location.canCreate === false) {
    return "This N2EditorHost can't create projects: it is older than engine #90 (it has no --create)"
  }
  return null
}

export type View = "welcome" | "editor"

/** A short description of the host's state, for the toolbar */
export function describeHost(host: HostState, connected: boolean): string {
  switch (host.status) {
    case "starting":
      return "Starting the editor host..."
    case "running":
      return connected ? "Connected" : "Connecting..."
    case "exited":
      return "The editor host exited"
    case "failed":
      return "The editor host failed"
    default:
      return "Editor host stopped"
  }
}

export class EditorStore {
  /** The open project's folder; null on the welcome screen */
  readonly projectPath = signal<string | null>(null)
  readonly projectName = computed(() => (this.projectPath.value ? basename(this.projectPath.value) : ""))
  readonly view = computed<View>(() => (this.projectPath.value ? "editor" : "welcome"))

  readonly recent = signal<readonly string[]>([])
  readonly host: Signal<HostState>
  readonly hostLocation = signal<HostLocation | null>(null)
  readonly connected = signal(false)
  readonly serverInfo = signal<ServerInfo | null>(null)
  readonly hostSummary = computed(() => describeHost(this.host.value, this.connected.value))
  /** Why Create New Project is unavailable, or null */
  readonly createUnavailable = computed(() => createUnavailableReason(this.hostLocation.value))

  /** What the editor is doing right now ("Opening project..."), or null */
  readonly busy = signal<string | null>(null)
  /** The last action's failure, until dismissed or the next action */
  readonly error = signal<string | null>(null)

  /**
   * The scene the host has loaded (GetOpenScene), kept current by sceneChanged events; null when not connected, with
   * no scene, or with a host older than protocol 1.3
   */
  readonly scene = signal<SceneInfoResponse | null>(null)
  /** The loaded scene has unsaved changes: its revision isn't the one it was saved at */
  readonly sceneDirty = computed(() => {
    const scene = this.scene.value
    return scene !== null && hasUnsavedChanges(scene)
  })
  /** The loaded scene's name for the toolbar, with a * after it when it has unsaved changes; "" with none */
  readonly sceneLabel = computed(() => {
    const scene = this.scene.value
    if (!scene) return ""
    return (scene.name || "Untitled") + (this.sceneDirty.value ? " *" : "")
  })
  /**
   * What the Edit menu shows: whether Undo and Redo can run and their steps' labels, kept current by historyChanged
   * events (and GetHistory on connecting, after missed events and around an undo). Nothing to undo when not connected.
   */
  readonly history = signal<HistoryStatus>(EmptyHistoryStatus)
  /**
   * The scene (sceneKey) whose autosave the user put off ("Decide later") or couldn't restore: it is offered again by
   * Edit > Recover autosave..., and in spite of the scene's unsaved changes. null when none.
   */
  readonly autosaveDeferred = signal<string | null>(null)
  /** An autosave decision is outstanding for the loaded scene: the Edit menu offers to recover it */
  readonly autosaveOutstanding = computed(() => {
    const scene = this.scene.value
    return scene !== null && this.autosaveDeferred.value === sceneKey(scene)
  })
  /**
   * Why the scene is a play session, not an editable one (the host refuses Undo, Redo and edits then); null while it
   * is edited. The play controller sets it (setPlayMode) for as long as a game starts or runs.
   */
  readonly playMode = signal<string | null>(null)
  /** The scene can be edited now: connected, with a scene, nothing busy and not a play session (Undo and Redo need it) */
  readonly canEdit = computed(
    () => this.connected.value && this.scene.value !== null && this.busy.value === null && this.playMode.value === null
  )
  /** The last assetsChanged event, and how many arrived (panels refetch their listings when it changes) */
  readonly lastAssetsChange = signal<AssetsChangedEvent | null>(null)
  readonly assetsChangeCount = signal(0)
  /**
   * How many frameChanged events arrived (protocol 1.7.0: what the viewport would show changed): the viewport asks for
   * a frame again when it changes. Events missed count too.
   */
  readonly frameChangeCount = signal(0)
  /**
   * How many sceneChanged events the host itself flagged full (another scene was loaded, or a snapshot restored). A
   * full change of lastSceneChange can also be a change too big to list: only this counts a replacement.
   */
  readonly sceneReplacedCount = signal(0)
  /**
   * What the scene's latest change touched, for panels that show its objects (the hierarchy, the inspector): they
   * react to sceneChangeCount changing, then read this. full: refetch everything (another scene was loaded, a change
   * too big to list, events were missed, or the connection changed), else refetch just entityIds with GetEntity, and
   * GetHierarchy when scene.revision moved. One change covers one poll's events (several arriving together are
   * merged); it is null before the first. A save changes no object and is no change.
   */
  readonly lastSceneChange = signal<SceneChange | null>(null)
  readonly sceneChangeCount = signal(0)
  /** How many projectChanged events arrived (project.n2proj was saved: refetch GetProjectInfo) */
  readonly projectChangeCount = signal(0)

  readonly console: ConsoleStore
  /** Counts scene fetches, so a slow answer can't replace a newer one */
  private sceneFetches = 0
  /** GetOpenScene calls still waiting for an answer */
  private sceneFetchesInFlight = 0
  /** Events were missed and the poll's own events haven't been applied yet: their change is everything */
  private sceneMissed = false
  /** The newest scene revision any sceneChanged event named on this connection; null when none (or unreliable) */
  private lastSeenRevision: number | null = null
  /** Counts history events and reads, so a slow GetHistory can't replace what a newer event said */
  private historyReads = 0
  /** Counts connections, so an answer or a question for an earlier one is dropped */
  private connections = 0
  /** The scene whose autosave GetAutosave was last answered for on this connection (sceneKey); null when none */
  private autosaveAsked: string | null = null
  /** The connection (this.connections) an autosave question is being asked on: no second one meanwhile; null when none */
  private autosaveAsking: number | null = null

  constructor(
    private readonly api: StoreApi,
    consoleOptions: ConsoleStoreOptions = {}
  ) {
    this.host = signal(api.host.state())
    this.console = new ConsoleStore((epoch, afterSeq, maxEvents) => api.engine.pollEvents(epoch, afterSeq, maxEvents), {
      ...consoleOptions,
      onEvents: (events) => {
        this.onEvents(events)
        consoleOptions.onEvents?.(events)
      },
      // Events were dropped, or another host's log began: what they carried may have been missed
      onMissedEvents: () => {
        batch(() => {
          // Panels refetch on these counters, and a missed assetsChanged or projectChanged can't be told apart
          this.assetsChangeCount.value++
          this.projectChangeCount.value++
          this.frameChangeCount.value++
          // The events of this same poll come next and must not narrow this to their ids: onEvents sees the flag
          this.sceneMissed = true
          this.lastSeenRevision = null // another host's revisions can't be compared with these
          this.recordSceneChange({ full: true, entityIds: [] })
        })
        void this.refreshScene()
        void this.refreshHistory() // a historyChanged may have been among them
        consoleOptions.onMissedEvents?.()
      },
    })
    api.host.onStateChange((state) => this.onHostState(state))
    api.engine.onConnectionChange((connected) => this.onConnection(connected))
    if (api.engine.isConnected()) this.onConnection(true)
  }

  /** Loads what the welcome screen shows: recent projects and where the host is */
  async load(): Promise<void> {
    await Promise.all([this.refreshRecent(), this.refreshHostLocation()])
  }

  async refreshRecent(): Promise<void> {
    try {
      this.recent.value = await this.api.project.getRecent()
    } catch (e) {
      console.error("Failed to read recent projects:", e)
    }
  }

  async refreshHostLocation(): Promise<void> {
    try {
      this.hostLocation.value = await this.api.host.location()
    } catch (e) {
      console.error("Failed to locate N2EditorHost:", e)
    }
  }

  /** Picks a folder and opens it */
  async openProject(): Promise<void> {
    await this.afterOpen(await this.run("Opening project...", () => this.api.project.openDialog()))
  }

  /**
   * Picks a folder for a new project, asks for its name (the folder's name by default) and creates it with
   * N2EditorHost --create (engine #90)
   */
  async createProject(): Promise<void> {
    const folder = await this.run(null, () => this.api.project.pickNewFolder())
    if (!folder) return
    const name = await this.api.dialogs.prompt("Project name", basename(folder))
    if (name === null) return
    await this.creating(folder, name, false)
  }

  async openRecent(projectPath: string): Promise<void> {
    await this.afterOpen(
      await this.run(`Opening ${basename(projectPath)}...`, () => this.api.project.openRecent(projectPath))
    )
  }

  async removeRecent(projectPath: string): Promise<void> {
    await this.run(null, () => this.api.project.removeRecent(projectPath))
    await this.refreshRecent()
  }

  async closeProject(): Promise<void> {
    if (!(await this.confirmDiscard("close the project"))) return
    await this.run("Closing project...", () => this.api.project.close())
    this.projectPath.value = null
    await this.refreshRecent()
  }

  async restartHost(): Promise<void> {
    // The host holds the scene's unsaved changes, and a new host starts from the file
    if (!(await this.confirmDiscard("restart the host"))) return
    await this.run("Restarting the editor host...", () => this.api.host.restart())
  }

  async stopHost(): Promise<void> {
    if (!(await this.confirmDiscard("stop the host"))) return
    await this.run("Stopping the editor host...", () => this.api.host.stop())
  }

  /** Picks the N2EditorHost executable */
  async locateHost(): Promise<void> {
    const location = await this.run(null, () => this.api.host.locate())
    if (location) this.hostLocation.value = location
  }

  dismissError(): void {
    this.error.value = null
  }

  /** Shows a failure from elsewhere in the editor (a panel's action), and logs it */
  reportError(what: string, e: unknown): void {
    console.error(`${what}:`, e)
    this.error.value = `${what}: ${e instanceof Error ? e.message : String(e)}`
  }

  /**
   * Shows an opened project. A folder that isn't a project yet (no project.n2proj) can be made one where it is:
   * --create adopts it, keeping its files and (with --project-id from-path) its assets' UUIDs.
   */
  private async afterOpen(result: OpenProjectResult | null | undefined): Promise<void> {
    if (result?.kind === "opened") {
      this.projectPath.value = result.path
    } else if (result?.kind === "notAProject") {
      const unavailable = this.createUnavailable.value
      if (unavailable) {
        this.error.value = `${result.message}. ${unavailable}.`
      } else if (
        await this.api.dialogs.confirm(
          `${result.message}.\n\nMake it a project? Its files are kept, and its assets keep their UUIDs.`,
          "Create project here"
        )
      ) {
        const name = await this.api.dialogs.prompt("Project name", basename(result.path))
        if (name !== null) await this.creating(result.path, name, true)
      }
    }
    await this.refreshRecent()
  }

  /** Creates a project in a folder the editor offered; one that already is a project can be opened instead */
  private async creating(folder: string, name: string, adopt: boolean): Promise<void> {
    const result: CreateProjectResult | undefined = await this.run(`Creating ${name || basename(folder)}...`, () =>
      this.api.project.create(folder, name, adopt)
    )
    if (result?.kind === "opened") {
      this.projectPath.value = result.path
      await this.refreshRecent()
    } else if (result?.kind === "alreadyAProject") {
      if (await this.api.dialogs.confirm(`${result.message}.\n\nOpen it?`, "Open project")) {
        await this.afterOpen(
          await this.run(`Opening ${basename(result.path)}...`, () => this.api.project.openFolder(result.path))
        )
      }
    }
  }

  /** Runs an action: busy while it runs, its failure in error (it resolves with undefined then) */
  private async run<T>(label: string | null, action: () => Promise<T>): Promise<T | undefined> {
    batch(() => {
      this.error.value = null
      if (label) this.busy.value = label
    })
    try {
      return await action()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // The editor cancelled it itself (stopped or closed while a host started, the page reloaded): no error
      if (!message.startsWith("Cancelled:")) this.error.value = message
      return undefined
    } finally {
      if (label) this.busy.value = null
    }
  }

  private onHostState(state: HostState): void {
    const previous = this.host.value
    this.host.value = state
    // The main process closed the project (a page reload does that); the welcome screen shows again. Checked
    // before anything else: closing a stopped host's project changes neither its status nor its launch.
    if (state.projectPath === null && this.projectPath.value !== null) this.projectPath.value = null
    if (state.status === previous.status && state.launch === previous.launch) return
    if (state.status === "starting") {
      this.console.note("info", `Starting N2EditorHost for ${state.projectPath ?? "the project"}`)
    } else if ((state.status === "exited" || state.status === "failed") && state.message) {
      this.console.note("error", state.message)
    }
  }

  private onConnection(connected: boolean): void {
    batch(() => {
      this.connections++
      this.autosaveAsked = null
      this.autosaveDeferred.value = null
      this.api.dialogs.dismissAutosave()
      this.historyReads++
      this.history.value = EmptyHistoryStatus // GetHistory below says what the host has (it may be a running host)
      this.connected.value = connected
      this.serverInfo.value = connected ? this.api.engine.serverInfo() : null
      if (!connected) {
        this.scene.value = null
        this.sceneFetches++ // an answer still on its way is for a connection that is gone
      }
      this.lastSeenRevision = null
      this.sceneMissed = false
      this.recordSceneChange({ full: true, entityIds: [] }) // another host (or none): nothing held is valid
    })
    if (connected) {
      this.console.connect(this.host.value.launch)
      void this.refreshScene()
      void this.refreshHistory()
    } else {
      this.console.disconnect()
    }
  }

  // ==================== Scenes ====================

  /** The newest scene revision any sceneChanged event named on this connection; null when unknown */
  get newestSceneRevision(): number | null {
    return this.lastSeenRevision
  }

  /**
   * Before something discards the loaded scene's unsaved changes: asks whether to save them (and saves), drop them or
   * not go on. Resolves whether to go on; always true when there are none.
   */
  async confirmDiscard(action: string): Promise<boolean> {
    // What is known may be up to 100 ms old (an edit nobody has polled yet): ask the host before deciding
    if (this.api.engine.isConnected()) {
      await this.console.pollNow().catch((e) => console.debug("PollEvents failed:", e))
      await this.refreshScene()
    }
    const scene = this.scene.value
    if (!scene || !this.sceneDirty.value) return true
    const choice = await this.api.dialogs.unsaved(
      `${scene.name || "Untitled"} has unsaved changes.`,
      `Discard and ${action}`
    )
    if (choice === "cancel") return false
    if (choice === "discard") return true
    return (await this.saveScene()) !== undefined
  }

  /** Opens a scene file (a res:// path), after asking about unsaved changes; undefined when not done */
  async openScene(path: string): Promise<SceneInfoResponse | undefined> {
    if (this.refusedWhilePlaying("Open scene")) return undefined
    if (!(await this.confirmDiscard("open the scene"))) return undefined
    const opened = await this.sceneAction("Opening scene...", () => this.api.engine.openScene(path))
    // The host looks for an autosave a crash left whenever a scene is opened (again too: that is reverting it)
    if (opened) void this.checkAutosave(opened)
    return opened
  }

  /**
   * Asks for the new scene's path (a res:// path; the default is offered) and makes an empty scene there, which becomes
   * the loaded one, after asking about unsaved changes. undefined when not done.
   */
  async newScene(defaultPath = "res://scenes/Untitled.scene"): Promise<SceneInfoResponse | undefined> {
    if (this.refusedWhilePlaying("New scene")) return undefined
    // The unsaved changes first: a "no" there shouldn't come after the user has typed a path
    if (!(await this.confirmDiscard("create the scene"))) return undefined
    const path = this.checkedScenePath(await this.api.dialogs.prompt("New scene (a res:// path)", defaultPath))
    if (path === "") return undefined
    const made = await this.sceneAction("Creating scene...", () => this.api.engine.newScene(path, ""))
    if (made) void this.checkAutosave(made)
    return made
  }

  /** While a game runs the scene is read-only: says so (error banner) and returns true for an action that would change it */
  refusedWhilePlaying(what: string): boolean {
    if (this.playMode.value === null) return false
    this.error.value = `${what}: not while ${this.playMode.value}. Stop the game first.`
    return true
  }

  /** What was typed as a scene path, as the host takes it; "" when cancelled or empty, or when it can't be one (error says why) */
  private checkedScenePath(input: string | null): string {
    if (input === null) return ""
    const problem = scenePathProblem(input)
    if (problem) {
      this.error.value = problem
      return ""
    }
    return normalizeScenePath(input)
  }

  /** Writes the loaded scene to its file; a scene with no file asks for a path first (saveSceneAs) */
  async saveScene(): Promise<SceneInfoResponse | undefined> {
    const scene = this.scene.value
    if (!scene) return undefined
    if (scene.path === "") return this.saveSceneAs()
    return this.sceneAction("Saving scene...", () => this.api.engine.saveSceneToFile(""))
  }

  /** Asks for a path and writes the loaded scene there; it becomes the scene's file */
  async saveSceneAs(): Promise<SceneInfoResponse | undefined> {
    const scene = this.scene.value
    if (!scene) return undefined
    const name = (scene.name || "Untitled").replace(/[\\/:*?"<>|]/g, "_")
    const input = await this.api.dialogs.prompt(
      "Save scene as (a res:// path)",
      scene.path || `res://scenes/${name}.scene`
    )
    const path = this.checkedScenePath(input)
    if (path === "") return undefined
    const saved = await this.sceneAction("Saving scene...", () => this.api.engine.saveSceneToFile(path))
    // The scene is another file now, which may have an autosave of its own
    if (saved) void this.checkAutosave(saved)
    return saved
  }

  /** Runs a scene command, and takes the scene info it answers as the loaded scene's (the events say the same soon) */
  private async sceneAction(
    label: string,
    action: () => Promise<SceneInfoResponse>
  ): Promise<SceneInfoResponse | undefined> {
    const result = await this.run(label, action)
    if (result && this.api.engine.isConnected()) {
      this.sceneFetches++ // a GetOpenScene still on its way is older than this
      this.scene.value = result
      void this.console.pollNow().catch(() => {}) // the panels hear of it now, not in 100 ms
    }
    return result
  }

  /** Fetches the loaded scene (GetOpenScene); none when the host has no scene or doesn't have the command */
  async refreshScene(): Promise<void> {
    const fetch = ++this.sceneFetches
    let scene: SceneInfoResponse | null = null
    if (this.api.engine.isConnected()) {
      this.sceneFetchesInFlight++
      try {
        scene = await this.api.engine.getOpenScene()
      } catch (e) {
        // An error answer means no scene (or a host before protocol 1.3); a dropped connection is reported elsewhere
        console.debug("GetOpenScene failed:", e)
      } finally {
        this.sceneFetchesInFlight--
      }
    }
    // Not for a connection that dropped while waiting, or when a newer fetch started
    if (fetch === this.sceneFetches && this.api.engine.isConnected()) {
      this.scene.value = scene
      // A scene this connection hasn't asked about (the host opened its startup scene, or another client changed it)
      if (scene && this.autosaveAsked !== sceneKey(scene)) void this.checkAutosave(scene)
    }
  }

  // ==================== Undo history ====================

  /** Reads the host's history (GetHistory) into history; a host without it (before protocol 1.6) has none */
  async refreshHistory(): Promise<void> {
    const read = ++this.historyReads
    let status = EmptyHistoryStatus
    if (this.api.engine.isConnected()) {
      try {
        status = historyStatusOf(await this.api.engine.getHistory())
      } catch (e) {
        console.debug("GetHistory failed:", e)
      }
    }
    if (read === this.historyReads) this.history.value = status
  }

  /**
   * After an undo, a redo, a restore or anything else the panels should hear of now rather than at the next poll:
   * polls the host's events (the scene's change reaches the hierarchy and the inspector) and reads the history
   */
  async syncAfterEdit(): Promise<void> {
    await Promise.all([
      this.console.pollNow().catch((e) => console.debug("PollEvents failed:", e)),
      this.refreshHistory(),
    ])
  }

  /**
   * Takes an undo's or redo's answer as the scene's revisions at once (the events say the same soon): when it brings
   * the scene back to the state it was saved at, savedRevision == revision and the unsaved marker goes
   */
  applyEditResult(result: EditResultResponse): void {
    const scene = this.scene.value
    if (!scene || result.revision < scene.revision) return
    this.scene.value = { ...scene, revision: result.revision, savedRevision: result.savedRevision }
  }

  // ==================== Autosave recovery ====================

  /**
   * Asks about the scene's autosave when the host has one that a crash left (GetAutosave; a host before protocol 1.6
   * has none to ask about): restore it (RestoreAutosave, one undoable step), discard it (DiscardAutosave), or decide
   * later (the host keeps it and writes no new one until the user decides or saves). Asked once per scene per
   * connection, and never when the scene has unsaved changes (then the autosave is this host's own copy of them),
   * unless the user already put the question off for this scene (autosaveOutstanding). A question already on screen is
   * not asked twice; when it is answered the scene it was about may be another one, which is then asked about instead.
   * manual: the user asked (recoverAutosave), so the scene's unsaved changes don't matter.
   */
  async checkAutosave(scene: SceneInfoResponse, manual = false): Promise<void> {
    const connection = this.connections
    if (this.autosaveAsking === connection) return
    this.autosaveAsking = connection
    let next: SceneInfoResponse | null = null
    try {
      next = await this.askAutosave(scene, manual, connection)
    } finally {
      if (this.autosaveAsking === connection) this.autosaveAsking = null
    }
    if (next && connection === this.connections) await this.checkAutosave(next)
  }

  /** One round of checkAutosave; resolves the scene to ask about next when the answer turned out to be for another one */
  private async askAutosave(
    scene: SceneInfoResponse,
    manual: boolean,
    connection: number
  ): Promise<SceneInfoResponse | null> {
    const key = sceneKey(scene)
    let info
    try {
      info = await this.api.engine.getAutosave()
    } catch (e) {
      // Not marked as asked: a transient failure is tried again at the next opportunity
      console.debug("GetAutosave failed:", e)
      return null
    }
    if (connection !== this.connections) return null // another host: its autosave is another question
    this.autosaveAsked = key
    if (!info.exists && this.autosaveDeferred.value === key) this.autosaveDeferred.value = null
    const current = this.scene.value
    if (!current) return null
    // Another scene was loaded meanwhile: that one is the question now
    if (sceneKey(current) !== key) return current
    const deferred = this.autosaveDeferred.value === key
    if (!info.exists || !(manual || deferred || shouldOfferAutosave(current, info))) return null
    let intro = ""
    for (;;) {
      const choice = await this.api.dialogs.autosave(
        intro + describeAutosave(current.name, info, undefined, current.path === "")
      )
      if (connection !== this.connections) return null
      const now = this.scene.value
      // The answer is for the scene that was asked about, and for no other
      if (!now || sceneKey(now) !== key) return now
      if (choice === "restore") {
        this.error.value = null
        if (await this.restoreAutosave()) {
          this.autosaveDeferred.value = null
          return null
        }
        // It failed (the host said why): the question stays, with Discard to get rid of a bad file
        intro = `The autosave couldn't be restored: ${this.error.value ?? "unknown error"}\n\n`
        this.autosaveDeferred.value = key
        continue
      }
      if (choice === "discard") {
        await this.run(null, () => this.api.engine.discardAutosave())
        this.autosaveDeferred.value = null
      } else {
        this.autosaveDeferred.value = key // Edit > Recover autosave... asks again
      }
      return null
    }
  }

  /** Asks about the loaded scene's autosave now (Edit > Recover autosave...), after a "Decide later" or a failed restore */
  async recoverAutosave(): Promise<void> {
    if (this.refusedWhilePlaying("Recover autosave")) return
    const scene = this.scene.value
    if (scene) await this.checkAutosave(scene, true)
  }

  /** Replaces the loaded scene's content with its autosave (one undoable step), and has everything follow */
  async restoreAutosave(): Promise<SceneInfoResponse | undefined> {
    const result = await this.run("Restoring the autosave...", () => this.api.engine.restoreAutosave())
    if (result && this.api.engine.isConnected()) {
      batch(() => {
        this.sceneFetches++ // a GetOpenScene still on its way is older than this
        this.scene.value = result
        // The content was replaced: nothing held about the objects is valid
        this.recordSceneChange({ full: true, entityIds: [] })
      })
      await this.syncAfterEdit()
    }
    return result
  }

  /** Whatever runs a play session says so (a reason to show), and ends it with null: Undo and Redo are off meanwhile */
  setPlayMode(reason: string | null): void {
    this.playMode.value = reason
  }

  /** Applies the host's state events; log events are the console's */
  private onEvents(events: EditorEvent[]): void {
    let refetch = false
    // After missed events everything may have changed, whatever ids this poll's events carry
    const pending: { change: SceneChange | null } = { change: this.sceneMissed ? { full: true, entityIds: [] } : null }
    this.sceneMissed = false
    batch(() => {
      for (const event of events) {
        const parsed = parseStateEvent(event)
        if (!parsed) continue
        if (parsed.kind === "sceneChanged") {
          const objects = sceneChangeOf(parsed, this.lastSeenRevision)
          if (parsed.full) this.sceneReplacedCount.value++
          if (objects) pending.change = mergeSceneChange(pending.change, objects)
          // The host's scene revision never goes down while it runs (loading a scene moves it up too)
          this.lastSeenRevision = Math.max(this.lastSeenRevision ?? 0, parsed.revision)
          const scene = this.scene.value
          if (scene && parsed.path !== "" && scene.path === parsed.path && this.sceneFetchesInFlight === 0) {
            // Same scene file, nothing being fetched: its revisions moved. (A scene with no file can't be told from
            // another one without fetching, and a fetch in flight must not be cancelled: its answer is the truth.)
            if (parsed.revision < scene.revision) continue // older than what is known
            this.scene.value = { ...scene, revision: parsed.revision, savedRevision: parsed.savedRevision }
          } else {
            // Another scene was loaded (or none was known): its name and uuid come from GetOpenScene
            refetch = true
          }
        } else if (parsed.kind === "assetsChanged") {
          this.lastAssetsChange.value = parsed
          this.assetsChangeCount.value++
        } else if (parsed.kind === "historyChanged") {
          this.historyReads++ // an older GetHistory still on its way is out of date
          this.history.value = {
            canUndo: parsed.canUndo,
            canRedo: parsed.canRedo,
            label: parsed.label,
            redoLabel: parsed.redoLabel,
            undoCount: parsed.undoCount,
            redoCount: parsed.redoCount,
          }
        } else if (parsed.kind === "frameChanged") {
          this.frameChangeCount.value++
        } else {
          this.projectChangeCount.value++
        }
      }
    })
    if (pending.change) this.recordSceneChange(pending.change)
    if (refetch) void this.refreshScene()
  }

  /** Publishes a change for the panels */
  private recordSceneChange(change: SceneChange): void {
    batch(() => {
      this.lastSceneChange.value = change
      this.sceneChangeCount.value++
    })
  }
}
