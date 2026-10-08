import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { FieldSchema } from "../protocol/protocol.generated"
import type { AssetEntry } from "../shared/api"
import { AssetLookup, BuiltinMeshes, assetName, isBuiltinAsset } from "../renderer/asset-lookup"

const font: AssetEntry = { uuid: "aaaaaaaa-0000-0000-0000-000000000001", path: "res://fonts/Main.ttf", resourceType: "Font" }
const texture: AssetEntry = { uuid: "AAAAAAAA-0000-0000-0000-000000000002", path: "res://art/Hero.png", resourceType: "Texture" }
const body: AssetEntry = {
  uuid: "aaaaaaaa-0000-0000-0000-000000000003",
  path: "res://models/robot.glb#mesh/Body",
  resourceType: "Mesh",
}
const audio: AssetEntry = { uuid: "aaaaaaaa-0000-0000-0000-000000000004", path: "res://a.wav", resourceType: "AudioClip" }

const field = (assetType?: string): FieldSchema => ({
  name: "_font",
  displayName: "Font",
  kind: "AssetRef",
  typeName: "Font",
  hidden: false,
  readOnly: false,
  assetType,
})

describe("AssetLookup", () => {
  const lookup = new AssetLookup([font, texture, body, audio], true)

  test("finds an asset by UUID (any case) and by path (any case), a model's sub-asset too", () => {
    assert.equal(lookup.byUuid(font.uuid)?.path, font.path)
    assert.equal(lookup.byUuid(texture.uuid.toLowerCase())?.path, texture.path)
    assert.equal(lookup.byPath("res://FONTS/main.ttf")?.uuid, font.uuid)
    assert.equal(lookup.byPath("res://models/robot.glb#mesh/Body")?.uuid, body.uuid)
    assert.equal(lookup.byPath("res://nope.png"), undefined)
    assert.equal(lookup.byUuid("x"), undefined)
  })

  test("paths compare exactly unless the file system doesn't tell cases apart", () => {
    const exact = new AssetLookup([font])
    assert.equal(exact.byPath("res://fonts/Main.ttf")?.uuid, font.uuid)
    assert.equal(exact.byPath("res://FONTS/main.ttf"), undefined)
    assert.equal(new AssetLookup([font], true).byPath("res://FONTS/main.ttf")?.uuid, font.uuid)
  })

  test("the engine's built-in meshes are always there", () => {
    assert.equal(BuiltinMeshes.length, 3)
    assert.equal(lookup.byUuid("6e32656e-6d65-5348-0001-000000000001")?.path, "builtin://mesh/Cube")
    assert.equal(new AssetLookup([]).ofType("Mesh").length, 3)
    assert.equal(isBuiltinAsset(BuiltinMeshes[0]), true)
    assert.equal(isBuiltinAsset(font), false)
  })

  test("the assets of a type, by path; every asset for a field that names no type", () => {
    assert.deepEqual(
      lookup.ofType("Mesh").map((e) => e.path),
      ["builtin://mesh/Cube", "builtin://mesh/Quad", "builtin://mesh/Sphere", "res://models/robot.glb#mesh/Body"]
    )
    assert.deepEqual(lookup.ofType("Font"), [font])
    assert.equal(lookup.ofType(undefined).length, 7)
    assert.deepEqual(lookup.ofType("Scene"), [])
  })

  test("an asset goes in a field of its type, and is refused in another with the engine's words", () => {
    assert.deepEqual(lookup.check(field("Font"), font), { ok: true, value: font.uuid })
    assert.deepEqual(lookup.check(field("Texture"), texture), { ok: true, value: texture.uuid.toLowerCase() })
    assert.deepEqual(lookup.check(field(undefined), audio), { ok: true, value: audio.uuid })
    const refused = lookup.check(field("Font"), texture)
    assert.deepEqual(refused, { ok: false, error: "Hero.png is a Texture; Font expects Font" })
    const audioRefused = lookup.check(field("Texture"), audio)
    assert.equal(audioRefused.ok, false)
    assert.match(audioRefused.ok ? "" : audioRefused.error, /a\.wav is an AudioClip; Font expects Texture/)
  })

  test("names for the person", () => {
    assert.equal(assetName(font), "Main.ttf")
    assert.equal(assetName(body), "robot.glb > Body")
    assert.equal(assetName(BuiltinMeshes[1]), "Sphere (built-in)")
    assert.deepEqual(lookup.label(font.uuid), { text: "Main.ttf", known: true })
    assert.deepEqual(lookup.label("12345678-9999-9999-9999-999999999999"), { text: "12345678... (not found)", known: false })
  })
})
