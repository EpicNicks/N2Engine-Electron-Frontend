// "Allow AI agent for this project" (MCP6): the switch, its per-project record, and the endpoint's lifecycle. Node only (no
// Electron): the engine, the dialog, the page and the clock are given in, so it is unit tested with fakes.
//
// The endpoint exists only while all of these hold: the switch is on for the open project, the project is a local one, the
// editor is connected to its host, and the editor may change the project (the host is not read-only and the role is not
// viewer). Each start makes a new secret and a new endpoint path and writes them to the discovery file (src/agent/discovery.ts,
// 0600); each stop closes the endpoint and the agent's connection and deletes that file. The record of which projects have
// the switch on is in the editor's user data (agent-projects.json), outside every project, so no project (and no agent) can
// write it; it is read at start, so the switch survives a restart of the editor but a secret never does.
import * as fs from "node:fs"
import * as path from "node:path"
import { InitialAgentState, type AgentState } from "../shared/api"
import { DiscoveryVersion, discoveryFile, listDiscoveries, newEndpointPath, newSecret, processAlive, removeDiscovery, writeDiscovery, projectKey } from "../agent/discovery"
import { AgentEndpoint, type AgentEngine, type ConfirmRequest } from "./agent-endpoint"
import { Multiplexer } from "./agent-mux"

/** The projects whose switch is on: a small JSON file in the user data folder, keyed by the project folder */
export class AgentProjectStore {
  constructor(private readonly file: string) {}

  private read(): Record<string, string> {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8")) as { version?: unknown; enabled?: unknown }
      if (value.version !== 1 || typeof value.enabled !== "object" || value.enabled === null) return {}
      const out: Record<string, string> = {}
      for (const [key, folder] of Object.entries(value.enabled)) if (/^[0-9a-f]{16}$/.test(key) && typeof folder === "string") out[key] = folder
      return out
    } catch {
      return {}
    }
  }

  isEnabled(projectPath: string): boolean {
    return projectKey(projectPath) in this.read()
  }

  set(projectPath: string, enabled: boolean): void {
    const all = this.read()
    const key = projectKey(projectPath)
    if (enabled) all[key] = projectPath
    else delete all[key]
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify({ version: 1, enabled: all }, null, 2), { mode: 0o600 })
  }
}

export interface AgentControllerDeps {
  store: Pick<AgentProjectStore, "isEnabled" | "set">
  /** The editor's user data folder: the discovery files go in its agent/ folder */
  userData: string
  engine: AgentEngine
  /** The open project's folder, or null */
  projectPath(): string | null
  /** The editor is connected to a remote engine (not a host of its own) */
  isRemote(): boolean
  /** Asks the page to settle its pending edits and end its edit groups (rejects when it cannot) */
  prepare(): Promise<void>
  /** The lane went back to the person after the agent changed the scene: the page looks again */
  changed(): void
  confirm(request: ConfirmRequest, signal: AbortSignal): Promise<boolean>
  publish(state: AgentState): void
  /** The size the person's page last set the viewport to */
  humanViewport(): { width: number; height: number } | null
  log?(message: string): void
  /** Tests: listen somewhere else, or use other limits */
  makeEndpoint?: (deps: ConstructorParameters<typeof AgentEndpoint>[0]) => AgentEndpoint
  endpointPath?: (userData: string) => { path: string; privateDir?: string }
  limits?: ConstructorParameters<typeof AgentEndpoint>[0]["limits"]
  mux?: { leaseIdleMs?: number; waitMs?: number }
}

export class AgentController {
  private state: AgentState = InitialAgentState
  private endpoint: AgentEndpoint | null = null
  private file: string | null = null
  private privateDir: string | null = null
  private startedFor: string | null = null
  /** Setting up the endpoint or taking it down: operations run one after another */
  private chain: Promise<void> = Promise.resolve()
  /** A lockout (too many wrong secrets) holds the endpoint down until the switch is turned off and on */
  private lockedOut = false
  private dirty = false
  private disposed = false
  private readonly mux: Multiplexer

  constructor(private readonly deps: AgentControllerDeps) {
    this.mux = new Multiplexer({
      prepare: () => deps.prepare(),
      expire: async () => {
        await this.endpoint?.endAgentWork()
      },
      released: () => {
        if (this.dirty) {
          this.dirty = false
          deps.changed()
        }
      },
      leaseIdleMs: deps.mux?.leaseIdleMs,
      waitMs: deps.mux?.waitMs,
      log: deps.log,
    })
    this.sweepStale()
  }

  /** The multiplexer: the main process sends the person's requests through it (EngineHost's gate) */
  get multiplexer(): Multiplexer {
    return this.mux
  }

  get current(): AgentState {
    return this.state
  }

  /** Files a crashed editor left behind (its process is gone) are removed; another running editor's are not */
  private sweepStale(): void {
    for (const { file, record } of listDiscoveries(this.deps.userData)) {
      if (record.pid !== process.pid && !processAlive(record.pid)) removeDiscovery(file)
    }
  }

  /** Why the switch cannot be on now, or null */
  private unavailableReason(): string | null {
    const project = this.deps.projectPath()
    if (project === null) return "Open a project first"
    if (this.deps.isRemote()) return "Not available for a remote engine: the agent works through a host this editor started"
    const info = this.deps.engine.serverInfo
    if (!this.deps.engine.isConnected || info === null) return "The editor is not connected to its host"
    if (info.readOnly) return "The editor is read-only (the host was started with --read-only)"
    if (info.role === "viewer" || (info.role !== "" && info.role !== "editor" && info.role !== "admin")) return "You are signed in as a viewer, who can look but not change anything"
    return null
  }

