// The editor tooling commands of EngineClient (protocol 1.17.0), against a host stand-in on a loopback socket: the
// requests it sends, the answers it validates and the host's Error responses.
import { test, describe, before, after } from "node:test"
import * as assert from "node:assert/strict"
import * as net from "node:net"
import { EngineClient, EngineError } from "../protocol/engine-client"
import { FrameReader } from "../protocol/framing"
import {
  CommandType,
  PROTOCOL_VERSION,
  ResponseType,
  decodeCheckLuaSyntaxRequest,
  decodeInstantiateEntitiesRequest,
  decodeSerializeEntitiesRequest,
  encodeEntitiesCreatedResponse,
  encodeSerializedEntitiesResponse,
  decodeGetAssetPreviewRequest,
  decodeSetEditorViewOptionsRequest,
  encodeAssetPreviewResponse,
  encodeErrorResponse,
  encodeFrame,
  encodeLuaSyntaxResponse,
  encodeOkResponse,
  encodeServerInfoResponse,
} from "../protocol/protocol.generated"

describe("EngineClient editor tooling commands", () => {
  const requests: Array<{ type: number; payload: Buffer }> = []
  let answer: Buffer = Buffer.alloc(0)
  let server: net.Server
  let port = 0
  const clients: EngineClient[] = []
  const reply = (type: number, payload: Uint8Array): void => {
    answer = Buffer.from(encodeFrame(type, payload))
  }

  before(async () => {
    server = net.createServer((socket) => {
      const reader = new FrameReader()
      socket.on("data", (chunk: Buffer) => {
        for (const frame of reader.push(chunk)) {
          if (frame.type === CommandType.Hello) {
            socket.write(
              encodeFrame(
                ResponseType.ServerInfo,
                encodeServerInfoResponse({
                  protocolVersion: PROTOCOL_VERSION,
                  engineVersion: "1.0.0",
                  capabilities: ["editorTooling", "luaSyntax", "assetPreviews"],
                  projectLoaded: true,
                  readOnly: false,
                  user: "",
                  role: "",
                })
              )
            )
          } else {
            requests.push({ type: frame.type, payload: Buffer.from(frame.payload) })
            socket.write(answer)
          }
        }
      })
      socket.on("error", () => {})
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as net.AddressInfo).port
  })

  after(async () => {
    for (const client of clients) client.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  async function connected(): Promise<EngineClient> {
    const client = new EngineClient()
    clients.push(client)
    await client.connect("127.0.0.1", port, {})
    requests.length = 0
    return client
  }

  test("the generated protocol is 1.17.0 or later", () => {
    assert.match(PROTOCOL_VERSION, /^1\.(1[7-9]|[2-9]\d)\./)
  })

  test("setEditorViewOptions sends the wireframe flag", async () => {
    const client = await connected()
    reply(ResponseType.Ok, encodeOkResponse({}))
    await client.setEditorViewOptions(true)
    assert.equal(requests[0].type, CommandType.SetEditorViewOptions)
    assert.deepEqual(decodeSetEditorViewOptionsRequest(requests[0].payload), { wireframe: true })
  })

  test("checkLuaSyntax sends text and chunk name and answers the validated result", async () => {
    const client = await connected()
    reply(ResponseType.LuaSyntax, encodeLuaSyntaxResponse({ result: { ok: false, line: 2, column: 4, message: "unexpected symbol" } }))
    const result = await client.checkLuaSyntax("x =\n= 1", "res://a.lua")
    assert.deepEqual(result, { ok: false, line: 2, column: 4, message: "unexpected symbol" })
    assert.deepEqual(decodeCheckLuaSyntaxRequest(requests[0].payload), { text: "x =\n= 1", chunkName: "res://a.lua" })
    reply(ResponseType.LuaSyntax, encodeLuaSyntaxResponse({ result: { ok: "no" } as never }))
    await assert.rejects(client.checkLuaSyntax("x", "a.lua"), /ok must be a boolean/)
  })

  test("getAssetPreview answers a texture's pixels and refuses an answer that doesn't fit the request", async () => {
    const client = await connected()
    const pixels = new Uint8Array(2 * 1 * 4).fill(7)
    const info = { kind: "texture", uuid: "u", path: "res://a.png", modified: 9, width: 2, height: 1, sourceWidth: 8, sourceHeight: 4 }
    reply(ResponseType.AssetPreview, encodeAssetPreviewResponse({ info, pixels }))
    const preview = await client.getAssetPreview("res://a.png", 64)
    assert.equal(preview.kind, "texture")
    if (preview.kind === "texture") assert.deepEqual([...preview.pixels], [...pixels])
    assert.deepEqual(decodeGetAssetPreviewRequest(requests[0].payload), { uuidOrPath: "res://a.png", maxSize: 64 })
    await assert.rejects(client.getAssetPreview("res://a.png", 1), /doesn't fit the requested 1/)
  })

  test("getAssetPreview answers an audio clip's peaks, and a size outside 1..256 sends nothing", async () => {
    const client = await connected()
    const info = { kind: "audio", uuid: "u", path: "res://a.wav", modified: 9, durationMs: 100, channels: 1, sampleRate: 8000, peaks: [{ min: -1, max: 1 }] }
    reply(ResponseType.AssetPreview, encodeAssetPreviewResponse({ info, pixels: new Uint8Array(0) }))
    const preview = await client.getAssetPreview("u", 8)
    assert.deepEqual(preview.kind === "audio" && preview.peaks, [{ min: -1, max: 1 }])
    requests.length = 0
    await assert.rejects(client.getAssetPreview("u", 0), /1 to 256/)
    await assert.rejects(client.getAssetPreview("u", 257), /1 to 256/)
    assert.equal(requests.length, 0)
  })

  test("the host's refusal is an EngineError", async () => {
    const client = await connected()
    reply(ResponseType.Error, encodeErrorResponse({ message: "Unsupported asset type" }))
    await assert.rejects(client.getAssetPreview("res://a.mesh", 64), (e) => e instanceof EngineError && /Unsupported/.test(e.message))
  })

  test("serializeEntities sends the ids and answers the payload (protocol 1.18.0)", async () => {
    const client = await connected()
    const clipboard = { format: "n2engine.entities", version: 1, objectCount: 1, entities: [{ uuid: "a" }] }
    reply(ResponseType.SerializedEntities, encodeSerializedEntitiesResponse({ clipboard }))
    assert.deepEqual(await client.serializeEntities(["a", "b"]), clipboard)
    assert.equal(requests[0].type, CommandType.SerializeEntities)
    assert.deepEqual(decodeSerializeEntitiesRequest(requests[0].payload), { ids: ["a", "b"] })
  })

  test("instantiateEntities sends the text, the place and the flag, and answers the new ids", async () => {
    const client = await connected()
    reply(ResponseType.EntitiesCreated, encodeEntitiesCreatedResponse({ ids: ["n1", "n2"] }))
    assert.deepEqual(await client.instantiateEntities('{"format":"n2engine.entities"}', "p", 3, true), ["n1", "n2"])
    assert.equal(requests[0].type, CommandType.InstantiateEntities)
    assert.deepEqual(decodeInstantiateEntitiesRequest(requests[0].payload), {
      clipboard: '{"format":"n2engine.entities"}',
      parentId: "p",
      siblingIndex: 3,
      keepExternalRefs: true,
    })
  })

  test("the host's refusal of a payload is an EngineError", async () => {
    const client = await connected()
    reply(ResponseType.Error, encodeErrorResponse({ message: "Clipboard payload is too large" }))
    await assert.rejects(client.instantiateEntities("{}", "", -1, false), (e) => e instanceof EngineError && /too large/.test(e.message))
  })
})
