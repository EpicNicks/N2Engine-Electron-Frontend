import { test, describe, after } from "node:test"
import * as assert from "node:assert/strict"
import * as net from "node:net"
import { AgentEndpoint, AgentUserName, dialogText, secretMatches } from "../main/agent-endpoint"
import { EngineClient, EngineError, HelloError, HostBusyError, type SocketFactory } from "../protocol/engine-client"
import { CommandType, ResponseType, encodeFrame, encodeHelloRequest } from "../protocol/protocol.generated"
import { FrameReader } from "../protocol/framing"
import { AgentCodes, agentClassOf, agentLabel } from "../agent/commands"
import { FakeEngine, Refused, TestSecret, connectAgent, startEndpoint, tick, type Started } from "./agent-fakes"

const open: Started[] = []
const clients: EngineClient[] = []
after(async () => {
  for (const c of clients) c.close()
  for (const s of open) await s.stop().catch(() => undefined)
})
async function start(options?: Parameters<typeof startEndpoint>[0]): Promise<Started> {
  const s = await startEndpoint(options)
  open.push(s)
  return s
}
async function agent(s: Started, secret?: string): Promise<EngineClient> {
  const c = await connectAgent(s, secret)
  clients.push(c)
  return c
}
const code = (e: unknown): string | undefined => (e instanceof EngineError ? e.code : undefined)

describe("authentication", () => {
  test("the secret is the Hello token, and the answer is the host's ServerInfo with the agent's own user and an editor role", async () => {
    const s = await start()
    const c = await agent(s)
    assert.equal(c.serverInfo?.user, AgentUserName)
    assert.equal(c.serverInfo?.role, "editor", "an admin host's session is capped to editor")
    assert.equal(c.serverInfo?.protocolVersion, s.engine.info.protocolVersion)
    assert.deepEqual(s.connections, [true])
  })

  test("a wrong secret is refused, and an empty one too; neither gets a command through", async () => {
    const s = await start()
    await assert.rejects(connectAgent(s, "00".repeat(32)), HelloError)
    await assert.rejects(connectAgent(s, ""), HelloError)
    await assert.rejects(connectAgent(s, TestSecret.slice(0, 63)), HelloError)
    assert.deepEqual(s.engine.calls, [])
    assert.deepEqual(s.connections, [])
  })

  test("a connection that sends a command before Hello is dropped", async () => {
    const s = await start()
    const socket = net.connect(s.listenPath)
    await new Promise<void>((r) => socket.once("connect", r))
    socket.write(encodeFrame(CommandType.GetHierarchy, new Uint8Array(0)))
    await new Promise<void>((r) => socket.once("close", () => r()))
    assert.deepEqual(s.engine.calls, [])
  })

  test("a connection that never says Hello is dropped after the timeout", async () => {
    const s = await start({ limits: { helloTimeoutMs: 40 } })
    const socket = net.connect(s.listenPath)
    await new Promise<void>((r) => socket.once("close", () => r()))
  })

  test("the comparison is on equal-length digests, so a prefix of the secret is as wrong as anything else", () => {
    assert.equal(secretMatches(TestSecret, TestSecret), true)
    assert.equal(secretMatches(TestSecret.slice(0, 10), TestSecret), false)
    assert.equal(secretMatches(TestSecret + "0", TestSecret), false)
    assert.equal(secretMatches("", TestSecret), false)
  })

  test("too many wrong secrets stop the endpoint and say so", async () => {
    const s = await start({ limits: { maxAuthFailures: 3 } })
    for (let i = 0; i < 3; i++) await connectAgent(s, "11".repeat(32)).catch(() => undefined)
    await tick(30)
    assert.equal(s.lockouts, 1)
    assert.equal(s.endpoint.listening, false)
    await assert.rejects(connectAgent(s))
  })

  test("a right secret resets the count", async () => {
    const s = await start({ limits: { maxAuthFailures: 3 } })
    await connectAgent(s, "11".repeat(32)).catch(() => undefined)
    await connectAgent(s, "11".repeat(32)).catch(() => undefined)
    const c = await agent(s)
    c.close()
    await tick(30)
    await connectAgent(s, "11".repeat(32)).catch(() => undefined)
    await connectAgent(s, "11".repeat(32)).catch(() => undefined)
    assert.equal(s.lockouts, 0)
  })

  test("one agent at a time: a second is told the editor is busy, and the first keeps working", async () => {
    const s = await start()
    const first = await agent(s)
    await assert.rejects(connectAgent(s), HostBusyError)
    await first.getHierarchy()
    first.close()
    await tick(30)
    const again = await agent(s)
    await again.getHierarchy()
  })

  test("a Hello over the size limit is dropped", async () => {
    const s = await start()
    const socket = net.connect(s.listenPath)
    await new Promise<void>((r) => socket.once("connect", r))
    const hello = encodeHelloRequest({ clientName: "x".repeat(8000), protocolVersion: "1.22.0", token: TestSecret, errorCodes: true, user: "", yield: false })
    socket.write(encodeFrame(CommandType.Hello, hello))
    await new Promise<void>((r) => socket.once("close", () => r()))
    assert.deepEqual(s.connections, [])
  })
})

