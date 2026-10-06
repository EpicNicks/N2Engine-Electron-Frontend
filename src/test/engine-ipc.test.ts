import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { IpcMain, WebContents } from "electron"
import { EngineHost } from "../main/engine-ipc"
import { EngineClient } from "../protocol/engine-client"
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

/** Just the EngineClient surface EngineHost uses */
class FakeClient {
  connected = false
  calls: Array<[string, unknown[]]> = []
  connectedTo: [string, number] | null = null
  private closeListeners: Array<() => void> = []

  get isConnected(): boolean {
    return this.connected
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener)
  }

  async connect(host: string, port: number): Promise<void> {
    this.connectedTo = [host, port]
    this.connected = true
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
}

function setup() {
  const sent: Array<[string, unknown]> = []
  const editor = {
    mainFrame: {},
    isDestroyed: () => false,
    send: (channel: string, value: unknown) => sent.push([channel, value]),
  }
  const client = new FakeClient()
  const host = new EngineHost(client as unknown as EngineClient, () => editor as unknown as WebContents)
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

  test("refuses calls from anything but the editor window's main frame", async () => {
    const { ipc, client, editor } = setup()
    const otherWindow = await ipc.invoke(Channels.engineCall, { mainFrame: {} }, "getCameraPosition", [])
    assert.equal(otherWindow.ok, false)
    const subframe = await ipc.handlers.get(Channels.engineCall)!(
      { sender: editor, senderFrame: {} },
      "getCameraPosition",
      []
    )
    assert.equal(subframe.ok, false)
    assert.equal(client.calls.length, 0)
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
