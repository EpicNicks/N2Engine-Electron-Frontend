// Every read tool against the fake host: the happy path, paging, truncation markers and size caps.
import { randomFillSync } from "node:crypto"
import { test, describe, before, after } from "node:test"
import * as assert from "node:assert/strict"
import { decodePngRgb } from "../src/png"
import { decomposeMatrix, utf8Range } from "../src/tools"
import * as limits from "../src/limits"
import { FakeHost, LightType, ProjectRoot, entityData, node } from "./fake-host"
import { TestToken, closeAllHarnesses, everything, startHarness, textOf, type Harness } from "./harness"

after(closeAllHarnesses)

describe("read tools against a fake host", () => {
  let h: Harness
  before(async () => {
    h = await startHarness()
  })
  after(async () => {
    await h.close()
  })

  test("every result is structured content plus a text block with the data in an untrusted envelope", async () => {
    const r = await h.call("n2_status")
    assert.ok(!r.isError, textOf(r))
    assert.equal(r.structuredContent.source, "host")
    assert.equal(r.structuredContent.untrusted, true)
    const text = textOf(r)
    assert.match(text, /<n2-data source="host" untrusted>/)
    assert.ok(text.endsWith("</n2-data>"))
    // The text block carries the same data the structured content does
    const inner = text.slice(text.indexOf("\n", text.indexOf("<n2-data")) + 1, text.lastIndexOf("\n</n2-data>"))
    assert.deepEqual(JSON.parse(inner), r.structuredContent)
  })

  test("n2_status: host, role, project, scene, play, health, history", async () => {
    const d = (await h.call("n2_status")).structuredContent.data
    assert.equal(d.bridge.name, "n2-mcp")
    assert.equal(d.bridge.backend, "connect")
    assert.equal(d.host.role, "editor")
    assert.equal(d.host.readOnly, false)
    assert.equal(d.host.protocolVersion, "1.21.0")
    assert.deepEqual(d.project, { name: "Demo", projectId: "22222222-0000-0000-0000-000000000000" })
    assert.equal(d.scene.path, "res://scenes/Main.scene")
    assert.equal(d.scene.dirty, false)
    assert.equal(d.play.state, "Edit")
    assert.equal(d.health.healthy, true)
    assert.deepEqual(d.history, { undoSteps: 2, redoSteps: 1, nextUndoLabel: "Move Player" })
    assert.deepEqual(d.unavailable, [])
  })

  test("n2_status: a dirty scene is said so, and a part the host can't answer is listed, not fatal", async () => {
    const dirty = await startHarness()
    dirty.host.on("GetOpenScene", () => ({ path: "res://scenes/Main.scene", name: "Main", uuid: "u", revision: 7, savedRevision: 5 }))
    dirty.host.on("GetEngineHealth", () => {
      throw new (class extends Error {})("boom")
    })
    // A refusal by the host (an EngineError) is "unavailable"; use the Refusal type for that
    const { Refusal } = await import("./fake-host")
    dirty.host.on("GetEngineHealth", () => {
      throw new Refusal("No renderer")
    })
    const r = await dirty.call("n2_status")
    assert.ok(!r.isError, textOf(r))
    assert.equal(r.structuredContent.data.scene.dirty, true)
    assert.equal(r.structuredContent.data.health, null)
    assert.deepEqual(r.structuredContent.data.unavailable, ["health"])
    assert.match(textOf(r), /unsaved changes/)
    await dirty.close()
  })

  test("n2_get_project_info: no absolute host paths", async () => {
    const r = await h.call("n2_get_project_info")
    const d = r.structuredContent.data
    assert.equal(d.name, "Demo")
    assert.equal(d.startupScene, "res://scenes/Main.scene")
    assert.deepEqual(d.scenes, ["res://scenes/Main.scene"])
    assert.deepEqual(d.settings, { window: { title: "Demo" } })
    assert.ok(!everything(r).includes("agent"), "no host user folder in the result")
    assert.ok(!everything(r).includes("rootPath"))
  })

  test("n2_get_hierarchy: nodes with depth, parent, components", async () => {
    const r = await h.call("n2_get_hierarchy")
    const d = r.structuredContent.data
    assert.equal(d.revision, 5)
    assert.equal(d.total, 4)
    assert.deepEqual(d.nodes.map((n: any) => [n.name, n.depth]), [["Root", 0], ["Player", 1], ["Camera", 2], ["Light", 1]])
    assert.deepEqual(d.nodes[1].components, ["MeshRenderer"])
    assert.equal(r.structuredContent.truncated, false)
    assert.equal(r.structuredContent.nextCursor, undefined)
  })

  test("n2_get_hierarchy: rootId lists a subtree with relative depth, maxDepth limits it", async () => {
    const player = "11111111-0000-0000-0000-000000000002"
    const sub = (await h.call("n2_get_hierarchy", { rootId: player })).structuredContent.data
    assert.deepEqual(sub.nodes.map((n: any) => [n.name, n.depth]), [["Player", 0], ["Camera", 1]])
    const shallow = (await h.call("n2_get_hierarchy", { maxDepth: 1 })).structuredContent.data
    assert.deepEqual(shallow.nodes.map((n: any) => n.name), ["Root", "Player", "Light"])
    const missing = await h.call("n2_get_hierarchy", { rootId: "ffffffff-0000-0000-0000-000000000000" })
    assert.equal(missing.isError, true)
    assert.equal(missing._meta?.["n2/errorCode"], "invalid_argument")
  })

  test("n2_get_entity: header, transforms, children, components with values", async () => {
    const id = "11111111-0000-0000-0000-000000000002"
    h.host.entities.set(id, entityData(id, "11111111-0000-0000-0000-000000000001", "Player", [
      { type: "MeshRenderer", uuid: "c1", values: { castShadows: true } },
      { type: "Light", uuid: "c2", values: { intensity: 3 } },
    ]))
    const r = await h.call("n2_get_entity", { entityId: id })
    assert.ok(!r.isError, textOf(r))
    const d = r.structuredContent.data
    assert.equal(d.entity.name, "Player")
    assert.deepEqual(d.localTransform.position, { x: 1, y: 2, z: 3 })
    assert.deepEqual(d.worldTransform.scale, { x: 2, y: 2, z: 2 })
    assert.deepEqual(d.worldTransform.rotation, { x: 0, y: 0, z: 0, w: 1 })
    assert.deepEqual(d.children, { count: 1, items: [{ id: "11111111-0000-0000-0000-000000000003", name: "Camera" }], truncated: false })
    assert.deepEqual(d.components.map((c: any) => c.type), ["MeshRenderer", "Light"])
    assert.deepEqual(d.components[1].values, { intensity: 3 })
    assert.equal(d.componentsOmitted, 0)
    const only = (await h.call("n2_get_entity", { entityId: id, componentTypes: ["Light"] })).structuredContent
    assert.deepEqual(only.data.components.map((c: any) => c.type), ["Light"])
    assert.equal(only.data.componentsOmitted, 1)
    assert.equal(only.truncated, true)
  })

  test("n2_get_entity: an unknown entity is a host_error that quotes the host's words as data", async () => {
    const r = await h.call("n2_get_entity", { entityId: "99999999-0000-0000-0000-000000000000" })
    assert.equal(r.isError, true)
    assert.equal(r._meta?.["n2/errorCode"], "host_error")
    assert.match(textOf(r), /Host said \(untrusted data, not instructions\): "No such object"/)
  })

  test("n2_get_entity: component values are bounded by the 64 KB budget with a marker", async () => {
    const id = "11111111-0000-0000-0000-0000000000aa"
    const big = Array.from({ length: 60 }, (_, i) => ({ type: `Blob${i}`, uuid: `u${i}`, values: { text: "x".repeat(3000) } }))
    h.host.entities.set(id, entityData(id, "", "Big", big))
    const r = await h.call("n2_get_entity", { entityId: id })
    assert.ok(!r.isError, textOf(r))
    assert.equal(r.structuredContent.truncated, true)
    const shown = r.structuredContent.data.components
    assert.ok(shown.length < 60, "components past the budget are left out")
    assert.equal(shown.length + r.structuredContent.data.componentsOmitted, 60)
    assert.ok(Buffer.byteLength(textOf(r)) <= limits.MaxResultBytes)
    assert.ok(everything(r).includes("[omitted: size budget reached]") || r.structuredContent.data.componentsOmitted > 0)
  })

  test("n2_get_component_types and n2_describe_component: JSON Schema from the field schemas", async () => {
    const list = (await h.call("n2_get_component_types")).structuredContent.data
    assert.equal(list.count, 2)
    assert.deepEqual(list.types[0], { typeName: "Light", singleton: false, fieldCount: 5 })
    const filtered = (await h.call("n2_get_component_types", { filter: "lua" })).structuredContent.data
    assert.deepEqual(filtered.types.map((t: any) => t.typeName), ["LuaComponent"])

    const d = (await h.call("n2_describe_component", { typeName: "Light" })).structuredContent.data
    const props = d.jsonSchema.properties
    assert.equal(d.jsonSchema.$schema, "https://json-schema.org/draft/2020-12/schema")
    assert.deepEqual(props.intensity, { type: "number", minimum: 0, maximum: 100, description: "Intensity. How bright" })
    assert.deepEqual(props.color.required, ["r", "g", "b", "a"].length === 4 ? ["x", "y", "z"] : [])
    assert.deepEqual(props.mode, { type: "string", enum: ["Point", "Spot"], description: "Mode" })
    assert.deepEqual(props.cookie.type, ["string", "null"])
    assert.equal(props.cookie.format, "uuid")
    assert.equal(props.secret, undefined, "hidden fields are left out")
    assert.equal(props.range.readOnly, true)
    assert.equal(props.isActive.type, "boolean")
    assert.deepEqual(d.defaults, { isActive: true, intensity: 1 })
    assert.equal(h.host.count("GetComponentTypes"), 1, "the types are asked for once per session")

    const unknown = await h.call("n2_describe_component", { typeName: "Nope" })
    assert.equal(unknown._meta?.["n2/errorCode"], "invalid_argument")
    const neither = await h.call("n2_describe_component", {})
    assert.equal(neither._meta?.["n2/errorCode"], "invalid_argument")
    const half = await h.call("n2_describe_component", { entityId: "a" })
    assert.equal(half._meta?.["n2/errorCode"], "invalid_argument")
  })

  test("n2_describe_component: a LuaComponent's script fields nest under their container", async () => {
    const d = (await h.call("n2_describe_component", { entityId: "e1", componentId: "c1" })).structuredContent.data
    assert.equal(d.typeName, "LuaComponent")
    assert.equal(d.jsonSchema.properties.scriptData.properties.speed.type, "number")
    assert.equal(d.jsonSchema.properties.scriptUUID.format, "uuid")
  })

  test("n2_list_assets and n2_get_asset_info", async () => {
    const d = (await h.call("n2_list_assets")).structuredContent.data
    assert.deepEqual(d.folders, ["res://scripts", "res://textures"])
    assert.equal(d.assets.length, 2)
    assert.deepEqual(d.assets[0], { path: "res://scripts/Player.lua", uuid: "a0000000-0000-0000-0000-000000000001", type: "LuaScript", size: 120, modified: 1700000000000, subAssets: 0 })
    const textures = (await h.call("n2_list_assets", { type: "Texture" })).structuredContent.data
    assert.deepEqual(textures.assets.map((a: any) => a.path), ["res://textures/wall.png"])
    const info = (await h.call("n2_get_asset_info", { pathOrUuid: "res://textures/wall.png" })).structuredContent.data.asset
    assert.equal(info.type, "Texture")
    assert.deepEqual(info.customData, { filter: "linear" })
    assert.equal(info.loaded, false)
    const missing = await h.call("n2_get_asset_info", { pathOrUuid: "res://nope.png" })
    assert.equal(missing._meta?.["n2/errorCode"], "host_error")
  })

  test("n2_read_text_asset: the file, with line endings as \\n", async () => {
    h.host.texts.set("res://a.txt", "one\r\ntwo\r\n")
    const r = await h.call("n2_read_text_asset", { path: "res://a.txt" })
    const d = r.structuredContent.data
    assert.equal(d.text, "one\ntwo\n")
    assert.equal(d.endOfFile, true)
    assert.equal(d.totalBytes, 10)
    assert.equal(r.structuredContent.truncated, false)
  })

  test("n2_read_text_asset: markup-heavy text still comes back as a shorter truncated slice", async () => {
    h.host.texts.set("res://ui/menu.xml", "<a>&</a>".repeat(40000))
    const r = await h.call("n2_read_text_asset", { path: "res://ui/menu.xml", length: 102400 })
    assert.notEqual(r.isError, true)
    assert.equal(r.structuredContent.truncated, true)
    assert.ok(r.structuredContent.data.length < 102400)
    assert.ok(typeof r.structuredContent.nextCursor === "string")
  })

  test("n2_get_console: the latest lines, then only what is new; level and contains filter", async () => {
    const c = await startHarness()
    c.host.addLogEvents(["info", "starting"], ["warn", "texture missing"], ["error", "Lua error in Player.lua"], ["info", "ready"])
    const first = (await c.call("n2_get_console")).structuredContent
    assert.deepEqual(first.data.lines.map((l: any) => l.message), ["starting", "texture missing", "Lua error in Player.lua", "ready"])
    assert.equal(first.nextCursor, "777:4")
    assert.equal(first.data.hasMore, false)
    c.host.addLogEvents(["info", "later"])
    const next = (await c.call("n2_get_console", { cursor: first.nextCursor })).structuredContent
    assert.deepEqual(next.data.lines.map((l: any) => l.message), ["later"])
    const errors = (await c.call("n2_get_console", { level: "warn" })).structuredContent.data.lines
    assert.deepEqual(errors.map((l: any) => l.level), ["warn", "error"])
    const contains = (await c.call("n2_get_console", { contains: "LUA" })).structuredContent.data.lines
    assert.deepEqual(contains.map((l: any) => l.message), ["Lua error in Player.lua"])
    const tail = (await c.call("n2_get_console", { limit: 2 })).structuredContent
    assert.deepEqual(tail.data.lines.map((l: any) => l.message), ["ready", "later"])
    assert.equal(tail.truncated, true)
    await c.close()
  })

  test("n2_get_console: paging forward with a cursor, a line at a time", async () => {
    const c = await startHarness()
    for (let i = 1; i <= 5; i++) c.host.addLogEvents(["info", `line ${i}`])
    const seen: string[] = []
    let cursor = "0:0"
    for (let page = 0; page < 10; page++) {
      const r = (await c.call("n2_get_console", { cursor, limit: 2 })).structuredContent
      seen.push(...r.data.lines.map((l: any) => l.message))
      cursor = r.nextCursor
      if (!r.data.hasMore) break
    }
    assert.deepEqual(seen, ["line 1", "line 2", "line 3", "line 4", "line 5"])
    await c.close()
  })

  test("n2_screenshot: a PNG image content block, 768x432 by default, that decodes to the frame", async () => {
    const r = await h.call("n2_screenshot")
    assert.ok(!r.isError, textOf(r))
    const image = r.content.find((c) => c.type === "image")!
    assert.equal(image.mimeType, "image/png")
    const png = Buffer.from(image.data!, "base64")
    const decoded = decodePngRgb(png)
    assert.deepEqual([decoded.width, decoded.height], [768, 432])
    // The fake host's frame: red is x mod 256, green is y mod 256, blue 128
    assert.deepEqual([...decoded.rgb.subarray(0, 3)], [0, 0, 128])
    const px = (432 - 1) * 768 + 300
    assert.deepEqual([...decoded.rgb.subarray(px * 3, px * 3 + 3)], [300 & 255, (432 - 1) & 255, 128])
    assert.equal(r.structuredContent.data.pngBytes, png.length)
    assert.equal(r.structuredContent.untrusted, false)
    assert.equal(h.host.viewport.width, 768)
  })

  test("n2_screenshot: the long side is capped at 1568 and the aspect ratio kept; the game view uses RenderFrame", async () => {
    const r = await h.call("n2_screenshot", { width: 3200, height: 1600, view: "game" })
    assert.ok(!r.isError, textOf(r))
    const d = r.structuredContent.data
    assert.deepEqual([d.width, d.height, d.scaledDown, d.view], [1568, 784, true, "game"])
    assert.ok(h.host.count("RenderFrame") >= 1)
    const bad = await h.call("n2_screenshot", { width: 5000 })
    assert.equal(bad.isError, true, "past the host's own 4096 limit is refused by the schema")
  })

  test("n2_screenshot: a picture over the PNG size cap is a result_too_large error with advice", async () => {
    const noisy = await startHarness()
    noisy.host.on("RenderFrameIfChanged", () => {
      const { width, height } = noisy.host.viewport
      const pixels = new Uint8Array(width * height * 4)
      randomFillSync(pixels)
      for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
      return { revision: 1, modified: true, width, height, pixels }
    })
    const r = await noisy.call("n2_screenshot", { width: 1568, height: 882 })
    assert.equal(r.isError, true)
    assert.equal(r._meta?.["n2/errorCode"], "result_too_large")
    assert.match(textOf(r), /smaller width and height/)
    await noisy.close()
  })

  test("n2_screenshot: a malformed frame from the host is refused", async () => {
    const bad = await startHarness()
    bad.host.on("RenderFrameIfChanged", () => ({ revision: 1, modified: true, width: 10, height: 10, pixels: new Uint8Array(12) }))
    const r = await bad.call("n2_screenshot")
    assert.equal(r.isError, true)
    assert.equal(r._meta?.["n2/errorCode"], "host_error")
    await bad.close()
  })

  test("no tool result ever holds the token or a host path", async () => {
    for (const name of ["n2_status", "n2_get_project_info", "n2_get_hierarchy", "n2_get_component_types", "n2_list_assets"]) {
      const text = everything(await h.call(name))
      assert.ok(!text.includes(TestToken), name)
      assert.ok(!text.includes("C:\\\\Users"), name)
      assert.ok(!text.includes(ProjectRoot), name)
    }
  })
})

