// The asset commands of EngineClient (protocol 1.9.0), against a host stand-in on a loopback socket: the requests it
// sends, the answers it validates, and the host's Error responses as EngineError.
import { test, describe, before, after } from "node:test"
import * as assert from "node:assert/strict"
import * as net from "node:net"
import { EngineClient, EngineError } from "../protocol/engine-client"
import { FrameReader } from "../protocol/framing"
import {
  CommandType,
  PROTOCOL_VERSION,
  ResponseType,
  decodeCreateFolderRequest,
  decodeCreateScriptAssetRequest,
  decodeGetAssetInfoRequest,
  decodeListAssetsRequest,
  decodeReadTextAssetRequest,
  decodeSetImportSettingsRequest,
  decodeWriteTextAssetRequest,
  encodeAssetCreatedResponse,
  encodeAssetDetailResponse,
  encodeAssetListResponse,
  encodeErrorResponse,
  encodeFrame,
  encodeOkResponse,
  encodeServerInfoResponse,
  encodeTextDataResponse,
  encodeWriteTextAssetRequest,
} from "../protocol/protocol.generated"

describe("EngineClient asset commands", () => {
  const requests: Array<{ type: number; payload: Buffer }> = []
  /** What the stand-in answers to the next command, as a whole frame */
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
                  capabilities: [],
                  projectLoaded: true,
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

  const info = { path: "res://a.png", uuid: "11111111-1111-1111-1111-111111111111", type: "Texture", size: 4, modified: 1 }

  test("listAssets sends the folder and recursive, and answers the validated listing", async () => {
    const client = await connected()
    reply(ResponseType.AssetList, encodeAssetListResponse({ folders: ["res://x"], assets: [info] }))
    const list = await client.listAssets("res://", true)
    assert.deepEqual(list, { folders: ["res://x"], assets: [info] })
    assert.equal(requests[0].type, CommandType.ListAssets)
    assert.deepEqual(decodeListAssetsRequest(requests[0].payload), { folder: "res://", recursive: true })
  })

  test("an answer of the wrong shape is refused", async () => {
    const client = await connected()
    reply(ResponseType.AssetList, encodeAssetListResponse({ folders: [], assets: [{ ...info, size: -1 }] }))
    await assert.rejects(client.listAssets("", true), /size must be a non-negative number/)
  })

  test("getAssetInfo asks by path or UUID and answers the details", async () => {
    const client = await connected()
    reply(ResponseType.AssetDetail, encodeAssetDetailResponse({ info: { ...info, customData: { a: 1 }, loaded: true } }))
    const details = await client.getAssetInfo("res://a.png")
    assert.deepEqual(details, { ...info, customData: { a: 1 }, loaded: true })
    assert.deepEqual(decodeGetAssetInfoRequest(requests[0].payload), { uuidOrPath: "res://a.png" })
  })

  test("setImportSettings sends the object", async () => {
    const client = await connected()
    reply(ResponseType.Ok, encodeOkResponse({}))
    await client.setImportSettings("res://a.png", { sRGB: false })
    assert.equal(requests[0].type, CommandType.SetImportSettings)
    assert.deepEqual(decodeSetImportSettingsRequest(requests[0].payload), { path: "res://a.png", customData: { sRGB: false } })
  })

  test("text is read and written exactly, a BOM, CRLF and non-ASCII included", async () => {
    const client = await connected()
    const text = "﻿-- café 😀\r\nprint(1)\r\n"
    reply(ResponseType.TextData, encodeTextDataResponse({ text }))
    assert.equal(await client.readTextAsset("res://a.lua"), text)
    assert.deepEqual(decodeReadTextAssetRequest(requests[0].payload), { path: "res://a.lua" })

    reply(ResponseType.Ok, encodeOkResponse({}))
    await client.writeTextAsset("res://a.lua", text)
    // The bytes carry the BOM (compared as bytes, so a reader that dropped it would show)
    const sent = requests[1].payload
    assert.equal(decodeWriteTextAssetRequest(sent).path, "res://a.lua")
    assert.ok(sent.includes(Buffer.from([0xef, 0xbb, 0xbf])), "the BOM was written")
    assert.ok(sent.equals(Buffer.from(encodeWriteTextAssetRequest({ path: "res://a.lua", text }))))
  })

  test("createScriptAsset answers the path and UUID the host chose", async () => {
    const client = await connected()
    reply(ResponseType.AssetCreated, encodeAssetCreatedResponse({ path: "res://Scripts/My_enemy.lua", uuid: "u" }))
    assert.deepEqual(await client.createScriptAsset("res://scripts/enemy.lua", "my enemy"), {
      path: "res://Scripts/My_enemy.lua",
      uuid: "u",
    })
    assert.deepEqual(decodeCreateScriptAssetRequest(requests[0].payload), {
      path: "res://scripts/enemy.lua",
      className: "my enemy",
    })
  })

  test("createFolder sends the path", async () => {
    const client = await connected()
    reply(ResponseType.Ok, encodeOkResponse({}))
    await client.createFolder("res://a/b")
    assert.deepEqual(decodeCreateFolderRequest(requests[0].payload), { path: "res://a/b" })
  })

  test("the host's Error responses reject with its message, and the connection carries on", async () => {
    const client = await connected()
    reply(ResponseType.Error, encodeErrorResponse({ message: "res://a.png is not a text file" }))
    await assert.rejects(client.readTextAsset("res://a.png"), (e: unknown) => {
      assert.ok(e instanceof EngineError)
      assert.equal(e.message, "res://a.png is not a text file")
      return true
    })
    reply(ResponseType.Ok, encodeOkResponse({}))
    await client.createFolder("res://ok")
    assert.equal(client.isConnected, true)
  })
})
