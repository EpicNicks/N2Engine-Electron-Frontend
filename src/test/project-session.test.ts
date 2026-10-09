import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { ConnectionState, HostState } from "../shared/api"
import * as path from "node:path"
import {
  CreateOptions,
  CreateProjectError,
  HostExit,
  HostProcess,
  LaunchOptions,
  ProbeOptions,
} from "../main/host-launcher"
import { CancelledError, EngineConnection, ProjectSession, ProjectSessionDeps } from "../main/project-session"
import type { SshTunnel, TunnelOptions } from "../main/ssh-tunnel"

/** The HostProcess surface ProjectSession uses */
class FakeHost {
  killed = 0
  /** Ignores kill (a host that takes its time to die) */
  stubborn = false
  exitInfo: HostExit | null = null
  private listeners: Array<(exit: HostExit) => void> = []
  constructor(
    readonly port: number,
    readonly token: string,
    private readonly options: LaunchOptions
  ) {}
  pid = 99
  lastOutput = ":\nsome stderr"
  get exited(): boolean {
    return this.exitInfo !== null
  }
  get exit(): HostExit | null {
    return this.exitInfo
  }
  onExit(listener: (exit: HostExit) => void): void {
    if (this.exitInfo) listener(this.exitInfo)
    else this.listeners.push(listener)
  }
  kill(): void {
    this.killed++
    if (!this.stubborn) this.end({ code: null, signal: "SIGTERM" })
  }
  /** The process ends */
  end(exit: HostExit): void {
    if (this.exitInfo) return
    this.exitInfo = exit
    this.listeners.splice(0).forEach((l) => l(exit))
    this.options.onExit?.(exit, this as unknown as HostProcess)
  }
}

class FakeEngine implements EngineConnection {
  connections: Array<[number, string]> = []
  disconnects = 0
  closes = 0
  failNext: string | null = null
  /** Runs as connectTo fails (the host dies meanwhile, say) */
  onFail: (() => void) | null = null
  /** Called on disconnect (Shutdown): an --exit-on-disconnect host exits */
  onDisconnect: (() => void) | null = null

  async connectTo(port: number, token: string): Promise<ConnectionState> {
    this.connections.push([port, token])
    if (this.failNext) {
      const message = this.failNext
      this.failNext = null
      this.onFail?.()
      throw new Error(message)
    }
    return { connected: true, epoch: this.connections.length, serverInfo: null }
  }
  disconnect(): void {
    this.disconnects++
    this.onDisconnect?.()
  }
  close(): void {
    this.closes++
  }
}

function setup(overrides: Partial<ProjectSessionDeps> = {}) {
  const states: HostState[] = []
  const launches: LaunchOptions[] = []
  const hosts: FakeHost[] = []
  const creates: CreateOptions[] = []
  const recent: string[] = []
  let root: string | null = null
  let hostPath: string | null = "C:\\engine\\N2EditorHost.exe"
  const engine = new FakeEngine()
  let failLaunch: string | null = null
  /** What the host's --help says it can do: by default a host older than engine #90 (no --create, no projects) */
  const capabilities = { create: false }
  const probes: ProbeOptions[] = []
  /** Folders holding a project.n2proj */
  const projects = new Set<string>()
  const uuid = "8e0c3a8e-0b1f-4f5e-9d0e-3f6f1c7d2a10"

  const session = new ProjectSession({
    files: {
      open: (dir: string) => {
        if (dir.includes("missing")) throw new Error(`ENOENT: ${dir}`)
        root = `real:${dir}`
        return root
      },
      close: () => {
        root = null
      },
      get rootPath() {
        return root
      },
    },
    recent: { add: (p: string) => recent.unshift(p) },
    settings: {
      require: () => {
        if (hostPath === null) throw new Error("N2EditorHost isn't set")
        return hostPath
      },
      readyTimeoutMs: () => 1234,
    },
    engine,
    publish: (state) => states.push(state),
    launch: async (options) => {
      launches.push(options)
      if (failLaunch) throw new Error(failLaunch)
      const host = new FakeHost(5000 + launches.length, `token-${launches.length}`, options)
      hosts.push(host)
      return host as unknown as HostProcess
    },
    create: async (options) => {
      creates.push(options)
      projects.add(options.projectDir)
      return { projectId: uuid, startupScene: "res://scenes/Main.scene" }
    },
    probe: async (options) => {
      probes.push(options)
      return { ...capabilities }
    },
    isProject: (dir) => projects.has(dir),
    ...overrides,
  })

  return {
    session,
    engine,
    states,
    launches,
    hosts,
    creates,
    recent,
    getRoot: () => root,
    capabilities,
    probes,
    projects,
    setHostPath: (p: string | null) => (hostPath = p),
    failLaunch: (message: string | null) => (failLaunch = message),
  }
}