describe("hierarchy paging, truncation and caps", () => {
  let h: Harness
  before(async () => {
    h = await startHarness()
    const nodes = [node("00000000-0000-0000-0000-000000000000", "", 0, "Root")]
    for (let i = 1; i <= 450; i++) nodes.push(node(`00000000-0000-0000-0000-${String(i).padStart(12, "0")}`, "00000000-0000-0000-0000-000000000000", i - 1, `Node ${i}`, ["Transform"]))
    h.host.nodes = nodes
  })
  after(async () => {
    await h.close()
  })

  test("200 nodes per page by default, with a cursor to the next, until the end", async () => {
    const names: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const r = await h.call("n2_get_hierarchy", cursor ? { cursor } : {})
      assert.ok(!r.isError, textOf(r))
      const s = r.structuredContent
      assert.ok(s.data.nodes.length <= limits.HierarchyDefaultLimit)
      assert.equal(s.data.total, 451)
      names.push(...s.data.nodes.map((n: any) => n.name))
      assert.equal(s.truncated, s.nextCursor !== undefined)
      cursor = s.nextCursor
      pages++
    } while (cursor)
    assert.equal(pages, 3)
    assert.equal(names.length, 451)
    assert.equal(new Set(names).size, 451)
  })

  test("limit is honoured and capped by the schema at 2000", async () => {
    const r = await h.call("n2_get_hierarchy", { limit: 10 })
    assert.equal(r.structuredContent.data.nodes.length, 10)
    assert.ok(r.structuredContent.nextCursor)
    const over = await h.call("n2_get_hierarchy", { limit: 5000 })
    assert.equal(over.isError, true)
  })

  test("a cursor the bridge didn't give out, or one for other arguments, is refused", async () => {
    const junk = await h.call("n2_get_hierarchy", { cursor: "not-a-cursor" })
    assert.equal(junk._meta?.["n2/errorCode"], "invalid_argument")
    const first = await h.call("n2_get_hierarchy", { limit: 5 })
    const other = await h.call("n2_get_hierarchy", { cursor: first.structuredContent.nextCursor, maxDepth: 3, limit: 5 })
    assert.equal(other._meta?.["n2/errorCode"], "invalid_argument")
  })

  test("a scene that changed between pages is flagged revisionChanged", async () => {
    const first = await h.call("n2_get_hierarchy", { limit: 5 })
    h.host.hierarchyRevision = 99
    const second = await h.call("n2_get_hierarchy", { cursor: first.structuredContent.nextCursor, limit: 5 })
    h.host.hierarchyRevision = 5
    assert.equal(second.structuredContent.data.revisionChanged, true)
    assert.equal(second.structuredContent.data.revision, 99)
    assert.ok(second.structuredContent.notes?.length)
  })

  test("a page of huge names is cut at the size budget with a cursor to continue", async () => {
    const big = await startHarness()
    big.host.nodes = Array.from({ length: 150 }, (_, i) =>
      node(`00000000-0000-0000-0000-${String(i).padStart(12, "0")}`, "", i, "N".repeat(256), Array.from({ length: 64 }, (_, k) => `Component${k}-${"c".repeat(100)}`))
    )
    const r = await big.call("n2_get_hierarchy", { limit: 150 })
    assert.ok(!r.isError, textOf(r))
    assert.ok(Buffer.byteLength(textOf(r)) <= limits.MaxResultBytes)
    assert.ok(r.structuredContent.data.nodes.length < 150)
    assert.equal(r.structuredContent.truncated, true)
    assert.ok(r.structuredContent.nextCursor)
    await big.close()
  })
})

