import { test, describe, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { MaxMetaBytes, entriesOfMeta, readAssetIndex } from "../main/asset-index"
import { ProjectFiles } from "../main/project-files"

const U1 = "2c8d6e0a-4f1b-5a3c-9e7d-1b0f2a6c4d81"
const U2 = "6e32656e-6d65-5348-0001-0000000000AA"
const U3 = "11111111-2222-3333-4444-555555555555"

const meta = (uuid: string, resourcePath: string, resourceType: string, extra: object = {}) => ({
  uuid,
  resourcePath,
  resourceType,
  lastModified: 1767700800,
  fileSize: 10,
  ...extra,
})

describe("entriesOfMeta", () => {
  test("a .meta is one entry, and a model's sub-assets follow it", () => {
    const model = meta(U1, "res://models/robot.glb", "Model", {
      customData: {
        model: { scale: 1 },
        subAssets: {
          "mesh/Body": { type: "Mesh", uuid: U2 },
          "material/Red": { type: "Material", uuid: U3 },
        },
      },
    })
    assert.deepEqual(entriesOfMeta(model), [
      { uuid: U1, path: "res://models/robot.glb", resourceType: "Model" },
      { uuid: U2.toLowerCase(), path: "res://models/robot.glb#mesh/Body", resourceType: "Mesh" },
      { uuid: U3, path: "res://models/robot.glb#material/Red", resourceType: "Material" },
    ])
  })

  test("a malformed .meta, or a malformed sub-asset, is skipped", () => {
    assert.deepEqual(entriesOfMeta(null), [])
    assert.deepEqual(entriesOfMeta([]), [])
    assert.deepEqual(entriesOfMeta(meta("not-a-uuid", "res://a.png", "Texture")), [])
    assert.deepEqual(entriesOfMeta(meta(U1, "C:/a.png", "Texture")), [])
    assert.deepEqual(entriesOfMeta(meta(U1, "res://a.png", undefined as never)), [
      { uuid: U1, path: "res://a.png", resourceType: "" },
    ])
    const sloppy = meta(U1, "res://m.glb", "Model", {
      customData: { subAssets: { a: null, b: { type: "Mesh", uuid: "x" }, c: { type: 5, uuid: U2 }, d: { type: "", uuid: U2 } } },
    })
    assert.equal(entriesOfMeta(sloppy).length, 1)
  })
})

describe("readAssetIndex", () => {
  let temp: string
  let root: string

  beforeEach(() => {
    temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "n2-assets-")))
    root = path.join(temp, "project")
    fs.mkdirSync(path.join(root, ".import", "textures"), { recursive: true })
  })
  afterEach(() => fs.rmSync(temp, { recursive: true, force: true }))

  const write = (relative: string, content: string | object) =>
    fs.writeFileSync(path.join(root, ".import", relative), typeof content === "string" ? content : JSON.stringify(content))

  test("reads every .meta under .import, sorted by path, skipping files that aren't metadata", () => {
    write("b.lua.meta", meta(U1, "res://b.lua", "LuaScript"))
    write(path.join("textures", "a.png.meta"), meta(U2, "res://textures/a.png", "Texture"))
    write("corrupt.meta", "{ not json")
    write("notes.txt", "ignored")
    write("empty.meta", "{}")
    assert.deepEqual(
      readAssetIndex(root).map((e) => e.path),
      ["res://b.lua", "res://textures/a.png"]
    )
  })

  test("a project without .import has no assets", () => {
    fs.rmSync(path.join(root, ".import"), { recursive: true })
    assert.deepEqual(readAssetIndex(root), [])
    assert.deepEqual(readAssetIndex(path.join(temp, "missing")), [])
  })

  test("an oversized .meta is skipped", () => {
    write("big.meta", meta(U1, "res://big.bin", "Unknown", { customData: { pad: "x".repeat(MaxMetaBytes) } }))
    write("small.meta", meta(U2, "res://small.bin", "Unknown"))
    assert.deepEqual(
      readAssetIndex(root).map((e) => e.path),
      ["res://small.bin"]
    )
  })

  test("links are never followed", () => {
    const outside = path.join(temp, "outside")
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, "evil.meta"), JSON.stringify(meta(U3, "res://evil.png", "Texture")))
    fs.symlinkSync(outside, path.join(root, ".import", "linked"), "junction")
    try {
      fs.symlinkSync(path.join(outside, "evil.meta"), path.join(root, ".import", "evil.meta"), "file")
    } catch {
      // creating a file link needs a privilege on Windows: the folder link already covers the walk
    }
    assert.deepEqual(readAssetIndex(root), [])

    // And .import itself as a link
    fs.rmSync(path.join(root, ".import"), { recursive: true })
    fs.symlinkSync(outside, path.join(root, ".import"), "junction")
    assert.deepEqual(readAssetIndex(root), [])
  })

  test("ProjectFiles.listAssets reads the open project's index, and needs one open", () => {
    write("a.meta", meta(U1, "res://a.png", "Texture"))
    const files = new ProjectFiles()
    assert.throws(() => files.listAssets(), /No project is open/)
    files.open(root)
    assert.deepEqual(files.listAssets(), [{ uuid: U1, path: "res://a.png", resourceType: "Texture" }])
  })
})