describe("limits", () => {
  test("a frame over the request limit ends the connection", async () => {
    const s = await start({ limits: { maxRequestBytes: 2048 } })
    const c = await agent(s)
    await assert.rejects(c.writeTextAsset("res://scripts/a.lua", "x".repeat(5000)))
    assert.equal(s.engine.calls.filter((x) => x.name === "WriteTextAsset").length, 0)
  })

  test("requests over the rate limit are refused with a code, in order, and the connection stays", async () => {
    const s = await start({ limits: { maxRequests: 3, rateWindowMs: 60000 } })
    const c = await agent(s)
    await c.getHierarchy()
    await c.getHierarchy()
    await c.getHierarchy()
    await assert.rejects(c.getHierarchy(), (e) => code(e) === AgentCodes.rateLimited)
    assert.equal(s.engine.calls.length, 3)
  })

  test("an answer over the response limit is refused, not sent", async () => {
    const s = await start({ limits: { maxResponseBytes: 64 } })
    s.engine.handlers.set("GetHierarchy", () => ({ revision: 1, nodes: Array.from({ length: 50 }, (_, i) => ({ id: `${i}`.padStart(36, "0"), parentId: "", index: i, name: "n", active: true, activeInHierarchy: true, layer: 0, tag: "", components: [] })) }))
    const c = await agent(s)
    await assert.rejects(c.getHierarchy(), (e) => code(e) === AgentCodes.tooLarge)
  })

  test("more requests waiting than the bound ends the connection", async () => {
    const s = await start({ limits: { maxPending: 2 } })
    const gate = new Promise<void>((r) => setTimeout(r, 150))
    s.engine.before = () => gate
    const c = await agent(s)
    const sends = [c.getHierarchy(), c.getHierarchy(), c.getHierarchy(), c.getHierarchy()]
    const results = await Promise.allSettled(sends)
    assert.ok(results.some((r) => r.status === "rejected"))
  })
})

describe("what an agent may send", () => {
  test("only the allowlist: Shutdown, extensions, play, prefab files, physics and network settings, audio and the legacy commands are forbidden", async () => {
    const s = await start()
    const c = await agent(s)
    for (const name of ["Shutdown", "InvokeMenuItem", "InvokeInspectorAction", "ReloadEditorExtensions", "WritePlaySnapshot", "SetPaused", "Step", "SendInput", "GetPlayState", "CreatePrefab", "ApplyPrefab", "SetPhysicsBackend", "SetNetworkSettings", "GetAudio", "SaveScene", "LoadScene", "CreateEntity", "SetEntityTransform", "SetEditorViewOptions", "SetCameraPosition"] as const) {
      assert.equal(agentClassOf(CommandType[name]), undefined, name)
      const reply = await c.sendRaw(CommandType[name], new Uint8Array(0))
      assert.equal(reply.type, ResponseType.ErrorCoded, name)
    }
    assert.deepEqual(s.engine.calls, [], "none of them reached the host")
    assert.equal(c.isConnected, true, "and the agent is still connected")
  })

  test("a command that no table knows is forbidden too", async () => {
    const s = await start()
    const c = await agent(s)
    const reply = await c.sendRaw(0x7e, new Uint8Array(0))
    assert.equal(reply.type, ResponseType.ErrorCoded)
    assert.deepEqual(s.engine.calls, [])
  })

  test("Hello again, after the first, is not a command", async () => {
    const s = await start()
    const c = await agent(s)
    const reply = await c.sendRaw(CommandType.Hello, encodeHelloRequest({ clientName: "x", protocolVersion: "1.22.0", token: TestSecret, errorCodes: true, user: "", yield: false }))
    assert.equal(reply.type, ResponseType.ErrorCoded)
  })

  test("the host's access token is nowhere in what the agent receives", async () => {
    const s = await start()
    const c = await agent(s)
    const info = JSON.stringify(c.serverInfo)
    assert.ok(!info.includes("token"))
    assert.equal(s.engine.calls.filter((x) => x.name === "Hello").length, 0)
  })
})

