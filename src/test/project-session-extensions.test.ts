import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { ConnectionState, ExtensionTrustState, HostState } from "../shared/api"
import type { HostExit, HostProcess, LaunchOptions } from "../main/host-launcher"
import { NoExtensionLaunch, type ExtensionLaunch } from "../main/extension-trust"
import { ExtensionGate, ProjectSession } from "../main/project-session"
import type { TunnelHandle } from "../main/project-session"

class FakeHost {
  killed = 0
  exitInfo: HostExit | null = null
  private listeners: Array<(exit: HostExit) => void> = []
  pid = 7
  lastOutput = ""
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
    const exit: HostExit = { code: null, signal: "SIGTERM" }
    if (this.exitInfo) return
    this.exitInfo = exit
    this.listeners.splice(0).forEach((l) => l(exit))
    this.options.onExit?.(exit, this as unknown as HostProcess)
  }
}

const state = (files: string[], trusted: boolean, enabled: boolean): ExtensionTrustState => ({ files, more: 0, trusted, enabled })

/** A gate that answers as the test says and records what it was asked */
function fakeGate() {
  const calls: string[] = []
  const gate = {
    forOpenAnswer: { flag: false, state: null } as ExtensionLaunch,
    forRestartAnswer: { flag: false, state: null } as ExtensionLaunch,
    enableAnswer: null as ExtensionLaunch | null,
    revokeAnswer: null as ExtensionTrustState | null,
    revokeArgs: [] as Array<[string, boolean]>,
    async forOpen(dir: string): Promise<ExtensionLaunch> {
      calls.push(`open ${dir}`)
      return gate.forOpenAnswer
    },
    forRestart(dir: string): ExtensionLaunch {
      calls.push(`restart ${dir}`)
      return gate.forRestartAnswer
    },
    async enable(dir: string): Promise<ExtensionLaunch | null> {
      calls.push(`enable ${dir}`)
      return gate.enableAnswer
    },
    revoke(dir: string, running: boolean): ExtensionTrustState | null {
      calls.push(`revoke ${dir}`)
      gate.revokeArgs.push([dir, running])
      return gate.revokeAnswer
    },
  }
  return { gate: gate satisfies ExtensionGate, calls }
}

function setup(gate?: ExtensionGate) {
  const states: HostState[] = []
  const launches: LaunchOptions[] = []
  const hosts: FakeHost[] = []
  let root: string | null = null
  const connections: number[] = []
  const session = new ProjectSession({
    files: {
      open: (dir: string) => (root = `real:${dir}`),
      close: () => {
        root = null
      },
      get rootPath() {
        return root
      },
    },
    recent: { add: () => {} },
    settings: { require: () => "N2EditorHost", readyTimeoutMs: () => 1000 },
    engine: {
      connectTo: async (port: number): Promise<ConnectionState> => {
        connections.push(port)
        return { connected: true, epoch: connections.length, serverInfo: null }
      },
      disconnect: () => {},
      close: () => {},
    },
    publish: (s) => states.push(s),
    launch: async (options) => {
      launches.push(options)
      const host = new FakeHost(5000 + launches.length, `t${launches.length}`, options)
      hosts.push(host)
      return host as unknown as HostProcess
    },
    openTunnel: async () => ({ localPort: 6000, exit: null, pid: 1, lastOutput: "", onExit: () => {}, kill: () => {} }) as TunnelHandle,
    probe: async () => ({ create: false }),
    ...(gate ? { extensions: gate } : {}),
  })
  return { session, states, launches, hosts, connections }
}

