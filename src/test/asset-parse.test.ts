import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { parseAssetDetails, parseAssetInfo, parseAssetList } from "../protocol/asset-parse"

const U1 = "11111111-1111-1111-1111-111111111111"
const U2 = "22222222-2222-2222-2222-222222222222"

const info = { path: "res://a.png", uuid: U1, type: "Texture", size: 12, modified: 1760000000000 }

describe("parseAssetList", () => {
  test("takes the folders and the assets, with a model's parts", () => {
    const list = parseAssetList({
      folders: ["res://empty", "res://scenes"],
      assets: [
        info,
        { ...info, path: "res://m.glb", type: "Model", subAssets: [{ key: "mesh/Body", uuid: U2, type: "Mesh" }] },
      ],
    })
    assert.deepEqual(list.folders, ["res://empty", "res://scenes"])
    assert.equal(list.assets.length, 2)
    assert.deepEqual(list.assets[1].subAssets, [{ key: "mesh/Body", uuid: U2, type: "Mesh" }])
    assert.equal(list.assets[0].subAssets, undefined)
  })

  test("a time past 2^32 is fine, a negative size or a missing field is not", () => {
    assert.equal(parseAssetInfo(info).modified, 1760000000000)
    assert.throws(() => parseAssetInfo({ ...info, size: -1 }), /size must be a non-negative number/)
    assert.throws(() => parseAssetInfo({ ...info, uuid: undefined }), /uuid must be a string/)
    assert.throws(() => parseAssetInfo({ ...info, subAssets: {} }), /subAssets must be an array/)
    assert.throws(() => parseAssetInfo({ ...info, subAssets: [{ key: "k" }] }), /sub-asset 0/)
  })

  test("answers of the wrong shape are refused", () => {
    assert.throws(() => parseAssetList(null), /must be an object/)
    assert.throws(() => parseAssetList({ folders: "x", assets: [] }), /folders must be an array/)
    assert.throws(() => parseAssetList({ folders: [], assets: {} }), /assets must be an array/)
    assert.throws(() => parseAssetList({ folders: [1], assets: [] }), /folder 0 must be a string/)
    assert.throws(() => parseAssetList({ folders: [], assets: [3] }), /item 0 must be an object/)
  })
})

describe("parseAssetDetails", () => {
  test("adds the import settings and whether the engine holds the asset", () => {
    const details = parseAssetDetails({ ...info, customData: { sRGB: true }, loaded: false })
    assert.deepEqual(details.customData, { sRGB: true })
    assert.equal(details.loaded, false)
  })

  test("no customData is none; one that isn't an object, or no loaded, is refused", () => {
    assert.deepEqual(parseAssetDetails({ ...info, loaded: true }).customData, {})
    assert.throws(() => parseAssetDetails({ ...info, customData: [1], loaded: true }), /customData must be an object/)
    assert.throws(() => parseAssetDetails({ ...info, customData: {} }), /loaded must be a boolean/)
    assert.throws(() => parseAssetDetails(5), /must be an object/)
  })
})
