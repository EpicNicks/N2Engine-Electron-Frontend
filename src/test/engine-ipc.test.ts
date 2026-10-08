import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { IpcMain, WebContents } from "electron"
import {
  EngineHost,
  EngineHostOptions,
  MaxJsonDepth,
  MaxJsonNodes,
  MaxUnusedViewBytes,
  ownedViews,
} from "../main/engine-ipc"
import { Commands } from "../protocol/codec"
import { FrameReader } from "../protocol/framing"
import { ResponseType, encodeFrame, encodeFrameDataResponse } from "../protocol/protocol.generated"
import { ConnectOptions, EngineClient } from "../protocol/engine-client"
import type { ServerInfoResponse } from "../protocol/protocol.generated"
import { Channels, ConnectionState, IpcResult } from "../shared/api"

type Handler = (event: unknown, ...args: unknown[]) => Promise<IpcResult<unknown>>

/** Records the handlers EngineHost registers, and invokes them as a given sender */
class FakeIpcMain {
  handlers = new Map<string, Handler>()

  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler)
  }

  invoke(channel: string, sender: { mainFrame: unknown }, ...args: unknown[]): Promise<IpcResult<unknown>> {
    return this.handlers.get(channel)!({ sender, senderFrame: sender.mainFrame }, ...args)
  }
}

const info: ServerInfoResponse = {
  protocolVersion: "1.1.0",
  engineVersion: "0.9.0",
  capabilities: [],
  projectLoaded: true,
}

/** Just the EngineClient surface EngineHost uses */
class FakeClient {
  connected = false
  calls: Array<[string, unknown[]]> = []
  connectedTo: [string, number] | null = null
  connectOptions: ConnectOptions | null = null
  /** Set to make connect's Hello fail with this message */
  refuseHello: string | null = null
  private closeListeners: Array<() => void> = []

  get isConnected(): boolean {
    return this.connected
  }

