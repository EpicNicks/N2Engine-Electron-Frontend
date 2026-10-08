import { test, describe, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AssetIndexCache, MaxMetaBytes, assetFilePath, parseMeta, readAssetIndex } from "../main/asset-index"
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

describe("parseMeta", () => {
  test("a .meta is the file, and a model's sub-assets with the file state they were indexed for", () => {
    const parsed = parseMeta(
      meta(U1, "res://models/robot.glb", "Model", {
        customData: {
          model: { scale: 1 },
          subAssets: {
            "mesh/Body": { type: "Mesh", uuid: U2 },
            "material/Red": { type: "Material", uuid: U3 },
          },
          subAssetsSource: { fileSize: 10, lastModified: 1767700800 },
        },
      })
    )
    assert.deepEqual(parsed?.file, { uuid: U1, path: "res://models/robot.glb", resourceType: "Model" })
    assert.deepEqual(parsed?.source, { fileSize: 10, lastModified: 1767700800 })
    assert.deepEqual(parsed?.subAssets, [
      { uuid: U2.toLowerCase(), path: "res://models/robot.glb#mesh/Body", resourceType: "Mesh" },
      { uuid: U3, path: "res://models/robot.glb#material/Red", resourceType: "Material" },
    ])
  })

  test("a malformed .meta, or a malformed sub-asset, is skipped", () => {
    assert.equal(parseMeta(null), null)
    assert.equal(parseMeta([]), null)
    assert.equal(parseMeta(meta("not-a-uuid", "res://a.png", "Texture")), null)
    assert.equal(parseMeta(meta(U1, "C:/a.png", "Texture")), null)
    assert.equal(parseMeta(meta(U1, "res://a.png", undefined as never))?.file.resourceType, "")
    const sloppy = meta(U1, "res://m.glb", "Model", {
      customData: {
        subAssets: { a: null, b: { type: "Mesh", uuid: "x" }, c: { type: 5, uuid: U2 }, d: { type: "", uuid: U2 } },
        subAssetsSource: { fileSize: "10" },
      },
    })
    assert.equal(parseMeta(sloppy)?.subAssets.length, 0)
    assert.equal(parseMeta(sloppy)?.source, null)
  })

  test("a res:// path is a file under the assets folder, or nothing", () => {
    const root = path.join(os.tmpdir(), "p")
    assert.equal(assetFilePath(root, "res://a/b.png"), path.join(root, "assets", "a", "b.png"))
    assert.equal(assetFilePath(root, "res://"), null)
    assert.equal(assetFilePath(root, "res://../secret.txt"), null)
    assert.equal(assetFilePath(root, "res://a/../../x"), null)
    assert.equal(assetFilePath(root, "res://a\0b"), null)
  })
})

