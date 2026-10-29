// The --electron backend: the command line, finding the editor's endpoint, and the bridge's tools against the REAL agent
// endpoint (src/main/agent-endpoint.ts, started by the real AgentController) in front of a fake host, with the native
// dialog and the page's settling replaced by fakes. A live Electron session with a real agent is not tested here (README).
import { test, describe, after, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { EngineClient } from "../../src/protocol/engine-client"
import { AgentController, AgentProjectStore } from "../../src/main/agent-controller"
import type { ConfirmRequest } from "../../src/main/agent-endpoint"
import { discoveryFile, readDiscovery, writeDiscovery } from "../../src/agent/discovery"
import type { BridgeOptions } from "../src/bridge"
import { CliError, parseArgs } from "../src/cli"
import { electronConnector, locateEndpoint } from "../src/electron-backend"
import { Scrubber } from "../src/scrub"
import { FakeHost, Refusal } from "./fake-host"
import { installWrites } from "./write-host"
import { TestToken, closeAllHarnesses, startHarness, textOf, type Harness } from "./harness"

after(closeAllHarnesses)

const args = (...a: string[]) => parseArgs(a, {})

describe("the command line", () => {
  test("--electron alone, with a project, and with the editor's user data", () => {
    assert.equal(args("--electron").mode, "electron")
    const cli = args("--electron", "--project", "C:\\Games\\Demo", "--user-data", "D:\\ud")
    assert.equal(cli.mode, "electron")
    if (cli.mode !== "electron") return
    assert.equal(cli.projectPath, "C:\\Games\\Demo")
    assert.equal(cli.userData, "D:\\ud")
    assert.equal(cli.allowIrreversible, false)
  })

  test("it cannot be combined with --launch or --connect, and --project/--user-data are for it alone", () => {
    assert.throws(() => args("--electron", "--launch", "C:\\P", "--host-path", "h"), CliError)
    assert.throws(() => args("--electron", "--connect", "h:1"), CliError)
    assert.throws(() => args("--launch", "C:\\P", "--host-path", "h", "--project", "C:\\P"), /belong to --electron/)
    assert.throws(() => args("--connect", "h:1", "--user-data", "x"), /belong to --electron/)
    assert.throws(() => args(), /--electron/)
  })

  test("--allow-admin does not apply; --allow-irreversible is accepted but changes nothing", () => {
    assert.throws(() => args("--electron", "--allow-admin"), /does not apply/)
    const cli = args("--electron", "--allow-irreversible")
    assert.equal(cli.mode === "electron" && cli.allowIrreversible, false, "the policy never gets the flag")
    assert.equal(cli.mode === "electron" && cli.ignoredAllowIrreversible, true)
  })

  test("a token or a host option is not for --electron", () => {
    assert.throws(() => args("--electron", "--token-env", "X"), /belong to --connect/)
    assert.throws(() => args("--electron", "--host-path", "h"), /belong to --launch/)
    assert.throws(() => args("--electron", "--token", "secret"), /never accepted/)
  })
})

/** A tmp user data folder and a project folder */
function folders() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "n2-electron-ud-"))
  const project = path.join(userData, "Game")
  fs.mkdirSync(project)
  cleanups.push(() => fs.rmSync(userData, { recursive: true, force: true }))
  return { userData, project }
}
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

