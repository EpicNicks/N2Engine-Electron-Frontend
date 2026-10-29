import { test, describe, after } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AgentController, AgentProjectStore } from "../main/agent-controller"
import { PrepareChannel } from "../main/agent-prepare"
import { agentDirectory, defaultUserData, discoveryFile, listDiscoveries, newEndpointPath, projectKey, readDiscovery, removeDiscovery, writeDiscovery } from "../agent/discovery"
import type { AgentState } from "../shared/api"
import { FakeEngine, connectAgent, tick } from "./agent-fakes"

const roots: string[] = []
const controllers: AgentController[] = []
after(() => {
  for (const c of controllers) c.dispose()
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

function setup(overrides: Partial<ConstructorParameters<typeof AgentController>[0]> = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "n2-agent-ud-"))
  roots.push(userData)
  const project = path.join(userData, "Game")
  fs.mkdirSync(project)
  const engine = new FakeEngine()
  const states: AgentState[] = []
  const ctx = { project: project as string | null, remote: false, changed: 0, asked: 0 }
  const controller = new AgentController({
    store: new AgentProjectStore(path.join(userData, "agent-projects.json")),
    userData,
    engine,
    projectPath: () => ctx.project,
    isRemote: () => ctx.remote,
    prepare: async () => undefined,
    changed: () => ctx.changed++,
    confirm: async () => {
      ctx.asked++
      return true
    },
    publish: (s) => states.push(s),
    humanViewport: () => null,
    ...overrides,
  })
  controllers.push(controller)
  return { userData, project, engine, states, ctx, controller, file: () => discoveryFile(userData, project) }
}

describe("the switch", () => {
  test("is off by default: no endpoint, no secret file", async () => {
    const t = setup()
    await t.controller.refresh()
    assert.equal(t.controller.current.enabled, false)
    assert.equal(t.controller.current.available, true)
    assert.equal(t.controller.current.listening, false)
    assert.equal(fs.existsSync(t.file()), false)
  })

  test("on: the endpoint listens and the secret file is written (0600 on POSIX), with nothing else in it", async () => {
    const t = setup()
    await t.controller.setEnabled(true)
    assert.deepEqual({ ...t.controller.current }, { available: true, reason: null, enabled: true, listening: true, connected: false })
    const record = readDiscovery(t.file())
    assert.ok(record?.endpoint && record.secret)
    assert.equal(record.projectPath, t.project)
    assert.match(record.secret!, /^[0-9a-f]{64}$/)
    assert.equal(record.pid, process.pid)
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(t.file()).mode & 0o777, 0o600)
      assert.equal(fs.statSync(path.dirname(t.file())).mode & 0o777, 0o700)
    }
    assert.ok(!JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(t.file(), "utf8")))).includes("token"), "the host's token is never in the file")
    const agent = await connectAgent({ listenPath: record.endpoint! }, record.secret)
    assert.equal(agent.isConnected, true)
    agent.close()
  })

  test("a connected agent shows in the state, and gone again", async () => {
    const t = setup()
    await t.controller.setEnabled(true)
    const record = readDiscovery(t.file())!
    const agent = await connectAgent({ listenPath: record.endpoint! }, record.secret)
    await tick(40)
    assert.equal(t.controller.current.connected, true)
    agent.close()
    await tick(80)
    assert.equal(t.controller.current.connected, false)
  })

  test("off: the endpoint and the agent's connection close at once and the secret file is deleted", async () => {
    const t = setup()
    await t.controller.setEnabled(true)
    const record = readDiscovery(t.file())!
    const agent = await connectAgent({ listenPath: record.endpoint! }, record.secret)
    let closed = false
    agent.onClose(() => (closed = true))
    await t.controller.setEnabled(false)
    await tick(20)
    assert.equal(closed, true)
    assert.equal(fs.existsSync(t.file()), false)
    assert.equal(t.controller.current.listening, false)
    await assert.rejects(connectAgent({ listenPath: record.endpoint! }, record.secret))
  })

  test("on again makes a new secret and a new endpoint, so the old secret opens nothing", async () => {
    const t = setup()
    await t.controller.setEnabled(true)
    const first = readDiscovery(t.file())!
    await t.controller.setEnabled(false)
    await t.controller.setEnabled(true)
    const second = readDiscovery(t.file())!
    assert.notEqual(first.secret, second.secret)
    assert.notEqual(first.endpoint, second.endpoint)
    await assert.rejects(connectAgent({ listenPath: second.endpoint! }, first.secret))
  })

  test("the banner's Disconnect drops the agent, deletes the secret and turns the switch off (nothing reconnects)", async () => {
    const t = setup()
    await t.controller.setEnabled(true)
    const record = readDiscovery(t.file())!
    const agent = await connectAgent({ listenPath: record.endpoint! }, record.secret)
    let closed = false
    agent.onClose(() => (closed = true))
    await t.controller.disconnectAgent()
    await tick(20)
    assert.equal(closed, true)
    assert.equal(fs.existsSync(t.file()), false)
    assert.equal(t.controller.current.enabled, false)
    await assert.rejects(connectAgent({ listenPath: record.endpoint! }, record.secret))
  })

  test("is kept per project: a new controller (a restart of the editor) starts the endpoint again, with a new secret", async () => {
    const t = setup()
    await t.controller.setEnabled(true)
    const before = readDiscovery(t.file())!
    t.controller.dispose()
    assert.equal(fs.existsSync(t.file()), false, "quitting deletes the secret file")
    const again = new AgentController({
      store: new AgentProjectStore(path.join(t.userData, "agent-projects.json")),
      userData: t.userData,
      engine: t.engine,
      projectPath: () => t.project,
      isRemote: () => false,
      prepare: async () => undefined,
      changed: () => undefined,
      confirm: async () => true,
      publish: () => undefined,
      humanViewport: () => null,
    })
    controllers.push(again)
    await again.refresh()
    const after = readDiscovery(t.file())!
    assert.equal(again.current.enabled, true)
    assert.notEqual(after.secret, before.secret)
  })

  test("another project has its own switch", async () => {
    const t = setup()
    await t.controller.setEnabled(true)
    const other = path.join(t.userData, "Other")
    fs.mkdirSync(other)
    t.ctx.project = other
    await t.controller.refresh()
    assert.equal(t.controller.current.enabled, false)
    assert.equal(t.controller.current.listening, false)
    assert.equal(fs.existsSync(t.file()), false, "the first project's endpoint closed when the project did")
    t.ctx.project = t.project
    await t.controller.refresh()
    assert.equal(t.controller.current.listening, true)
  })

  test("closing the project closes the endpoint", async () => {
    const t = setup()
    await t.controller.setEnabled(true)
    t.ctx.project = null
    await t.controller.refresh()
    assert.equal(t.controller.current.listening, false)
    assert.equal(fs.existsSync(t.file()), false)
    assert.equal(t.controller.current.reason, "Open a project first")
  })
})

