import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { ConnectionState, HostState } from "../shared/api"
import type { CreateOptions, HostExit, HostProcess, LaunchOptions } from "../main/host-launcher"
import { EngineConnection, ProjectSession } from "../main/project-session"

/** The HostProcess surface ProjectSession uses */
class FakeHost {
  killed = 0
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
  onExit(listener: (exit: HostExit) => void): void {
    if (this.exitInfo) listener(this.exitInfo)
    else this.listeners.push(listener)
  }
  kill(): void {
    this.killed++
    this.exit({ code: null, signal: "SIGTERM" })
  }
  /** The process ends */
  exit(exit: HostExit): void {
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
  /** Called on disconnect (Shutdown): an --exit-on-disconnect host exits */
  onDisconnect: (() => void) | null = null

  async connectTo(port: number, token: string): Promise<ConnectionState> {
    this.connections.push([port, token])
    if (this.failNext) {
      const message = this.failNext
      this.failNext = null
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

function setup() {
  const states: HostState[] = []
  const launches: LaunchOptions[] = []
  const hosts: FakeHost[] = []
  const creates: CreateOptions[] = []
  const recent: string[] = []
  let root: string | null = null
  let hostPath: string | null = "C:\\engine\\N2EditorHost.exe"
  const engine = new FakeEngine()
  let failLaunch: string | null = null

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
    },
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
    setHostPath: (p: string | null) => (hostPath = p),
    failLaunch: (message: string | null) => (failLaunch = message),
  }
}

const statuses = (states: HostState[]) => states.map((s) => s.status)

describe("ProjectSession", () => {
  test("opening a project launches a host for it, connects with its port and token, and remembers it", async () => {
    const { session, engine, states, launches, recent } = setup()
    const opened = await session.openProject("C:\\Games\\A")
    assert.equal(opened, "real:C:\\Games\\A")
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
    hosts[0].exit({ code: 3, signal: null })
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
    engine.onDisconnect = () => hosts[0].exit({ code: 0, signal: null })
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
    await assert.rejects(opening, /SIGTERM/)
  })

  test("creating runs --create with the host, then opens the new project", async () => {
    const { session, creates, launches } = setup()
    const opened = await session.createProject("C:\\Games\\New")
    assert.equal(creates.length, 1)
    assert.equal(creates[0].hostPath, "C:\\engine\\N2EditorHost.exe")
    assert.match(creates[0].projectDir, /New$/)
    assert.equal(launches.length, 1)
    assert.equal(opened, "real:C:\\Games\\New")
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
