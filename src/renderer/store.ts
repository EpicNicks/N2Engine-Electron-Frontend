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
  engine: Pick<EngineApi, "isConnected" | "serverInfo" | "onConnectionChange" | "pollEvents">
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

  readonly console: ConsoleStore

  constructor(
    private readonly api: StoreApi,
    consoleOptions: ConsoleStoreOptions = {}
  ) {
    this.host = signal(api.host.state())
    this.console = new ConsoleStore(
      (epoch, afterSeq, maxEvents) => api.engine.pollEvents(epoch, afterSeq, maxEvents),
      consoleOptions
    )
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
    if (state.status === previous.status && state.launch === previous.launch) return
    if (state.status === "starting") {
      this.console.note("info", `Starting N2EditorHost for ${state.projectPath ?? "the project"}`)
    } else if ((state.status === "exited" || state.status === "failed") && state.message) {
      this.console.note("error", state.message)
    }
    // The main process closed the project (a page reload does that); the welcome screen shows again
    if (state.projectPath === null && this.projectPath.value !== null) this.projectPath.value = null
  }

  private onConnection(connected: boolean): void {
    batch(() => {
      this.connected.value = connected
      this.serverInfo.value = connected ? this.api.engine.serverInfo() : null
    })
    if (connected) this.console.connect(this.host.value.launch)
    else this.console.disconnect()
  }
}
