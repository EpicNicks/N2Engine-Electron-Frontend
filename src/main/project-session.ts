// The open project and its editor host process (#6: one host per project). Opening a project launches
// N2EditorHost for it (HostProcess), waits for the ready line and connects with the host's token; opening another,
// closing it, a page reload and quitting the editor stop the host. Node only (no Electron): the dialogs are in
// project-ipc.ts, and everything here is unit tested with fakes.
import * as fs from "fs"
import * as path from "path"
import type { ConnectionState, CreateProjectResult, HostState, OpenProjectResult } from "../shared/api"
import {
  CreateOptions,
  CreateProjectError,
  CreatedProject,
  HostCapabilities,
  HostExit,
  HostProcess,
  LaunchOptions,
  ProbeOptions,
  createProjectWithHost,
  describeExit,
  probeHostCapabilities,
} from "./host-launcher"
import type { HostSettings } from "./host-settings"
import type { ProjectFiles } from "./project-files"
import type { RecentProjects } from "./recent-projects"

/** The project file a folder needs to be a project (engine #90) */
export const ProjectFileName = "project.n2proj"

function notAProject(folder: string, detail?: string): OpenProjectResult {
  return {
    kind: "notAProject",
    path: folder,
    message: detail ?? `${folder} isn't a project: it has no ${ProjectFileName}`,
  }
}

/** After Shutdown (stop), how long the host gets to exit before it is killed */
export const StopGraceMs = 3000

/**
 * After a failed connection, how long to wait for the host's exit before killing it: the socket's close usually
 * arrives before the process's, and a host that died says why in its exit code and last output
 */
