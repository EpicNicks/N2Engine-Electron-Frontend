import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import * as net from "node:net"
import {
  DefaultClientName,
  EngineClient,
  EngineError,
  HelloError,
  HelloTimeoutMilliseconds,
  MaxPayloadBytesBeforeHello,
  MaxRequestPayloadBytes,
  ShutdownGraceMilliseconds,
} from "../protocol/engine-client"
import {
  CommandType,
  HelloRequest,
  PROTOCOL_VERSION,
  ResponseType,
  ServerInfoResponse,
  decodeAddComponentRequest,
  decodeCreateEntityExRequest,
  decodeDuplicateEntityRequest,
  decodeGetComponentRequest,
  decodeGetEntityRequest,
  decodeGetLuaFieldsRequest,
  decodeHelloRequest,
  decodeNewSceneRequest,
  decodeOpenSceneRequest,
  decodeSaveSceneToFileRequest,
  decodeRemoveComponentRequest,
  decodeSetComponentFieldsRequest,
  decodeSetEntityParentRequest,
  decodeSetEntityPropertiesRequest,
  decodeSetLocalTransformRequest,
  decodeSetProjectSettingsRequest,
  decodeSetStartupSceneRequest,
  encodeComponentAddedResponse,
  encodeComponentDataResponse,
  encodeComponentTypesResponse,
  encodeEntityCreatedResponse,
  encodeEntityDataResponse,
  encodeErrorResponse,
  encodeHierarchyResponse,
  encodeLuaFieldsResponse,
  encodeOkResponse,
  encodeProjectInfoResponse,
  encodeSceneInfoResponse,
  encodeFrame,
  encodeServerInfoResponse,
} from "../protocol/protocol.generated"

const serverInfo = (protocolVersion: string = PROTOCOL_VERSION): ServerInfoResponse => ({
  protocolVersion,
  engineVersion: "0.9.0",
  capabilities: [],
  projectLoaded: true,
})

/** The host's answer to a Hello: a whole response frame, or null for none */
type HelloAnswer = (hello: HelloRequest) => Buffer | null

const acceptHello: HelloAnswer = () =>
  Buffer.from(encodeFrame(ResponseType.ServerInfo, encodeServerInfoResponse(serverInfo())))

// Enough of a net.Socket for EngineClient: data, error and close events, write, end and destroy. It answers Hello
// itself (on the next turn, with answerHello), so written holds only what the client sent after it.
class FakeSocket extends EventEmitter {
  destroyed = false
  ended = false
  written: Buffer[] = []
  hellos: HelloRequest[] = []

  constructor(private readonly answerHello: HelloAnswer) {
    super()
  }

  end(): this {
    this.ended = true
    return this
  }

