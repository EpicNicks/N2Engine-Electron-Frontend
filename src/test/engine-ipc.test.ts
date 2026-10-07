import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { IpcMain, WebContents } from "electron"
import { EngineHost, EngineHostOptions, ownedViews } from "../main/engine-ipc"
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
  return { ipc, client, editor, sent }
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

  test("connects only to this machine, on a valid port", async () => {
    const { ipc, client, editor } = setup()
    assert.equal((await ipc.invoke(Channels.engineConnect, editor, "example.com", 9999)).ok, false)
    assert.equal((await ipc.invoke(Channels.engineConnect, editor, "localhost", 70000)).ok, false)
    assert.equal((await ipc.invoke(Channels.engineConnect, editor, "localhost", "9999")).ok, false)
    assert.equal(client.connectedTo, null)

    const result = await ipc.invoke(Channels.engineConnect, editor, "127.0.0.1", 1234)
    assert.equal(result.ok, true)
    assert.equal((result as { value: ConnectionState }).value.connected, true)
    assert.deepEqual(client.connectedTo, ["127.0.0.1", 1234])
  })

  test("a dropped connection is pushed to the page with a newer epoch", async () => {
    const { ipc, client, editor, sent } = setup()
    const connected = (await ipc.invoke(Channels.engineConnect, editor, "localhost", 9999)) as {
      value: ConnectionState
    }
    client.drop()
    assert.equal(sent.length, 1)
    const [channel, state] = sent[0] as [string, ConnectionState]
    assert.equal(channel, Channels.engineState)
    assert.equal(state.connected, false)
    assert.ok(state.epoch > connected.value.epoch)
  })

  test("attaching (a page load) closes a connection the previous page left open", async () => {
    const { ipc, client, editor } = setup()
    await ipc.invoke(Channels.engineConnect, editor, "localhost", 9999)
    const result = (await ipc.invoke(Channels.engineAttach, editor)) as { value: ConnectionState }
    assert.equal(result.value.connected, false)
    assert.equal(client.connected, false)
  })
})

describe("EngineHost Hello", () => {
  test("connects with the host's access token, and reports the ServerInfo in the state", async () => {
    const { ipc, client, editor } = setup({ token: "the-access-token" })
    const result = (await ipc.invoke(Channels.engineConnect, editor, "localhost", 9999)) as { value: ConnectionState }
    assert.deepEqual(client.connectOptions, { token: "the-access-token" })
    assert.equal(result.value.connected, true)
    assert.deepEqual(result.value.serverInfo, info)
    // The token stays in the main process
    assert.ok(!JSON.stringify(result).includes("the-access-token"))
  })

  test("without a token, Hello carries none", async () => {
    const { ipc, client, editor } = setup()
    await ipc.invoke(Channels.engineConnect, editor, "localhost", 9999)
    assert.deepEqual(client.connectOptions, { token: undefined })
  })

  test("a failed Hello is an error result, and leaves the page disconnected", async () => {
    const { ipc, client, editor, sent } = setup({ token: "wrong" })
    client.refuseHello = "The editor host refused Hello: Invalid access token"
    const result = await ipc.invoke(Channels.engineConnect, editor, "localhost", 9999)
    assert.deepEqual(result, { ok: false, error: "The editor host refused Hello: Invalid access token" })
    const [channel, state] = sent[sent.length - 1] as [string, ConnectionState]
    assert.equal(channel, Channels.engineState)
    assert.equal(state.connected, false)
    assert.equal(state.serverInfo, null)
  })
})

describe("results sent over IPC", () => {
  test("a frame's pixels are copied out of the larger buffer they view", async () => {
    const { ipc, client, editor } = setup()
    const chunk = Buffer.alloc(64, 0xee)
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

  test("ownedViews copies only views onto part of a buffer, wherever they are in the value", () => {
    const whole = new Float32Array([1, 2, 3])
    assert.equal(ownedViews(whole), whole)

    const backing = new ArrayBuffer(32)
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