export const ConnectFailureExitWaitMs = 500

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
  create?: (options: CreateOptions) => Promise<CreatedProject>
  /** N2EditorHost --help: what the host can do */
  probe?: (options: ProbeOptions) => Promise<HostCapabilities>
  /** Whether a folder holds a project.n2proj */
  isProject?: (dir: string) => boolean
  /** Logs for the developer (never with the token) */
  log?: (message: string) => void
  /** How long a stopped host gets to exit (default StopGraceMs) */
  stopGraceMs?: number
  /** The --renderer to start hosts with (undefined: the host's default); the play child gets the same */
  renderer?: () => string | undefined
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
  private readonly create: (options: CreateOptions) => Promise<CreatedProject>
  private readonly probe: (options: ProbeOptions) => Promise<HostCapabilities>
  private readonly isProject: (dir: string) => boolean
  /** Each host path's capabilities, asked once */
  private readonly capabilityCache = new Map<string, Promise<HostCapabilities>>()
  /** Kills the --help probes still running */
  private readonly probeKills = new Set<() => void>()

  private readonly stopGraceMs: number

  constructor(private readonly deps: ProjectSessionDeps) {
    this.launch = deps.launch ?? HostProcess.launch
    this.create = deps.create ?? createProjectWithHost
    this.probe = deps.probe ?? probeHostCapabilities
    this.isProject = deps.isProject ?? ((dir) => fs.existsSync(path.join(dir, ProjectFileName)))
    this.stopGraceMs = deps.stopGraceMs ?? StopGraceMs
  }

  /**
   * What the host at hostPath can do, from N2EditorHost --help (asked once per path; a failed probe is asked again
   * next time). Never starts the engine.
   */
  capabilities(hostPath: string): Promise<HostCapabilities> {
    const cached = this.capabilityCache.get(hostPath)
    if (cached) return cached
    if (this.disposed) return Promise.reject(new CancelledError("Cancelled: the editor is closing"))
    let kill: (() => void) | null = null
    const probing = this.probe({ hostPath, onSpawned: (k) => this.probeKills.add((kill = k)) }).finally(() => {
      if (kill) this.probeKills.delete(kill)
    })
    this.capabilityCache.set(hostPath, probing)
    probing.catch(() => this.capabilityCache.delete(hostPath))
    return probing
  }

  /** Whether the host can create projects; false when asking it failed */
  private async canCreate(hostPath: string): Promise<boolean> {
    try {
      return (await this.capabilities(hostPath)).create
    } catch (e) {
      this.deps.log?.(`Couldn't ask N2EditorHost what it can do: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  get state(): HostState {
    return this.current
  }

  /** The open project's folder, or null */
  get projectPath(): string | null {
    return this.deps.files.rootPath
  }

  /**
   * Opens a project: stops any host, launches one for it and connects. A folder without project.n2proj, with a host
   * that has projects (engine #90), isn't opened: the result says so, and no host is started.
   */
  openProject(dir: string): Promise<OpenProjectResult> {
    return this.serial(() => this.open(dir))
  }

  /**
   * Makes a folder a project with N2EditorHost --create (engine #90), then opens it. name: the project's name
   * (empty: the folder's name). adopt: keep the asset UUIDs an existing folder's assets had
   * (--project-id from-path). A folder that already is a project is left alone, and the result says so.
   */
  createProject(dir: string, options: { name?: string; adopt?: boolean } = {}): Promise<CreateProjectResult> {
    return this.serial(async (): Promise<CreateProjectResult> => {
      const hostPath = this.deps.settings.require()
      const projectDir = path.resolve(dir)
      this.assertCanSpawn()
      this.launchCancelled = false
      try {
        const created = await this.create({
          hostPath,
          projectDir,
          name: options.name || undefined,
          projectId: options.adopt ? "from-path" : undefined,
          onSpawned: (kill) => (this.killLaunching = kill),
        })
        this.deps.log?.(`Created a project in ${projectDir} (projectId ${created.projectId})`)
      } catch (e) {
        if (this.launchCancelled) throw new CancelledError("Cancelled: creating the project was stopped")
        if (e instanceof CreateProjectError && e.kind === "alreadyAProject") {
          return { kind: "alreadyAProject", path: projectDir, message: e.message }
        }
        throw e
      } finally {
        this.killLaunching = null
      }
      const opened = await this.open(projectDir)
      if (opened.kind !== "opened") throw new Error(opened.message)
      return opened
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
    this.probeKills.forEach((kill) => kill())
  }

  /** Throws when the editor quit, or the project closed (or the page reloaded) after this operation was queued */
  private assertCanSpawn(): void {
    if (this.disposed) throw new CancelledError("Cancelled: the editor is closing")
    if (this.running !== this.generation) throw new CancelledError()
  }

  private async open(dir: string): Promise<OpenProjectResult> {
    const hostPath = this.deps.settings.require()
    // A host with projects (engine #90) refuses a folder without project.n2proj: say so before stopping anything
    const resolved = path.resolve(dir)
    if ((await this.canCreate(hostPath)) && !this.isProject(resolved)) {
      return notAProject(resolved)
    }
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
      // The host checks too, before its engine starts (exit code 1, "project.n2proj not found: ...")
      if (e instanceof Error && e.message.includes(`${ProjectFileName} not found`)) {
        this.setState({ status: "stopped", projectPath: null, message: null })
        return notAProject(projectPath, e.message)
      }
      throw e
    }
    this.deps.recent.add(projectPath)
    return { kind: "opened", path: projectPath }
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
        renderer: this.deps.renderer?.(),
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
      // Did it die between its ready line and Hello? Then its exit says why, not the closed connection
      const exited = host.exit ?? ((await waitForExit(host, ConnectFailureExitWaitMs)) ? host.exit : null)
      // A host nobody can talk to is no use; with a token, it would also wait forever for a Hello
      if (!exited) {
        if (this.host === host) this.killHost()
        else host.kill()
      }
      const message = exited
        ? `N2EditorHost ${describeExit(exited)} before the editor could connect${host.lastOutput}`
        : `Couldn't connect to N2EditorHost: ${e instanceof Error ? e.message : String(e)}`
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