describe("when the switch is not available", () => {
  test("a read-only editor: refused with the reason, and no endpoint", async () => {
    const t = setup()
    t.engine.info = { ...t.engine.info, readOnly: true }
    await assert.rejects(t.controller.setEnabled(true), /read-only/)
    assert.equal(t.controller.current.available, false)
    assert.match(t.controller.current.reason ?? "", /read-only/)
    assert.equal(fs.existsSync(t.file()), false)
  })

  test("a viewer: refused with the reason", async () => {
    const t = setup()
    t.engine.info = { ...t.engine.info, role: "viewer" }
    await assert.rejects(t.controller.setEnabled(true), /viewer/)
    assert.equal(t.controller.current.available, false)
  })

  test("a remote engine: refused", async () => {
    const t = setup()
    t.ctx.remote = true
    await assert.rejects(t.controller.setEnabled(true), /remote/)
  })

  test("no connection to the host yet: refused", async () => {
    const t = setup()
    t.engine.up = false
    await assert.rejects(t.controller.setEnabled(true), /not connected/)
  })

  test("on, and then the editor goes read-only: the endpoint closes, and the secret file says why (no secret in it)", async () => {
    const t = setup()
    await t.controller.setEnabled(true)
    const record = readDiscovery(t.file())!
    const agent = await connectAgent({ listenPath: record.endpoint! }, record.secret)
    let closed = false
    agent.onClose(() => (closed = true))
    t.engine.info = { ...t.engine.info, readOnly: true }
    await t.controller.refresh()
    await tick(20)
    assert.equal(closed, true)
    assert.equal(t.controller.current.enabled, true, "the person's choice is kept")
    assert.equal(t.controller.current.listening, false)
    const status = readDiscovery(t.file())
    assert.ok(status)
    assert.equal(status.secret, undefined)
    assert.equal(status.endpoint, undefined)
    assert.match(status.reason ?? "", /read-only/)
    // and when the editor can write again, the endpoint is back
    t.engine.info = { ...t.engine.info, readOnly: false }
    await t.controller.refresh()
    assert.equal(t.controller.current.listening, true)
    assert.ok(readDiscovery(t.file())?.secret)
  })

  test("the host going away closes the endpoint", async () => {
    const t = setup()
    await t.controller.setEnabled(true)
    t.engine.up = false
    await t.controller.refresh()
    assert.equal(t.controller.current.listening, false)
  })
})

describe("a lockout", () => {
  test("too many wrong secrets close the endpoint and delete the secret; turning the switch off and on brings it back", async () => {
    const t = setup({ limits: { maxAuthFailures: 2 } })
    await t.controller.setEnabled(true)
    const record = readDiscovery(t.file())!
    for (let i = 0; i < 2; i++) await connectAgent({ listenPath: record.endpoint! }, "11".repeat(32)).catch(() => undefined)
    await tick(60)
    assert.equal(t.controller.current.listening, false)
    assert.equal(fs.existsSync(t.file()), false)
    await t.controller.setEnabled(false)
    await t.controller.setEnabled(true)
    assert.equal(t.controller.current.listening, true)
  })
})

