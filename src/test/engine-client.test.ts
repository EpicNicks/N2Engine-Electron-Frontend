import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import * as net from "node:net"
import { EngineClient, EngineError, MaxRequestPayloadBytes, ShutdownGraceMilliseconds } from "../protocol/engine-client"
import { encodeFrame } from "../protocol/protocol.generated"

// Enough of a net.Socket for EngineClient: data, error and close events, write, end and destroy
class FakeSocket extends EventEmitter {
  destroyed = false
  ended = false
  written: Buffer[] = []

  end(): this {
    this.ended = true
    return this
  }

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

/** A client whose sockets connect on the next turn, or never when autoConnect is false */
function connectFake(autoConnect: boolean = true): { client: EngineClient; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  const client = new EngineClient((_options, onConnect) => {
    const socket = new FakeSocket()
    sockets.push(socket)
    if (autoConnect) setImmediate(onConnect)
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

function frame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.from(encodeFrame(type, payload))
}

describe("EngineClient requests", () => {
  test("responses are matched to requests in order, even when they arrive in one chunk", async () => {
    const { client, sockets } = connectFake()
    await client.connect()

    const first = client.getCameraPosition()
    const second = client.rescanAssets()
    const third = client.getCameraPosition()
    sockets[0].emit(
      "data",
      Buffer.concat([cameraPositionResponse(1, 2, 3), frame(0x00), cameraPositionResponse(4, 5, 6)])
    )

    assert.deepEqual(await first, { x: 1, y: 2, z: 3 })
    await second
    assert.deepEqual(await third, { x: 4, y: 5, z: 6 })
  })

  test("a request goes out as one frame: type, length, payload", async () => {
    const { client, sockets } = connectFake()
    await client.connect()

    const pending = client.setViewportSize(16, 9)
    assert.deepEqual([...sockets[0].written[0]], [0x02, 8, 0, 0, 0, 16, 0, 0, 0, 9, 0, 0, 0])
    sockets[0].emit("data", frame(0x00))
    await pending
  })

  test("an Error response rejects with the server's message", async () => {
    const { client, sockets } = connectFake()
    await client.connect()

    const pending = client.renderFrame()
    sockets[0].emit("data", frame(0x01, Buffer.from("No renderer", "utf-8")))
    await assert.rejects(pending, (e: Error) => e instanceof EngineError && e.message === "No renderer")
  })

  test("GetAudio's 'No audio stream' error is null, not a failure", async () => {
    const { client, sockets } = connectFake()
    await client.connect()

    const pending = client.getAudio()
    sockets[0].emit("data", frame(0x01, Buffer.from("No audio stream: not on a loopback device", "utf-8")))
    assert.equal(await pending, null)
  })

  test("an unexpected response type is an error", async () => {
    const { client, sockets } = connectFake()
    await client.connect()

    const pending = client.getCameraPosition()
    sockets[0].emit("data", frame(0x00))
    await assert.rejects(pending, /GetCameraPosition: expected response type 3, got 0/)
  })

  test("event frames (0xC0+) go to the event listener and don't consume a pending request", async () => {
    const { client, sockets } = connectFake()
    await client.connect()
    const events: number[] = []
    client.onEvent((f) => events.push(f.type))

    const pending = client.getCameraPosition()
    sockets[0].emit("data", Buffer.concat([frame(0xc0, Buffer.from("{}")), cameraPositionResponse(7, 8, 9)]))
    assert.deepEqual(await pending, { x: 7, y: 8, z: 9 })
    assert.deepEqual(events, [0xc0])
  })

  test("requests without a connection fail immediately", async () => {
    const { client } = connectFake()
    await assert.rejects(client.getCameraPosition(), /Not connected/)
  })

  test("the server closing the connection rejects pending requests and notifies close listeners", async () => {
    const { client, sockets } = connectFake()
    await client.connect()
    let closes = 0
    client.onClose(() => closes++)

    const pending = client.getCameraPosition()
    sockets[0].destroy()
    await assert.rejects(pending, /Connection closed/)
    assert.equal(closes, 1)
    assert.equal(client.isConnected, false)
  })

  test("a frame over the size limit closes the connection", async () => {
    const { client, sockets } = connectFake()
    await client.connect()

    const pending = client.renderFrame()
    const header = Buffer.alloc(5)
    header.writeUInt8(0x02, 0)
    header.writeUInt32LE(0xffffffff, 1)
    sockets[0].emit("data", header)
    await assert.rejects(pending, /claims 4294967295 payload bytes/)
    assert.equal(client.isConnected, false)
  })
})

describe("EngineClient connect always settles", () => {
  test("close() while connecting rejects the connect", async () => {
    const { client } = connectFake(false)
    const connecting = client.connect()
    client.close()
    await assert.rejects(connecting, /Disconnected/)
    assert.equal(client.isConnected, false)
  })

  test("a second connect() while the first is connecting rejects the first", async () => {
    const { client, sockets } = connectFake(false)
    const first = client.connect()
    const second = client.connect()
    await assert.rejects(first, /Reconnected/)
    assert.equal(sockets[0].destroyed, true)
    // The second socket never connects; closing it settles that connect too
    sockets[1].destroy()
    await assert.rejects(second, /Connection closed before it opened/)
  })

  test("a socket that closes before connecting, with no error, rejects the connect", async () => {
    const { client, sockets } = connectFake(false)
    const connecting = client.connect()
    sockets[0].destroy()
    await assert.rejects(connecting, /Connection closed before it opened/)
  })
})

describe("EngineClient disconnect", () => {
  test("writes Shutdown and ends the socket, destroying it on the reply", async () => {
    const { client, sockets } = connectFake()
    await client.connect()
    const pending = client.getCameraPosition()

    client.disconnect()
    await assert.rejects(pending, /Disconnected/)
    assert.equal(client.isConnected, false)
    const socket = sockets[0]
    assert.deepEqual([...socket.written[socket.written.length - 1]], [0xff, 0, 0, 0, 0])
    assert.equal(socket.ended, true)
    assert.equal(socket.destroyed, false, "not destroyed before the Shutdown reply")

    socket.emit("data", frame(0x00))
    assert.equal(socket.destroyed, true)
  })

  test("destroys the socket after the grace period when no reply comes", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const { client, sockets } = connectFake()
    const connecting = client.connect()
    // setImmediate isn't mocked, so the fake socket still connects
    await connecting
    client.disconnect()
    assert.equal(sockets[0].destroyed, false)
    t.mock.timers.tick(ShutdownGraceMilliseconds)
    assert.equal(sockets[0].destroyed, true)
  })
})

describe("EngineClient request limits", () => {
  test("a payload over the engine's limit is refused without desyncing the queue", async () => {
    const { client, sockets } = connectFake()
    await client.connect()

    await assert.rejects(client.sendRaw(0x21, new Uint8Array(MaxRequestPayloadBytes + 1)), /payload too large/)
    assert.equal(sockets[0].written.length, 0)
    const next = client.getCameraPosition()
    sockets[0].emit("data", cameraPositionResponse(1, 2, 3))
    assert.deepEqual(await next, { x: 1, y: 2, z: 3 })
  })
})