const statuses = (states: HostState[]) => states.map((s) => s.status)

describe("ProjectSession", () => {
  test("opening a project launches a host for it, connects with its port and token, and remembers it", async () => {
    const { session, engine, states, launches, recent } = setup()
    const opened = await session.openProject("C:\\Games\\A")
    assert.deepEqual(opened, { kind: "opened", path: "real:C:\\Games\\A" })
    assert.equal(launches[0].hostPath, "C:\\engine\\N2EditorHost.exe")
    assert.equal(launches[0].projectDir, "real:C:\\Games\\A")
    assert.equal(launches[0].readyTimeoutMs, 1234, "the ready timeout from settings.json")
    assert.deepEqual(engine.connections, [[5001, "token-1"]])
    assert.deepEqual(recent, ["real:C:\\Games\\A"])
    assert.deepEqual(statuses(states), ["starting", "running"])
    assert.equal(session.state.launch, 1)
    assert.equal(session.state.projectPath, "real:C:\\Games\\A")
    for (const state of states) assert.ok(!JSON.stringify(state).includes("token-1"))
  })

  test("opening another project kills the first host before launching the next", async () => {
    const { session, hosts, states } = setup()
    await session.openProject("A")
    await session.openProject("B")
    assert.equal(hosts[0].killed, 1)
    assert.equal(hosts[1].killed, 0)
    assert.equal(session.state.launch, 2)
    assert.equal(session.state.projectPath, "real:B")
    // The first host's exit was expected: not reported as a crash
    assert.ok(!statuses(states).includes("exited"))
  })

  test("without a host path, nothing is stopped or launched", async () => {
    const { session, launches, setHostPath, hosts } = setup()
    await session.openProject("A")
    setHostPath(null)
    await assert.rejects(session.openProject("B"), /isn't set/)
    assert.equal(launches.length, 1)
    assert.equal(hosts[0].killed, 0)
  })

  test("a host that fails to launch leaves no project open, and the state says why", async () => {
    const { session, failLaunch, getRoot, recent } = setup()
    failLaunch("N2EditorHost exited with code 1 before it was ready:\nProject folder not found")
    await assert.rejects(session.openProject("A"), /exited with code 1/)
    assert.equal(getRoot(), null)
    assert.deepEqual(recent, [])
    assert.equal(session.state.status, "failed")
    assert.match(session.state.message ?? "", /Project folder not found/)
  })

  test("a missing folder fails before anything launches", async () => {
    const { session, launches } = setup()
    await assert.rejects(session.openProject("missing"), /ENOENT/)
    assert.equal(launches.length, 0)
    assert.equal(session.state.status, "stopped")
  })

  test("a host that can't be connected to is killed", async () => {
    const { session, engine, hosts, getRoot } = setup()
    engine.failNext = "The editor host refused Hello: Invalid access token"
    await assert.rejects(session.openProject("A"), /Couldn't connect to N2EditorHost: .*Invalid access token/)
    assert.equal(hosts[0].killed, 1)
    assert.equal(getRoot(), null)
    assert.equal(session.state.status, "failed")
  })

  test("a host that exits on its own is reported, with its last output; restart launches a new one", async () => {
    const { session, hosts, engine, launches } = setup()
    await session.openProject("A")
    hosts[0].end({ code: 3, signal: null })
    assert.equal(session.state.status, "exited")
    assert.equal(session.state.message, "N2EditorHost exited with code 3:\nsome stderr")
    assert.ok(engine.closes > 0)

    await session.restartHost()
    assert.equal(launches.length, 2)
    assert.equal(launches[1].projectDir, "real:A")
    assert.equal(session.state.status, "running")
    assert.equal(session.state.launch, 2)
  })

  test("stop asks the host to shut down and doesn't kill one that exits", async () => {
    const { session, hosts, engine } = setup()
    await session.openProject("A")
    engine.onDisconnect = () => hosts[0].end({ code: 0, signal: null })
    await session.stopHost()
    assert.equal(engine.disconnects, 1)
    assert.equal(hosts[0].killed, 0)
    assert.equal(session.state.status, "stopped")
    assert.equal(session.projectPath, "real:A", "the project stays open")
  })

  test("closing the project kills the host and forgets the project", async () => {
    const { session, hosts, getRoot } = setup()
    await session.openProject("A")
    await session.closeProject()
    assert.equal(hosts[0].killed, 1)
    assert.equal(getRoot(), null)
    assert.deepEqual(
      { status: session.state.status, projectPath: session.state.projectPath },
      { status: "stopped", projectPath: null }
    )
  })

  test("killHost (quitting) kills a host still starting", async () => {
    const states: HostState[] = []
    let killedWhileStarting = 0
    let rejectLaunch: (e: Error) => void = () => {}
    const session = new ProjectSession({
      files: { open: (d: string) => d, close: () => {}, rootPath: null },
      recent: { add: () => {} },
      settings: { require: () => "host", readyTimeoutMs: () => 30000 },
      // No real N2EditorHost --help: a host older than engine #90
      probe: async () => ({ create: false }),
      engine: new FakeEngine(),
      publish: (s) => states.push(s),
      launch: (options) =>
        new Promise((_, reject) => {
          rejectLaunch = reject
          options.onSpawned?.(() => {
            killedWhileStarting++
            reject(new Error("N2EditorHost was ended by SIGTERM before it was ready"))
          })
        }),
    })
    const opening = session.openProject("A")
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(session.state.status, "starting")
    session.killHost()
    assert.equal(killedWhileStarting, 1)
    rejectLaunch(new Error("unused"))
    await assert.rejects(opening, CancelledError)
  })

  test("creating runs --create with the host and the name, then opens the new project", async () => {
    const { session, creates, launches, capabilities } = setup()
    capabilities.create = true
    const folder = path.resolve("Games", "New")
    const opened = await session.createProject(folder, { name: "My Game" })
    assert.equal(creates.length, 1)
    assert.equal(creates[0].hostPath, "C:\\engine\\N2EditorHost.exe")
    assert.equal(creates[0].projectDir, folder)
    assert.equal(creates[0].name, "My Game")
    assert.equal(creates[0].projectId, undefined, "a new project gets a new id")
    assert.equal(launches.length, 1)
    assert.deepEqual(opened, { kind: "opened", path: `real:${folder}` })
  })

  test("adopting a folder passes --project-id from-path, so its assets keep their UUIDs", async () => {
    const { session, creates } = setup()
    await session.createProject(path.resolve("Old"), { name: "", adopt: true })
    assert.equal(creates[0].projectId, "from-path")
    assert.equal(creates[0].name, undefined, "an empty name: the host uses the folder's")
  })

  test("a folder that already is a project (exit 2) is reported, not opened", async () => {
    const message = "C:\\Old already has a project.n2proj; nothing was changed"
    const { session, launches } = setup({
      create: async () => {
        throw new CreateProjectError("alreadyAProject", message)
      },
    })
    const result = await session.createProject(path.resolve("Old"))
    assert.deepEqual(result, { kind: "alreadyAProject", path: path.resolve("Old"), message })
    assert.equal(launches.length, 0)
  })

  test("other --create failures reject with the host's reason", async () => {
    const { session } = setup({
      create: async () => {
        throw new CreateProjectError("failed", "Couldn't create the project: Access is denied")
      },
    })
    await assert.rejects(session.createProject(path.resolve("New")), /Access is denied/)
  })

  test("with a host that has projects, a folder without project.n2proj isn't opened: no host starts", async () => {
    const { session, capabilities, launches, getRoot, projects } = setup()
    capabilities.create = true
    const folder = path.resolve("Plain")
    assert.deepEqual(await session.openProject(folder), {
      kind: "notAProject",
      path: folder,
      message: `${folder} isn't a project: it has no project.n2proj`,
    })
    assert.equal(launches.length, 0)
    assert.equal(getRoot(), null)

    projects.add(folder)
    assert.equal((await session.openProject(folder)).kind, "opened")
  })

  test("a host older than engine #90 opens any folder, as before", async () => {
    const { session, launches } = setup()
    assert.equal((await session.openProject(path.resolve("Plain"))).kind, "opened")
    assert.equal(launches.length, 1)
  })

  test("the host's own refusal (project.n2proj not found, exit 1) is reported as not a project", async () => {
    const { session, failLaunch, getRoot } = setup()
    failLaunch(
      "N2EditorHost exited with code 1 before it was ready:\nproject.n2proj not found: C:\\Plain is not a project"
    )
    const result = await session.openProject("C:\\Plain")
    assert.equal(result.kind, "notAProject")
    assert.match((result as { message: string }).message, /project.n2proj not found/)
    assert.equal(getRoot(), null)
    assert.equal(session.state.status, "stopped")
  })

  test("the host is asked what it can do once, with --help only", async () => {
    const { session, probes } = setup()
    await session.capabilities("C:\\engine\\N2EditorHost.exe")
    await session.openProject("A")
    await session.openProject("B")
    assert.equal(probes.length, 1)
    assert.equal(probes[0].hostPath, "C:\\engine\\N2EditorHost.exe")
  })

  test("operations run one at a time", async () => {
    const { session, launches } = setup()
    const a = session.openProject("A")
    const b = session.openProject("B")
    await Promise.all([a, b])
    assert.deepEqual(
      launches.map((l) => l.projectDir),
      ["real:A", "real:B"]
    )
    assert.equal(session.projectPath, "real:B")
  })
})

/** A launch that waits until the test settles it, or until it is killed */
function pendingLaunch() {
  const control = { kills: 0, spawned: false, options: null as LaunchOptions | null }
  const launch = (options: LaunchOptions) =>
    new Promise<HostProcess>((_, reject) => {
      control.spawned = true
      control.options = options
      options.onSpawned?.(() => {
        control.kills++
        reject(new Error("N2EditorHost was ended by SIGTERM before it was ready"))
      })
    })
  return { control, launch }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe("ProjectSession: a host that dies before Hello", () => {
  test("its exit code and last output explain the failure, not the closed connection", async () => {
    const { session, engine, hosts } = setup()
    engine.failNext = "Disconnected"
    engine.onFail = () => {
      hosts[0].lastOutput = ":\n[ERROR] Fatal error: out of memory"
      hosts[0].end({ code: 3, signal: null })
    }
    await assert.rejects(
      session.openProject("A"),
      (e: Error) =>
        e.message ===
        "N2EditorHost exited with code 3 before the editor could connect:\n[ERROR] Fatal error: out of memory"
    )
    assert.equal(session.state.status, "failed")
    assert.match(session.state.message ?? "", /exited with code 3/)
    assert.equal(hosts[0].killed, 0, "it was already gone")
  })
})

describe("ProjectSession: quitting, reloading, stopping and closing", () => {
  test("shutdown while the old host is still dying: the next host is never spawned", async () => {
    const { session, hosts, launches } = setup({ stopGraceMs: 30 })
    await session.openProject("A")
    hosts[0].stubborn = true
    const opening = session.openProject("B")
    await tick()
    // openProject(B) is in stopCurrent, waiting for host A to exit
    session.shutdown()
    await assert.rejects(opening, CancelledError)
    assert.equal(launches.length, 1, "nothing launched after shutdown")
  })

  test("a page reload while the old host is still dying: the queued open spawns nothing", async () => {
    const { session, hosts, launches, getRoot } = setup({ stopGraceMs: 30 })
    await session.openProject("A")
    hosts[0].stubborn = true
    const opening = session.openProject("B")
    await tick()
    const resetting = session.reset()
    await assert.rejects(opening, CancelledError)
    await resetting
    assert.equal(launches.length, 1)
    assert.equal(getRoot(), null)
    assert.equal(session.state.projectPath, null)
  })

  test("shutdown during --create kills the create child, and nothing is launched after it", async () => {
    let kills = 0
    let finish: () => void = () => {}
    const { session, launches } = setup({
      create: (options) =>
        new Promise((resolve, reject) => {
          finish = () => resolve({ projectId: "8e0c3a8e-0b1f-4f5e-9d0e-3f6f1c7d2a10", startupScene: null })
          options.onSpawned?.(() => {
            kills++
            reject(new Error("N2EditorHost --create was ended by SIGTERM"))
          })
        }),
    })
    const creating = session.createProject("C:\\Games\\New")
    await tick()
    session.shutdown()
    assert.equal(kills, 1)
    finish()
    await assert.rejects(creating, CancelledError)
    assert.equal(launches.length, 0)
    await assert.rejects(session.openProject("A"), CancelledError)
    assert.equal(launches.length, 0, "nothing spawns after shutdown")
  })

  test("closing while the host starts kills it at once, without waiting for the launch", async () => {
    const { control, launch } = pendingLaunch()
    const { session, getRoot } = setup({ launch })
    const opening = session.openProject("A")
    await tick()
    assert.equal(session.state.status, "starting")
    const closing = session.closeProject()
    assert.equal(control.kills, 1, "killed before the close joins the queue")
    await assert.rejects(opening, CancelledError)
    await closing
    assert.equal(getRoot(), null)
    assert.deepEqual(
      { status: session.state.status, projectPath: session.state.projectPath },
      { status: "stopped", projectPath: null }
    )
  })

  test("stopping while the host starts kills it at once; the project stays open", async () => {
    const { control, launch } = pendingLaunch()
    const { session } = setup({ launch })
    await assert.rejects(
      (async () => {
        const opening = session.openProject("A")
        await tick()
        const stopping = session.stopHost()
        assert.equal(control.kills, 1)
        await stopping
        return opening
      })(),
      CancelledError
    )
    assert.equal(session.state.status, "stopped")
  })
})

/** The SshTunnel surface ProjectSession uses */
class FakeTunnel {
  killed = 0
  exitInfo: HostExit | null = null
  pid = 555
  lastOutput = ":\nssh: connect to host cloud port 22: Connection refused"
  private listeners: Array<(exit: HostExit) => void> = []
  constructor(
    readonly localPort: number,
    private readonly options: TunnelOptions
  ) {}
  get exit(): HostExit | null {
    return this.exitInfo
  }
  onExit(listener: (exit: HostExit) => void): void {
    if (this.exitInfo) listener(this.exitInfo)
    else this.listeners.push(listener)
  }
  kill(): void {
    this.killed++
    this.end({ code: null, signal: "SIGTERM" })
  }
  end(exit: HostExit): void {
    if (this.exitInfo) return
    this.exitInfo = exit
    this.listeners.splice(0).forEach((l) => l(exit))
    this.options.onExit?.(exit, this as unknown as SshTunnel)
  }
}

const remote = { target: "dev@cloud", sshPort: 2222, hostPort: 7777 }

function remoteSetup(overrides: Partial<ProjectSessionDeps> = {}) {
  const tunnels: FakeTunnel[] = []
  const opened: TunnelOptions[] = []
  const remembered: unknown[] = []
  let failOpen: string | null = null
  const t = setup({
    openTunnel: async (options) => {
      opened.push(options)
      if (failOpen) throw new Error(failOpen)
      const tunnel = new FakeTunnel(40000 + opened.length, options)
      tunnels.push(tunnel)
      return tunnel as unknown as SshTunnel
    },
    recentRemotes: { add: (settings) => remembered.push(settings) },
    ...overrides,
  })
  return { ...t, tunnels, opened, remembered, failOpen: (m: string | null) => (failOpen = m) }
}

describe("ProjectSession remote mode", () => {
  test("connecting opens the tunnel, connects through its local port with the token, and remembers the remote", async () => {
    const { session, engine, states, tunnels, opened, remembered, launches, getRoot } = remoteSetup()
    const name = await session.connectRemote(remote, "s3cret-token")
    assert.equal(name, "dev@cloud:7777")
    assert.deepEqual(opened[0].settings, remote)
    assert.deepEqual(engine.connections, [[40001, "s3cret-token"]])
    assert.deepEqual(remembered, [remote])
    assert.equal(launches.length, 0, "no local host")
    assert.equal(getRoot(), null, "no local project")
    assert.deepEqual(statuses(states), ["starting", "running"])
    assert.equal(session.state.mode, "remote")
    assert.equal(session.state.projectPath, "dev@cloud:7777")
    assert.equal(session.isRemote, true)
    assert.equal(tunnels.length, 1)
    // The token is in nothing the page or the tunnel gets
    assert.ok(!JSON.stringify(states).includes("s3cret-token"))
    assert.ok(!JSON.stringify(opened[0]).includes("s3cret-token"))
    assert.ok(!Object.keys(opened[0]).includes("token"))
  })

  test("settings and token are checked before anything is stopped or opened", async () => {
    const { session, opened, hosts } = remoteSetup()
    await session.openProject("A")
    await assert.rejects(
      session.connectRemote({ target: "-oProxyCommand=x@y", hostPort: 1 }, "t"),
      /can't start with '-'/
    )
    await assert.rejects(session.connectRemote({ target: "a@b", hostPort: 0 }, "t"), /host's port/)
    await assert.rejects(session.connectRemote(remote, ""), /access token/)
    await assert.rejects(session.connectRemote(remote, 5), /access token/)
    assert.equal(opened.length, 0)
    assert.equal(hosts[0].killed, 0, "the local host is untouched")
    assert.equal(session.state.status, "running")
  })

  test("connecting from a local project stops that host first", async () => {
    const { session, hosts, getRoot } = remoteSetup()
    await session.openProject("A")
    await session.connectRemote(remote, "t")
    assert.equal(hosts[0].killed, 1)
    assert.equal(getRoot(), null)
    assert.equal(session.state.mode, "remote")
  })

  test("a tunnel that can't open fails with its message and leaves nothing open", async () => {
    const { session, failOpen, states, engine } = remoteSetup()
    failOpen("ssh exited with code 255 before the tunnel was up:\nPermission denied (publickey).")
    await assert.rejects(session.connectRemote(remote, "t"), /Permission denied/)
    assert.equal(session.state.status, "failed")
    assert.equal(session.state.mode, "local")
    assert.equal(session.state.projectPath, null)
    assert.match(session.state.message ?? "", /Permission denied/)
    assert.deepEqual(engine.connections, [])
    assert.deepEqual(statuses(states), ["starting", "failed"])
  })

  test("a host that refuses the connection closes the tunnel and says why, with ssh's stderr", async () => {
    const { session, engine, tunnels, remembered } = remoteSetup()
    engine.failNext = "The editor host refused Hello: Invalid access token"
    await assert.rejects(
      session.connectRemote(remote, "wrong"),
      /connecting to the host through it failed: .*Invalid access token/
    )
    assert.equal(tunnels[0].killed, 1)
    assert.equal(session.state.status, "failed")
    assert.match(session.state.message ?? "", /Connection refused/)
    assert.deepEqual(remembered, [], "a remote that didn't connect isn't remembered")
    assert.ok(!(session.state.message ?? "").includes("wrong"))
  })

  test("a tunnel that dies while connecting is reported as that", async () => {
    const { session, engine, tunnels } = remoteSetup()
    engine.failNext = "Connection closed"
    engine.onFail = () => tunnels[0].end({ code: 255, signal: null })
    await assert.rejects(
      session.connectRemote(remote, "t"),
      /SSH tunnel to dev@cloud:7777 exited with code 255 before the editor could connect/
    )
    assert.equal(session.state.status, "failed")
  })

  test("the tunnel dying later shows like a host exit, with ssh's stderr", async () => {
    const { session, engine, tunnels } = remoteSetup()
    await session.connectRemote(remote, "t")
    tunnels[0].end({ code: 255, signal: null })
    assert.equal(session.state.status, "exited")
    assert.equal(session.state.mode, "remote")
    assert.equal(
      session.state.message,
      "The SSH tunnel to dev@cloud:7777 exited with code 255:\nssh: connect to host cloud port 22: Connection refused"
    )
    assert.ok(engine.closes > 0)
  })

  test("closing the project closes the tunnel and never asks the remote host to shut down", async () => {
    const { session, engine, tunnels, states } = remoteSetup()
    await session.connectRemote(remote, "t")
    await session.closeProject()
    assert.equal(tunnels[0].killed, 1)
    assert.equal(engine.disconnects, 0, "no Shutdown is sent to a host that isn't the editor's")
    assert.deepEqual(
      { status: session.state.status, mode: session.state.mode, projectPath: session.state.projectPath },
      { status: "stopped", mode: "local", projectPath: null }
    )
    assert.ok(!statuses(states).includes("exited"), "the tunnel's end was expected")
  })

  test("connecting again replaces the tunnel without a Shutdown", async () => {
    const { session, engine, tunnels } = remoteSetup()
    await session.connectRemote(remote, "t")
    await session.connectRemote({ ...remote, hostPort: 7778 }, "t")
    assert.equal(tunnels[0].killed, 1)
    assert.equal(tunnels.length, 2)
    assert.equal(engine.disconnects, 0)
    assert.equal(session.state.projectPath, "dev@cloud:7778")
    assert.equal(session.state.launch, 2)
  })

  test("Start, Stop and Restart host are refused in remote mode", async () => {
    const { session, engine, tunnels, launches } = remoteSetup()
    await session.connectRemote(remote, "t")
    await assert.rejects(session.restartHost(), /can't restart a remote engine's host/)
    await assert.rejects(session.stopHost(), /can't stop a remote engine's host/)
    assert.equal(tunnels[0].killed, 0)
    assert.equal(engine.disconnects, 0)
    assert.equal(launches.length, 0)
    assert.equal(session.state.status, "running")
  })

  test("a page reload (reset) closes the tunnel", async () => {
    const { session, tunnels } = remoteSetup()
    await session.connectRemote(remote, "t")
    await session.reset()
    assert.equal(tunnels[0].killed, 1)
    assert.equal(session.state.projectPath, null)
  })

  test("killHost (quitting) ends the tunnel synchronously", async () => {
    const { session, tunnels } = remoteSetup()
    await session.connectRemote(remote, "t")
    session.killHost()
    assert.equal(tunnels[0].killed, 1)
  })

  test("closing while the tunnel opens kills it at once and the connect is cancelled", async () => {
    let kills = 0
    const { session, engine } = remoteSetup({
      openTunnel: (options) =>
        new Promise((_, reject) => {
          options.onSpawned?.(() => {
            kills++
            reject(new Error("ssh was ended by SIGTERM before the tunnel was up"))
          })
        }),
    })
    const connecting = session.connectRemote(remote, "t")
    await tick()
    assert.equal(session.state.status, "starting")
    const closing = session.closeProject()
    assert.equal(kills, 1, "killed before the close joins the queue")
    await assert.rejects(connecting, CancelledError)
    await closing
    assert.equal(engine.connections.length, 0)
    assert.equal(session.state.status, "stopped")
    assert.equal(session.state.projectPath, null)
  })

  test("shutdown is final: it kills the tunnel, and a queued or later connect opens nothing", async () => {
    const { session, tunnels, opened } = remoteSetup()
    await session.connectRemote(remote, "t")
    const again = session.connectRemote({ ...remote, hostPort: 7779 }, "t")
    session.shutdown()
    assert.equal(tunnels[0].killed, 1)
    await assert.rejects(again, CancelledError)
    await assert.rejects(session.connectRemote(remote, "t"), CancelledError)
    assert.equal(opened.length, 1, "nothing is opened after shutdown")
  })

  test("a tunnel that opens just as the editor quits is killed", async () => {
    let tunnel: FakeTunnel | null = null
    let release: () => void = () => {}
    const { session, engine } = remoteSetup({
      openTunnel: async (options) => {
        await new Promise<void>((resolve) => (release = resolve))
        return (tunnel = new FakeTunnel(40001, options)) as unknown as SshTunnel
      },
    })
    const connecting = session.connectRemote(remote, "t")
    await tick()
    session.shutdown()
    release()
    await assert.rejects(connecting, CancelledError)
    assert.equal(tunnel!.killed, 1)
    assert.equal(engine.connections.length, 0)
  })
})