describe("asset list paging, text asset ranges", () => {
  test("the asset list pages folders then assets with a cursor", async () => {
    const h = await startHarness()
    h.host.assets = Array.from({ length: 450 }, (_, i) => ({ path: `res://a/${i}.lua`, uuid: `a${i}`, type: "LuaScript", size: 1, modified: 1 }))
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const r = await h.call("n2_list_assets", { ...(cursor ? { cursor } : {}), limit: 200 })
      assert.ok(!r.isError, textOf(r))
      seen.push(...r.structuredContent.data.folders, ...r.structuredContent.data.assets.map((a: any) => a.path))
      cursor = r.structuredContent.nextCursor
      pages++
    } while (cursor)
    assert.equal(pages, 3)
    assert.equal(seen.length, 452)
    assert.equal(new Set(seen).size, 452)
    await h.close()
  })

  test("a text asset is capped at 100 KB per call, with a truncation marker and a next offset", async () => {
    const h = await startHarness()
    h.host.texts.set("res://big.txt", "0123456789".repeat(30000)) // 300000 bytes
    const first = await h.call("n2_read_text_asset", { path: "res://big.txt" })
    assert.equal(first.structuredContent.data.length, limits.TextAssetDefaultBytes)
    assert.equal(first.structuredContent.truncated, true)
    assert.match(first.structuredContent.data.truncationNote, /^\.\.\.\[truncated: 267232 more bytes follow; call again with offset 32768\]$/)
    assert.equal(first.structuredContent.nextCursor, "32768")
    const max = await h.call("n2_read_text_asset", { path: "res://big.txt", length: limits.TextAssetMaxBytes })
    assert.equal(max.structuredContent.data.length, limits.TextAssetMaxBytes)
    assert.ok(Buffer.byteLength(textOf(max)) <= limits.TextAssetMaxBytes + 4096, "the whole text block stays near the 100 KB cap")
    // A file of newlines is twice the size as JSON: the slice shrinks until its JSON text fits
    h.host.texts.set("res://nl.txt", "\n".repeat(150000))
    const nl = await h.call("n2_read_text_asset", { path: "res://nl.txt", length: limits.TextAssetMaxBytes })
    assert.ok(!nl.isError, textOf(nl))
    assert.ok(nl.structuredContent.data.length < limits.TextAssetMaxBytes)
    assert.ok(Buffer.byteLength(textOf(nl)) <= limits.TextAssetMaxBytes * 1.2)
    assert.equal(nl.structuredContent.truncated, true)
    const over = await h.call("n2_read_text_asset", { path: "res://big.txt", length: limits.TextAssetMaxBytes + 1 })
    assert.equal(over.isError, true, "a longer range is refused by the schema")
    // Reading the whole file in ranges gives the file back
    let offset = 0
    let all = ""
    for (;;) {
      const r = await h.call("n2_read_text_asset", { path: "res://big.txt", offset, length: limits.TextAssetMaxBytes })
      all += r.structuredContent.data.text
      if (r.structuredContent.data.endOfFile) break
      offset = r.structuredContent.data.offset + r.structuredContent.data.length
    }
    assert.equal(all, "0123456789".repeat(30000))
    const past = await h.call("n2_read_text_asset", { path: "res://big.txt", offset: 300001 })
    assert.equal(past._meta?.["n2/errorCode"], "invalid_argument")
    await h.close()
  })

  test("ranges land on UTF-8 character boundaries", async () => {
    const h = await startHarness()
    h.host.texts.set("res://u.txt", "a\u00e9\u20ac\u{1F600}b") // 1 + 2 + 3 + 4 + 1 bytes
    const parts: string[] = []
    let offset = 0
    for (let i = 0; i < 20; i++) {
      const r = await h.call("n2_read_text_asset", { path: "res://u.txt", offset, length: 2 })
      parts.push(r.structuredContent.data.text)
      if (r.structuredContent.data.endOfFile) break
      offset = r.structuredContent.data.offset + r.structuredContent.data.length
    }
    assert.equal(parts.join(""), "a\u00e9\u20ac\u{1F600}b")
    assert.ok(parts.every((p) => !p.includes("\ufffd")))
    await h.close()
  })
})

