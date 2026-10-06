import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import * as net from "node:net"
import { EngineClient } from "../engine-client"

// Enough of a net.Socket for EngineClient: data, error and close events, write and destroy
class FakeSocket extends EventEmitter {
  destroyed = false
  written: Buffer[] = []

  write(data: Buffer): boolean {
    this.written.push(data)
    return true
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true
      // Like a real socket, close arrives asynchronously, so it can land after a reconnect
      setImmediate(() => this.emit("close"))
    }
    return this
  }
}

function connectFake(): { client: EngineClient; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  const client = new EngineClient((_options, onConnect) => {
    const socket = new FakeSocket()
    sockets.push(socket)
    setImmediate(onConnect)
    return socket as unknown as net.Socket
  })
  return { client, sockets }
}

// A CameraPosition response (0x03): three float32s
function cameraPositionResponse(x: number, y: number, z: number): Buffer {
  const response = Buffer.alloc(5 + 12)
  response.writeUInt8(0x03, 0)
  response.writeUInt32LE(12, 1)
  response.writeFloatLE(x, 5)
  response.writeFloatLE(y, 9)
  response.writeFloatLE(z, 13)
  return response
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe("EngineClient reconnects", () => {
  test("a partial response from a dropped connection doesn't corrupt the next one", async () => {
    const { client, sockets } = connectFake()
    await client.connect()

    const first = client.getCameraPosition()
    sockets[0].emit("data", cameraPositionResponse(9, 9, 9).subarray(0, 7)) // cut off mid-response
    sockets[0].destroy()
    await assert.rejects(first, /Connection closed/)

    await client.connect()
    const second = client.getCameraPosition()
    sockets[1].emit("data", cameraPositionResponse(1, 2, 3))
    assert.deepEqual(await second, { x: 1, y: 2, z: 3 })
  })

  test("the old socket's late close doesn't touch the new connection", async () => {
    const { client, sockets } = connectFake()
    await client.connect()

    const stale = client.getCameraPosition()
    sockets[0].emit("data", cameraPositionResponse(9, 9, 9).subarray(0, 3))

    // Reconnect before the first socket's close event has fired
    const reconnected = client.connect()
    await assert.rejects(stale, /Reconnected/)
    await reconnected
    const pending = client.getCameraPosition()
    await tick() // the old socket's close fires now
    await tick()

    assert.equal(client.isConnected, true)
    sockets[1].emit("data", cameraPositionResponse(4, 5, 6))
    assert.deepEqual(await pending, { x: 4, y: 5, z: 6 })

    // And the old socket's data is ignored
    sockets[0].emit("data", cameraPositionResponse(7, 7, 7))
    const next = client.getCameraPosition()
    sockets[1].emit("data", cameraPositionResponse(1, 1, 1))
    assert.deepEqual(await next, { x: 1, y: 1, z: 1 })
  })

  test("disconnect rejects pending requests", async () => {
    const { client } = connectFake()
    await client.connect()

    const pending = client.getCameraPosition()
    client.disconnect()
    await assert.rejects(pending, /Disconnected/)
    assert.equal(client.isConnected, false)
  })
})
