// A Hello answered with ErrorCoded busy (protocol 1.13): the host is serving another session. Against a host stand-in
// on a loopback socket; the codec is checked against the engine's golden ErrorCoded vector.
import { test, describe, before, after } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { EngineClient, HelloError, HostBusyError, busyHolderRole } from "../protocol/engine-client"
import { FrameReader } from "../protocol/framing"
import {
  CommandType,
  PROTOCOL_VERSION,
  ResponseCodecs,
  ResponseType,
  decodeErrorCodedResponse,
  encodeErrorCodedResponse,
  encodeErrorResponse,
  encodeFrame,
} from "../protocol/protocol.generated"
import { errorCode } from "../main/ipc"

const HOST_TEXT = "The host is serving another session (a viewer session); try again later"
const fromHex = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"))

describe("the golden ErrorCoded vector (protocol 1.13)", () => {
  const vectorsPath = path.join(__dirname, "..", "..", "src", "protocol", "test-vectors.json")
  const vectors = JSON.parse(fs.readFileSync(vectorsPath, "utf-8")) as {
    protocolVersion: string
    responses: Array<{ response: string; payload: string; fields: { message: string; code: string } }>
  }

  test("the vectors and the client are at the same version (1.17.0)", () => {
    assert.equal(vectors.protocolVersion, "1.17.0")
    assert.equal(PROTOCOL_VERSION, "1.17.0")
  })

  test("the vector decodes, and a busy answer round-trips through the same codec", () => {
    const vector = vectors.responses.find((v) => v.response === "ErrorCoded")!
    assert.deepEqual(ResponseCodecs.ErrorCoded.decode(fromHex(vector.payload)), vector.fields)
    const busy = { message: HOST_TEXT, code: "busy" }
    assert.deepEqual(decodeErrorCodedResponse(encodeErrorCodedResponse(busy)), busy)
  })
})

describe("busyHolderRole", () => {
  test("takes only one of the three known roles from the text", () => {
    assert.equal(busyHolderRole(HOST_TEXT), "viewer")
    assert.equal(busyHolderRole("The host is serving another session (an admin session); try again later"), "admin")
    assert.equal(busyHolderRole("The host is serving another session (an editor session); try again later"), "editor")
  })

  test("any other text gives no role, so nothing from the host is ever shown", () => {
    assert.equal(busyHolderRole("The host is serving another session; try again later"), undefined)
    assert.equal(busyHolderRole("The host is serving another session (a <b>root</b> session)"), undefined)
    assert.equal(busyHolderRole("(a superuser session)"), undefined)
    assert.equal(busyHolderRole(""), undefined)
  })
})

describe("EngineClient connect against a host that answers Hello with busy", () => {
  let answer: Buffer = Buffer.alloc(0)
  let server: net.Server
  let port = 0
  const hellos: number[] = []

  before(async () => {
    server = net.createServer((socket) => {
      const reader = new FrameReader()
      socket.on("data", (chunk: Buffer) => {
        for (const frame of reader.push(chunk)) {
          if (frame.type === CommandType.Hello) {
            hellos.push(frame.payload.length)
            socket.write(answer)
            socket.end() // the host closes the connection after a busy answer
          }
        }
      })
      socket.on("error", () => {})
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as net.AddressInfo).port
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const reply = (type: number, payload: Uint8Array): void => {
    answer = Buffer.from(encodeFrame(type, payload))
  }

  test("ErrorCoded busy rejects with a HostBusyError carrying the role, not a HelloError", async () => {
    reply(ResponseType.ErrorCoded, encodeErrorCodedResponse({ message: HOST_TEXT, code: "busy" }))
    const client = new EngineClient()
    await assert.rejects(client.connect("127.0.0.1", port, { token: "right" }), (e: Error) => {
      assert.ok(e instanceof HostBusyError)
      assert.ok(!(e instanceof HelloError))
      assert.equal(e.holderRole, "viewer")
      assert.equal(e.code, "busy")
      assert.equal(e.message, "The host is busy with another session (a viewer session)")
      assert.equal(new HostBusyError("admin").message, "The host is busy with another session (an admin session)")
      assert.equal(new HostBusyError("editor").message, "The host is busy with another session (an editor session)")
      return true
    })
    assert.equal(client.isConnected, false)
  })

  test("a busy answer with a text that names no known role still is busy, and shows none", async () => {
    reply(ResponseType.ErrorCoded, encodeErrorCodedResponse({ message: "<script>x</script>", code: "busy" }))
    const client = new EngineClient()
    await assert.rejects(client.connect("127.0.0.1", port, { token: "right" }), (e: Error) => {
      assert.ok(e instanceof HostBusyError)
      assert.equal(e.holderRole, undefined)
      assert.equal(e.message, "The host is busy with another session")
      return true
    })
  })

  test("the code is the contract: other coded and plain refusals of a Hello stay HelloErrors", async () => {
    for (const answerFrame of [
      () => reply(ResponseType.ErrorCoded, encodeErrorCodedResponse({ message: HOST_TEXT, code: "forbidden" })),
      () => reply(ResponseType.ErrorCoded, encodeErrorCodedResponse({ message: "Invalid access token", code: "" })),
      () => reply(ResponseType.Error, encodeErrorResponse({ message: "Invalid access token" })),
      // A plain Error with the busy text is not busy: only the code says so
      () => reply(ResponseType.Error, encodeErrorResponse({ message: HOST_TEXT })),
    ]) {
      answerFrame()
      const client = new EngineClient()
      await assert.rejects(client.connect("127.0.0.1", port, { token: "wrong" }), (e: Error) => {
        assert.ok(e instanceof HelloError, e.message)
        assert.ok(!(e instanceof HostBusyError))
        return true
      })
    }
  })

  test("the token went only in Hello, once per connect", async () => {
    hellos.length = 0
    reply(ResponseType.ErrorCoded, encodeErrorCodedResponse({ message: HOST_TEXT, code: "busy" }))
    const client = new EngineClient()
    await assert.rejects(client.connect("127.0.0.1", port, { token: "right" }))
    assert.equal(hellos.length, 1)
  })
})

describe("the code crossing IPC", () => {
  test("a HostBusyError carries busy; auth errors carry nothing", () => {
    assert.equal(errorCode(new HostBusyError("editor")), "busy")
    assert.equal(errorCode(new HelloError("Invalid access token")), undefined)
    assert.equal(errorCode(new Error("The pinned certificate does not match")), undefined)
  })
})
