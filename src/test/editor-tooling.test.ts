import { test } from "node:test"
import * as assert from "node:assert/strict"
import { hostHasEditorTooling, parseAssetPreview, parseLuaSyntax, checkPreviewSize } from "../protocol/editor-tooling"

const texture = (over: Record<string, unknown> = {}, pixels = new Uint8Array(2 * 3 * 4)) => ({
  info: { kind: "texture", uuid: "u", path: "res://a.png", modified: 5, width: 2, height: 3, sourceWidth: 20, sourceHeight: 30, ...over },
  pixels,
})
const audio = (over: Record<string, unknown> = {}, pixels = new Uint8Array(0)) => ({
  info: { kind: "audio", uuid: "u", path: "res://a.wav", modified: 5, durationMs: 1500, channels: 2, sampleRate: 44100, peaks: [{ min: -0.5, max: 0.5 }], ...over },
  pixels,
})

test("hostHasEditorTooling needs protocol 1.17.0 or later", () => {
  for (const [version, expected] of [["1.16.9", false], ["1.17.0", true], ["1.20.1", true], ["2.0.0", true], ["1.17", false], [null, false], [undefined, false], [117, false]] as const) {
    assert.equal(hostHasEditorTooling(version), expected, String(version))
  }
})

test("CheckLuaSyntax answers are validated: ok and message are required, the column only comes with a number", () => {
  assert.deepEqual(parseLuaSyntax({ result: { ok: true, line: 0, message: "" } }), { ok: true, line: 0, message: "" })
  assert.deepEqual(parseLuaSyntax({ result: { ok: false, line: 3, column: 7, message: "boom" } }), { ok: false, line: 3, column: 7, message: "boom" })
  assert.deepEqual(parseLuaSyntax({ result: { ok: false, line: 3, message: "boom" } }), { ok: false, line: 3, message: "boom" })
  for (const bad of [null, [], { ok: "yes", line: 0, message: "" }, { ok: false, line: -1, message: "" }, { ok: false, line: 1.5, message: "" },
    { ok: false, line: 1, message: 4 }, { ok: false, line: 1, column: "2", message: "" }]) {
    assert.throws(() => parseLuaSyntax({ result: bad } as never), /Lua syntax result/, JSON.stringify(bad))
  }
})

test("a texture preview must fit the request, the source and its own pixel count", () => {
  const ok = parseAssetPreview(texture() as never, 64)
  assert.equal(ok.kind, "texture")
  assert.throws(() => parseAssetPreview(texture({ width: 100, height: 3 }, new Uint8Array(1200)) as never, 64), /doesn't fit/)
  assert.throws(() => parseAssetPreview(texture({ sourceWidth: 1 }) as never, 64), /larger than the source/)
  assert.throws(() => parseAssetPreview(texture({}, new Uint8Array(23)) as never, 64), /23 bytes for a 2x3/)
  assert.throws(() => parseAssetPreview(texture({ width: 0 }, new Uint8Array(0)) as never, 64), /doesn't fit/)
  assert.throws(() => parseAssetPreview(texture({ uuid: 4 }) as never, 64), /uuid must be a string/)
  assert.throws(() => parseAssetPreview(texture({ modified: -1 }) as never, 64), /modified/)
  assert.throws(() => parseAssetPreview({ info: texture().info, pixels: [1, 2] } as never, 64), /pixels must be bytes/)
})

test("an audio preview has no pixels and at most twice the size in finite, ordered peaks", () => {
  assert.equal(parseAssetPreview(audio() as never, 1).kind, "audio")
  const three = [{ min: 0, max: 0 }, { min: 0, max: 0 }, { min: 0, max: 0 }]
  assert.throws(() => parseAssetPreview(audio({ peaks: three }) as never, 1), /exceed the limit of 2/)
  assert.throws(() => parseAssetPreview(audio({}, new Uint8Array(4)) as never, 8), /no pixels/)
  assert.throws(() => parseAssetPreview(audio({ peaks: [{ min: 1, max: -1 }] }) as never, 8), /peak 0/)
  assert.throws(() => parseAssetPreview(audio({ peaks: [{ min: NaN, max: 0 }] }) as never, 8), /peak 0/)
  assert.throws(() => parseAssetPreview(audio({ peaks: "x" }) as never, 8), /peaks must be an array/)
  assert.throws(() => parseAssetPreview(audio({ channels: -1 }) as never, 8), /channels/)
  assert.throws(() => parseAssetPreview(audio({ kind: "mesh" }) as never, 8), /unknown kind/)
})

test("the preview size is a whole number from 1 to 256", () => {
  assert.equal(checkPreviewSize(256), 256)
  for (const bad of [0, 257, 1.5, "64", NaN]) assert.throws(() => checkPreviewSize(bad), /1 to 256/)
})