  write(data: Uint8Array): boolean {
    if (data[0] === CommandType.Hello && this.hellos.length === 0) {
      const hello = decodeHelloRequest(data.subarray(5))
      this.hellos.push(hello)
      const answer = this.answerHello(hello)
      if (answer) setImmediate(() => this.emit("data", answer))
      return true
    }
    this.written.push(Buffer.from(data))
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

/**
 * A client whose sockets connect on the next turn (or never when autoConnect is false), and whose host answers
 * Hello with answerHello
 */
function connectFake(
  autoConnect: boolean = true,
  answerHello: HelloAnswer = acceptHello
): { client: EngineClient; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  const client = new EngineClient((_options, onConnect) => {
    const socket = new FakeSocket(answerHello)
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

/** Waits (a turn at a time) until done() holds; fails rather than hanging when it doesn't within maxTurns */
async function until(done: () => boolean, maxTurns: number = 100): Promise<void> {
  for (let turn = 0; !done(); turn++) {
    if (turn === maxTurns) assert.fail(`still waiting after ${maxTurns} turns`)
    await tick()
  }
}

/** Until the client has said Hello on its socket'th connection */
const saidHello =
  (sockets: FakeSocket[], socket: number = 0) =>
  () =>
    sockets.length > socket && sockets[socket].hellos.length > 0

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

describe("EngineClient Hello", () => {
  test("connect says Hello first, with this editor's protocol version, and resolves with ServerInfo", async () => {
    const { client, sockets } = connectFake()
    const info = await client.connect()

    assert.deepEqual(sockets[0].hellos, [
      { clientName: DefaultClientName, protocolVersion: PROTOCOL_VERSION, token: "" },
    ])
    assert.deepEqual(info, serverInfo())
    assert.deepEqual(client.serverInfo, serverInfo())
    assert.equal(client.isConnected, true)
  })

  test("the token and client name are sent in Hello", async () => {
    const { client, sockets } = connectFake()
    await client.connect("localhost", 9999, { token: "the-access-token", clientName: "Test" })
    assert.deepEqual(sockets[0].hellos, [
      { clientName: "Test", protocolVersion: PROTOCOL_VERSION, token: "the-access-token" },
    ])
  })

  test("nothing else is sent, and the client isn't connected, until Hello succeeds", async () => {
    const { client, sockets } = connectFake(true, () => null)
    const connecting = client.connect()
    await until(saidHello(sockets))

    assert.equal(client.isConnected, false)
    assert.equal(client.serverInfo, null)
    await assert.rejects(client.getCameraPosition(), /Hello hasn't completed/)
    assert.equal(sockets[0].written.length, 0)

    sockets[0].emit("data", acceptHello(sockets[0].hellos[0]))
    await connecting
    assert.equal(client.isConnected, true)
  })

  test("a refused Hello rejects connect with the host's message and closes the connection", async () => {
    const refuse: HelloAnswer = () =>
      Buffer.from(encodeFrame(ResponseType.Error, encodeErrorResponse({ message: "Invalid access token" })))
    const { client, sockets } = connectFake(true, refuse)
    let closes = 0
    client.onClose(() => closes++)

    await assert.rejects(
      client.connect("localhost", 9999, { token: "wrong" }),
      (e: Error) => e instanceof HelloError && /refused Hello: Invalid access token/.test(e.message)
    )
    assert.equal(sockets[0].destroyed, true)
    assert.equal(client.isConnected, false)
    assert.equal(client.serverInfo, null)
    assert.equal(closes, 1)
    await assert.rejects(client.getCameraPosition(), /Not connected/)
  })

  test("a host with a different major protocol version is refused", async () => {
    const major = Number(PROTOCOL_VERSION.split(".")[0])
    const { client, sockets } = connectFake(true, () =>
      Buffer.from(encodeFrame(ResponseType.ServerInfo, encodeServerInfoResponse(serverInfo(`${major + 1}.0.0`))))
    )
    await assert.rejects(client.connect(), (e: Error) => e instanceof HelloError && /major versions/.test(e.message))
    assert.equal(sockets[0].destroyed, true)
    assert.equal(client.isConnected, false)
  })

  test("an answer that isn't ServerInfo or Error fails Hello", async () => {
    const { client, sockets } = connectFake(true, () => Buffer.from(encodeFrame(ResponseType.Ok, new Uint8Array(0))))
    await assert.rejects(client.connect(), /Hello: expected response type 11, got 0/)
    assert.equal(sockets[0].destroyed, true)
  })

  test("no answer within the Hello timeout fails Hello and closes the connection", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const { client, sockets } = connectFake(true, () => null)
    const connecting = client.connect()
    // setImmediate isn't mocked, so the fake socket still connects
    await until(saidHello(sockets))

    t.mock.timers.tick(HelloTimeoutMilliseconds - 1)
    assert.equal(sockets[0].destroyed, false)
    t.mock.timers.tick(1)
    await assert.rejects(connecting, (e: Error) => e instanceof HelloError && /didn't answer Hello/.test(e.message))
    assert.equal(sockets[0].destroyed, true)
  })

  test("a Hello over the host's pre-Hello payload limit is refused without being sent", async () => {
    const { client, sockets } = connectFake()
    await assert.rejects(
      client.connect("localhost", 9999, { token: "x".repeat(MaxPayloadBytesBeforeHello) }),
      /payload too large/
    )
    assert.equal(sockets[0].hellos.length, 0)
    assert.equal(sockets[0].destroyed, true)
  })

  test("each connection says Hello again", async () => {
    const { client, sockets } = connectFake()
    await client.connect()
    await client.connect()
    assert.equal(sockets[0].hellos.length, 1)
    assert.equal(sockets[1].hellos.length, 1)
    assert.equal(client.isConnected, true)
  })

  test("a second connect() while the first is saying Hello rejects the first and says Hello again", async () => {
    let answered = 0
    const { client, sockets } = connectFake(true, (hello) => (answered++ === 0 ? null : acceptHello(hello)))
    const first = client.connect()
    await until(saidHello(sockets))

    const second = client.connect()
    await assert.rejects(first, /Reconnected/)
    assert.deepEqual(await second, serverInfo())
    assert.equal(sockets[0].destroyed, true)
    assert.equal(sockets[1].hellos.length, 1)
    assert.equal(client.isConnected, true)

    // The new connection works, and the old socket's late close doesn't touch it
    await tick()
    const pending = client.getCameraPosition()
    sockets[1].emit("data", cameraPositionResponse(1, 2, 3))
    assert.deepEqual(await pending, { x: 1, y: 2, z: 3 })
  })

  test("disconnect while saying Hello closes without sending Shutdown", async () => {
    const { client, sockets } = connectFake(true, () => null)
    const connecting = client.connect()
    await until(saidHello(sockets))
    client.disconnect()
    await assert.rejects(connecting, /Disconnected/)
    assert.equal(sockets[0].written.length, 0)
    assert.equal(sockets[0].destroyed, true)
  })
})

describe("EngineClient scene and project commands (protocol 1.3)", () => {
  const scene = {
    path: "res://assets/scenes/main.scene",
    name: "main",
    uuid: "11111111-2222-3333-4444-555555555555",
    revision: 7,
    savedRevision: 5,
  }
  const project = {
    rootPath: "C:\\Games\\A",
    userDataPath: "C:\\Users\\me\\AppData\\N2\\A",
    project: {
      formatVersion: 1,
      name: "A",
      projectId: "aaaa",
      engineVersion: "1.0.0",
      startupScene: "res://assets/scenes/main.scene",
      scenes: ["res://assets/scenes/main.scene"],
      settings: { physics: { gravity: -9.8 } },
    },
  }
  const sceneInfo = (): Buffer => frame(ResponseType.SceneInfo, Buffer.from(encodeSceneInfoResponse(scene)))
  const projectInfo = (): Buffer => frame(ResponseType.ProjectInfo, Buffer.from(encodeProjectInfoResponse(project)))
  const sentFrame = (socket: FakeSocket, i: number): { type: number; payload: Buffer } => ({
    type: socket.written[i][0],
    payload: socket.written[i].subarray(5),
  })

  test("the scene commands send their ids and payloads and answer SceneInfo", async () => {
    const { client, sockets } = connectFake()
    await client.connect()

    const opened = client.openScene(scene.path)
    sockets[0].emit("data", sceneInfo())
    assert.deepEqual(await opened, scene)
    assert.equal(sentFrame(sockets[0], 0).type, 0x25)
    assert.deepEqual(decodeOpenSceneRequest(sentFrame(sockets[0], 0).payload), { path: scene.path })

    const saved = client.saveSceneToFile("")
    sockets[0].emit("data", sceneInfo())
    assert.deepEqual(await saved, scene)
    assert.equal(sentFrame(sockets[0], 1).type, 0x26)
    assert.deepEqual(decodeSaveSceneToFileRequest(sentFrame(sockets[0], 1).payload), { path: "" })

    const created = client.newScene("res://assets/scenes/new.scene", "New")
    sockets[0].emit("data", sceneInfo())
    assert.deepEqual(await created, scene)
    assert.equal(sentFrame(sockets[0], 2).type, 0x27)
    assert.deepEqual(decodeNewSceneRequest(sentFrame(sockets[0], 2).payload), {
      path: "res://assets/scenes/new.scene",
      name: "New",
    })

    const current = client.getOpenScene()
    sockets[0].emit("data", sceneInfo())
    assert.deepEqual(await current, scene)
    assert.equal(sentFrame(sockets[0], 3).type, 0x29)
    assert.equal(sentFrame(sockets[0], 3).payload.length, 0)
  })

  test("the project commands send their ids and payloads and answer ProjectInfo", async () => {
    const { client, sockets } = connectFake()
    await client.connect()

    const info = client.getProjectInfo()
    sockets[0].emit("data", projectInfo())
    assert.deepEqual(await info, project)
    assert.equal(sentFrame(sockets[0], 0).type, 0x70)
    assert.equal(sentFrame(sockets[0], 0).payload.length, 0)

    const patch = { physics: { gravity: -1 }, input: null }
    const changed = client.setProjectSettings(patch)
    sockets[0].emit("data", projectInfo())
    assert.deepEqual(await changed, project)
    assert.equal(sentFrame(sockets[0], 1).type, 0x71)
    assert.deepEqual(decodeSetProjectSettingsRequest(sentFrame(sockets[0], 1).payload), { settings: patch })

    const startup = client.setStartupScene("")
    sockets[0].emit("data", projectInfo())
    await startup
    assert.equal(sentFrame(sockets[0], 2).type, 0x72)
    assert.deepEqual(decodeSetStartupSceneRequest(sentFrame(sockets[0], 2).payload), { path: "" })
  })

  test("the hierarchy commands send their ids and payloads and decode the answers", async () => {
    const { client, sockets } = connectFake()
    await client.connect()
    const answer = (type: number, payload: Uint8Array): void => {
      sockets[0].emit("data", frame(type, Buffer.from(payload)))
    }
    const node = {
      id: "u1",
      parentId: "",
      index: 0,
      name: "Cube",
      active: true,
      activeInHierarchy: true,
      layer: 0,
      tag: "",
      components: ["Transform", "MeshRenderer"],
    }

    const hierarchy = client.getHierarchy()
    answer(ResponseType.Hierarchy, encodeHierarchyResponse({ revision: 7, nodes: [node] }))
    assert.deepEqual(await hierarchy, { revision: 7, nodes: [node] })
    assert.equal(sentFrame(sockets[0], 0).type, 0x28)
    assert.equal(sentFrame(sockets[0], 0).payload.length, 0)

    const created = client.createEntityEx("Box", "parent", -1, "Cube")
    answer(ResponseType.EntityCreated, encodeEntityCreatedResponse({ entityId: "new-id" }))
    assert.equal(await created, "new-id")
    assert.equal(sentFrame(sockets[0], 1).type, 0x35)
    assert.deepEqual(decodeCreateEntityExRequest(sentFrame(sockets[0], 1).payload), {
      name: "Box",
      parentId: "parent",
      siblingIndex: -1,
      preset: "Cube",
    })

    const moved = client.setEntityParent("a", "", 3, true)
    answer(ResponseType.Ok, encodeOkResponse({}))
    await moved
    assert.equal(sentFrame(sockets[0], 2).type, 0x36)
    assert.deepEqual(decodeSetEntityParentRequest(sentFrame(sockets[0], 2).payload), {
      entityId: "a",
      parentId: "",
      siblingIndex: 3,
      keepWorldTransform: true,
    })

    const properties = { name: "Hero", active: false, tag: "Player", layer: 31 }
    const changed = client.setEntityProperties("a", properties)
    answer(ResponseType.Ok, encodeOkResponse({}))
    await changed
    assert.equal(sentFrame(sockets[0], 3).type, 0x37)
    assert.deepEqual(decodeSetEntityPropertiesRequest(sentFrame(sockets[0], 3).payload), { entityId: "a", properties })

    const copy = client.duplicateEntity("a")
    answer(ResponseType.EntityCreated, encodeEntityCreatedResponse({ entityId: "copy-id" }))
    assert.equal(await copy, "copy-id")
    assert.equal(sentFrame(sockets[0], 4).type, 0x38)
    assert.deepEqual(decodeDuplicateEntityRequest(sentFrame(sockets[0], 4).payload), { entityId: "a" })

    const worldMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]
    const entity = {
      header: { ...node, id: "a" },
      transform: { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
      components: [{ type: "Transform", uuid: "c1", values: { enabled: true } }],
    }
    const detail = client.getEntity("a")
    answer(ResponseType.EntityData, encodeEntityDataResponse({ entity, worldMatrix }))
    assert.deepEqual(await detail, { entity, worldMatrix })
    assert.equal(sentFrame(sockets[0], 5).type, 0x39)
    assert.deepEqual(decodeGetEntityRequest(sentFrame(sockets[0], 5).payload), { entityId: "a" })

    const placed = client.setLocalTransform("a", { x: 1, y: 2, z: 3 }, { x: 0, y: 0.5, z: 0, w: 0.5 }, { x: 2, y: 2, z: 2 })
    answer(ResponseType.Ok, encodeOkResponse({}))
    await placed
    assert.equal(sentFrame(sockets[0], 6).type, 0x3a)
    assert.deepEqual(decodeSetLocalTransformRequest(sentFrame(sockets[0], 6).payload), {
      entityId: "a",
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0.5, z: 0, w: 0.5 },
      scale: { x: 2, y: 2, z: 2 },
    })
  })

  test("setEntityProperties refuses an unknown key or a bad value without sending anything", async () => {
    const { client, sockets } = connectFake()
    await client.connect()
    const bad: unknown[] = [
      { colour: "red" },
      { name: 5 },
      { tag: null },
      { active: "yes" },
      { active: 1 },
      { layer: 32 },
      { layer: -1 },
      { layer: 1.5 },
      { layer: "3" },
      { name: "ok", extra: true }, // one bad key refuses the lot
      JSON.parse('{"__proto__": {}}'),
      [],
      null,
      "{}",
    ]
    for (const properties of bad) {
      await assert.rejects(client.setEntityProperties("a", properties), Error, JSON.stringify(properties))
    }
    assert.equal(sockets[0].written.length, 0)
    await assert.rejects(client.setEntityProperties("a", { colour: 1 }), /unknown property colour/)
  })

  test("the component commands send their ids and payloads and decode the answers", async () => {
    const { client, sockets } = connectFake()
    await client.connect()
    const answer = (type: number, payload: Uint8Array): void => {
      sockets[0].emit("data", frame(type, Buffer.from(payload)))
    }
    const field = { name: "volume", displayName: "Volume", kind: "Float", typeName: "float", hidden: false, readOnly: false }
    const schema = { typeName: "AudioSource", singleton: false, fields: [{ ...field, min: 0, max: 1 }], defaults: { volume: 1 } }

    const types = client.getComponentTypes()
    answer(ResponseType.ComponentTypes, encodeComponentTypesResponse({ types: [schema] }))
    assert.deepEqual(await types, [schema])
    assert.equal(sentFrame(sockets[0], 0).type, 0x60)
    assert.equal(sentFrame(sockets[0], 0).payload.length, 0)

    const added = client.addComponent("e1", "AudioSource")
    answer(ResponseType.ComponentAdded, encodeComponentAddedResponse({ componentId: "c1", values: { volume: 1 } }))
    assert.deepEqual(await added, { componentId: "c1", values: { volume: 1 } })
    assert.equal(sentFrame(sockets[0], 1).type, 0x61)
    assert.deepEqual(decodeAddComponentRequest(sentFrame(sockets[0], 1).payload), {
      entityId: "e1",
      typeName: "AudioSource",
    })

    const removed = client.removeComponent("e1", "c1")
    answer(ResponseType.Ok, encodeOkResponse({}))
    await removed
    assert.equal(sentFrame(sockets[0], 2).type, 0x62)
    assert.deepEqual(decodeRemoveComponentRequest(sentFrame(sockets[0], 2).payload), { entityId: "e1", componentId: "c1" })

    const set = client.setComponentFields("e1", "c1", { volume: 0.5 })
    answer(ResponseType.ComponentData, encodeComponentDataResponse({ values: { volume: 0.5, isActive: true } }))
    assert.deepEqual(await set, { volume: 0.5, isActive: true })
    assert.equal(sentFrame(sockets[0], 3).type, 0x63)
    assert.deepEqual(decodeSetComponentFieldsRequest(sentFrame(sockets[0], 3).payload), {
      entityId: "e1",
      componentId: "c1",
      values: { volume: 0.5 },
    })

    const got = client.getComponent("e1", "c1")
    answer(ResponseType.ComponentData, encodeComponentDataResponse({ values: { volume: 1 } }))
    assert.deepEqual(await got, { volume: 1 })
    assert.equal(sentFrame(sockets[0], 4).type, 0x64)
    assert.deepEqual(decodeGetComponentRequest(sentFrame(sockets[0], 4).payload), { entityId: "e1", componentId: "c1" })

    const luaSchema = {
      typeName: "LuaComponent",
      singleton: false,
      fields: [{ ...field, name: "speed", container: "scriptData" }],
    }
    const lua = client.getLuaFields("e1", "c1")
    answer(ResponseType.LuaFields, encodeLuaFieldsResponse({ schema: luaSchema }))
    assert.deepEqual(await lua, luaSchema)
    assert.equal(sentFrame(sockets[0], 5).type, 0x65)
    assert.deepEqual(decodeGetLuaFieldsRequest(sentFrame(sockets[0], 5).payload), { entityId: "e1", componentId: "c1" })
  })

  test("the component commands refuse bad arguments, and malformed schemas, without sending anything bad", async () => {
    const { client, sockets } = connectFake()
    await client.connect()
    await assert.rejects(client.addComponent("", "Light"), /entityId must be a non-empty string/)
    await assert.rejects(client.addComponent("e1", ""), /typeName must be a non-empty string/)
    await assert.rejects(client.removeComponent("e1", ""), /componentId/)
    await assert.rejects(client.setComponentFields("e1", "c1", [1]), /values must be a JSON object/)
    await assert.rejects(client.setComponentFields("e1", "c1", null), /values must be a JSON object/)
    await assert.rejects(client.setComponentFields("e1", "c1", "{}"), /values must be a JSON object/)
    await assert.rejects(client.getComponent("", "c1"), /entityId/)
    await assert.rejects(client.getLuaFields("e1", "a b"), /componentId/)
    assert.equal(sockets[0].written.length, 0)

    // A malformed schema from the host is an error for the caller, not a bad value for the inspector
    const bad = client.getComponentTypes()
    sockets[0].emit(
      "data",
      frame(ResponseType.ComponentTypes, Buffer.from(encodeComponentTypesResponse({ types: [{ typeName: "X" } as never] })))
    )
    await assert.rejects(bad, /singleton must be a boolean|fields must be an array/)
  })

  test("AddComponent's answer must carry the new component's UUID", async () => {
    const { client, sockets } = connectFake()
    await client.connect()
    const added = client.addComponent("e1", "Light")
    sockets[0].emit(
      "data",
      frame(ResponseType.ComponentAdded, Buffer.from(encodeComponentAddedResponse({ componentId: "", values: {} })))
    )
    await assert.rejects(added, /without the new component's UUID/)
  })

  test("an Error answer rejects with the host's message", async () => {
    const { client, sockets } = connectFake()
    await client.connect()
    const pending = client.openScene("res://nope.txt")
    sockets[0].emit("data", frame(ResponseType.Error, Buffer.from("not a scene path")))
    await assert.rejects(pending, /not a scene path/)
  })
})