  get serverInfo(): ServerInfoResponse | null {
    return this.connected ? info : null
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener)
  }

  async connect(host: string, port: number, options: ConnectOptions): Promise<ServerInfoResponse> {
    this.connectedTo = [host, port]
    this.connectOptions = options
    if (this.refuseHello !== null) {
      // As EngineClient does: the connection is closed (and the close reported) before connect rejects
      this.closeListeners.forEach((l) => l())
      throw new Error(this.refuseHello)
    }
    this.connected = true
    return info
  }

  disconnect(): void {
    this.drop()
  }

  close(): void {
    if (this.connected) this.drop()
  }

  /** The connection ends (the host closed it, or disconnect/close) */
  drop(): void {
    this.connected = false
    this.closeListeners.forEach((l) => l())
  }

  async getCameraPosition(): Promise<unknown> {
    this.calls.push(["getCameraPosition", []])
    return { x: 1, y: 2, z: 3 }
  }

  async setViewportSize(width: number, height: number): Promise<void> {
    this.calls.push(["setViewportSize", [width, height]])
  }

  async createEntity(name: string): Promise<string> {
    this.calls.push(["createEntity", [name]])
    return "id"
  }

  async setEntityTransform(...args: unknown[]): Promise<void> {
    this.calls.push(["setEntityTransform", args])
  }

  /** What renderFrame resolves with: by default a frame whose pixels are a view into a larger (socket) buffer */
  frame: unknown = null

  async pollEvents(epoch: number, afterSeq: number, maxEvents: number): Promise<unknown> {
    this.calls.push(["pollEvents", [epoch, afterSeq, maxEvents]])
    return {
      epoch: 7,
      nextSeq: 1,
      dropped: 0,
      events: [{ seq: 1, kind: "log", level: "info", message: "hi", time: 0 }],
    }
  }

  /** Records the call and answers with the command's name */
  private record(name: string, args: unknown[]): Promise<unknown> {
    this.calls.push([name, args])
    return Promise.resolve({ name })
  }
  openScene = (...args: unknown[]) => this.record("openScene", args)
  saveSceneToFile = (...args: unknown[]) => this.record("saveSceneToFile", args)
  newScene = (...args: unknown[]) => this.record("newScene", args)
  getOpenScene = (...args: unknown[]) => this.record("getOpenScene", args)
  getProjectInfo = (...args: unknown[]) => this.record("getProjectInfo", args)
  setProjectSettings = (...args: unknown[]) => this.record("setProjectSettings", args)
  setStartupScene = (...args: unknown[]) => this.record("setStartupScene", args)
  getHierarchy = (...args: unknown[]) => this.record("getHierarchy", args)
  createEntityEx = (...args: unknown[]) => this.record("createEntityEx", args)
  setEntityParent = (...args: unknown[]) => this.record("setEntityParent", args)
  setEntityProperties = (...args: unknown[]) => this.record("setEntityProperties", args)
  duplicateEntity = (...args: unknown[]) => this.record("duplicateEntity", args)
  getEntity = (...args: unknown[]) => this.record("getEntity", args)
  setLocalTransform = (...args: unknown[]) => this.record("setLocalTransform", args)
  renderFrameIfChanged = (...args: unknown[]) => this.record("renderFrameIfChanged", args)
  setEditorCamera = (...args: unknown[]) => this.record("setEditorCamera", args)
  getEditorCamera = (...args: unknown[]) => this.record("getEditorCamera", args)
  getComponentTypes = (...args: unknown[]) => this.record("getComponentTypes", args)
  addComponent = (...args: unknown[]) => this.record("addComponent", args)
  removeComponent = (...args: unknown[]) => this.record("removeComponent", args)
  setComponentFields = (...args: unknown[]) => this.record("setComponentFields", args)
  getComponent = (...args: unknown[]) => this.record("getComponent", args)
  getLuaFields = (...args: unknown[]) => this.record("getLuaFields", args)
  undo = (...args: unknown[]) => this.record("undo", args)
  redo = (...args: unknown[]) => this.record("redo", args)
  beginEditGroup = (...args: unknown[]) => this.record("beginEditGroup", args)
  endEditGroup = (...args: unknown[]) => this.record("endEditGroup", args)
  getHistory = (...args: unknown[]) => this.record("getHistory", args)
  getAutosave = (...args: unknown[]) => this.record("getAutosave", args)
  restoreAutosave = (...args: unknown[]) => this.record("restoreAutosave", args)
  discardAutosave = (...args: unknown[]) => this.record("discardAutosave", args)

  async renderFrame(): Promise<unknown> {
    this.calls.push(["renderFrame", []])
    return this.frame
  }
}

const PageUrl = "file:///C:/editor/src/index.html"

function setup(options: EngineHostOptions = {}) {
  const sent: Array<[string, unknown]> = []
  const editor = {
    mainFrame: { url: PageUrl },
    isDestroyed: () => false,
    send: (channel: string, value: unknown) => sent.push([channel, value]),
  }
  const client = new FakeClient()
  const host = new EngineHost(
    client as unknown as EngineClient,
    {
      getEditor: () => editor as unknown as WebContents,
      url: PageUrl,
    },
    options
  )
  const ipc = new FakeIpcMain()
  host.register(ipc as unknown as IpcMain)
  return { ipc, host, client, editor, sent }
}

