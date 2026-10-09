// The open project and its editor host process (#6: one host per project). Opening a project launches
// N2EditorHost for it (HostProcess), waits for the ready line and connects with the host's token; opening another,
// closing it, a page reload and quitting the editor stop the host. Node only (no Electron): the dialogs are in
// project-ipc.ts, and everything here is unit tested with fakes.
//
// Remote mode (frontend issue #21) shares the session: connectRemote opens an SSH tunnel (ssh-tunnel.ts) to a host
// that is already running and connects through it. That host isn't the editor's: nothing here starts, stops or kills
// it, and closing the project, a reload or quitting only ends the tunnel's ssh.
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
import type { RecentRemotes } from "./recent-remotes"
import { SshTunnel, TunnelOptions, describeRemote, parseRemoteSettings } from "./ssh-tunnel"

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

/** What the session needs of an SshTunnel */
export type TunnelHandle = Pick<SshTunnel, "localPort" | "exit" | "pid" | "lastOutput" | "onExit" | "kill">

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
  /** Opens an SSH tunnel for remote mode (default SshTunnel.open) */
  openTunnel?: (options: TunnelOptions) => Promise<TunnelHandle>
  /** Remembers the remotes that were connected to (their settings, never a token) */
  recentRemotes?: Pick<RecentRemotes, "add">
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