describe("helpers", () => {
  test("utf8Range moves both ends to character boundaries and never returns an empty slice inside a character", () => {
    const bytes = Buffer.from("a\u00e9\u20ac", "utf8") // 61 | c3 a9 | e2 82 ac
    assert.deepEqual(utf8Range(bytes, 0, 2), { start: 0, end: 1 })
    assert.deepEqual(utf8Range(bytes, 2, 1), { start: 3, end: 6 })
    assert.deepEqual(utf8Range(bytes, 0, 100), { start: 0, end: 6 })
    assert.deepEqual(utf8Range(bytes, 100, 10), { start: 6, end: 6 })
  })

  test("decomposeMatrix recovers position, scale and rotation", () => {
    const half = Math.SQRT1_2
    // Scale (1,2,3), rotation 90 degrees about z, translation (4,5,6); column-major
    const m = [0, 1, 0, 0, -2, 0, 0, 0, 0, 0, 3, 0, 4, 5, 6, 1]
    const t = decomposeMatrix(m)!
    assert.deepEqual(t.position, { x: 4, y: 5, z: 6 })
    assert.ok(Math.abs(t.scale.x - 1) < 1e-9 && Math.abs(t.scale.y - 2) < 1e-9 && Math.abs(t.scale.z - 3) < 1e-9)
    assert.ok(Math.abs(t.rotation.z - half) < 1e-9 && Math.abs(t.rotation.w - half) < 1e-9)
    assert.equal(decomposeMatrix([1, 2, 3]), null)
    assert.equal(decomposeMatrix(Array(16).fill(NaN)), null)
  })
})
