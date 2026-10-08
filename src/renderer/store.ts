// The editor's state, as signals the panels read, and the actions that change it. No DOM: it is given the page's
// API (window.engine, window.host, window.project) or a fake, so it is unit tested in Node.
import { Signal, batch, computed, signal } from "@preact/signals-core"
import type { EngineApi, HostApi, HostLocation, HostState, ProjectApi, ServerInfo } from "../shared/api"
import { ConsoleStore, ConsoleStoreOptions } from "./console-store"
import { basename } from "./paths"

/** The parts of the page's API the store uses */
export interface StoreApi {
  engine: Pick<EngineApi, "isConnected" | "serverInfo" | "onConnectionChange" | "pollEvents">
  host: HostApi
  project: Pick<ProjectApi, "openDialog" | "createDialog" | "openRecent" | "getRecent" | "removeRecent" | "close">
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

  /** What the editor is doing right now ("Opening project..."), or null */
  readonly busy = signal<string | null>(null)
  /** The last action's failure, until dismissed or the next action */
  readonly error = signal<string | null>(null)

  readonly console: ConsoleStore

  constructor(
    private readonly api: StoreApi,
    consoleOptions: ConsoleStoreOptions = {},
  ) {
    this.host = signal(api.host.state())
    this.console = new ConsoleStore(
      (epoch, afterSeq, maxEvents) => api.engine.pollEvents(epoch, afterSeq, maxEvents),
      consoleOptions,
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
  openProject(): Promise<void> {
    return this.opening("Opening project...", () => this.api.project.openDialog())
  }

  /** Picks a new folder and creates a project there with N2EditorHost --create (engine #75) */
  createProject(): Promise<void> {
    return this.opening("Creating project...", () => this.api.project.createDialog())
  }

  openRecent(projectPath: string): Promise<void> {
    return this.opening(`Opening ${basename(projectPath)}...`, () => this.api.project.openRecent(projectPath))
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

  private async opening(label: string, open: () => Promise<string | null>): Promise<void> {
    const projectPath = await this.run(label, open)
    if (projectPath) this.projectPath.value = projectPath
    await this.refreshRecent()
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
      this.error.value = e instanceof Error ? e.message : String(e)
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