describe("EngineHost (the main process's engine IPC)", () => {
  test("forwards allowed commands to the client with their arguments", async () => {
    const { ipc, client, editor } = setup()
    assert.deepEqual(await ipc.invoke(Channels.engineCall, editor, "getCameraPosition", []), {
      ok: true,
      value: { x: 1, y: 2, z: 3 },
    })
    await ipc.invoke(Channels.engineCall, editor, "setViewportSize", [640, 480])
    assert.deepEqual(client.calls[1], ["setViewportSize", [640, 480]])
  })

  test("refuses names outside the API, even ones the client has", async () => {
    const { ipc, editor } = setup()
    for (const name of ["connect", "disconnect", "sendRaw", "send", "constructor", "__proto__", 42]) {
      const result = await ipc.invoke(Channels.engineCall, editor, name, [])
      assert.equal(result.ok, false, `${String(name)} is refused`)
    }
    assert.equal((await ipc.invoke(Channels.engineCall, editor, "getCameraPosition", "not an array")).ok, false)
  })

  test("checks each argument's type before calling the client", async () => {
    const { ipc, client, editor } = setup()
    const v = { x: 1, y: 2, z: 3 }
    const bad: Array<[string, unknown[]]> = [
      ["createEntity", [["a", "b"]]], // an array where a string is expected
      ["createEntity", [{ length: 1e9 }]], // Buffer.from would allocate this much
      ["createEntity", [42]],
      ["createEntity", []], // too few
      ["createEntity", ["a", "b"]], // too many
      ["setViewportSize", [640.5, 480]],
      ["setViewportSize", [2 ** 31, 480]],
      ["setViewportSize", ["640", 480]],
      ["setEntityTransform", ["id", v, v, { x: 1, y: 2 }]],
      ["setEntityTransform", ["id", v, v, [1, 2, 3]]],
      ["setEntityTransform", ["id", v, { x: NaN, y: 0, z: 0 }, v]],
      ["setEntityTransform", ["id", v, v, null]],
    ]
    for (const [name, args] of bad) {
      const result = await ipc.invoke(Channels.engineCall, editor, name, args)
      assert.equal(result.ok, false, `${name}(${JSON.stringify(args)}) is refused`)
    }
    assert.equal(client.calls.length, 0)

    // Only x, y and z of a vec3 are passed on
    const ok = await ipc.invoke(Channels.engineCall, editor, "setEntityTransform", [
      "id",
      { ...v, extra: "ignored" },
      v,
      v,
    ])
    assert.equal(ok.ok, true)
    assert.deepEqual(client.calls[0], ["setEntityTransform", ["id", v, v, v]])
  })

  test("pollEvents takes three unsigned 32-bit integers", async () => {
    const { ipc, client, editor } = setup()
    const bad: unknown[][] = [
      [-1, 0, 256],
      [0, 2 ** 32, 256],
      [0, 0, 1.5],
      [0, 0, "256"],
      [0, 0, NaN],
      [0, 0],
      [0, 0, 256, 1],
    ]
    for (const args of bad) {
      const result = await ipc.invoke(Channels.engineCall, editor, "pollEvents", args)
      assert.equal(result.ok, false, `pollEvents(${JSON.stringify(args)}) is refused`)
    }
    assert.equal(client.calls.length, 0)

    const result = await ipc.invoke(Channels.engineCall, editor, "pollEvents", [0xffffffff, 0, 256])
    assert.equal(result.ok, true)
    assert.deepEqual(client.calls, [["pollEvents", [0xffffffff, 0, 256]]])
    assert.equal((result as { value: { events: unknown[] } }).value.events.length, 1)
  })

  test("the scene and project commands are forwarded with checked arguments", async () => {
    const { ipc, client, editor } = setup()
    const scenePath = "res://assets/scenes/main.scene"
    const calls: Array<[string, unknown[]]> = [
      ["openScene", [scenePath]],
      ["saveSceneToFile", [""]],
      ["newScene", [scenePath, "Main"]],
      ["getOpenScene", []],
      ["getProjectInfo", []],
      ["setProjectSettings", [{ physics: { gravity: -9.8, layers: [1, 2, null] }, input: null }]],
      ["setStartupScene", [scenePath]],
    ]
    for (const [name, args] of calls) {
      const result = await ipc.invoke(Channels.engineCall, editor, name, args)
      assert.deepEqual(result, { ok: true, value: { name } }, name)
    }
    assert.deepEqual(client.calls, calls)

    const bad: Array<[string, unknown[]]> = [
      ["openScene", []],
      ["openScene", [42]],
      ["openScene", [["a"]]],
      ["openScene", [scenePath, scenePath]],
      ["saveSceneToFile", [null]],
      ["newScene", [scenePath]],
      ["newScene", [scenePath, 7]],
      ["getOpenScene", [1]],
      ["getProjectInfo", ["x"]],
      ["setStartupScene", [{}]],
      ["setProjectSettings", []],
      ["setProjectSettings", [null]],
      ["setProjectSettings", [[1, 2]]], // a merge patch is an object
      ["setProjectSettings", ["{}"]],
      ["setProjectSettings", [{ a: NaN }]],
      ["setProjectSettings", [{ a: Infinity }]],
      ["setProjectSettings", [{ a: undefined }]],
      ["setProjectSettings", [{ a: () => 1 }]],
      ["setProjectSettings", [{ a: new Date(0) }]],
      ["setProjectSettings", [{ a: { b: new Map() } }]],
      ["setProjectSettings", [{ a: BigInt(1) }]],
    ]
    client.calls.length = 0
    for (const [name, args] of bad) {
      const result = await ipc.invoke(Channels.engineCall, editor, name, args)
      assert.equal(result.ok, false, `${name}(${String(args.length)} args) is refused`)
    }
    assert.equal(client.calls.length, 0)
  })

  test("the hierarchy commands are forwarded with checked arguments", async () => {
    const { ipc, client, editor } = setup()
    const v = { x: 1, y: 2, z: 3 }
    const q = { x: 0, y: 0, z: 0, w: 1 }
    const calls: Array<[string, unknown[]]> = [
      ["getHierarchy", []],
      ["createEntityEx", ["Cube", "", -1, "Cube"]],
      ["createEntityEx", ["", "parent-uuid", 2, "empty"]],
      ["setEntityParent", ["id", "", 0, true]],
      ["setEntityParent", ["id", "parent", -1, false]],
      ["setEntityProperties", ["id", { name: "Hero", active: false, tag: "Player", layer: 3 }]],
      ["duplicateEntity", ["id"]],
      ["getEntity", ["id"]],
      ["setLocalTransform", ["id", v, q, v]],
    ]
    for (const [name, args] of calls) {
      const result = await ipc.invoke(Channels.engineCall, editor, name, args)
      assert.deepEqual(result, { ok: true, value: { name } }, name)
    }
    assert.deepEqual(client.calls, calls)

    const bad: Array<[string, unknown[]]> = [
      ["getHierarchy", ["x"]],
      ["createEntityEx", ["Cube", "", -1]], // too few
      ["createEntityEx", ["Cube", "", 1.5, "Cube"]], // not an integer
      ["createEntityEx", ["Cube", "", 2 ** 31, "Cube"]],
      ["createEntityEx", ["Cube", "", "-1", "Cube"]],
      ["createEntityEx", ["Cube", null, -1, "Cube"]],
      ["createEntityEx", ["Cube", "", -1, ["Cube"]]],
      ["setEntityParent", ["id", "", 0, "true"]], // a boolean, not a string
      ["setEntityParent", ["id", "", 0, 1]],
      ["setEntityParent", ["id", "", 0]],
      ["setEntityProperties", ["id"]],
      ["setEntityProperties", ["id", null]],
      ["setEntityProperties", ["id", [1]]],
      ["setEntityProperties", ["id", "{}"]],
      ["setEntityProperties", ["id", { layer: NaN }]],
      ["duplicateEntity", []],
      ["duplicateEntity", [5]],
      ["getEntity", [{}]],
      ["setLocalTransform", ["id", v, v, v]], // a vec3 where a quaternion is expected
      ["setLocalTransform", ["id", v, { x: 0, y: 0, z: 0 }, v]],
      ["setLocalTransform", ["id", v, { x: 0, y: 0, z: 0, w: NaN }, v]],
      ["setLocalTransform", ["id", v, { x: 0, y: 0, z: 0, w: Infinity }, v]],
      ["setLocalTransform", ["id", v, [0, 0, 0, 1], v]],
      ["setLocalTransform", ["id", v, null, v]],
    ]
    client.calls.length = 0
    for (const [name, args] of bad) {
      const result = await ipc.invoke(Channels.engineCall, editor, name, args)
      assert.equal(result.ok, false, `${name}(${JSON.stringify(args)}) is refused`)
    }
    assert.equal(client.calls.length, 0)

    // Only x, y, z and w of a quaternion are passed on
    const ok = await ipc.invoke(Channels.engineCall, editor, "setLocalTransform", ["id", v, { ...q, extra: 1 }, v])
    assert.equal(ok.ok, true)
    assert.deepEqual(client.calls[0], ["setLocalTransform", ["id", v, q, v]])
  })

  test("the viewport commands are forwarded with checked arguments", async () => {
    const { ipc, client, editor } = setup()
    const v = { x: 1, y: 2, z: 3 }
    const q = { x: 0, y: 0, z: 0, w: 1 }
    const calls: Array<[string, unknown[]]> = [
      ["renderFrameIfChanged", [0]],
      ["renderFrameIfChanged", [4294967295]],
      ["setEditorCamera", [v, q, 60, false, 5, 0.1, 1000]],
      ["getEditorCamera", []],
    ]
    for (const [name, args] of calls) {
      const result = await ipc.invoke(Channels.engineCall, editor, name, args)
      assert.deepEqual(result, { ok: true, value: { name } }, name)
    }
    assert.deepEqual(client.calls, calls)

    const bad: Array<[string, unknown[]]> = [
      ["renderFrameIfChanged", []],
      ["renderFrameIfChanged", [-1]],
      ["renderFrameIfChanged", [1.5]],
      ["renderFrameIfChanged", ["1"]],
      ["renderFrameIfChanged", [2 ** 32]],
      ["setEditorCamera", [v, q, 60, false, 5, 0.1]], // too few
      ["setEditorCamera", [v, v, 60, false, 5, 0.1, 1000]], // a vec3 where a quaternion is expected
      ["setEditorCamera", [v, q, 60, 0, 5, 0.1, 1000]], // a number where a bool is expected
      ["setEditorCamera", [v, q, NaN, false, 5, 0.1, 1000]],
      ["setEditorCamera", [v, q, 60, false, Infinity, 0.1, 1000]],
      ["getEditorCamera", [1]],
    ]
    client.calls.length = 0
    for (const [name, args] of bad) {
      const result = await ipc.invoke(Channels.engineCall, editor, name, args)
      assert.equal(result.ok, false, `${name}(${JSON.stringify(args)}) is refused`)
    }
    assert.equal(client.calls.length, 0)
  })

  test("the component commands are forwarded with checked arguments", async () => {
    const { ipc, client, editor } = setup()
    const values = { isActive: false, intensity: 2, color: { x: 1, y: 0.5, z: 0 }, scriptData: { target: { $ref: null } } }
    const calls: Array<[string, unknown[]]> = [
      ["getComponentTypes", []],
      ["addComponent", ["entity", "Light"]],
      ["removeComponent", ["entity", "component"]],
      ["setComponentFields", ["entity", "component", values]],
      ["setComponentFields", ["entity", "component", {}]],
      ["getComponent", ["entity", "component"]],
      ["getLuaFields", ["entity", "component"]],
    ]
    for (const [name, args] of calls) {
      const result = await ipc.invoke(Channels.engineCall, editor, name, args)
      assert.deepEqual(result, { ok: true, value: { name } }, name)
    }
    assert.deepEqual(client.calls, calls)

    const bad: Array<[string, unknown[]]> = [
      ["getComponentTypes", ["x"]],
      ["addComponent", ["entity"]],
      ["addComponent", ["entity", 5]],
      ["removeComponent", [1, "component"]],
      ["setComponentFields", ["entity", "component"]],
      ["setComponentFields", ["entity", "component", null]],
      ["setComponentFields", ["entity", "component", [1]]],
      ["setComponentFields", ["entity", "component", "{}"]],
      ["setComponentFields", ["entity", "component", { intensity: NaN }]],
      ["setComponentFields", ["entity", "component", { intensity: Infinity }]],
      ["setComponentFields", ["entity", "component", { a: undefined }]],
      ["setComponentFields", ["entity", "component", { a: new Map() }]],
      ["getComponent", ["entity", {}]],
      ["getLuaFields", ["entity"]],
    ]
    client.calls.length = 0
    for (const [name, args] of bad) {
      const result = await ipc.invoke(Channels.engineCall, editor, name, args)
      assert.equal(result.ok, false, `${name}(${JSON.stringify(args)}) is refused`)
    }
    assert.equal(client.calls.length, 0)
  })

  test("the undo, group and autosave commands are forwarded with checked arguments", async () => {
    const { ipc, client, editor } = setup()
    const calls: Array<[string, unknown[]]> = [
      ["undo", []],
      ["redo", []],
      ["beginEditGroup", ["Move 3 objects"]],
      ["endEditGroup", []],
      ["getHistory", []],
      ["getAutosave", []],
      ["restoreAutosave", []],
      ["discardAutosave", []],
    ]
    for (const [name, args] of calls) {
      const result = await ipc.invoke(Channels.engineCall, editor, name, args)
      assert.deepEqual(result, { ok: true, value: { name } }, name)
    }
    assert.deepEqual(client.calls, calls)

    const bad: Array<[string, unknown[]]> = [
      ["undo", ["x"]],
      ["redo", [1]],
      ["beginEditGroup", []],
      ["beginEditGroup", [5]],
      ["beginEditGroup", [["a"]]],
      ["beginEditGroup", [{ length: 1e9 }]],
      ["beginEditGroup", ["a", "b"]],
      ["endEditGroup", ["x"]],
      ["getHistory", [1]],
      ["getAutosave", [1]],
      ["restoreAutosave", ["x"]],
      ["discardAutosave", [null]],
    ]
    client.calls.length = 0
    for (const [name, args] of bad) {
      const result = await ipc.invoke(Channels.engineCall, editor, name, args)
      assert.equal(result.ok, false, `${name}(${JSON.stringify(args)}) is refused`)
    }
    assert.equal(client.calls.length, 0)
  })

  test("entity properties are a fresh plain copy, and a patch of shared references is refused quickly", async () => {
    const { ipc, client, editor } = setup()
    const properties = { name: "Hero" }
    assert.equal((await ipc.invoke(Channels.engineCall, editor, "setEntityProperties", ["id", properties])).ok, true)
    const passed = client.calls[0][1][1] as Record<string, unknown>
    assert.notEqual(passed, properties)
    assert.deepEqual(passed, properties)

    let shared: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < MaxJsonDepth - 2; i++) shared = { a: shared, b: shared }
    client.calls.length = 0
    const started = Date.now()
    assert.equal((await ipc.invoke(Channels.engineCall, editor, "setEntityProperties", ["id", shared])).ok, false)
    assert.ok(Date.now() - started < 2000)
    assert.equal(client.calls.length, 0)
  })

  test("a settings patch is passed on as a fresh plain copy, and too deep a one is refused", async () => {
    const { ipc, client, editor } = setup()
    const patch = JSON.parse('{"__proto__": {"polluted": true}, "a": {"b": [1, {"c": "d"}]}}')
    assert.equal((await ipc.invoke(Channels.engineCall, editor, "setProjectSettings", [patch])).ok, true)
    const passed = client.calls[0][1][0] as Record<string, unknown>
    assert.notEqual(passed, patch)
    assert.deepEqual(JSON.parse(JSON.stringify(passed)), JSON.parse(JSON.stringify(patch)))
    assert.equal(Object.getPrototypeOf(passed), Object.prototype)
    assert.equal(Object.prototype.hasOwnProperty.call(passed, "__proto__"), true)
    assert.equal(({} as Record<string, unknown>).polluted, undefined)

    let deep: Record<string, unknown> = {}
    for (let i = 0; i < MaxJsonDepth + 1; i++) deep = { n: deep }
    client.calls.length = 0
    assert.equal((await ipc.invoke(Channels.engineCall, editor, "setProjectSettings", [deep])).ok, false)
    assert.equal(client.calls.length, 0)
  })

  test("a patch of shared references is refused by its node count, quickly", async () => {
    const { ipc, client, editor } = setup()
    // Each level holds the level below twice: 2^30 values to copy, though only 31 objects and 30 levels deep
    let shared: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < MaxJsonDepth - 2; i++) shared = { a: shared, b: shared }
    const started = Date.now()
    const result = await ipc.invoke(Channels.engineCall, editor, "setProjectSettings", [shared])
    assert.equal(result.ok, false)
    assert.ok(Date.now() - started < 2000)
    assert.equal(client.calls.length, 0)

    // A big but honest patch still goes through
    const wide: Record<string, number> = {}
    for (let i = 0; i < MaxJsonNodes / 2; i++) wide["k" + i] = i
    assert.equal((await ipc.invoke(Channels.engineCall, editor, "setProjectSettings", [wide])).ok, true)
  })

  test("refuses calls from anything but the editor page (its window, main frame and URL)", async () => {
    const { ipc, client, editor } = setup()
    const otherWindow = await ipc.invoke(Channels.engineCall, { mainFrame: {} }, "getCameraPosition", [])
    assert.equal(otherWindow.ok, false)
    const subframe = await ipc.handlers.get(Channels.engineCall)!(
      { sender: editor, senderFrame: {} },
      "getCameraPosition",
      []
    )
    assert.equal(subframe.ok, false)

    // The editor's main frame showing some other page (it navigated, or was redirected)
    editor.mainFrame.url = "https://example.com/"
    assert.equal((await ipc.invoke(Channels.engineCall, editor, "getCameraPosition", [])).ok, false)
    editor.mainFrame.url = PageUrl + "#section"
    assert.equal((await ipc.invoke(Channels.engineCall, editor, "getCameraPosition", [])).ok, true)
    assert.equal(client.calls.length, 1)
  })

  test("connects only to a valid port, on loopback, and pushes the new state to the page", async () => {
    const { host, client, sent } = setup()
    for (const port of [0, 70000, 1.5, NaN]) {
      await assert.rejects(host.connectTo(port, "t"))
    }
    assert.equal(client.connectedTo, null)

    const state = await host.connectTo(1234, "t")
    assert.equal(state.connected, true)
    assert.deepEqual(client.connectedTo, ["127.0.0.1", 1234])
    assert.deepEqual(sent[sent.length - 1], [Channels.engineState, state])
  })

  test("the page can't pick a host: there is no connect channel", () => {
    const { ipc } = setup()
    assert.deepEqual([...ipc.handlers.keys()].sort(), [Channels.engineAttach, Channels.engineCall].sort())
  })

  test("a dropped connection is pushed to the page with a newer epoch", async () => {
    const { host, client, sent } = setup()
    const connected = await host.connectTo(9999, "")
    client.drop()
    const [channel, state] = sent[sent.length - 1] as [string, ConnectionState]
    assert.equal(channel, Channels.engineState)
    assert.equal(state.connected, false)
    assert.ok(state.epoch > connected.epoch)
  })

  test("attaching (a page load) closes a connection the previous page left open, and says so", async () => {
    let attached = 0
    const { ipc, host, client, editor } = setup({ onAttach: () => attached++ })
    await host.connectTo(9999, "")
    const result = (await ipc.invoke(Channels.engineAttach, editor)) as { value: ConnectionState }
    assert.equal(result.value.connected, false)
    assert.equal(client.connected, false)
    assert.equal(attached, 1)
  })
})

