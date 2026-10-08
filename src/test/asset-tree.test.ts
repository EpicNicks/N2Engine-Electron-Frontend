import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { AssetInfo } from "../protocol/protocol.generated"
import {
  AssetListing,
  RootFolder,
  ancestorsOf,
  assetEntriesOf,
  buildRows,
  childPath,
  formatSize,
  nameOf,
  parentOf,
  typesOf,
} from "../renderer/asset-tree"

const asset = (path: string, type: string, extra: Partial<AssetInfo> = {}): AssetInfo => ({
  path,
  uuid: `${String(path.length).padStart(8, "0")}-0000-0000-0000-000000000000`,
  type,
  size: 100,
  modified: 1,
  ...extra,
})

const listing: AssetListing = {
  folders: ["res://empty", "res://models", "res://scenes", "res://scenes/old"],
  assets: [
    asset("res://scenes/Main.scene", "Scene"),
    asset("res://scenes/old/Level1.scene", "Scene"),
    asset("res://hero.png", "Texture"),
    asset("res://models/robot.glb", "Model", {
      subAssets: [
        { key: "mesh/Body", uuid: "aaaaaaaa-0000-0000-0000-000000000001", type: "Mesh" },
        { key: "material/Metal", uuid: "aaaaaaaa-0000-0000-0000-000000000002", type: "Material" },
      ],
    }),
  ],
}

const labels = (rows: ReturnType<typeof buildRows>) => rows.map((r) => `${"  ".repeat(r.depth)}${r.kind}:${r.name}`)

describe("paths", () => {
  test("names, parents and children of res:// paths", () => {
    assert.equal(nameOf("res://scenes/Main.scene"), "Main.scene")
    assert.equal(nameOf("res://scenes"), "scenes")
    assert.equal(parentOf("res://scenes/Main.scene"), "res://scenes")
    assert.equal(parentOf("res://hero.png"), RootFolder)
    assert.equal(parentOf("res://models/robot.glb#mesh/Body"), "res://models")
    assert.equal(parentOf(RootFolder), RootFolder)
    assert.equal(childPath(RootFolder, "a"), "res://a")
    assert.equal(childPath("res://x", "a"), "res://x/a")
    assert.deepEqual(ancestorsOf("res://a/b/c.lua"), ["res://a", "res://a/b"])
    assert.deepEqual(ancestorsOf("res://c.lua"), [])
  })
})

describe("buildRows", () => {
  test("a closed tree shows the top level: folders first, then files", () => {
    assert.deepEqual(labels(buildRows(listing, new Set())), [
      "folder:empty",
      "folder:models",
      "folder:scenes",
      "asset:hero.png",
    ])
  })

  test("an open folder shows its contents, an open model its parts", () => {
    const rows = buildRows(listing, new Set(["res://scenes", "res://models", "res://models/robot.glb"]))
    assert.deepEqual(labels(rows), [
      "folder:empty",
      "folder:models",
      "  asset:robot.glb",
      "    sub:mesh/Body",
      "    sub:material/Metal",
      "folder:scenes",
      "  folder:old",
      "  asset:Main.scene",
      "asset:hero.png",
    ])
  })

  test("a folder counts everything under it, empty ones included", () => {
    const rows = buildRows(listing, new Set())
    const counts = Object.fromEntries(rows.flatMap((r) => (r.kind === "folder" ? [[r.name, r.items]] : [])))
    assert.deepEqual(counts, { empty: 0, models: 1, scenes: 2 })
  })

  test("a folder only an asset's path implies is shown", () => {
    const rows = buildRows(
      { folders: [], assets: [asset("res://a/b/c.lua", "LuaScript")] },
      new Set(["res://a", "res://a/b"])
    )
    assert.deepEqual(labels(rows), ["folder:a", "  folder:b", "    asset:c.lua"])
  })

  test("names sort with their numbers in order", () => {
    const rows = buildRows(
      { folders: [], assets: ["res://a10.lua", "res://a2.lua"].map((p) => asset(p, "LuaScript")) },
      new Set()
    )
    assert.deepEqual(labels(rows), ["asset:a2.lua", "asset:a10.lua"])
  })

  test("a filter makes a flat list of what matches, parts included", () => {
    assert.deepEqual(labels(buildRows(listing, new Set(), { text: "scene", type: "" })), [
      "asset:scenes/Main.scene",
      "asset:scenes/old/Level1.scene",
    ])
    assert.deepEqual(labels(buildRows(listing, new Set(), { text: "", type: "Mesh" })), [
      "sub:models/robot.glb#mesh/Body",
    ])
    assert.deepEqual(
      labels(buildRows(listing, new Set(), { text: "AAAAAAAA-0000-0000-0000-000000000002", type: "" })),
      ["sub:models/robot.glb#material/Metal"]
    )
    assert.deepEqual(buildRows(listing, new Set(), { text: "nothing", type: "" }), [])
  })
})

describe("listing helpers", () => {
  test("the resource types, sorted, parts' too", () => {
    assert.deepEqual(typesOf(listing), ["Material", "Mesh", "Model", "Scene", "Texture"])
  })

  test("entries for the inspector's fields: files and parts, lower-case UUIDs", () => {
    const entries = assetEntriesOf({
      folders: [],
      assets: [
        asset("res://m.glb", "Model", {
          uuid: "AAAAAAAA-0000-0000-0000-000000000000",
          subAssets: [{ key: "mesh/A", uuid: "BBBBBBBB-0000-0000-0000-000000000000", type: "Mesh" }],
        }),
      ],
    })
    assert.deepEqual(entries, [
      { uuid: "aaaaaaaa-0000-0000-0000-000000000000", path: "res://m.glb", resourceType: "Model" },
      { uuid: "bbbbbbbb-0000-0000-0000-000000000000", path: "res://m.glb#mesh/A", resourceType: "Mesh" },
    ])
  })

  test("sizes for a person", () => {
    assert.equal(formatSize(0), "0 B")
    assert.equal(formatSize(1023), "1023 B")
    assert.equal(formatSize(1536), "1.5 KB")
    assert.equal(formatSize(20 * 1024), "20 KB")
    assert.equal(formatSize(3.2 * 1024 * 1024), "3.2 MB")
    assert.equal(formatSize(-1), "")
  })
})
