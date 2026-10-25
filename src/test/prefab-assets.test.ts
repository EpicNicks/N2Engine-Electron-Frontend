// The prefab path rules, the drag data a prefab carries, and how the hierarchy's prefab options read the page (protocol 1.19.0).
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { signal } from "@preact/signals-core"
import {
  PrefabAssetsCapability,
  defaultPrefabPath,
  normalizePrefabPath,
  prefabFileName,
  prefabPathIn,
  samePath,
} from "../protocol/prefab-assets"
import { assetDragData, parsePrefabDrop } from "../renderer/drag-types"
import { prefabOptions } from "../renderer/prefab-options"
import type { AssetListing } from "../renderer/asset-tree"

const U1 = "11111111-1111-1111-1111-111111111111"
const U2 = "22222222-2222-2222-2222-222222222222"

describe("prefab paths", () => {
  test("the default path is res://prefabs/<name>.prefab, with characters a file name cannot have replaced", () => {
    assert.equal(defaultPrefabPath("Hero"), "res://prefabs/Hero.prefab")
    assert.equal(defaultPrefabPath("a/b:c"), "res://prefabs/a_b_c.prefab")
    assert.equal(defaultPrefabPath("  "), "res://prefabs/Prefab.prefab")
    assert.equal(prefabFileName("..hidden. "), "hidden")
  })

  test("the path in a folder", () => {
    assert.equal(prefabPathIn("res://", "Hero"), "res://Hero.prefab")
    assert.equal(prefabPathIn("res://enemies", "Orc"), "res://enemies/Orc.prefab")
    assert.equal(prefabPathIn("res://enemies/", "Orc"), "res://enemies/Orc.prefab")
  })

  test("typed text becomes a res:// path ending in .prefab", () => {
    assert.deepEqual(normalizePrefabPath("res://prefabs/A.prefab"), { path: "res://prefabs/A.prefab", error: null })
    assert.deepEqual(normalizePrefabPath("  prefabs/A  "), { path: "res://prefabs/A.prefab", error: null })
    assert.deepEqual(normalizePrefabPath("/prefabs/A.PREFAB"), { path: "res://prefabs/A.PREFAB", error: null })
  })

  test("a path the host would refuse is refused first, with the reason", () => {
    for (const bad of ["", "   ", "res://", "res://dir/", "res://a/../b.prefab", "res://a\\b.prefab", "res://a//b.prefab", "res://a/b?.prefab", "res://.prefab"]) {
      const result = normalizePrefabPath(bad)
      assert.equal(result.path, null, bad)
      assert.ok(result.error, bad)
    }
    assert.equal(normalizePrefabPath(`res://${"a".repeat(300)}.prefab`).path, null)
  })

  test("case matters only on a case-sensitive file system", () => {
    assert.ok(samePath("res://A.prefab", "res://a.prefab", true))
    assert.ok(!samePath("res://A.prefab", "res://a.prefab", false))
  })
})

describe("the drag data of a prefab", () => {
  const prefab = { uuid: U1, path: "res://p.prefab", resourceType: "Prefab" }

  test("one prefab, a list of them, and nothing that is not a prefab or not valid", () => {
    assert.deepEqual(parsePrefabDrop(assetDragData(prefab)), [prefab])
    const list = JSON.stringify([JSON.parse(assetDragData(prefab)), JSON.parse(assetDragData({ ...prefab, uuid: U2 }))])
    assert.deepEqual(parsePrefabDrop(list).map((a) => a.uuid), [U1, U2])
    assert.deepEqual(parsePrefabDrop(assetDragData({ ...prefab, resourceType: "Texture" })), [])
    assert.deepEqual(parsePrefabDrop(JSON.stringify({ uuid: "nope", path: "x", type: "Prefab" })), [])
    assert.deepEqual(parsePrefabDrop("not json"), [])
    assert.deepEqual(parsePrefabDrop(""), [])
  })
})

describe("prefabOptions", () => {
  const listing = { folders: [], assets: [{ path: "res://P.prefab", uuid: U1, type: "Prefab", size: 1, modified: 1 }] } as AssetListing
  const make = (capabilities: unknown, connected = true) => {
    const host = { connected: signal(connected), serverInfo: signal<{ capabilities?: unknown } | null>({ capabilities }) }
    const assets = { listing: signal<AssetListing | null>(listing), refresh: async () => void refreshed.push(1) }
    const refreshed: number[] = []
    const errors: string[] = []
    const options = prefabOptions(host, assets, { caseInsensitivePaths: true, onError: (what) => errors.push(what) })
    return { host, assets, options, refreshed, errors }
  }

  test("enabled follows the capability and the connection", () => {
    const t = make([PrefabAssetsCapability])
    assert.equal(t.options.enabled.value, true)
    t.host.serverInfo.value = { capabilities: ["entityClipboard"] }
    assert.equal(t.options.enabled.value, false)
    t.host.serverInfo.value = { capabilities: [PrefabAssetsCapability] }
    t.host.connected.value = false
    assert.equal(t.options.enabled.value, false)
    assert.equal(make(undefined).options.enabled.value, false)
  })

  test("paths come from the listing; the file system decides whether case matters", () => {
    const t = make([PrefabAssetsCapability])
    assert.equal(t.options.pathOf(U1.toUpperCase()), "res://P.prefab")
    assert.equal(t.options.pathOf(U2), null)
    assert.equal(t.options.exists("res://p.prefab"), true) // case-insensitive
    assert.equal(t.options.exists("res://q.prefab"), false)
    t.assets.listing.value = null
    assert.equal(t.options.exists("res://P.prefab"), false)
  })

  test("changed lists the assets again", () => {
    const t = make([PrefabAssetsCapability])
    t.options.changed()
    assert.deepEqual(t.refreshed, [1])
  })
})