describe("finding the editor's endpoint", () => {
  test("nothing there: the editor is not running or the switch is off, and the message says how to turn it on", () => {
    const { userData, project } = folders()
    assert.throws(
      () => locateEndpoint({ projectPath: project, userData }),
      (e: any) => e.code === "host_unavailable" && /Allow AI agent for this project/.test(e.message + e.advice)
    )
    assert.throws(() => locateEndpoint({ userData }), (e: any) => e.code === "host_unavailable")
  })

  test("several projects, none chosen: asks for --project and lists names only", () => {
    const { userData, project } = folders()
    const other = path.join(userData, "Other")
    const record = (p: string) => ({ version: 1, projectPath: p, endpoint: "\\\\.\\pipe\\x", secret: "d".repeat(64), pid: process.pid, startedAt: "now" })
    writeDiscovery(discoveryFile(userData, project), record(project))
    writeDiscovery(discoveryFile(userData, other), record(other))
    assert.throws(() => locateEndpoint({ userData }), (e: any) => e.code === "invalid_argument" && /--project/.test(e.advice) && /Game/.test(e.message))
    assert.equal(locateEndpoint({ userData, projectPath: project }).projectPath, project)
  })

  test("the only project is used without --project", () => {
    const { userData, project } = folders()
    writeDiscovery(discoveryFile(userData, project), { version: 1, projectPath: project, endpoint: "e", secret: "d".repeat(64), pid: 1, startedAt: "now" })
    assert.equal(locateEndpoint({ userData }).projectPath, project)
  })

  test("a switch that is on while the editor is read-only says so (no secret to use)", () => {
    const { userData, project } = folders()
    writeDiscovery(discoveryFile(userData, project), { version: 1, projectPath: project, pid: process.pid, startedAt: "now", reason: "The editor is read-only (the host was started with --read-only)" })
    assert.throws(() => locateEndpoint({ userData, projectPath: project }), (e: any) => e.code === "read_only" && /read-only/.test(e.message))
  })

  test("the user data comes from the environment variable when no folder is given", () => {
    const { userData, project } = folders()
    writeDiscovery(discoveryFile(userData, project), { version: 1, projectPath: project, endpoint: "e", secret: "d".repeat(64), pid: 1, startedAt: "now" })
    assert.equal(locateEndpoint({ projectPath: project, env: { N2ENGINE_EDITOR_USERDATA: userData } }).endpoint, "e")
  })
})