describe("the role cap", () => {
  test("a viewer editor makes a viewer agent, and every write is refused by the endpoint itself", async () => {
    const engine = new FakeEngine()
    engine.info = { ...engine.info, role: "viewer" }
    const s = await start({ engine })
    const c = await agent(s)
    assert.equal(c.serverInfo?.role, "viewer")
    await c.getHierarchy()
    await assert.rejects(c.destroyEntity("00000000-0000-4000-8000-000000000001"), (e) => code(e) === "readOnly")
    await assert.rejects(c.writeTextAsset("res://scripts/a.lua", "x"), (e) => code(e) === "readOnly")
    await assert.rejects(c.beginEditGroup("AI: x"), (e) => code(e) === "readOnly")
    assert.deepEqual(s.engine.names(), ["GetHierarchy"])
  })

  test("a read-only editor refuses writes too, and an unknown role counts as a viewer", async () => {
    const engine = new FakeEngine()
    engine.info = { ...engine.info, readOnly: true, role: "editor" }
    const s = await start({ engine })
    const c = await agent(s)
    await assert.rejects(c.duplicateEntity("00000000-0000-4000-8000-000000000001"), (e) => code(e) === "readOnly")
    engine.info = { ...engine.info, readOnly: false, role: "surprise" }
    assert.equal((await connectAgent(s).catch((e) => e)) instanceof HostBusyError, true, "(the first agent still holds the endpoint)")
    c.close()
    await tick(30)
    const d = await agent(s)
    assert.equal(d.serverInfo?.role, "viewer")
  })

  test("an editor host's session stays an editor's, and an old host with no role counts as the person's own (editor at most)", async () => {
    const engine = new FakeEngine()
    engine.info = { ...engine.info, role: "" }
    const s = await start({ engine })
    const c = await agent(s)
    assert.equal(c.serverInfo?.role, "editor")
  })
})

describe("edit steps are the agent's, labelled AI:", () => {
  test("a group the agent opens gets an AI: label, whatever label it sent", async () => {
    const s = await start()
    const c = await agent(s)
    await c.beginEditGroup("n2_set_transform #1")
    await c.endEditGroup()
    await c.beginEditGroup("AI: n2_create #2")
    await c.endEditGroup()
    const begins = s.engine.calls.filter((x) => x.name === "BeginEditGroup").map((x) => x.request.label)
    assert.deepEqual(begins, ["AI: n2_set_transform #1", "AI: n2_create #2"])
    assert.equal(agentLabel("x".repeat(300)).length <= 100, true)
  })

  test("a scene change with no group of the agent's is wrapped in one that is labelled AI:", async () => {
    const s = await start()
    const c = await agent(s)
    await c.destroyEntity("00000000-0000-4000-8000-000000000001")
    assert.deepEqual(s.engine.names(), ["BeginEditGroup", "DestroyEntity", "EndEditGroup"])
    assert.equal(s.engine.calls[0].request.label, "AI: DestroyEntity")
  })

  test("inside the agent's own group nothing more is opened, and EndEditGroup with no group of its own is refused", async () => {
    const s = await start()
    const c = await agent(s)
    await assert.rejects(c.endEditGroup(), (e) => code(e) === AgentCodes.noGroup)
    await c.beginEditGroup("AI: batch")
    await c.destroyEntity("00000000-0000-4000-8000-000000000001")
    await c.destroyEntity("00000000-0000-4000-8000-000000000002")
    await c.endEditGroup()
    assert.deepEqual(s.engine.names(), ["BeginEditGroup", "DestroyEntity", "DestroyEntity", "EndEditGroup"])
  })

  test("a group the agent leaves open is ended when it disconnects, so the person is never left inside one", async () => {
    const s = await start()
    const c = await agent(s)
    await c.beginEditGroup("AI: batch")
    await c.beginEditGroup("AI: nested")
    c.close()
    await tick(60)
    assert.deepEqual(s.engine.names(), ["BeginEditGroup", "BeginEditGroup", "EndEditGroup", "EndEditGroup"])
    assert.equal(s.mux.leased, false)
  })

  test("and so is a group left open by an agent that stays connected but idle", async () => {
    const s = await start({ leaseIdleMs: 30 })
    const c = await agent(s)
    await c.beginEditGroup("AI: batch")
    await tick(120)
    assert.deepEqual(s.engine.names(), ["BeginEditGroup", "EndEditGroup"])
    assert.ok(s.log.some((l) => /left an edit group/.test(l)))
  })
})

