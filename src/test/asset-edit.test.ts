import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import {
  MaxImportSettingsBytes,
  MaxTextAssetBytes,
  checkAssetName,
  checkScriptName,
  checkTextForWrite,
  importSettingsText,
  isTextAssetPath,
  parseImportSettings,
  sameImportSettings,
  scriptFileName,
} from "../renderer/asset-edit"

const errorOf = (checked: { ok: boolean; error?: string }) => (checked.ok ? null : checked.error)

describe("checkAssetName", () => {
  test("ordinary names pass, with or without an extension", () => {
    for (const name of ["Player", "player.lua", "My Folder", "a.b.c", "ünï"]) {
      assert.equal(checkAssetName(name).ok, true, name)
    }
  })

  test("what a file can't be called on every platform is refused", () => {
    assert.match(errorOf(checkAssetName(""))!, /empty/)
    assert.match(errorOf(checkAssetName(".."))!, /isn't a name/)
    assert.match(errorOf(checkAssetName("a/b"))!, /can't contain "\/"/)
    assert.match(errorOf(checkAssetName("a:b"))!, /can't contain ":"/)
    assert.match(errorOf(checkAssetName("a\u0007b"))!, /control character/)
    assert.match(errorOf(checkAssetName("a."))!, /end with a dot or a space/)
    assert.match(errorOf(checkAssetName("a "))!, /end with a dot or a space/)
    assert.match(errorOf(checkAssetName("CON"))!, /reserved/)
    assert.match(errorOf(checkAssetName("nul.txt"))!, /reserved/)
    assert.match(errorOf(checkAssetName("x".repeat(256)))!, /255 bytes/)
    // 255 bytes of ASCII is the limit, 256 bytes of two-byte characters is over it
    assert.equal(checkAssetName("x".repeat(255)).ok, true)
    assert.equal(checkAssetName("é".repeat(128)).ok, false)
  })

  test("a script's name gets .lua unless it has it", () => {
    assert.equal(scriptFileName("Player"), "Player.lua")
    assert.equal(scriptFileName(" Player.LUA "), "Player.LUA")
    assert.deepEqual(checkScriptName("Player"), { ok: true, value: "Player.lua" })
    assert.match(errorOf(checkScriptName(".lua"))!, /empty/)
    assert.match(errorOf(checkScriptName("a/b"))!, /can't contain/)
  })
})

describe("import settings", () => {
  test("shown pretty-printed, {} for none", () => {
    assert.equal(importSettingsText({ a: 1 }), '{\n  "a": 1\n}')
    assert.equal(importSettingsText(undefined), "{}")
  })

  test("an object is taken", () => {
    assert.deepEqual(parseImportSettings('{ "sRGB": true, "size": [1, 2] }'), {
      ok: true,
      value: { sRGB: true, size: [1, 2] },
    })
    assert.deepEqual(parseImportSettings("{}"), { ok: true, value: {} })
  })

  test("what isn't a JSON object is explained", () => {
    assert.match(errorOf(parseImportSettings(""))!, /empty/)
    assert.match(errorOf(parseImportSettings("{ nope"))!, /^Not valid JSON/)
    assert.match(errorOf(parseImportSettings("[1]"))!, /must be a JSON object/)
    assert.match(errorOf(parseImportSettings("5"))!, /must be a JSON object/)
    assert.match(errorOf(parseImportSettings("null"))!, /must be a JSON object/)
  })

  test("limits: size and depth", () => {
    const big = JSON.stringify({ s: "x".repeat(MaxImportSettingsBytes) })
    assert.match(errorOf(parseImportSettings(big))!, /larger than 64 KiB/)
    assert.equal(parseImportSettings(JSON.stringify({ s: "x".repeat(MaxImportSettingsBytes - 20) })).ok, true)
    let deep = "1"
    for (let i = 0; i < 40; i++) deep = `[${deep}]`
    assert.match(errorOf(parseImportSettings(`{"a": ${deep}}`))!, /nested too deeply/)
  })

  test("two texts are the same settings whatever their spacing and key order", () => {
    assert.equal(sameImportSettings('{"a":1,"b":{"c":2,"d":3}}', '{ "b": {"d":3, "c":2}, "a": 1 }'), true)
    assert.equal(sameImportSettings('{"a":1}', '{"a":2}'), false)
    assert.equal(sameImportSettings("{ nope", "{ nope"), true)
    assert.equal(sameImportSettings("{ nope", "{}"), false)
  })
})

describe("text files", () => {
  test("the host's allow-list of extensions, in any case", () => {
    for (const path of ["res://a.lua", "res://a.SCENE", "res://dir.d/a.Json", "res://a.frag", "res://a.shader"]) {
      assert.equal(isTextAssetPath(path), true, path)
    }
    for (const path of ["res://a.png", "res://a", "res://.lua", "res://a.glb"]) {
      assert.equal(isTextAssetPath(path), false, path)
    }
  })

  test("a text the host would take", () => {
    assert.equal(checkTextForWrite("print('hi')\r\nüñí 😀").ok, true)
    assert.equal(checkTextForWrite("").ok, true)
  })

  test("a NUL, half a surrogate pair, or more than 4 MiB is refused", () => {
    assert.match(errorOf(checkTextForWrite("a\u0000b"))!, /NUL/)
    assert.match(errorOf(checkTextForWrite("a\ud83db"))!, /UTF-8/)
    assert.match(errorOf(checkTextForWrite("a\ude00"))!, /UTF-8/)
    assert.equal(checkTextForWrite("x".repeat(MaxTextAssetBytes)).ok, true)
    assert.match(errorOf(checkTextForWrite("x".repeat(MaxTextAssetBytes + 1)))!, /larger than 4 MiB/)
    // 3-byte characters: under the limit in characters, over it in bytes
    assert.match(errorOf(checkTextForWrite("€".repeat(MaxTextAssetBytes / 3 + 1)))!, /larger than 4 MiB/)
  })
})
