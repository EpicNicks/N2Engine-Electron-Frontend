// The open project and its editor host process (#6: one host per project). Opening a project launches
// N2EditorHost for it (HostProcess), waits for the ready line and connects with the host's token; opening another,
// closing it, a page reload and quitting the editor stop the host. Node only (no Electron): the dialogs are in
// project-ipc.ts, and everything here is unit tested with fakes.
import * as path from "path"
import type { ConnectionState, HostState } from "../shared/api"
import { CreateOptions, HostExit, HostProcess, LaunchOptions, createProjectWithHost } from "./host-launcher"
import type { HostSettings } from "./host-settings"
import type { ProjectFiles } from "./project-files"
import type { RecentProjects } from "./recent-projects"

/** After Shutdown (stop), how long the host gets to exit before it is killed */
export const StopGraceMs = 3000

/** An operation that was queued before the editor quit, the page reloaded or the project closed */
export class CancelledError extends Error {
  constructor(message = "Cancelled: the page reloaded or the project was closed") {
    super(message)
    this.name = "CancelledError"
  }
}

/** What the session needs of EngineHost */
export interface EngineConnection {
  connectTo(port: number, token: string): Promise<ConnectionState>
  disconnect(): void
  close(): void
}

export interface ProjectSessionDeps {
  files: Pick<ProjectFiles, "open" | "close" | "rootPath">
  recent: Pick<RecentProjects, "add">
  settings: Pick<HostSettings, "require" | "readyTimeoutMs">
  engine: EngineConnection
  /** Tells the page the host's state changed */
  publish(state: HostState): void
  launch?: (options: LaunchOptions) => Promise<HostProcess>
  create?: (options: CreateOptions) => Promise<void>
  /** Logs for the developer (never with the token) */
  log?: (message: string) => void
  /** How long a stopped host gets to exit (default StopGraceMs) */
  stopGraceMs?: number
}