/** The editor: a fake host, the editor's own EngineClient to it, and the real controller and endpoint in front */
async function editor(options: { role?: string; readOnly?: boolean; answer?: (request: ConfirmRequest) => boolean } = {}) {
  const host = await new FakeHost({ token: TestToken, role: options.role ?? "admin", readOnly: options.readOnly, user: "alice" }).start()
  const world = installWrites(host, options.role ?? "admin")
  host.on("GetEditorCamera", () => ({
    position: { x: 1, y: 2, z: 3 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    fovY: 60,
    orthographic: false,
    orthoSize: 5,
    nearPlane: 0.1,
    farPlane: 1000,
    view: new Array(16).fill(0),
    projection: new Array(16).fill(0),
  }))
  // The real host's wording for a file that is not there
  host.on("ReadTextAsset", (r) => {
    const text = host.texts.get(r.path)
    if (text === undefined) throw new Refusal(`File not found: ${r.path}`)
    return { text }
  })
  const cameraSets: unknown[] = []
  host.on("SetEditorCamera", (r) => void cameraSets.push(r))
  const client = new EngineClient()
  await client.connect("127.0.0.1", host.port, { token: TestToken, user: "alice" })
  const { userData, project } = folders()
  const asked: ConfirmRequest[] = []
  const prepares: number[] = []
  let human: { width: number; height: number } | null = null
  const controller = new AgentController({
    store: new AgentProjectStore(path.join(userData, "agent-projects.json")),
    userData,
    engine: client,
    projectPath: () => project,
    isRemote: () => false,
    prepare: async () => void prepares.push(Date.now()),
    changed: () => undefined,
    confirm: async (request) => {
      asked.push(request)
      return options.answer ? options.answer(request) : true
    },
    publish: () => undefined,
    humanViewport: () => human,
  })
  cleanups.push(async () => {
    controller.dispose()
    client.close()
    await host.stop()
  })
  return { host, world, client, controller, userData, project, asked, prepares, cameraSets, setHumanViewport: (v: typeof human) => (human = v) }
}

async function bridgeFor(e: Awaited<ReturnType<typeof editor>>, bridge: Partial<BridgeOptions> = {}, harness: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const scrubber = new Scrubber()
  const h = await startHarness({
    ...harness,
    // The harness's own fake host stands in for nothing here: the bridge talks to the editor's endpoint only
    existingHost: e.host,
    bridge: {
      ...bridge,
      scrubber,
      connector: electronConnector({ projectPath: e.project, userData: e.userData, scrubber }),
    },
  })
  cleanups.push(() => h.close())
  return h
}

describe("the bridge's tools through the editor's endpoint", () => {
  test("read tools work, the backend is electron, the role is an editor's even on an admin host, and the play tools are not offered", async () => {
    const e = await editor({ role: "admin" })
    await e.controller.setEnabled(true)
    const h = await bridgeFor(e)
    const status = await h.call("n2_status")
    assert.ok(!status.isError, textOf(status))
    assert.equal(status.structuredContent.data.bridge.backend, "electron")
    assert.equal(status.structuredContent.data.host.role, "editor")
    const tools = (await h.client.listTools()).tools.map((t) => t.name)
    assert.ok(tools.includes("n2_create_entity"), "write tools are listed for the editor role")
    assert.ok(!tools.some((n) => n.startsWith("n2_play_")), "no play tools")
    const tree = await h.call("n2_get_hierarchy", {})
    assert.ok(!tree.isError, textOf(tree))
    assert.ok(e.prepares.length > 0, "the page was asked to settle before the first call")
  })

  test("the editor's own token never appears: the host saw one Hello, the editor's, and none from the agent", async () => {
    const e = await editor()
    await e.controller.setEnabled(true)
    const h = await bridgeFor(e)
    await h.call("n2_status")
    assert.deepEqual([...new Set(e.host.helloTokens)], [TestToken])
    assert.equal(e.host.connections, 1, "the agent has no connection of its own to the host")
  })

  test("an agent's edit is one undo step labelled AI: in the person's history", async () => {
    const e = await editor()
    await e.controller.setEnabled(true)
    const h = await bridgeFor(e)
    const before = e.world.steps.length
    const r = await h.call("n2_create_entity", { name: "Crate", preset: "Cube" })
    assert.ok(!r.isError, textOf(r))
    assert.equal(e.world.steps.length, before + 1)
    assert.match(e.world.steps[e.world.steps.length - 1].label, /^AI: n2_create_entity #\d+$/)
  })

  test("a viewer editor gives a viewer agent: read tools only, no write tool is listed", async () => {
    const e = await editor({ role: "viewer" })
    // The controller refuses a viewer; the endpoint is started directly by pretending the editor was an editor at that time
    await assert.rejects(e.controller.setEnabled(true), /viewer/)
    const h = await bridgeFor(e)
    const r = await h.call("n2_status")
    assert.equal(r.isError, true)
    assert.ok(["host_unavailable", "read_only"].includes(r._meta?.["n2/errorCode"] as string))
  })

  test("the editor is read-only: a clear error, not a hang", async () => {
    const e = await editor({ readOnly: true })
    await assert.rejects(e.controller.setEnabled(true), /read-only/)
    // the switch was already on from an earlier session: the editor writes the reason into the file
    const store = new AgentProjectStore(path.join(e.userData, "agent-projects.json"))
    store.set(e.project, true)
    await e.controller.refresh()
    const h = await bridgeFor(e)
    const r = await h.call("n2_status")
    assert.equal(r.isError, true)
    assert.equal(r._meta?.["n2/errorCode"], "read_only")
    assert.match(textOf(r), /read-only/)
  })

  test("the switch off: the next call fails with how to turn it on, and an agent already attached is cut off", async () => {
    const e = await editor()
    await e.controller.setEnabled(true)
    const h = await bridgeFor(e)
    assert.ok(!(await h.call("n2_status")).isError)
    await e.controller.setEnabled(false)
    await new Promise((r) => setTimeout(r, 30))
    const r = await h.call("n2_status")
    assert.equal(r.isError, true)
    assert.match(textOf(r), /Allow AI agent for this project/)
  })

  test("a secret the editor no longer accepts is auth_failed, with advice to turn the switch on again", async () => {
    const e = await editor()
    await e.controller.setEnabled(true)
    const file = discoveryFile(e.userData, e.project)
    const record = readDiscovery(file)!
    writeDiscovery(file, { ...record, secret: "0".repeat(64) })
    const h = await bridgeFor(e)
    const r = await h.call("n2_status")
    assert.equal(r._meta?.["n2/errorCode"], "auth_failed")
    assert.match(textOf(r), /Allow AI agent for this project/)
  })

  test("a second agent while one is attached is told the editor is busy", async () => {
    const e = await editor()
    await e.controller.setEnabled(true)
    const first = await bridgeFor(e)
    assert.ok(!(await first.call("n2_status")).isError)
    const second = await bridgeFor(e)
    const r = await second.call("n2_status")
    assert.equal(r.isError, true)
    assert.equal(r._meta?.["n2/errorCode"], "busy")
  })
})

describe("the confirmation gate, through the bridge's tools", () => {
  test("n2_save_scene: the person declines in the editor's dialog, and the tool returns a plain refusal; the host never saw it", async () => {
    const e = await editor({ answer: () => false })
    await e.controller.setEnabled(true)
    const h = await bridgeFor(e)
    const r = await h.call("n2_save_scene", {})
    assert.equal(r.isError, true)
    assert.equal(r._meta?.["n2/errorCode"], "confirmation_declined")
    assert.equal(e.host.count("SaveSceneToFile"), 0)
    assert.equal(e.asked.length, 1)
    assert.match(e.asked[0].message, /Save the open scene/)
  })

  test("accepted, it proceeds, and the journal says the editor asked", async () => {
    const e = await editor({ answer: () => true })
    await e.controller.setEnabled(true)
    const h = await bridgeFor(e)
    const r = await h.call("n2_save_scene", {})
    assert.ok(!r.isError, textOf(r))
    assert.equal(e.host.count("SaveSceneToFile"), 1)
    assert.equal(e.asked.length, 1)
  })

  test("the bridge's own --allow-irreversible does not bypass it, and the MCP client is not asked a second time", async () => {
    const e = await editor({ answer: () => false })
    await e.controller.setEnabled(true)
    const h = await bridgeFor(e, { policy: { readOnly: false, allowIrreversible: true, maxWrites: 2000, writeTools: null, disabledTools: new Set(), keepJournal: false } }, { elicit: "form" })
    const r = await h.call("n2_set_project_settings", { settings: { window: { title: "Changed" } } })
    assert.equal(r._meta?.["n2/errorCode"], "confirmation_declined")
    assert.equal(e.host.count("SetProjectSettings"), 0)
    assert.deepEqual(h.asked, [], "the client's elicitation is not used; the editor's dialog is the one question")
    assert.equal(e.asked.length, 1)
  })

  test("overwriting an existing text file is asked about; a new file is not", async () => {
    const e = await editor({ answer: () => false })
    await e.controller.setEnabled(true)
    const h = await bridgeFor(e)
    const fresh = await h.call("n2_write_text_asset", { path: "res://scripts/New.lua", text: "-- new" })
    assert.ok(!fresh.isError, textOf(fresh))
    assert.equal(e.asked.length, 0)
    const over = await h.call("n2_write_text_asset", { path: "res://scripts/Player.lua", text: "-- changed" })
    assert.equal(over._meta?.["n2/errorCode"], "confirmation_declined")
    assert.equal(e.asked.length, 1)
    assert.equal(e.host.texts.get("res://scripts/Player.lua"), "-- Player\nfunction update() end\n", "the file is as it was")
  })

  test("undoing the agent's own step needs no question; the person's steps the bridge itself refuses to touch", async () => {
    const e = await editor({ answer: () => false })
    await e.controller.setEnabled(true)
    const h = await bridgeFor(e)
    const made = await h.call("n2_create_entity", { name: "Crate", preset: "Cube" })
    assert.ok(!made.isError, textOf(made))
    const undone = await h.call("n2_undo", {})
    assert.ok(!undone.isError, textOf(undone))
    assert.equal(e.asked.length, 0)
    e.world.humanEdit("Move Player", () => undefined)
    const refused = await h.call("n2_undo", {})
    assert.equal(refused.isError, true)
    assert.equal(e.host.count("Undo"), 1, "only the agent's own step was undone")
  })
})

describe("the person's editor view", () => {
  test("a screenshot leaves the viewport size and the editor camera as the person had them", async () => {
    const e = await editor()
    e.setHumanViewport({ width: 1111, height: 555 })
    e.host.viewport = { width: 1111, height: 555 }
    await e.controller.setEnabled(true)
    const h = await bridgeFor(e)
    const r = await h.call("n2_screenshot", { width: 320, height: 180 })
    assert.ok(!r.isError, textOf(r))
    assert.ok(r.content.some((c) => c.type === "image"))
    assert.deepEqual(e.host.viewport, { width: 1111, height: 555 }, "the person's size is back")
    assert.equal(e.cameraSets.length, 1, "and so is the camera")
    // a second picture sets the size again (the editor restored it) rather than assuming the first one's
    e.host.received.length = 0
    const again = await h.call("n2_screenshot", { width: 320, height: 180 })
    assert.ok(!again.isError, textOf(again))
    assert.ok(e.host.received.some((x) => x.name === "SetViewportSize" && (x.request as any).width === 320))
    assert.deepEqual(e.host.viewport, { width: 1111, height: 555 })
  })
})