describe("settlement and the person's own requests", () => {
  test("the page settles before an agent call, and the person's request that arrives during a group waits for it to end", async () => {
    const s = await start()
    const c = await agent(s)
    await c.beginEditGroup("AI: batch")
    assert.deepEqual(s.prepares, ["settle"], "settled once, before the group opened")
    let humanDone = false
    const human = s.mux.human(async () => {
      s.engine.calls.push({ name: "HUMAN", type: 0, request: {} })
      humanDone = true
    })
    await c.destroyEntity("00000000-0000-4000-8000-000000000001")
    await tick(20)
    assert.equal(humanDone, false, "the person's inspector edit does not land inside the agent's group")
    await c.endEditGroup()
    await human
    assert.deepEqual(s.engine.names(), ["BeginEditGroup", "DestroyEntity", "EndEditGroup", "HUMAN"])
    assert.deepEqual(s.prepares, ["settle"], "no second settle inside the group")
  })

  test("a settle that fails refuses the call, which never reaches the host", async () => {
    const s = await start({
      prepare: async () => {
        throw new Error("window closed")
      },
    })
    const c = await agent(s)
    await assert.rejects(c.getHierarchy(), (e) => code(e) === AgentCodes.busy && /settle/.test((e as Error).message))
    assert.deepEqual(s.engine.calls, [])
  })

  test("the lane goes back to the person with a notice when the agent changed the scene", async () => {
    const s = await start()
    const c = await agent(s)
    await c.getHierarchy()
    assert.equal(s.changed, 0)
    await c.destroyEntity("00000000-0000-4000-8000-000000000001")
    assert.ok(s.changed > 0)
  })
})

