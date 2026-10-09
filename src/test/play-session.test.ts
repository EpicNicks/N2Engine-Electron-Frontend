import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import * as path from "node:path"
import type { PlayStateResponse } from "../protocol/protocol.generated"
import { GameEndedMessage, PlayState } from "../shared/api"
import { HostExit, HostProcess, LaunchOptions } from "../main/host-launcher"
import { CancelledError } from "../main/project-session"
import { PlayConnection, PlaySession, PlaySessionDeps, isInside, isSnapshotFile, playFailureReason } from "../main/play-session"

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** The HostProcess surface PlaySession uses */
class FakeChild {
  killed = 0
  /** Ignores kill (a child that takes its time to die) */
  stubborn = false
  exitInfo: HostExit | null = null
  pid = 77
  lastOutput = ""
  private listeners: Array<(exit: HostExit) => void> = []
  constructor(
    readonly port: number,
    readonly token: string,
    private readonly options: LaunchOptions
  ) {}
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
  end(exit: HostExit): void {
    if (this.exitInfo) return
    this.exitInfo = exit
    this.listeners.splice(0).forEach((l) => l(exit))
    this.options.onExit?.(exit, this as unknown as HostProcess)
  }
}

class FakeConnection implements PlayConnection {
  connected = false
  connects: Array<[string, number, string]> = []
  disconnects = 0
  closes = 0
  calls: string[] = []
  failConnect: string | null = null
  /** Called on disconnect (Shutdown): an --exit-on-disconnect child exits */
  onDisconnect: (() => void) | null = null
  playState: PlayStateResponse = { state: "Playing", frame: 0, time: 0 }
  private closeListeners: Array<() => void> = []
  get isConnected(): boolean {
    return this.connected
  }
  async connect(host: string, port: number, options: { token: string }): Promise<unknown> {
    this.connects.push([host, port, options.token])
    if (this.failConnect) throw new Error(this.failConnect)
    this.connected = true
    return {}
  }
  disconnect(): void {
    this.disconnects++
    this.end()
    this.onDisconnect?.()
  }
  close(): void {
    this.closes++
    this.end()
  }
  /** The connection ends (either side) */
  end(): void {
    if (!this.connected) return
    this.connected = false
    this.closeListeners.forEach((l) => l())
  }
  onClose(listener: () => void): void {
    this.closeListeners.push(listener)
  }
  async setPaused(paused: boolean): Promise<void> {
    this.calls.push(`setPaused ${paused}`)
    this.playState = { ...this.playState, state: paused ? "Paused" : "Playing" }
  }
  async step(frames: number): Promise<void> {
    this.calls.push(`step ${frames}`)
    this.playState = { ...this.playState, frame: this.playState.frame + frames }
  }
  async getPlayState(): Promise<PlayStateResponse> {
    this.calls.push("getPlayState")
    return this.playState
  }
  async renderFrame(): Promise<never> {
    throw new Error("not used")
  }
  async setViewportSize(): Promise<void> {}
  async getAudio(): Promise<null> {
    return null
  }
  async pollEvents(): Promise<never> {
    throw new Error("not used")
  }
  async sendInput(): Promise<void> {}
}

const Project = path.resolve("proj")
const Snapshot = path.join(Project, ".n2", "play", "Main-1a2b3c4d.scene")

function setup(overrides: Partial<PlaySessionDeps> = {}) {
  const states: PlayState[] = []
  const launches: LaunchOptions[] = []
  const children: FakeChild[] = []
  const connections: FakeConnection[] = []
  const snapshots: string[] = []
  const removed: string[] = []
  const editor = { isConnected: true, snapshotFile: Snapshot, failSnapshot: null as string | null }
  const hooks = {
    failLaunch: null as string | null,
    connect: null as ((c: FakeConnection, child: FakeChild) => void) | null,
    /** Awaited before the snapshot answers (a stop while it is written) */
    snapshotGate: null as Promise<void> | null,
    launchGate: null as Promise<void> | null,
  }
  let project: string | null = Project

  const session = new PlaySession({
    editor: {
      get isConnected() {
        return editor.isConnected
      },
      writePlaySnapshot: async (scenePath) => {
        snapshots.push(scenePath)
        await hooks.snapshotGate
        if (editor.failSnapshot) throw new Error(editor.failSnapshot)
        return editor.snapshotFile
      },
    },
    projectPath: () => project,
    hostPath: () => "C:\\engine\\N2EditorHost.exe",
    renderer: () => "software",
    readyTimeoutMs: () => 4321,
    createConnection: () => {
      const connection = new FakeConnection()
      connections.push(connection)
      const child = children[children.length - 1]
      // Shutdown on the connection ends the child, as --exit-on-disconnect does
      connection.onDisconnect = () => child?.end({ code: 0, signal: null })
      hooks.connect?.(connection, child)
      return connection
    },
    publish: (state) => states.push(state),
    launch: async (options) => {
      launches.push(options)
      await hooks.launchGate
      if (hooks.failLaunch) throw new Error(hooks.failLaunch)
      const child = new FakeChild(6000 + launches.length, `token-${launches.length}`, options)
      children.push(child)
      return child as unknown as HostProcess
    },
    removeFile: async (file) => {
      removed.push(file)
    },
    stopGraceMs: 30,
    ...overrides,
  })
  return {
    session,
    states,
    launches,
    children,
    connections,
    snapshots,
    removed,
    editor,
    hooks,
    setProject: (p: string | null) => (project = p),
    statuses: () => states.map((s) => s.status),
  }
}

