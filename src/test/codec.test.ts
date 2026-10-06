import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { Commands } from "../protocol/codec"
import { CommandType, ResponseType } from "../protocol/protocol.generated"
import { PayloadWriter } from "../protocol/serialization"

const bytes = (b: Buffer): number[] => [...b]

describe("request encoding", () => {
  test("SetViewportSize: two int32s", () => {
    assert.deepEqual(bytes(Commands.SetViewportSize.encode({ width: 640, height: 480 })), [
      0x80, 0x02, 0, 0, 0xe0, 0x01, 0, 0,
    ])
  })

  test("CreateEntity: a length-prefixed UTF-8 string", () => {
    assert.deepEqual(bytes(Commands.CreateEntity.encode({ name: "Hé" })), [3, 0, 0, 0, 0x48, 0xc3, 0xa9])
  })

  test("SetEntityTransform: id, then position, rotation and scale as float32 triples", () => {
    const encoded = Commands.SetEntityTransform.encode({
      entityId: "e",
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 4, y: 5, z: 6 },
      scale: { x: 7, y: 8, z: 9 },
    })
    assert.equal(encoded.length, 4 + 1 + 9 * 4)
    assert.equal(encoded.toString("utf-8", 4, 5), "e")
    const floats = Array.from({ length: 9 }, (_, i) => encoded.readFloatLE(5 + i * 4))
    assert.deepEqual(floats, [1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test("commands with no fields send an empty payload", () => {
    assert.equal(Commands.RenderFrame.encode({}).length, 0)
    assert.equal(Commands.GetEngineHealth.encode({}).length, 0)
  })

  test("every spec carries its generated command and response ids", () => {
    assert.equal(Commands.RenderFrame.command, CommandType.RenderFrame)
    assert.equal(Commands.RenderFrame.response, ResponseType.FrameData)
    assert.equal(Commands.GetAllEntities.response, ResponseType.EntityList)
    assert.equal(Commands.LoadScene.response, ResponseType.Ok)
  })
})

describe("response decoding", () => {
  test("FrameData: width, height, then the pixels to the end", () => {
    const payload = new PayloadWriter().uint32(2).uint32(1).finish()
    const frame = Commands.RenderFrame.decode(Buffer.concat([payload, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])]))
    assert.equal(frame.width, 2)
    assert.equal(frame.height, 1)
    assert.deepEqual([...frame.pixels], [1, 2, 3, 4, 5, 6, 7, 8])
  })

  test("EntityList: a count, then id and name per entity", () => {
    const payload = new PayloadWriter().uint32(2).string("a").string("Alpha").string("b").string("Beta").finish()
    assert.deepEqual(Commands.GetAllEntities.decode(payload), {
      count: 2,
      entities: [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
      ],
    })
  })

  test("EngineHealth", () => {
    const payload = new PayloadWriter()
      .bool(true)
      .uint32(1)
      .string("Audio")
      .string("Running")
      .string("Loopback")
      .finish()
    assert.deepEqual(Commands.GetEngineHealth.decode(payload), {
      healthy: true,
      count: 1,
      subsystems: [{ name: "Audio", state: "Running", detail: "Loopback" }],
    })
  })

  test("EntityTransform", () => {
    const payload = new PayloadWriter()
      .vec3({ x: 1, y: 2, z: 3 })
      .vec3({ x: 0, y: 90, z: 0 })
      .vec3({ x: 1, y: 1, z: 1 })
      .finish()
    assert.deepEqual(Commands.GetEntityTransform.decode(payload), {
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 90, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    })
  })

  test("a truncated payload throws instead of reading garbage", () => {
    const payload = new PayloadWriter().uint32(3).string("a").string("Alpha").finish()
    assert.throws(() => Commands.GetAllEntities.decode(payload), /EntityList too short/)
  })
})