/** Resolves once the host (or tunnel) has exited, or after ms (false then) */
function waitForExit(host: Pick<HostProcess, "onExit">, ms: number): Promise<boolean> {
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
  /** The SSH tunnel of the remote engine the editor is connected to (remote mode); never both this and a host */
  private tunnel: TunnelHandle | null = null
  /** Kills the child being spawned (a host being launched, or --create), until it settles */
  private killLaunching: (() => void) | null = null
  /** The editor killed the child being spawned itself (cancelLaunch): its failure is a cancellation */
  private launchCancelled = false
  /** Set by shutdown(): nothing is ever spawned again */
  private disposed = false
  /** Aborted by shutdown(): a tunnel being opened is killed, or never spawned */
  private readonly shutdownSignal = new AbortController()
  /**
   * Bumped by closeProject (and so by a page reload) and shutdown: operations queued before that spawn nothing.
   * Each operation runs with the generation it was queued in (running).
   */
  private generation = 0
  private running = 0
  /** The --renderer the current (or last) host was launched with: the play child gets the same */
  private launchedRenderer: string | undefined
  private current: HostState = { status: "stopped", mode: "local", launch: 0, projectPath: null, message: null }
  // Operations run one at a time, in order: opening a project while another opens waits for it
  private queue: Promise<unknown> = Promise.resolve()

  private readonly launch: (options: LaunchOptions) => Promise<HostProcess>
  private readonly openTunnel: (options: TunnelOptions) => Promise<TunnelHandle>
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
    this.openTunnel = deps.openTunnel ?? SshTunnel.open
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

  /** The --renderer the editor host was launched with (undefined: the host's default) */
  get hostRenderer(): string | undefined {
    return this.launchedRenderer
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

  /** Whether the editor is connected (or connecting) to a remote engine through a tunnel it opened */
  get isRemote(): boolean {
    return this.current.mode === "remote"
  }

  private remoteHostError(what: string): Error {
    return new Error(
      `The editor can't ${what} a remote engine's host: it didn't start it. Disconnect, then connect again to reopen the tunnel.`
    )
  }

  /**
   * Remote mode: opens an SSH tunnel to a host that is already running (settings are validated here: the page's input
   * is never passed on unchecked) and connects through it with the token. Any local host or earlier tunnel is stopped
   * first. Resolves with the remote's name. The token goes to the engine connection and nowhere else: not the tunnel's
   * arguments or environment, a log line, the state or an error. Failing leaves nothing open.
   */
  connectRemote(settingsInput: unknown, token: unknown): Promise<string> {
    // Checked before anything is stopped
    let settings: ReturnType<typeof parseRemoteSettings>
    try {
      settings = parseRemoteSettings(settingsInput)
    } catch (e) {
      return Promise.reject(e)
    }
    if (typeof token !== "string" || token === "") return Promise.reject(new Error("Enter the host's access token"))
    return this.serial(async () => {
      const label = describeRemote(settings)
      await this.stopCurrent(false)
      this.assertCanSpawn()
      this.deps.files.close()
      const launch = this.current.launch + 1
      this.setState({ status: "starting", mode: "remote", launch, projectPath: label, message: null })
      const failed = (message: string): void =>
        this.setState({ status: "failed", mode: "local", projectPath: null, message })

      let tunnel: TunnelHandle
      this.launchCancelled = false
      try {
        tunnel = await this.openTunnel({
          settings,
          signal: this.shutdownSignal.signal,
          onExit: (exit, t) => this.onTunnelExit(t, exit, label),
          onSpawned: (kill) => (this.killLaunching = kill),
        })
      } catch (e) {
        if (this.launchCancelled || this.disposed) {
          this.setState({ status: "stopped", mode: "local", projectPath: null, message: null })
          throw new CancelledError("Cancelled: the tunnel was closed while it opened")
        }
        failed(e instanceof Error ? e.message : String(e))
        throw e
      } finally {
        this.killLaunching = null
      }
      if (this.disposed) {
        tunnel.kill()
        throw new CancelledError("Cancelled: the editor is closing")
      }
      this.tunnel = tunnel
      this.deps.log?.(`SSH tunnel to ${label} opened (pid ${tunnel.pid ?? "?"}, local port ${tunnel.localPort})`)

      try {
        await this.deps.engine.connectTo(tunnel.localPort, token)
      } catch (e) {
        // Did ssh die between the forward and Hello? Then its exit says why, not the closed connection
        const exited = tunnel.exit ?? ((await waitForExit(tunnel, ConnectFailureExitWaitMs)) ? tunnel.exit : null)
        const output = tunnel.lastOutput
        if (this.tunnel === tunnel) this.killHost()
        else tunnel.kill()
        const message = exited
          ? `The SSH tunnel to ${label} ${describeExit(exited)} before the editor could connect${output}`
          : `The tunnel is up, but connecting to the host through it failed: ${e instanceof Error ? e.message : String(e)}${output}`
        failed(message)
        throw new Error(message)
      }
      // Hello went through a port ssh holds; if ssh is gone now it isn't a tunnel any more, whatever answered
      if (tunnel.exit) {
        const message = `The SSH tunnel to ${label} ${describeExit(tunnel.exit)} right after the editor connected${tunnel.lastOutput}`
        if (this.tunnel === tunnel) this.killHost()
        failed(message)
        throw new Error(message)
      }
      if (this.tunnel === tunnel) this.setState({ status: "running", message: null })
      this.deps.recentRemotes?.add(settings)
      return label
    })
  }

  /** Stops the open project's host, if any, and launches a new one */
  restartHost(): Promise<void> {
    return this.serial(async () => {
      if (this.isRemote) throw this.remoteHostError("restart")
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
    if (this.isRemote) return Promise.reject(this.remoteHostError("stop"))
    this.cancelLaunch()
    return this.serial(async () => {
      if (this.isRemote) throw this.remoteHostError("stop")
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
      this.setState({ status: "stopped", mode: "local", projectPath: null, message: null })
    })
  }

  /**
   * Kills the host now, synchronously: for quitting, where nothing can be awaited. The connection is closed first,
   * so an --exit-on-disconnect host that outlives the kill still exits.
   */
  killHost(): void {
    const host = this.host
    const tunnel = this.tunnel
    this.host = null
    this.tunnel = null
    this.deps.engine.close()
    host?.kill()
    tunnel?.kill()
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
    this.shutdownSignal.abort()
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
    this.setState({ status: "starting", mode: "local", launch, projectPath, message: null })

    let host: HostProcess
    this.launchedRenderer = this.deps.renderer?.()
    this.launchCancelled = false
    try {
      host = await this.launch({
        hostPath,
        projectDir: projectPath,
        renderer: this.launchedRenderer,
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
    const tunnel = this.tunnel
    if (tunnel) {
      // Only the tunnel is ours: no Shutdown is ever sent to a remote host (disconnect()), the connection and ssh are
      // just closed. No longer current: its exit is expected, not reported as the tunnel dying.
      this.tunnel = null
      this.deps.engine.close()
      tunnel.kill()
      await waitForExit(tunnel, this.stopGraceMs)
      return
    }
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

  /** The tunnel ended on its own (ssh died, the network dropped, the server ended the session) */
  private onTunnelExit(tunnel: TunnelHandle, exit: HostExit, label: string): void {
    if (tunnel !== this.tunnel) return
    this.tunnel = null
    this.deps.engine.close()
    this.deps.log?.(`The SSH tunnel to ${label} ${describeExit(exit)}`)
    this.setState({
      status: "exited",
      message: `The SSH tunnel to ${label} ${describeExit(exit)}${tunnel.lastOutput}`,
    })
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