  /** Called whenever something the state depends on may have changed (a project opened, the connection, the switch) */
  refresh(): Promise<void> {
    const run = (): Promise<void> => this.reconcile()
    this.chain = this.chain.then(run, run)
    return this.chain
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) return
    const project = this.deps.projectPath()
    const enabled = project !== null && !this.deps.isRemote() && this.deps.store.isEnabled(project)
    const reason = this.unavailableReason()
    const shouldRun = enabled && reason === null && !this.lockedOut
    if (this.endpoint !== null && (!shouldRun || this.startedFor !== project)) await this.stopEndpoint()
    if (shouldRun && this.endpoint === null) await this.startEndpoint(project!)
    if (enabled && reason !== null && project !== null) this.writeStatusFile(project, reason)
    else if (!enabled && project !== null) removeDiscovery(discoveryFile(this.deps.userData, project))
    this.setState({
      available: reason === null,
      reason,
      enabled,
      listening: this.endpoint?.listening === true,
      connected: this.endpoint?.connected === true,
    })
  }

  private setState(next: AgentState): void {
    if (next.available === this.state.available && next.reason === this.state.reason && next.enabled === this.state.enabled && next.listening === this.state.listening && next.connected === this.state.connected) return
    this.state = next
    this.deps.publish(next)
  }

  private writeStatusFile(project: string, reason: string): void {
    try {
      writeDiscovery(discoveryFile(this.deps.userData, project), { version: DiscoveryVersion, projectPath: project, pid: process.pid, startedAt: new Date().toISOString(), reason })
    } catch (e) {
      this.deps.log?.(`could not write the agent status file: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async startEndpoint(project: string): Promise<void> {
    const secret = newSecret()
    const where = (this.deps.endpointPath ?? ((u) => newEndpointPath(u)))(this.deps.userData)
    this.privateDir = where.privateDir ?? null
    fs.mkdirSync(path.join(this.deps.userData, "agent"), { recursive: true, mode: 0o700 })
    const options: ConstructorParameters<typeof AgentEndpoint>[0] = {
      engine: this.deps.engine,
      mux: this.mux,
      secret,
      listenPath: where.path,
      confirm: this.deps.confirm,
      humanViewport: this.deps.humanViewport,
      limits: this.deps.limits,
      log: this.deps.log,
      onConnection: () => void this.refresh(),
      onChanged: () => {
        this.dirty = true
      },
      onLockout: () => {
        this.lockedOut = true
        void this.refresh()
      },
    }
    const endpoint = this.deps.makeEndpoint ? this.deps.makeEndpoint(options) : new AgentEndpoint(options)
    try {
      await endpoint.start()
    } catch (e) {
      this.deps.log?.(`the agent endpoint could not start: ${e instanceof Error ? e.message : String(e)}`)
      this.cleanupPrivateDir()
      return
    }
    const file = discoveryFile(this.deps.userData, project)
    try {
      writeDiscovery(file, { version: DiscoveryVersion, projectPath: project, endpoint: where.path, secret, pid: process.pid, startedAt: new Date().toISOString() })
    } catch (e) {
      this.deps.log?.(`could not write the agent secret file: ${e instanceof Error ? e.message : String(e)}`)
      endpoint.shutdown()
      this.cleanupPrivateDir()
      return
    }
    this.endpoint = endpoint
    this.file = file
    this.startedFor = project
    this.deps.log?.("the AI agent endpoint is listening")
  }

  private async stopEndpoint(): Promise<void> {
    const endpoint = this.endpoint
    const file = this.file
    this.endpoint = null
    this.file = null
    this.startedFor = null
    // The secret goes first: nothing can connect with it from here on
    if (file) removeDiscovery(file)
    if (endpoint) await endpoint.stop().catch((e) => this.deps.log?.(`stopping the agent endpoint failed: ${e instanceof Error ? e.message : String(e)}`))
    this.cleanupPrivateDir()
  }

  private cleanupPrivateDir(): void {
    if (this.privateDir) {
      try {
        fs.rmSync(this.privateDir, { recursive: true, force: true })
      } catch {
        // best effort
      }
      this.privateDir = null
    }
  }

  /** The switch. Turning it off closes the endpoint and the agent's connection at once and deletes the secret file. */
  async setEnabled(enabled: boolean): Promise<AgentState> {
    const project = this.deps.projectPath()
    if (project === null) throw new Error("Open a project first")
    if (enabled) {
      const reason = this.unavailableReason() ?? (this.deps.isRemote() ? "Not available for a remote engine" : null)
      if (reason !== null) {
        await this.refresh()
        throw new Error(reason)
      }
    }
    this.deps.store.set(project, enabled)
    this.lockedOut = false
    await this.refresh()
    return this.state
  }

  /** The banner's button: the agent is dropped and the switch goes off, so its secret is revoked and nothing reconnects */
  async disconnectAgent(): Promise<AgentState> {
    const project = this.deps.projectPath()
    if (project !== null) this.deps.store.set(project, false)
    this.lockedOut = false
    await this.refresh()
    return this.state
  }

  /** Synchronous, final: the editor is quitting */
  dispose(): void {
    this.disposed = true
    const file = this.file
    this.file = null
    if (file) removeDiscovery(file)
    this.endpoint?.shutdown()
    this.endpoint = null
    this.cleanupPrivateDir()
  }
}