describe("EngineHost Hello", () => {
  test("connects with the host's access token, and reports the ServerInfo in the state", async () => {
    const { host, client } = setup()
    const state = await host.connectTo(9999, "the-access-token")
    assert.deepEqual(client.connectOptions, { token: "the-access-token" })
    assert.equal(state.connected, true)
    assert.deepEqual(state.serverInfo, info)
    // The token stays in the main process
    assert.ok(!JSON.stringify(state).includes("the-access-token"))
  })

  test("the token is in nothing sent to the page: results, errors or state pushes", async () => {
    const token = "the-access-token"
    const { ipc, host, client, editor, sent } = setup()
    const results: unknown[] = []
    await host.connectTo(9999, token)
    results.push(await ipc.invoke(Channels.engineCall, editor, "getCameraPosition", []))
    client.drop()
    client.refuseHello = "The editor host refused Hello: Invalid access token"
    await assert.rejects(host.connectTo(9999, token), (e: Error) => !e.message.includes(token))
    results.push(await ipc.invoke(Channels.engineCall, editor, "getCameraPosition", []))
    results.push(await ipc.invoke(Channels.engineAttach, editor))

    assert.ok(sent.length >= 2)
    for (const [channel, value] of sent) {
      assert.equal(channel, Channels.engineState)
      assert.ok(!JSON.stringify(value).includes(token), `state push ${JSON.stringify(value)}`)
    }
    for (const result of results) {
      assert.ok(!JSON.stringify(result).includes(token), `result ${JSON.stringify(result)}`)
    }
  })

  test("a failed Hello rejects, and leaves the page disconnected", async () => {
    const { host, client, sent } = setup()
    client.refuseHello = "The editor host refused Hello: Invalid access token"
    await assert.rejects(host.connectTo(9999, "wrong"), /Invalid access token/)
    const [channel, state] = sent[sent.length - 1] as [string, ConnectionState]
    assert.equal(channel, Channels.engineState)
    assert.equal(state.connected, false)
    assert.equal(state.serverInfo, null)
  })
})