describe("ProjectSession and editor extensions", () => {
  test("without a gate no host ever gets the flag, and the state has no extension key", async () => {
    const { session, launches, states } = setup()
    await session.openProject("C:\\A")
    await session.restartHost()
    assert.equal(launches.length, 2)
    for (const launch of launches) assert.ok(!("editorExtensions" in launch), "the option is absent, not just false")
    for (const s of states) assert.ok(!("extensionTrust" in s))
  })

  test("opening asks the gate with the real folder, and the flag follows its answer", async () => {
    const { gate, calls } = fakeGate()
    gate.forOpenAnswer = { flag: true, state: state(["a.lua"], true, true) }
    const { session, launches, states } = setup(gate)
    await session.openProject("C:\\A")
    assert.deepEqual(calls, ["open real:C:\\A"])
    assert.equal(launches[0].editorExtensions, true)
    assert.equal(launches[0].projectDir, "real:C:\\A")
    assert.deepEqual(session.state.extensionTrust, state(["a.lua"], true, true))
    assert.deepEqual(states[0].extensionTrust, state(["a.lua"], true, true), "published with the starting state")
  })

  test("Not now: no flag, and the state says the extensions are not trusted (the banner's reason)", async () => {
    const { gate } = fakeGate()
    gate.forOpenAnswer = { flag: false, state: state(["a.lua"], false, false) }
    const { session, launches } = setup(gate)
    await session.openProject("C:\\A")
    assert.ok(!("editorExtensions" in launches[0]))
    assert.deepEqual(session.state.extensionTrust, state(["a.lua"], false, false))
  })

  test("a project with no extensions has no extension state", async () => {
    const { gate } = fakeGate()
    const { session } = setup(gate)
    await session.openProject("C:\\A")
    assert.ok(!("extensionTrust" in session.state))
  })

  test("a restart asks nothing new: it uses the gate's restart answer", async () => {
    const { gate, calls } = fakeGate()
    gate.forOpenAnswer = { flag: false, state: state(["a.lua"], false, false) }
    gate.forRestartAnswer = { flag: true, state: state(["a.lua"], true, true) }
    const { session, launches } = setup(gate)
    await session.openProject("C:\\A")
    await session.restartHost()
    assert.deepEqual(calls, ["open real:C:\\A", "restart real:C:\\A"])
    assert.ok(!("editorExtensions" in launches[0]))
    assert.equal(launches[1].editorExtensions, true)
  })

  test("another project is decided on its own; its state replaces the first's", async () => {
    const { gate, calls } = fakeGate()
    gate.forOpenAnswer = { flag: true, state: state(["a.lua"], true, true) }
    const { session, launches } = setup(gate)
    await session.openProject("A")
    gate.forOpenAnswer = NoExtensionLaunch
    await session.openProject("B")
    assert.deepEqual(calls, ["open real:A", "open real:B"])
    assert.equal(launches[0].editorExtensions, true)
    assert.ok(!("editorExtensions" in launches[1]), "B does not inherit A's flag")
    assert.ok(!("extensionTrust" in session.state))
  })

  test("a remote engine never gets the flag, never asks the gate, and clears the extension state", async () => {
    const { gate, calls } = fakeGate()
    gate.forOpenAnswer = { flag: true, state: state(["a.lua"], true, true) }
    const { session, launches } = setup(gate)
    await session.openProject("A")
    await session.connectRemote({ target: "me@host", hostPort: 9000 }, "tok")
    assert.equal(launches.length, 1, "no host was launched for the remote")
    assert.deepEqual(calls, ["open real:A"])
    assert.ok(!("extensionTrust" in session.state))
    await assert.rejects(session.enableExtensions(), /operator/)
    await assert.rejects(session.forgetExtensionTrust(), /remote/)
    assert.deepEqual(calls, ["open real:A"])
  })

  test("closing the project clears the extension state", async () => {
    const { gate } = fakeGate()
    gate.forOpenAnswer = { flag: true, state: state(["a.lua"], true, true) }
    const { session } = setup(gate)
    await session.openProject("A")
    await session.closeProject()
    assert.ok(!("extensionTrust" in session.state))
  })

  test("enableExtensions: Not now changes nothing and starts no host", async () => {
    const { gate } = fakeGate()
    gate.forOpenAnswer = { flag: false, state: state(["a.lua"], false, false) }
    const { session, launches, hosts } = setup(gate)
    await session.openProject("A")
    assert.equal(await session.enableExtensions(), false)
    assert.equal(launches.length, 1)
    assert.equal(hosts[0].killed, 0)
    assert.deepEqual(session.state.extensionTrust, state(["a.lua"], false, false))
  })

  test("enableExtensions: Trust restarts the host with the flag", async () => {
    const { gate, calls } = fakeGate()
    gate.forOpenAnswer = { flag: false, state: state(["a.lua"], false, false) }
    gate.enableAnswer = { flag: true, state: state(["a.lua"], true, true) }
    const { session, launches, hosts } = setup(gate)
    await session.openProject("A")
    assert.equal(await session.enableExtensions(), true)
    assert.deepEqual(calls, ["open real:A", "enable real:A"])
    assert.equal(launches.length, 2)
    assert.equal(hosts[0].killed, 1, "the old host was stopped")
    assert.equal(launches[1].editorExtensions, true)
    assert.deepEqual(session.state.extensionTrust, state(["a.lua"], true, true))
  })

  test("enableExtensions with no project open is an error and asks nothing", async () => {
    const { gate, calls } = fakeGate()
    const { session } = setup(gate)
    await assert.rejects(session.enableExtensions(), /No project is open/)
    assert.deepEqual(calls, [])
  })

  test("forgetExtensionTrust revokes the open folder, says whether the running host still has them, and publishes", async () => {
    const { gate, calls } = fakeGate()
    gate.forOpenAnswer = { flag: true, state: state(["a.lua"], true, true) }
    gate.revokeAnswer = state(["a.lua"], false, true)
    const { session, states } = setup(gate)
    await session.openProject("A")
    const before = states.length
    await session.forgetExtensionTrust()
    assert.deepEqual(calls, ["open real:A", "revoke real:A"])
    assert.deepEqual(gate.revokeArgs, [["real:A", true]], "the host is running with the flag")
    assert.deepEqual(session.state.extensionTrust, state(["a.lua"], false, true))
    assert.equal(states.length, before + 1)
  })

  test("forgetExtensionTrust of a host that runs without the flag says so", async () => {
    const { gate } = fakeGate()
    gate.forOpenAnswer = { flag: false, state: state(["a.lua"], false, false) }
    const { session } = setup(gate)
    await session.openProject("A")
    await session.forgetExtensionTrust()
    assert.deepEqual(gate.revokeArgs, [["real:A", false]])
  })
})