describe("files", () => {
  test("a file a crashed editor left (its process is gone) is removed at the next start; a live one is not", async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "n2-agent-ud-"))
    roots.push(userData)
    const dead = path.join(userData, "A")
    const live = path.join(userData, "B")
    // A pid that is not running: ask for one that surely is not (a very high number)
    writeDiscovery(discoveryFile(userData, dead), { version: 1, projectPath: dead, endpoint: "x", secret: "a".repeat(64), pid: 2 ** 30, startedAt: "2026-01-01T00:00:00Z" })
    writeDiscovery(discoveryFile(userData, live), { version: 1, projectPath: live, endpoint: "x", secret: "b".repeat(64), pid: process.pid, startedAt: "2026-01-01T00:00:00Z" })
    const c = new AgentController({
      store: new AgentProjectStore(path.join(userData, "p.json")),
      userData,
      engine: new FakeEngine(),
      projectPath: () => null,
      isRemote: () => false,
      prepare: async () => undefined,
      changed: () => undefined,
      confirm: async () => false,
      publish: () => undefined,
      humanViewport: () => null,
    })
    controllers.push(c)
    assert.equal(fs.existsSync(discoveryFile(userData, dead)), false)
    assert.equal(fs.existsSync(discoveryFile(userData, live)), true)
  })

  test("a discovery file that others can read is not trusted, and a malformed one is nothing", () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "n2-agent-ud-"))
    roots.push(userData)
    const project = path.join(userData, "P")
    const file = discoveryFile(userData, project)
    writeDiscovery(file, { version: 1, projectPath: project, endpoint: "x", secret: "c".repeat(64), pid: 1, startedAt: "now" })
    assert.ok(readDiscovery(file))
    if (process.platform !== "win32") {
      fs.chmodSync(file, 0o644)
      assert.equal(readDiscovery(file), null)
    }
    fs.writeFileSync(file, "{not json", { mode: 0o600 })
    assert.equal(readDiscovery(file), null)
    fs.writeFileSync(file, JSON.stringify({ version: 1, projectPath: project, pid: 1, startedAt: "x", secret: "short", endpoint: "y" }), { mode: 0o600 })
    assert.equal(readDiscovery(file)?.secret, undefined, "a secret that is not 64 hex digits is dropped")
    assert.equal(removeDiscovery(file), true)
    assert.equal(removeDiscovery(file), false)
  })

  test("projects are keyed by their folder, case folded where the file system does", () => {
    assert.equal(projectKey("C:\\Games\\Demo", "win32"), projectKey("c:\\games\\demo\\", "win32"))
    assert.notEqual(projectKey("/a/Demo", "linux"), projectKey("/a/demo", "linux"))
    assert.equal(listDiscoveries(path.join(os.tmpdir(), "n2-no-such-folder")).length, 0)
    assert.ok(agentDirectory("/u").endsWith("agent"))
  })

  test("default user data follows Electron's per platform folders", () => {
    assert.equal(defaultUserData("win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "C:\\Users\\a"), path.join("C:\\Users\\a\\AppData\\Roaming", "n2enginewebfrontend"))
    assert.equal(defaultUserData("darwin", {}, "/Users/a"), path.join("/Users/a", "Library", "Application Support", "n2enginewebfrontend"))
    assert.equal(defaultUserData("linux", {}, "/home/a"), path.join("/home/a", ".config", "n2enginewebfrontend"))
    assert.equal(defaultUserData("linux", { XDG_CONFIG_HOME: "/x" }, "/home/a"), path.join("/x", "n2enginewebfrontend"))
  })

  test("the endpoint path: a named pipe on Windows, a short socket path elsewhere", () => {
    assert.match(newEndpointPath("C:\\U", "win32").path, /^\\\\\.\\pipe\\n2engine-agent-[0-9a-f]{16}$/)
    const posix = newEndpointPath("/short", "linux")
    assert.ok(Buffer.byteLength(posix.path) <= 104)
    const long = newEndpointPath("/" + "x".repeat(200), "linux")
    assert.ok(Buffer.byteLength(long.path) <= 104, "a long user data path moves the socket to a private temp folder")
    assert.ok(long.privateDir)
    fs.rmSync(long.privateDir!, { recursive: true, force: true })
  })
})

describe("settling the page", () => {
  test("the request waits for the page's answer, fails on its error and on no answer, and never settles twice", async () => {
    const sent: number[] = []
    const channel = new PrepareChannel((id) => (sent.push(id), true), 40)
    const ok = channel.request()
    channel.answer(sent[0], null)
    await ok
    const bad = channel.request()
    channel.answer(sent[1], "an edit failed")
    await assert.rejects(bad, /an edit failed/)
    await assert.rejects(channel.request(), /did not settle in time/)
    const none = new PrepareChannel(() => false)
    await assert.rejects(none.request(), /not open/)
    channel.answer(999, null)
    channel.answer("x", null)
    const pending = channel.request()
    channel.cancelAll("gone")
    await assert.rejects(pending, /gone/)
  })
})
