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
  decodeApplyPrefabRequest,
  decodeCreatePrefabRequest,
  decodeInstantiateEntitiesRequest,
  decodeInstantiatePrefabRequest,
  decodeUnpackPrefabRequest,
  decodeSetPhysicsBackendRequest,
  decodeSetNetworkSettingsRequest,
  decodeGetNetworkValidationRequest,
  encodeNetworkSettingsResponse,
  encodeNetworkValidationResponse,
  type NetworkSettingsInfo,
  type NetworkValidationReport,
  encodePhysicsBackendsResponse,
  type PhysicsBackendsInfo,
  encodeAssetCreatedResponse,
  encodeEntityCreatedResponse,
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
  test("createPrefab sends the object, the path and the flag, and answers the file's path and UUID (protocol 1.19.0)", async () => {
    const client = await connected()
    reply(ResponseType.AssetCreated, encodeAssetCreatedResponse({ path: "res://prefabs/A.prefab", uuid: "u-1" }))
    assert.deepEqual(await client.createPrefab("e1", "res://prefabs/A.prefab", true), { path: "res://prefabs/A.prefab", uuid: "u-1" })
    assert.equal(requests[0].type, CommandType.CreatePrefab)
    assert.deepEqual(decodeCreatePrefabRequest(requests[0].payload), { entityId: "e1", path: "res://prefabs/A.prefab", overwrite: true })
  })

  test("instantiatePrefab sends the prefab, the place and the position, and answers the new root's id", async () => {
    const client = await connected()
    reply(ResponseType.EntityCreated, encodeEntityCreatedResponse({ entityId: "new1" }))
    assert.equal(await client.instantiatePrefab("u-1", "p", 2, true, { x: 1, y: 2, z: 3 }), "new1")
    assert.equal(requests[0].type, CommandType.InstantiatePrefab)
    assert.deepEqual(decodeInstantiatePrefabRequest(requests[0].payload), {
      uuidOrPath: "u-1",
      parentId: "p",
      siblingIndex: 2,
      hasPosition: true,
      position: { x: 1, y: 2, z: 3 },
    })
  })

  test("applyPrefab and unpackPrefab send the object's id", async () => {
    const client = await connected()
    reply(ResponseType.Ok, encodeOkResponse({}))
    await client.applyPrefab("e1")
    assert.equal(requests[0].type, CommandType.ApplyPrefab)
    assert.deepEqual(decodeApplyPrefabRequest(requests[0].payload), { entityId: "e1" })
    await client.unpackPrefab("e2")
    assert.equal(requests[1].type, CommandType.UnpackPrefab)
    assert.deepEqual(decodeUnpackPrefabRequest(requests[1].payload), { entityId: "e2" })
  })

  test("a play host's refusal of CreatePrefab is an EngineError", async () => {
    const client = await connected()
    reply(ResponseType.Error, encodeErrorResponse({ message: "Not available in a play host" }))
    await assert.rejects(client.createPrefab("e1", "res://a.prefab", false), (e) => e instanceof EngineError && /play host/.test(e.message))
  })

  const backendsInfo: PhysicsBackendsInfo = {
    current: "physx",
    configured: false,
    active: "physx",
    restartRequired: false,
    networkPreset: "",
    backends: [
      {
        id: "physx",
        displayName: "PhysX",
        compiledIn: true,
        determinism: "SameBinary",
        determinismDefault: "None",
        features: ["layers", "triggers"],
        missingFeatures: ["events", "queries"],
        supportsSnapshot: true,
        supportsSetState: false,
        deterministicSelectable: false,
      },
      {
        id: "jolt",
        displayName: "Jolt",
        compiledIn: false,
        determinism: "None",
        determinismDefault: "None",
        features: [],
        missingFeatures: ["layers", "triggers", "events", "queries"],
        supportsSnapshot: false,
        supportsSetState: false,
        deterministicSelectable: false,
        note: "Not compiled into this host; what it declares is unknown",
      },
    ],
  }

  test("getPhysicsBackends sends no fields and answers the described backends (protocol 1.20.0)", async () => {
    const client = await connected()
    reply(ResponseType.PhysicsBackends, encodePhysicsBackendsResponse({ info: backendsInfo }))
    assert.deepEqual(await client.getPhysicsBackends(), backendsInfo)
    assert.equal(requests[0].type, CommandType.GetPhysicsBackends)
    assert.equal(requests[0].payload.length, 0)
  })

  test("setPhysicsBackend sends the backend and answers the new description", async () => {
    const client = await connected()
    const after = { ...backendsInfo, current: "jolt", configured: true, restartRequired: true }
    reply(ResponseType.PhysicsBackends, encodePhysicsBackendsResponse({ info: after }))
    assert.deepEqual(await client.setPhysicsBackend("jolt"), after)
    assert.equal(requests[0].type, CommandType.SetPhysicsBackend)
    assert.deepEqual(decodeSetPhysicsBackendRequest(requests[0].payload), { backend: "jolt" })
  })

  test("an answer that is not a PhysicsBackendsInfo is rejected", async () => {
    const client = await connected()
    reply(ResponseType.PhysicsBackends, encodePhysicsBackendsResponse({ info: { ...backendsInfo, backends: [{ id: "physx" }] } as unknown as PhysicsBackendsInfo }))
    await assert.rejects(client.getPhysicsBackends(), /backends must be a list/)
    reply(ResponseType.PhysicsBackends, encodePhysicsBackendsResponse({ info: { ...backendsInfo, restartRequired: "yes" } as unknown as PhysicsBackendsInfo }))
    await assert.rejects(client.setPhysicsBackend("physx"), /booleans/)
  })

  test("the host's refusals of SetPhysicsBackend are EngineErrors (play host, not compiled in, not deterministic-selectable)", async () => {
    const client = await connected()
    for (const message of ["Not available in a play host", "Backend jolt is not compiled into this host", "Backend physx is not deterministic-selectable"]) {
      reply(ResponseType.Error, encodeErrorResponse({ message }))
      await assert.rejects(client.setPhysicsBackend("jolt"), (e) => e instanceof EngineError && e.message.includes(message))
    }
  })
  const networkInfo: NetworkSettingsInfo = {
    preset: "authoritative",
    customised: false,
    storedCustomised: false,
    tickRate: 60,
    values: {},
    overrides: {},
    ranges: [{ key: "network.tickRate", min: 30, max: 120, default: 60, integer: true }],
    lostGuarantees: [],
    presets: [
      {
        id: "authoritative",
        label: "Server authoritative",
        summary: "A server simulates the game",
        selected: true,
        selectable: true,
        rows: [
          {
            key: "network.tickRate",
            label: "Tick rate",
            governed: true,
            locked: false,
            tunable: true,
            startupChecked: false,
            settingKey: "network.tickRate",
            value: 60,
            description: "30, 60 or 120 Hz",
            current: 60,
            atPresetValue: true,
            source: "default",
          },
        ],
      },
    ],
    backend: { selected: "physx", deterministicSelectable: [] },
    nudge: { show: false, reasons: [], networkObjects: 0, hint: "" },
    problems: [],
  }
  const networkReport: NetworkValidationReport = {
    preset: "deterministic",
    projectPreset: "authoritative",
    refused: true,
    unmet: 1,
    summary: "Deterministic: 1 of 1 requirements are unmet; the engine would refuse to start this project.",
    requirements: [{ id: "simd-scalar", text: "math.simdTier is scalar", met: false, detail: "auto", fix: { label: "Set math.simdTier to scalar", settings: { math: { simdTier: "scalar" } } } }],
    warnings: [],
    environment: {},
  }

  test("getNetworkSettings sends no fields and answers the described settings (protocol 1.21.0)", async () => {
    const client = await connected()
    reply(ResponseType.NetworkSettings, encodeNetworkSettingsResponse({ info: networkInfo }))
    assert.deepEqual(await client.getNetworkSettings(), networkInfo)
    assert.equal(requests[0].type, CommandType.GetNetworkSettings)
    assert.equal(requests[0].payload.length, 0)
  })

  test("setNetworkSettings sends the preset and the patch and answers the new description", async () => {
    const client = await connected()
    const after = { ...networkInfo, tickRate: 30 }
    reply(ResponseType.NetworkSettings, encodeNetworkSettingsResponse({ info: after }))
    assert.deepEqual(await client.setNetworkSettings("", { tickRate: 30 }), after)
    assert.equal(requests[0].type, CommandType.SetNetworkSettings)
    assert.deepEqual(decodeSetNetworkSettingsRequest(requests[0].payload), { preset: "", settings: { tickRate: 30 } })
  })

  test("getNetworkValidation sends the preset and answers the report, with the fix patch", async () => {
    const client = await connected()
    reply(ResponseType.NetworkValidation, encodeNetworkValidationResponse({ report: networkReport }))
    assert.deepEqual(await client.getNetworkValidation("deterministic"), networkReport)
    assert.equal(requests[0].type, CommandType.GetNetworkValidation)
    assert.deepEqual(decodeGetNetworkValidationRequest(requests[0].payload), { preset: "deterministic" })
  })

  test("a network answer that does not have the documented shape is rejected", async () => {
    const client = await connected()
    reply(ResponseType.NetworkSettings, encodeNetworkSettingsResponse({ info: { ...networkInfo, presets: [{ id: "x" }] } as unknown as NetworkSettingsInfo }))
    await assert.rejects(client.getNetworkSettings(), /presets must be a list/)
    reply(ResponseType.NetworkValidation, encodeNetworkValidationResponse({ report: { ...networkReport, unmet: "1" } as unknown as NetworkValidationReport }))
    await assert.rejects(client.getNetworkValidation(""), /unmet a number/)
  })

  test("the host's refusals of SetNetworkSettings are EngineErrors (play host, not tunable, out of range, Deterministic without a backend)", async () => {
    const client = await connected()
    for (const message of ["Not available in a play host", "physics.gpu is not a tunable network setting", "tickRate must be between 30 and 120", "The Deterministic preset can't be chosen: no backend"]) {
      reply(ResponseType.Error, encodeErrorResponse({ message }))
      await assert.rejects(client.setNetworkSettings("deterministic", {}), (e) => e instanceof EngineError && e.message.includes(message))
    }
  })
})