describe("readAssetIndex", () => {
  let temp: string
  let root: string

  beforeEach(() => {
    temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "n2-assets-")))
    root = path.join(temp, "project")
    fs.mkdirSync(path.join(root, ".import", "textures"), { recursive: true })
    fs.mkdirSync(path.join(root, "assets", "textures"), { recursive: true })
  })
  afterEach(() => fs.rmSync(temp, { recursive: true, force: true }))

  const write = (relative: string, content: string | object) =>
    fs.writeFileSync(path.join(root, ".import", relative), typeof content === "string" ? content : JSON.stringify(content))
  /** An asset file, and its .meta */
  const asset = (resource: string, uuid: string, type: string, extra: object = {}, content = "data") => {
    const file = path.join(root, "assets", ...resource.split("/"))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    fs.mkdirSync(path.join(root, ".import", path.dirname(resource)), { recursive: true })
    write(resource + ".meta", meta(uuid, "res://" + resource, type, extra))
    return file
  }

  test("reads every .meta under .import, sorted by path, skipping files that aren't metadata", async () => {
    asset("b.lua", U1, "LuaScript")
    asset("textures/a.png", U2, "Texture")
    write("corrupt.meta", "{ not json")
    write("notes.txt", "ignored")
    write("empty.meta", "{}")
    assert.deepEqual(
      (await readAssetIndex(root)).map((e) => e.path),
      ["res://b.lua", "res://textures/a.png"]
    )
  })

  test("a .meta whose file is gone (the host keeps it) isn't listed", async () => {
    const file = asset("a.png", U1, "Texture")
    asset("b.png", U2, "Texture")
    fs.rmSync(file)
    assert.deepEqual(
      (await readAssetIndex(root)).map((e) => e.path),
      ["res://b.png"]
    )
    // A folder where the file was isn't the file
    fs.mkdirSync(file)
    assert.equal((await readAssetIndex(root)).length, 1)
  })

  test("a .meta that names a path outside the assets folder isn't listed", async () => {
    fs.writeFileSync(path.join(root, "secret.txt"), "x")
    write("evil.meta", meta(U1, "res://../secret.txt", "Unknown"))
    assert.deepEqual(await readAssetIndex(root), [])
  })

  test("a model's sub-assets are listed only while the file is the one that was indexed", async () => {
    const file = path.join(root, "assets", "robot.glb")
    fs.writeFileSync(file, "12345")
    const modified = Math.floor(fs.statSync(file).mtimeMs / 1000)
    const sub = { "mesh/Body": { type: "Mesh", uuid: U2 } }
    write(
      "robot.glb.meta",
      meta(U1, "res://robot.glb", "Model", {
        customData: { subAssets: sub, subAssetsSource: { fileSize: 5, lastModified: modified } },
      })
    )
    assert.deepEqual(
      (await readAssetIndex(root)).map((e) => e.path),
      ["res://robot.glb", "res://robot.glb#mesh/Body"]
    )
    // The file changed (re-exported): the index is stale until the host loads the model again
    fs.writeFileSync(file, "123456789")
    assert.deepEqual(
      (await readAssetIndex(root)).map((e) => e.path),
      ["res://robot.glb"]
    )
    // No source recorded: nothing says the index fits
    write("robot.glb.meta", meta(U1, "res://robot.glb", "Model", { customData: { subAssets: sub } }))
    assert.equal((await readAssetIndex(root)).length, 1)
  })

  test("a project without .import has no assets", async () => {
    fs.rmSync(path.join(root, ".import"), { recursive: true })
    assert.deepEqual(await readAssetIndex(root), [])
    assert.deepEqual(await readAssetIndex(path.join(temp, "missing")), [])
  })

  test("an oversized .meta is skipped", async () => {
    asset("big.bin", U1, "Unknown", { customData: { pad: "x".repeat(MaxMetaBytes) } })
    asset("small.bin", U2, "Unknown")
    assert.deepEqual(
      (await readAssetIndex(root)).map((e) => e.path),
      ["res://small.bin"]
    )
  })

  test("the .meta files read in one listing have a total byte budget", async () => {
    asset("a.png", U1, "Texture")
    asset("b.png", U2, "Texture")
    const size = fs.statSync(path.join(root, ".import", "a.png.meta")).size
    assert.equal((await readAssetIndex(root, new Map(), size * 2)).length, 2)
    assert.equal((await readAssetIndex(root, new Map(), size + 1)).length, 1)
    assert.equal((await readAssetIndex(root, new Map(), 0)).length, 0)
  })

  test("links are never followed", async () => {
    const outside = path.join(temp, "outside")
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, "evil.meta"), JSON.stringify(meta(U3, "res://evil.png", "Texture")))
    fs.writeFileSync(path.join(root, "assets", "evil.png"), "x")
    fs.symlinkSync(outside, path.join(root, ".import", "linked"), "junction")
    try {
      fs.symlinkSync(path.join(outside, "evil.meta"), path.join(root, ".import", "evil.meta"), "file")
    } catch {
      // creating a file link needs a privilege on Windows: the folder link already covers the walk
    }
    assert.deepEqual(await readAssetIndex(root), [])

    // And .import itself as a link
    fs.rmSync(path.join(root, ".import"), { recursive: true })
    fs.symlinkSync(outside, path.join(root, ".import"), "junction")
    assert.deepEqual(await readAssetIndex(root), [])
  })

  test("a .meta that didn't change since the last listing isn't read again, one that did is", async () => {
    asset("a.png", U1, "Texture")
    const cache: AssetIndexCache = new Map()
    assert.equal((await readAssetIndex(root, cache)).length, 1)
    assert.equal(cache.size, 1)
    const [key, held] = [...cache][0]
    // Change what the cache holds: a listing that uses it shows the change, so the file wasn't read again
    held.parsed = { ...held.parsed!, file: { ...held.parsed!.file, resourceType: "Cached" } }
    assert.equal((await readAssetIndex(root, cache))[0].resourceType, "Cached")
    // The .meta changed: it is read again
    const later = new Date(Date.now() + 5000)
    write("a.png.meta", meta(U1, "res://a.png", "Texture", { fileSize: 99 }))
    fs.utimesSync(key, later, later)
    assert.equal((await readAssetIndex(root, cache))[0].resourceType, "Texture")
    // A .meta that is gone leaves the cache
    fs.rmSync(key)
    assert.deepEqual(await readAssetIndex(root, cache), [])
    assert.equal(cache.size, 0)
  })

  test("ProjectFiles.listAssets reads the open project's index, and needs one open", async () => {
    asset("a.png", U1, "Texture")
    const files = new ProjectFiles()
    assert.throws(() => files.listAssets(), /No project is open/)
    files.open(root)
    assert.deepEqual(await files.listAssets(), [{ uuid: U1, path: "res://a.png", resourceType: "Texture" }])
  })
})
