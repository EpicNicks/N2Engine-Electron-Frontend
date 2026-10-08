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
import type { EditorEvent, SceneInfoResponse } from "../protocol/protocol.generated"
import { AssetsChangedEvent, hasUnsavedChanges, parseStateEvent } from "../protocol/editor-events"
import { ConsoleStore, ConsoleStoreOptions } from "./console-store"
import { basename } from "./paths"

/** Questions the store asks the user (the page's dialogs; a fake in tests) */
export interface Dialogs {
  /** A line of text; null when cancelled */
  prompt(title: string, value: string): Promise<string | null>
  /** Whether the user agreed */
  confirm(message: string, okLabel: string): Promise<boolean>
}

/** The parts of the page's API the store uses */
export interface StoreApi {
  engine: Pick<EngineApi, "isConnected" | "serverInfo" | "onConnectionChange" | "pollEvents" | "getOpenScene">
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
  /** The last assetsChanged event, and how many arrived (panels refetch their listings when it changes) */
  readonly lastAssetsChange = signal<AssetsChangedEvent | null>(null)
  readonly assetsChangeCount = signal(0)
  /** How many projectChanged events arrived (project.n2proj was saved: refetch GetProjectInfo) */
  readonly projectChangeCount = signal(0)

  readonly console: ConsoleStore
  /** Counts scene fetches, so a slow answer can't replace a newer one */
  private sceneFetches = 0
  /** GetOpenScene calls still waiting for an answer */
  private sceneFetchesInFlight = 0

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
        })
        void this.refreshScene()
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
    await this.run("Closing project...", () => this.api.project.close())
    this.projectPath.value = null
    await this.refreshRecent()
  }

  restartHost(): Promise<void> {
    return this.run("Restarting the editor host...", () => this.api.host.restart())
  }

  stopHost(): Promise<void> {
    return this.run("Stopping the editor host...", () => this.api.host.stop())
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
      this.connected.value = connected
      this.serverInfo.value = connected ? this.api.engine.serverInfo() : null
      if (!connected) {
        this.scene.value = null
        this.sceneFetches++ // an answer still on its way is for a connection that is gone
      }
    })
    if (connected) {
      this.console.connect(this.host.value.launch)
      void this.refreshScene()
    } else {
      this.console.disconnect()
    }
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
    if (fetch === this.sceneFetches && this.api.engine.isConnected()) this.scene.value = scene
  }

  /** Applies the host's state events; log events are the console's */
  private onEvents(events: EditorEvent[]): void {
    let refetch = false
    batch(() => {
      for (const event of events) {
        const parsed = parseStateEvent(event)
        if (!parsed) continue
        if (parsed.kind === "sceneChanged") {
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
        } else {
          this.projectChangeCount.value++
        }
      }
    })
    if (refetch) void this.refreshScene()
  }
}