describe("PlaySession", () => {
  test("a remote engine can not be played: refused with the reason, before a snapshot or a child", async () => {
    const t = setup({ unavailable: () => "Play mode needs a local engine" })
    await assert.rejects(t.session.start(), /Play mode needs a local engine/)
    assert.deepEqual(t.snapshots, [])
    assert.equal(t.launches.length, 0)
    assert.equal(t.session.state.status, "stopped")
    assert.deepEqual(t.statuses(), [])
  })

  test("starts: snapshot from the open scene, a child with the edit host's project and renderer, a second connection", async () => {
    const t = setup()
    await t.session.start()
    assert.deepEqual(t.snapshots, [""])
    assert.equal(t.launches.length, 1)
    const launch = t.launches[0]
    assert.equal(launch.playFile, Snapshot)
    assert.equal(launch.projectDir, Project)
    assert.equal(launch.renderer, "software")
    assert.equal(launch.hostPath, "C:\\engine\\N2EditorHost.exe")
    assert.equal(launch.readyTimeoutMs, 4321)
    assert.deepEqual(t.connections[0].connects, [["127.0.0.1", 6001, "token-1"]])
    assert.deepEqual(t.statuses(), ["starting", "playing"])
    assert.equal(t.session.state.status, "playing")
    assert.equal(t.session.state.launch, 1)
  })

  test("a child that starts paused is shown as paused", async () => {
    const t = setup()
    t.hooks.connect = (c) => (c.playState = { state: "Paused", frame: 3, time: 0.06 })
    await t.session.start()
    assert.equal(t.session.state.status, "paused")
    assert.equal(t.session.state.frame, 3)
  })

  test("the snapshot is removed once the child is up, but only from the project's .n2 folder", async () => {
    const t = setup()
    await t.session.start()
    await turn()
    assert.deepEqual(t.removed, [Snapshot])

    const u = setup()
    u.editor.snapshotFile = path.resolve("elsewhere", "Main.scene")
    await u.session.start()
    await turn()
    assert.deepEqual(u.removed, [])
  })

  test("isInside", () => {
    assert.equal(isInside("/a/.n2", "/a/.n2/play/x.scene"), true)
    assert.equal(isInside("/a/.n2", "/a/other.scene"), false)
    assert.equal(isInside("/a/.n2", "/a/.n2/../x"), false)
    assert.equal(isInside("/a/.n2", "/a/.n2"), false)
  })

  test("only a .scene directly in <project>/.n2/play is a snapshot", () => {
    assert.equal(isSnapshotFile(Project, Snapshot), true)
    assert.equal(isSnapshotFile(Project, path.join(Project, ".n2", "play", "nested", "x.scene")), false)
    assert.equal(isSnapshotFile(Project, path.join(Project, ".n2", "play", "x.lua")), false)
    assert.equal(isSnapshotFile(Project, path.join(Project, ".n2", "autosave", "x.scene")), false)
    assert.equal(isSnapshotFile(Project, path.join(Project, "assets", "Main.scene")), false)
  })

  test("a snapshot is removed when the start fails or is cancelled before the child is up", async () => {
    const t = setup()
    t.hooks.failLaunch = "N2EditorHost exited with code 1 before it was ready"
    await assert.rejects(t.session.start())
    await turn()
    assert.deepEqual(t.removed, [Snapshot])

    const u = setup()
    let release!: () => void
    u.hooks.launchGate = new Promise((resolve) => (release = resolve))
    const started = u.session.start()
    started.catch(() => {})
    await turn()
    const stopped = u.session.stop()
    release()
    await stopped
    await assert.rejects(started, CancelledError)
    await turn()
    assert.deepEqual(u.removed, [Snapshot])
  })

  test("the edit host closing while the snapshot is written is a cancellation, not a failure", async () => {
    const t = setup()
    let fail!: () => void
    t.hooks.snapshotGate = new Promise((_, reject) => (fail = () => reject(new Error("Connection closed"))))
    const started = t.session.start()
    started.catch(() => {})
    await turn()
    const stopped = t.session.stop("The editor host's connection ended")
    fail()
    await stopped
    await assert.rejects(started, /^CancelledError: Cancelled:/)
  })

  test("a child that never answers after Hello fails the start instead of staying Starting", async () => {
    const t = setup({ requestTimeoutMs: 20 })
    t.hooks.connect = (c) => (c.getPlayState = () => new Promise(() => {}))
    await assert.rejects(t.session.start(), /didn't answer within/)
    assert.equal(t.session.state.status, "failed")
    assert.equal(t.children[0].killed, 1)
  })

  test("shutdown kills a child that is still being stopped", async () => {
    const t = setup({ stopGraceMs: 500 })
    await t.session.start()
    t.connections[0].onDisconnect = null // ignores Shutdown
    const stopping = t.session.stop()
    await turn()
    assert.equal(t.children[0].killed, 0)
    t.session.shutdown()
    assert.equal(t.children[0].killed, 1)
    await stopping
  })

  test("a snapshot that can't be written fails the start, and no child is launched", async () => {
    const t = setup()
    t.editor.failSnapshot = "No scene is open"
    await assert.rejects(t.session.start(), /Couldn't write the play snapshot: No scene is open/)
    assert.equal(t.launches.length, 0)
    assert.equal(t.session.state.status, "failed")
    assert.match(t.session.state.message ?? "", /No scene is open/)
    // It can be tried again
    t.editor.failSnapshot = null
    await t.session.start()
    assert.equal(t.session.state.status, "playing")
  })

  test("a snapshot the child refuses shows its reason, not the launcher's wrapping", async () => {
    const t = setup()
    t.hooks.failLaunch =
      "N2EditorHost exited with code 1 before it was ready:\nN2EditorHost --play: scene.scene is not a scene"
    await assert.rejects(t.session.start(), /Couldn't start the game: scene\.scene is not a scene/)
    assert.equal(t.session.state.status, "failed")
    assert.equal(t.session.state.message, "Couldn't start the game: scene.scene is not a scene")
  })

  test("playFailureReason", () => {
    assert.equal(
      playFailureReason("N2EditorHost exited with code 1 before it was ready:\nN2EditorHost --play: bad"),
      "bad"
    )
    assert.equal(playFailureReason("timed out"), "timed out")
  })

  test("no project, or no edit host connection: refused before anything is written", async () => {
    const t = setup()
    t.setProject(null)
    await assert.rejects(t.session.start(), /No project is open/)
    t.setProject(Project)
    t.editor.isConnected = false
    await assert.rejects(t.session.start(), /isn't connected/)
    assert.deepEqual(t.snapshots, [])
    assert.deepEqual(t.states, [])
  })

  test("a second start while one runs is refused", async () => {
    const t = setup()
    await t.session.start()
    await assert.rejects(t.session.start(), /already running/)
    assert.equal(t.launches.length, 1)
  })

  test("a connection that fails kills the child and reports why", async () => {
    const t = setup()
    t.hooks.connect = (c) => (c.failConnect = "refused")
    await assert.rejects(t.session.start(), /Couldn't connect to the game: refused/)
    assert.equal(t.children[0].killed, 1)
    assert.equal(t.session.state.status, "failed")
  })

  test("a child that died before Hello says so, with its output", async () => {
    const t = setup()
    t.hooks.connect = (c, child) => {
      c.failConnect = "Connection closed"
      child.lastOutput = ":\nsegfault"
      child.end({ code: 3, signal: null })
    }
    await assert.rejects(t.session.start(), /exited with code 3 before the editor could connect:\nsegfault/)
    assert.equal(t.session.state.status, "failed")
  })

  test("a child that crashes while playing is exited, with its code and output", async () => {
    const t = setup()
    await t.session.start()
    t.children[0].lastOutput = ":\nLua: boom"
    t.children[0].end({ code: 139, signal: null })
    const state = t.session.state
    assert.equal(state.status, "exited")
    assert.match(state.message ?? "", /exited with code 139:\nLua: boom/)
    assert.equal(t.connections[0].closes, 1)
    // The editor can play again
    await t.session.start()
    assert.equal(t.session.state.status, "playing")
    assert.equal(t.session.state.launch, 2)
  })

  test("a game that quits itself (exit code 0) is exited without a failure message", async () => {
    const t = setup()
    await t.session.start()
    t.children[0].end({ code: 0, signal: null })
    assert.equal(t.session.state.status, "exited")
    assert.equal(t.session.state.message, GameEndedMessage)
  })

  test("stop: Shutdown on the connection, then waits for the child to exit, without a kill", async () => {
    const t = setup()
    await t.session.start()
    await t.session.stop()
    assert.equal(t.connections[0].disconnects, 1)
    assert.equal(t.children[0].killed, 0)
    assert.equal(t.session.state.status, "stopped")
    // The expected exit is no crash
    assert.deepEqual(t.statuses(), ["starting", "playing", "stopped"])
  })

  test("stop: a child that ignores Shutdown is killed after the grace period", async () => {
    const t = setup()
    await t.session.start()
    t.connections[0].onDisconnect = null // Shutdown doesn't end it
    await t.session.stop()
    assert.equal(t.connections[0].disconnects, 1)
    assert.equal(t.children[0].killed, 1)
    assert.equal(t.children[0].exited, true)
  })

  test("stop with nothing running is no error and publishes nothing", async () => {
    const t = setup()
    await t.session.stop()
    assert.deepEqual(t.states, [])
  })

  test("stop after a crash goes back to stopped", async () => {
    const t = setup()
    await t.session.start()
    t.children[0].end({ code: 1, signal: null })
    await t.session.stop()
    assert.equal(t.session.state.status, "stopped")
  })

  test("stop with a reason (the edit host went away) keeps it as the message", async () => {
    const t = setup()
    await t.session.start()
    await t.session.stop("The editor host's connection ended")
    assert.equal(t.session.state.status, "stopped")
    assert.equal(t.session.state.message, "The editor host's connection ended")
  })

  test("stop while the snapshot is being written: the start is cancelled and no child is launched", async () => {
    const t = setup()
    let release!: () => void
    t.hooks.snapshotGate = new Promise((resolve) => (release = resolve))
    const started = t.session.start()
    started.catch(() => {})
    await turn()
    assert.equal(t.session.state.status, "starting")
    const stopped = t.session.stop()
    release()
    await stopped
    await assert.rejects(started, CancelledError)
    assert.equal(t.launches.length, 0)
    assert.equal(t.session.state.status, "stopped")
  })

  test("stop while the child is starting kills it", async () => {
    const t = setup()
    let release!: () => void
    t.hooks.launchGate = new Promise((resolve) => (release = resolve))
    const started = t.session.start()
    started.catch(() => {})
    await turn()
    const stopped = t.session.stop()
    release()
    await stopped
    await assert.rejects(started, CancelledError)
    assert.equal(t.children[0].killed, 1)
    assert.equal(t.connections.length, 0)
    assert.equal(t.session.state.status, "stopped")
    // And a later start works
    t.hooks.launchGate = null
    await t.session.start()
    assert.equal(t.session.state.status, "playing")
  })

  test("shutdown kills the child at once and nothing starts after it", async () => {
    const t = setup()
    await t.session.start()
    t.session.shutdown()
    assert.equal(t.children[0].killed, 1)
    assert.equal(t.connections[0].closes >= 1, true)
    await assert.rejects(t.session.start(), CancelledError)
  })

  test("pause, resume and step read the state back", async () => {
    const t = setup()
    await t.session.start()
    await t.session.setPaused(true)
    assert.equal(t.session.state.status, "paused")
    await t.session.step(5)
    assert.equal(t.session.state.frame, 5)
    assert.deepEqual(t.connections[0].calls.filter((c) => c !== "getPlayState"), ["setPaused true", "step 5"])
    await t.session.setPaused(false)
    assert.equal(t.session.state.status, "playing")
  })

  test("step needs a paused game and 1 to 1000 frames", async () => {
    const t = setup()
    await t.session.start()
    await assert.rejects(t.session.step(1), /paused game/)
    await t.session.setPaused(true)
    await assert.rejects(t.session.step(0), /1 to 1000/)
    await assert.rejects(t.session.step(1001), /1 to 1000/)
    await assert.rejects(t.session.step(1.5), /1 to 1000/)
    await t.session.step(1000)
    assert.equal(t.session.state.frame, 1000)
  })

  test("commands with no game running are refused", async () => {
    const t = setup()
    assert.throws(() => t.session.client, /No game is running/)
    await assert.rejects(t.session.setPaused(true), /No game is running/)
    // refresh with no game is no error
    assert.equal((await t.session.refresh()).status, "stopped")
  })

  test("refresh follows a game that paused itself, and publishes only changes", async () => {
    const t = setup()
    await t.session.start()
    const before = t.states.length
    await t.session.refresh()
    assert.equal(t.states.length, before, "nothing changed")
    t.connections[0].playState = { state: "Paused", frame: 9, time: 0.18 }
    await t.session.refresh()
    assert.equal(t.session.state.status, "paused")
    assert.equal(t.states.length, before + 1)
  })

  test("the token never appears in the state", async () => {
    const t = setup()
    await t.session.start()
    assert.doesNotMatch(JSON.stringify(t.states), /token-/)
  })
})