/** Resolves once the host has exited, or after ms (false then) */
function waitForExit(host: HostProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    host.onExit(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export class ProjectSession {
  private host: HostProcess | null = null
  /** Kills the child being spawned (a host being launched, or --create), until it settles */
  private killLaunching: (() => void) | null = null
  /** The editor killed the child being spawned itself (cancelLaunch): its failure is a cancellation */
  private launchCancelled = false
  /** Set by shutdown(): nothing is ever spawned again */
  private disposed = false
  /**
   * Bumped by closeProject (and so by a page reload) and shutdown: operations queued before that spawn nothing.
   * Each operation runs with the generation it was queued in (running).
   */
  private generation = 0
  private running = 0
  private current: HostState = { status: "stopped", launch: 0, projectPath: null, message: null }
  // Operations run one at a time, in order: opening a project while another opens waits for it
  private queue: Promise<unknown> = Promise.resolve()

  private readonly launch: (options: LaunchOptions) => Promise<HostProcess>
  private readonly create: (options: CreateOptions) => Promise<void>

  private readonly stopGraceMs: number

  constructor(private readonly deps: ProjectSessionDeps) {
    this.launch = deps.launch ?? HostProcess.launch
    this.create = deps.create ?? createProjectWithHost
    this.stopGraceMs = deps.stopGraceMs ?? StopGraceMs
  }

  get state(): HostState {
    return this.current
  }

  /** The open project's folder, or null */
  get projectPath(): string | null {
    return this.deps.files.rootPath
  }

  /** Opens a project: stops any host, launches one for it and connects. Resolves with its real path. */
  openProject(dir: string): Promise<string> {
    return this.serial(() => this.open(dir))
  }

  /**
   * Creates a project with N2EditorHost --create (engine #75), then opens it. projectId adopts an id (--project-id),
   * so an existing folder keeps its asset UUIDs.
   */
  createProject(dir: string, projectId?: string): Promise<string> {
    return this.serial(async () => {
      const hostPath = this.deps.settings.require()
      this.assertCanSpawn()
      this.launchCancelled = false
      try {
        await this.create({
          hostPath,
          projectDir: path.resolve(dir),
          projectId,
          onSpawned: (kill) => (this.killLaunching = kill),
        })
      } catch (e) {
        if (this.launchCancelled) throw new CancelledError("Cancelled: creating the project was stopped")
        throw e
      } finally {
        this.killLaunching = null
      }
      return this.open(dir)
    })
  }

  /** Stops the open project's host, if any, and launches a new one */
  restartHost(): Promise<void> {
    return this.serial(async () => {
      const projectPath = this.deps.files.rootPath
      if (projectPath === null) throw new Error("No project is open")
      await this.start(projectPath)
    })
  }

  /**
   * Shuts the host down: Shutdown, then a kill if it hasn't exited after StopGraceMs. The project stays open. A host
   * still starting is killed at once, without waiting for its launch.
   */
  stopHost(): Promise<void> {
    this.cancelLaunch()
    return this.serial(async () => {
      await this.stopCurrent(true)
      this.setState({ status: "stopped", message: null })
    })
  }

  /**
   * Closes the project and stops its host. A child still being spawned is killed at once, and operations queued
   * before this one spawn nothing.
   */
  closeProject(): Promise<void> {
    this.generation++
    this.cancelLaunch()
    return this.serial(async () => {
      this.killHost()
      this.deps.files.close()
      this.setState({ status: "stopped", projectPath: null, message: null })
    })
  }

  /**
   * Kills the host now, synchronously: for quitting, where nothing can be awaited. The connection is closed first,
   * so an --exit-on-disconnect host that outlives the kill still exits.
   */
  killHost(): void {
    const host = this.host
    this.host = null
    this.deps.engine.close()
    host?.kill()
    this.cancelLaunch()
  }

  /** Kills the child being spawned, if any (a host starting, or --create) */
  private cancelLaunch(): void {
    if (!this.killLaunching) return
    this.launchCancelled = true
    this.killLaunching()
  }

  /**
   * For a page (re)load: kills the host and any child being spawned, and closes the project. Operations queued
   * before it spawn nothing.
   */
  reset(): Promise<void> {
    this.killHost()
    return this.closeProject()
  }

  /**
   * For quitting, synchronous and final: kills the host and any child being spawned (a host starting, --create),
   * and nothing is spawned after it, whatever is still queued
   */
  shutdown(): void {
    this.disposed = true
    this.generation++
    this.killHost()
  }

  /** Throws when the editor quit, or the project closed (or the page reloaded) after this operation was queued */
  private assertCanSpawn(): void {
    if (this.disposed) throw new CancelledError("Cancelled: the editor is closing")
    if (this.running !== this.generation) throw new CancelledError()
  }

  private async open(dir: string): Promise<string> {
    const hostPath = this.deps.settings.require()
    await this.stopCurrent(false)
    let projectPath: string
    try {
      projectPath = this.deps.files.open(dir)
    } catch (e) {
      this.deps.files.close()
      this.setState({ status: "stopped", projectPath: null, message: null })
      throw e
    }
    try {
      await this.start(projectPath, hostPath)
    } catch (e) {
      this.deps.files.close()
      throw e
    }
    this.deps.recent.add(projectPath)
    return projectPath
  }

  /** Launches a host for the project and connects to it; any current host is stopped first */
  private async start(projectPath: string, hostPath: string = this.deps.settings.require()): Promise<void> {
    await this.stopCurrent(false)
    // Checked right before spawning: stopCurrent may have waited for the old host while the editor quit
    this.assertCanSpawn()
    const launch = this.current.launch + 1
    this.setState({ status: "starting", launch, projectPath, message: null })

    let host: HostProcess
    this.launchCancelled = false
    try {
      host = await this.launch({
        hostPath,
        projectDir: projectPath,
        readyTimeoutMs: this.deps.settings.readyTimeoutMs(),
        onExit: (exit, h) => this.onExit(h, exit),
        onSpawned: (kill) => (this.killLaunching = kill),
      })
    } catch (e) {
      if (this.launchCancelled) {
        this.setState({ status: "stopped", message: null })
        throw new CancelledError("Cancelled: the host was stopped while it started")
      }
      const message = e instanceof Error ? e.message : String(e)
      this.setState({ status: "failed", message })
      throw e
    } finally {
      this.killLaunching = null
    }
    this.host = host
    this.deps.log?.(`N2EditorHost started for ${projectPath} (pid ${host.pid ?? "?"}, port ${host.port})`)

    try {
      await this.deps.engine.connectTo(host.port, host.token)
    } catch (e) {
      // A host nobody can talk to is no use; with a token, it would also wait forever for a Hello
      this.killHost()
      const message = `Couldn't connect to N2EditorHost: ${e instanceof Error ? e.message : String(e)}`
      this.setState({ status: "failed", message })
      throw new Error(message)
    }
    if (this.host === host) this.setState({ status: "running", message: null })
  }

  /** Ends the current host: gracefully (Shutdown, then a kill after StopGraceMs) or with a kill */
  private async stopCurrent(graceful: boolean): Promise<void> {
    const host = this.host
    if (!host) {
      this.deps.engine.close()
      return
    }
    // No longer current: its exit is expected, not reported as a crash
    this.host = null
    if (graceful) {
      this.deps.engine.disconnect()
      if (await waitForExit(host, this.stopGraceMs)) return
    } else {
      this.deps.engine.close()
    }
    host.kill()
    await waitForExit(host, this.stopGraceMs)
  }

  /** The current host ended on its own (a crash, or its session ended) */
  private onExit(host: HostProcess, exit: HostExit): void {
    if (host !== this.host) return
    this.host = null
    this.deps.engine.close()
    const how = exit.code !== null ? `exited with code ${exit.code}` : `was ended by ${exit.signal ?? "a signal"}`
    this.deps.log?.(`N2EditorHost ${how}`)
    this.setState({ status: "exited", message: `N2EditorHost ${how}${host.lastOutput}` })
  }

  private setState(change: Partial<HostState>): void {
    this.current = { ...this.current, ...change }
    this.deps.publish(this.current)
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.generation
    const run = (): Promise<T> => {
      this.running = generation
      return operation()
    }
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return result
  }
}