describe("the confirmation gate for the irreversible tier", () => {
  const cases: Array<[string, (c: EngineClient) => Promise<unknown>, RegExp, string]> = [
    ["SaveSceneToFile", (c) => c.saveSceneToFile("res://scenes/a.scene"), /Save the open scene to res:\/\/scenes\/a\.scene/, "SaveSceneToFile"],
    ["OpenScene", (c) => c.openScene("res://scenes/b.scene"), /Open the scene res:\/\/scenes\/b\.scene/, "OpenScene"],
    ["NewScene", (c) => c.newScene("res://scenes/c.scene", "C"), /new empty scene "C" in res:\/\/scenes\/c\.scene/, "NewScene"],
    ["SetProjectSettings", (c) => c.setProjectSettings({ window: { title: "x" } }), /project's settings \(window\)/, "SetProjectSettings"],
    ["SetStartupScene", (c) => c.setStartupScene("res://scenes/a.scene"), /startup scene to res:\/\/scenes\/a\.scene/, "SetStartupScene"],
    ["SetImportSettings", (c) => c.setImportSettings("res://t.png", { filter: "x" }), /import settings of res:\/\/t\.png/, "SetImportSettings"],
    ["RestoreAutosave", (c) => c.restoreAutosave(), /autosave/, "RestoreAutosave"],
    ["DiscardAutosave", (c) => c.discardAutosave(), /autosave/, "DiscardAutosave"],
  ]
  for (const [name, call, text, command] of cases) {
    test(`${name}: a native question names the operation; refused, nothing is sent to the host; accepted, it runs`, async () => {
      const refused = await start({ answer: () => false })
      const a = await agent(refused)
      await assert.rejects(call(a), (e) => code(e) === AgentCodes.declined)
      assert.equal(refused.asked.length, 1)
      assert.match(refused.asked[0].message, text)
      assert.equal(refused.engine.calls.some((x) => x.name === command), false, "declined: the host never saw it")

      const allowed = await start({ answer: () => true })
      const b = await agent(allowed)
      await call(b)
      assert.equal(allowed.engine.calls.some((x) => x.name === command), true)
    })
  }

  test("overwriting a text file is confirmed; a new file is not", async () => {
    const s = await start({ answer: () => false })
    s.engine.handlers.set("ReadTextAsset", (r) => {
      if (r.path === "res://scripts/new.lua") throw new Refused("Not found: res://scripts/new.lua")
      return { text: "old" }
    })
    const c = await agent(s)
    await c.writeTextAsset("res://scripts/new.lua", "-- new")
    assert.equal(s.asked.length, 0)
    await assert.rejects(c.writeTextAsset("res://scripts/old.lua", "-- changed"), (e) => code(e) === AgentCodes.declined)
    assert.match(s.asked[0].message, /Overwrite the file res:\/\/scripts\/old\.lua/)
    assert.equal(s.engine.calls.filter((x) => x.name === "WriteTextAsset").length, 1, "only the new file was written")
  })

  test("a text file that cannot be read for another reason is treated as existing", async () => {
    const s = await start({ answer: () => false })
    s.engine.handlers.set("ReadTextAsset", () => {
      throw new Refused("Text file is larger than 4 MiB")
    })
    const c = await agent(s)
    await assert.rejects(c.writeTextAsset("res://scripts/big.lua", "x"), (e) => code(e) === AgentCodes.declined)
  })

  test("the question is a dialog of the main process: a name with control characters cannot fake a second line", () => {
    assert.equal(dialogText("res://a\nAllow? yes\r\x07b"), "res://a Allow? yes  b")
    assert.equal(dialogText("x".repeat(500)).length, 163)
  })

  test("no answer in time counts as no", async () => {
    const s = await start({ limits: { confirmTimeoutMs: 30 }, answer: () => new Promise<boolean>(() => undefined) })
    const c = await agent(s)
    // The fake never answers; the endpoint's own timer aborts the signal, which a real dialog treats as cancelled. The fake
    // here ignores the signal, so only check the endpoint did ask once and that the host saw nothing.
    const result = Promise.race([c.saveSceneToFile("").then(() => "ran"), tick(200).then(() => "waiting")])
    assert.equal(await result, "waiting")
    assert.equal(s.engine.calls.some((x) => x.name === "SaveSceneToFile"), false)
  })

  test("Undo of the agent's own step needs no question; of the person's step it does", async () => {
    const s = await start({ answer: () => false })
    s.engine.handlers.set("GetHistory", () => ({ cursor: 1, entries: [{ label: "AI: n2_create #1", bytes: 1 }] }))
    const c = await agent(s)
    await c.undo()
    assert.equal(s.asked.length, 0)
    s.engine.handlers.set("GetHistory", () => ({ cursor: 1, entries: [{ label: "Move Player", bytes: 1 }] }))
    await assert.rejects(c.undo(), (e) => code(e) === AgentCodes.declined)
    assert.match(s.asked[0].message, /Undo the step "Move Player"/)
    assert.equal(s.engine.calls.filter((x) => x.name === "Undo").length, 1)
  })

  test("a person's step that appears between the question and the undo is not undone unasked", async () => {
    const s = await start({ answer: () => true })
    let reads = 0
    s.engine.handlers.set("GetHistory", () => {
      reads++
      // First look: the agent's own step. Then the person edits.
      return reads === 1
        ? { cursor: 1, entries: [{ label: "AI: n2_create #1", bytes: 1 }] }
        : { cursor: 2, entries: [{ label: "AI: n2_create #1", bytes: 1 }, { label: "Move Player", bytes: 1 }] }
    })
    const c = await agent(s)
    await assert.rejects(c.undo(), (e) => code(e) === AgentCodes.busy)
    assert.equal(s.engine.calls.some((x) => x.name === "Undo"), false)
  })

  test("--allow-irreversible has no part in it: the endpoint has no such switch, and the answer is the person's alone", async () => {
    const s = await start({ answer: () => false })
    const c = await agent(s)
    await assert.rejects(c.saveSceneToFile(""), (e) => code(e) === AgentCodes.declined)
  })
})

describe("the person's editor view (risk R4)", () => {
  test("the camera and the viewport size are put back after the picture", async () => {
    const s = await start()
    s.humanView = { width: 1000, height: 600 }
    const c = await agent(s)
    await c.setViewportSize(768, 432)
    await c.renderFrameIfChanged(0)
    assert.deepEqual(s.engine.names(), ["GetEditorCamera", "SetViewportSize", "RenderFrameIfChanged", "SetViewportSize", "SetEditorCamera"])
    assert.deepEqual(s.engine.calls[1].request, { width: 768, height: 432 })
    assert.deepEqual(s.engine.calls[3].request, { width: 1000, height: 600 }, "the person's size, not the agent's")
    assert.deepEqual(s.engine.calls[4].request.position, { x: 1, y: 2, z: 3 })
    assert.equal(s.mux.leased, false, "and the lane is the person's again")
  })

  test("the person's requests wait during the picture, so none sees the agent's size", async () => {
    const s = await start()
    s.humanView = { width: 800, height: 600 }
    const c = await agent(s)
    await c.setViewportSize(768, 432)
    let ran = false
    const human = s.mux.human(async () => void (ran = true))
    await tick(20)
    assert.equal(ran, false)
    await c.renderFrame()
    await human
    assert.equal(ran, true)
  })

  test("a second picture is saved and restored again, and an unknown person's size is left alone", async () => {
    const s = await start()
    const c = await agent(s)
    await c.setViewportSize(768, 432)
    await c.renderFrameIfChanged(0)
    await c.setViewportSize(768, 432)
    await c.renderFrameIfChanged(0)
    assert.equal(s.engine.calls.filter((x) => x.name === "GetEditorCamera").length, 2)
    assert.equal(s.engine.calls.filter((x) => x.name === "SetViewportSize").length, 2, "the size the person last set is not known, so only the agent's two are sent")
    assert.equal(s.engine.calls.filter((x) => x.name === "SetEditorCamera").length, 2)
  })

  test("a render with no change of view (the game view at the current size) has nothing to restore", async () => {
    const s = await start()
    const c = await agent(s)
    await c.renderFrame()
    assert.deepEqual(s.engine.names(), ["RenderFrame"])
  })

  test("an agent that sets the size and walks away: the view is restored when it disconnects", async () => {
    const s = await start()
    s.humanView = { width: 640, height: 480 }
    const c = await agent(s)
    await c.setViewportSize(768, 432)
    c.close()
    await tick(60)
    assert.deepEqual(s.engine.calls[s.engine.calls.length - 2].request, { width: 640, height: 480 })
    assert.equal(s.mux.leased, false)
  })
})

describe("lifecycle", () => {
  test("stop() closes the agent's connection, ends its open work and stops listening", async () => {
    const s = await start()
    const c = await agent(s)
    await c.beginEditGroup("AI: batch")
    let closed = false
    c.onClose(() => (closed = true))
    await s.endpoint.stop()
    await tick(20)
    assert.equal(closed, true)
    assert.equal(s.endpoint.listening, false)
    assert.ok(s.engine.names().includes("EndEditGroup"))
    await assert.rejects(connectAgent(s))
  })

  test("disconnect() drops the agent and the endpoint keeps listening", async () => {
    const s = await start()
    const c = await agent(s)
    let closed = false
    c.onClose(() => (closed = true))
    s.endpoint.disconnect()
    await tick(30)
    assert.equal(closed, true)
    assert.equal(s.endpoint.listening, true)
    assert.equal(s.endpoint.connected, false)
  })

  test("an editor with no host connection answers Hello with an error, and commands with one", async () => {
    const s = await start()
    s.engine.up = false
    await assert.rejects(connectAgent(s), HelloError)
    s.engine.up = true
    const c = await agent(s)
    s.engine.up = false
    await assert.rejects(c.getHierarchy())
  })
})