describe("results sent over IPC", () => {
  test("a frame's pixels are copied out of the larger buffer they view", async () => {
    const { ipc, client, editor } = setup()
    // A socket chunk: a frame, with other frames around it
    const chunk = Buffer.alloc(64 * 1024, 0xee)
    const pixels = chunk.subarray(13, 21)
    pixels.set([1, 2, 3, 4, 5, 6, 7, 8])
    client.frame = { width: 2, height: 1, pixels }

    const result = (await ipc.invoke(Channels.engineCall, editor, "renderFrame", [])) as {
      value: { width: number; height: number; pixels: Uint8Array }
    }
    const sent = result.value.pixels
    assert.notEqual(sent.buffer, chunk.buffer)
    assert.equal(sent.byteOffset, 0)
    assert.equal(sent.buffer.byteLength, 8)
    assert.deepEqual([...sent], [1, 2, 3, 4, 5, 6, 7, 8])
    assert.deepEqual({ ...result.value, pixels: null }, { width: 2, height: 1, pixels: null })

    // The copy is independent of the socket's buffer
    chunk.fill(0)
    assert.deepEqual([...sent], [1, 2, 3, 4, 5, 6, 7, 8])
  })

  test("a frame assembled from several chunks is posted without a copy", () => {
    const width = 64
    const height = 64
    const pixels = new Uint8Array(width * height * 4).map((_, i) => i & 0xff)
    const wire = Buffer.from(encodeFrame(ResponseType.FrameData, encodeFrameDataResponse({ width, height, pixels })))

    const reader = new FrameReader()
    const frames = [0, 1000, 9000].flatMap((start, i, starts) =>
      reader.push(wire.subarray(start, starts[i + 1] ?? wire.length))
    )
    assert.equal(frames.length, 1)
    const frame = Commands.RenderFrame.decode(frames[0].payload)
    assert.deepEqual([...frame.pixels], [...pixels])
    assert.equal(frame.pixels.buffer.byteLength - frame.pixels.byteLength, 8, "the payload's own buffer")

    const posted = ownedViews(frame)
    assert.equal(posted.pixels, frame.pixels)
  })

  test("ownedViews copies only views onto a small part of a buffer, wherever they are in the value", () => {
    const whole = new Float32Array([1, 2, 3])
    assert.equal(ownedViews(whole), whole)

    const backing = new ArrayBuffer(MaxUnusedViewBytes + 32)
    const floats = new Float32Array(backing, 8, 2)
    floats.set([0.5, -0.5])
    const value = ownedViews({ list: [{ floats }], view: new DataView(backing, 4, 4), n: 1, s: "s" })
    const copied = value.list[0].floats
    assert.ok(copied instanceof Float32Array)
    assert.equal(copied.buffer.byteLength, 8)
    assert.deepEqual([...copied], [0.5, -0.5])
    assert.equal(value.view.buffer.byteLength, 4)
    assert.equal(value.n, 1)
    assert.equal(value.s, "s")
  })
})
