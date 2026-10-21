import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { AssetDetails, AssetInfo } from "../protocol/protocol.generated"
import { AssetsState, settingsEdited } from "../renderer/assets-state"
import {
  FontSchema,
  ImportField,
  ModelSchema,
  TextureSchema,
  checkFieldValue,
  checkImportSettings,
  fieldText,
  firstImportError,
  importSchemaFor,
  maxSpreadPx,
  otherSettings,
  parseFieldText,
  withField,
} from "../renderer/assets-import-schema"

// The engine's parsers, as read on N2Engine master (key: kind, default, accepted values). A change of the tables must be
// a change of the engine first: Texture::ParseSettings, Model::ParseSettings, Font::ParseAtlasSettings.
const EngineFixture: Record<string, Record<string, [string, unknown, unknown[]?]>> = {
  Texture: {
    srgb: ["bool", true],
    filter: ["enum", "linear", ["linear", "nearest"]],
    wrap: ["enum", "repeat", ["repeat", "clamp"]],
    mipmaps: ["bool", true],
    flipY: ["bool", true],
  },
  Model: {
    scale: ["number", 1],
    importMaterials: ["bool", true],
    generateNormals: ["enum", "ifMissing", ["never", "ifMissing", "always"]],
    generateTangents: ["enum", "ifMissing", ["never", "ifMissing", "always"]],
    pbrMaterials: ["bool", false],
    mergeSubmeshesByMaterial: ["bool", false],
  },
  Font: {
    basePx: ["number", 48],
    spreadPx: ["integer", 8],
    paddingPx: ["integer", 2],
    charset: ["enum", "latin1", ["ascii", "latin1"]],
    extraChars: ["text", ""],
  },
}

const field = (schema: typeof TextureSchema, key: string): ImportField => {
  const found = schema.fields.find((f) => f.key === key)
  assert.ok(found, key)
  return found
}

describe("the import settings tables", () => {
  test("each type's fields, kinds, defaults and choices are the engine's", () => {
    for (const [type, keys] of Object.entries(EngineFixture)) {
      const schema = importSchemaFor(type)
      assert.ok(schema, type)
      assert.deepEqual(
        schema.fields.map((f) => f.key),
        Object.keys(keys),
        type
      )
      for (const [key, [kind, def, options]] of Object.entries(keys)) {
        const f = field(schema, key)
        assert.equal(f.kind, kind, `${type}.${key}`)
        assert.equal(f.defaultValue, def, `${type}.${key}`)
        if (options) assert.deepEqual([...(f.options ?? [])], options, `${type}.${key}`)
        // The default is always a value the engine reads
        assert.equal(checkFieldValue(f, f.defaultValue), null, `${type}.${key}`)
      }
    }
    assert.equal(TextureSchema.block, "texture")
    assert.equal(ModelSchema.block, "model")
    assert.equal(FontSchema.block, "font")
  })

  test("types without a loader that reads settings have no form", () => {
    for (const type of ["AudioClip", "LuaScript", "Material", "Scene", "Mesh", "", undefined, null]) {
      assert.equal(importSchemaFor(type), null, String(type))
    }
  })

  test("ranges: model scale above 0; font basePx 4..256, spreadPx 1..32 and paddingPx 0..16, integers", () => {
    const scale = field(ModelSchema, "scale")
    assert.equal(checkFieldValue(scale, 0.01), null)
    assert.match(checkFieldValue(scale, 0)!, /above 0/)
    assert.match(checkFieldValue(scale, -1)!, /above 0/)
    assert.match(checkFieldValue(scale, "1")!, /above 0/)
    const base = field(FontSchema, "basePx")
    assert.equal(checkFieldValue(base, 4), null)
    assert.equal(checkFieldValue(base, 256), null)
    assert.equal(checkFieldValue(base, 12.5), null)
    assert.match(checkFieldValue(base, 3.9)!, /from 4 to 256/)
    assert.match(checkFieldValue(base, 257)!, /from 4 to 256/)
    const spread = field(FontSchema, "spreadPx")
    assert.equal(checkFieldValue(spread, 1), null)
    assert.equal(checkFieldValue(spread, 32), null)
    assert.match(checkFieldValue(spread, 0)!, /integer from 1 to 32/)
    assert.match(checkFieldValue(spread, 33)!, /integer from 1 to 32/)
    assert.match(checkFieldValue(spread, 2.5)!, /integer/)
    const padding = field(FontSchema, "paddingPx")
    assert.equal(checkFieldValue(padding, 0), null)
    assert.equal(checkFieldValue(padding, 16), null)
    assert.match(checkFieldValue(padding, 17)!, /from 0 to 16/)
  })

  test("choices are exact (the engine compares case), booleans are JSON booleans", () => {
    const filter = field(TextureSchema, "filter")
    assert.equal(checkFieldValue(filter, "nearest"), null)
    assert.match(checkFieldValue(filter, "Nearest")!, /"linear" or "nearest"/)
    assert.match(checkFieldValue(field(TextureSchema, "srgb"), "true")!, /true or false/)
    assert.match(checkFieldValue(field(FontSchema, "extraChars"), 5)!, /a string/)
  })

  test("maxSpreadPx is the engine's: half the base size, from 1 to 32", () => {
    assert.equal(maxSpreadPx(48), 24)
    assert.equal(maxSpreadPx(4), 2)
    assert.equal(maxSpreadPx(9), 4)
    assert.equal(maxSpreadPx(256), 32)
    assert.equal(maxSpreadPx(1), 1)
  })
})

describe("checking settings", () => {
  test("values the engine would ignore are errors; unknown keys of the block are listed; the rest is not the form's", () => {
    const check = checkImportSettings(TextureSchema, {
      texture: { filter: "bilinear", mipmaps: false, anisotropy: 4 },
      other: { anything: 1 },
    })
    assert.deepEqual(Object.keys(check.fieldErrors), ["filter"])
    assert.deepEqual(check.unknownKeys, ["anisotropy"])
    assert.equal(check.blockError, null)
    assert.match(firstImportError(check)!, /Filter must be/)
    assert.equal(firstImportError(checkImportSettings(TextureSchema, { texture: { mipmaps: false } })), null)
    assert.equal(firstImportError(checkImportSettings(TextureSchema, {})), null)
  })

  test("a block that is not an object is an error", () => {
    const check = checkImportSettings(ModelSchema, { model: [1] })
    assert.match(check.blockError!, /"model" must be an object/)
    assert.equal(firstImportError(check), check.blockError)
  })

  test("a spread too large for the base size is a warning (the engine lowers it), not an error", () => {
    const check = checkImportSettings(FontSchema, { font: { basePx: 10 } })
    assert.deepEqual(check.warnings, ["SDF spread 8 is too large for base size 10: the engine uses 5"])
    assert.equal(firstImportError(check), null)
    assert.deepEqual(checkImportSettings(FontSchema, { font: { basePx: 64, spreadPx: 32 } }).warnings, [])
  })

  test("a draft that is not a number is the first error", () => {
    const check = checkImportSettings(ModelSchema, {})
    assert.match(firstImportError(check, { scale: "abc" }, ModelSchema)!, /Scale: "abc" is not a number/)
    assert.equal(firstImportError(check, { scale: "2" }, ModelSchema), null)
  })
})

describe("field text", () => {
  test("numbers: empty is the default; hex, words and out-of-range values are refused", () => {
    const scale = field(ModelSchema, "scale")
    assert.deepEqual(parseFieldText(scale, ""), { ok: true, value: undefined })
    assert.deepEqual(parseFieldText(scale, " 0.01 "), { ok: true, value: 0.01 })
    assert.deepEqual(parseFieldText(scale, "1e-2"), { ok: true, value: 0.01 })
    assert.equal(parseFieldText(scale, "0x10").ok, false)
    assert.equal(parseFieldText(scale, "Infinity").ok, false)
    assert.equal(parseFieldText(scale, "0").ok, false)
    const spread = field(FontSchema, "spreadPx")
    assert.deepEqual(parseFieldText(spread, "12"), { ok: true, value: 12 })
    const half = parseFieldText(spread, "1.5")
    assert.equal(half.ok, false)
    if (!half.ok) assert.equal(half.error, "SDF spread must be an integer from 1 to 32")
  })

  test("what a field shows: the draft, else the value, else empty", () => {
    const scale = field(ModelSchema, "scale")
    assert.equal(fieldText(scale, {}, {}), "")
    assert.equal(fieldText(scale, { scale: 0.5 }, {}), "0.5")
    assert.equal(fieldText(scale, { scale: 0.5 }, { scale: "0." }), "0.")
    assert.equal(fieldText(field(TextureSchema, "filter"), { filter: "nearest" }, {}), "nearest")
    assert.equal(fieldText(field(TextureSchema, "srgb"), { srgb: false }, {}), "false")
  })

  test("withField sets and removes a key, keeping every other key and their order; an empty block goes", () => {
    const settings = { a: 1, texture: { wrap: "clamp", x: 2 }, z: 3 }
    const set = withField(TextureSchema, settings, "filter", "nearest")
    assert.deepEqual(set, { a: 1, texture: { wrap: "clamp", x: 2, filter: "nearest" }, z: 3 })
    assert.deepEqual(Object.keys(set), ["a", "texture", "z"])
    assert.deepEqual(settings.texture, { wrap: "clamp", x: 2 }, "not changed in place")
    assert.deepEqual(withField(TextureSchema, set, "wrap", undefined), { a: 1, texture: { x: 2, filter: "nearest" }, z: 3 })
    assert.deepEqual(withField(TextureSchema, { texture: { wrap: "clamp" } }, "wrap", undefined), {})
    assert.deepEqual(withField(ModelSchema, {}, "scale", 0.01), { model: { scale: 0.01 } })
    assert.deepEqual(otherSettings(TextureSchema, set), { a: 1, z: 3 })
  })
})

// ==================== AssetsState with the form ====================

const U1 = "11111111-1111-1111-1111-111111111111"
const U2 = "22222222-2222-2222-2222-222222222222"
const U3 = "33333333-3333-3333-3333-333333333333"

function setup(settings: Record<string, unknown> = {}) {
  const state = {
    assets: [
      { path: "res://hero.png", uuid: U1, type: "Texture", size: 10, modified: 1 },
      { path: "res://ship.glb", uuid: U2, type: "Model", size: 10, modified: 1 },
      { path: "res://ui.ttf", uuid: U3, type: "Font", size: 10, modified: 1 },
    ] as AssetInfo[],
    settings,
  }
  const calls: string[] = []
  let blocked: string | null = null
  const engine = {
    listAssets: async () => ({ folders: [], assets: state.assets.map((a) => ({ ...a })) }),
    getAssetInfo: async (path: string): Promise<AssetDetails> => {
      calls.push(`getAssetInfo ${path}`)
      const asset = state.assets.find((a) => a.path === path)!
      return { ...asset, customData: structuredClone(state.settings), loaded: true }
    },
    setImportSettings: async (path: string, customData: unknown) => {
      calls.push(`setImportSettings ${path} ${JSON.stringify(customData)}`)
      state.settings = customData as Record<string, unknown>
    },
    readTextAsset: async () => "",
    writeTextAsset: async () => {},
    createScriptAsset: async () => ({ path: "", uuid: "" }),
    createFolder: async () => {},
  }
  const assets = new AssetsState(engine, null, () => {}, () => blocked)
  return { assets, state, calls, block: (reason: string | null) => (blocked = reason) }
}

describe("AssetsState: editing the typed fields", () => {
  test("a choice goes into the settings text; Default removes the key; back to the host's is not edited", async () => {
    const { assets } = setup({ keep: true })
    await assets.refresh()
    await assets.select("res://hero.png")
    assets.editSettingField("filter", "nearest")
    assert.deepEqual(JSON.parse(assets.detail.value!.settings), { keep: true, texture: { filter: "nearest" } })
    assert.equal(settingsEdited(assets.detail.value!), true)
    assets.editSettingField("srgb", "false")
    assert.deepEqual(JSON.parse(assets.detail.value!.settings).texture, { filter: "nearest", srgb: false })
    assets.editSettingField("filter", "")
    assets.editSettingField("srgb", "")
    assert.equal(assets.detail.value!.settings, assets.detail.value!.baseline)
    assert.equal(settingsEdited(assets.detail.value!), false)
  })

  test("a number being typed stays a draft until it is valid; a draft that is not valid stops Apply", async () => {
    const { assets, calls } = setup()
    await assets.refresh()
    await assets.select("res://ship.glb")
    assets.editSettingField("scale", "0")
    assert.equal(assets.detail.value!.settings, "{}", "nothing invalid is written")
    assert.deepEqual(assets.detail.value!.fields, { scale: "0" })
    assert.equal(settingsEdited(assets.detail.value!), true)
    assert.equal(await assets.applySettings(), false)
    assert.match(assets.detail.value!.error!, /Scale must be a number above 0/)
    assert.equal(calls.some((c) => c.startsWith("setImportSettings")), false)

    assets.editSettingField("scale", "0.01")
    assert.deepEqual(JSON.parse(assets.detail.value!.settings), { model: { scale: 0.01 } })
    assert.deepEqual(assets.detail.value!.fields, {}, "it reads back the same: no longer a draft")
    assets.editSettingField("generateTangents", "always")
    assert.equal(await assets.applySettings(), true)
    assert.ok(calls.includes('setImportSettings res://ship.glb {"model":{"scale":0.01,"generateTangents":"always"}}'))
    assert.equal(settingsEdited(assets.detail.value!), false)
  })

  test("Revert drops the settings edits and the drafts", async () => {
    const { assets } = setup({ font: { basePx: 32 } })
    await assets.refresh()
    await assets.select("res://ui.ttf")
    assets.editSettingField("paddingPx", "4")
    assets.editSettingField("basePx", "x")
    assert.equal(settingsEdited(assets.detail.value!), true)
    assets.revertSettings()
    assert.equal(assets.detail.value!.settings, assets.detail.value!.baseline)
    assert.deepEqual(assets.detail.value!.fields, {})
  })

  test("Apply refuses what the engine would ignore, also when it was typed as JSON", async () => {
    const { assets, calls } = setup()
    await assets.refresh()
    await assets.select("res://ui.ttf")
    assets.editSettings('{ "font": { "charset": "utf8" } }')
    assert.equal(await assets.applySettings(), false)
    assert.match(assets.detail.value!.error!, /Charset must be "ascii" or "latin1"/)
    assets.editSettings('{ "font": "big" }')
    assert.equal(await assets.applySettings(), false)
    assert.match(assets.detail.value!.error!, /"font" must be an object/)
    // A key the engine does not read is kept and sent
    assets.editSettings('{ "font": { "charset": "ascii", "hinting": 1 } }')
    assert.equal(await assets.applySettings(), true)
    assert.ok(calls.includes('setImportSettings res://ui.ttf {"font":{"charset":"ascii","hinting":1}}'))
  })

  test("a field never overwrites a block that is not an object, nor text that is not JSON", async () => {
    const { assets } = setup({ texture: 5 })
    await assets.refresh()
    await assets.select("res://hero.png")
    assets.editSettingField("filter", "nearest")
    assert.equal(assets.detail.value!.settings, '{\n  "texture": 5\n}')
    assets.editSettings("{ nope")
    assets.editSettingField("filter", "nearest")
    assert.equal(assets.detail.value!.settings, "{ nope")
  })

  test("editing the JSON text drops the drafts; while play mode blocks writes Apply is refused", async () => {
    const { assets, block, calls } = setup()
    await assets.refresh()
    await assets.select("res://ship.glb")
    assets.editSettingField("scale", "-")
    assets.editSettings('{ "model": { "scale": 2 } }')
    assert.deepEqual(assets.detail.value!.fields, {})
    block("a play session is running")
    assert.equal(await assets.applySettings(), false)
    assert.match(assets.detail.value!.error!, /can't be changed now: a play session is running/)
    assert.equal(calls.some((c) => c.startsWith("setImportSettings")), false)
  })

  test("a refresh keeps a draft being typed", async () => {
    const { assets } = setup()
    await assets.refresh()
    await assets.select("res://ship.glb")
    assets.editSettingField("scale", "0.")
    await assets.refresh()
    assert.deepEqual(assets.detail.value!.fields, { scale: "0." })
  })

  test("the view switch is state of the panel", () => {
    const { assets } = setup()
    assert.equal(assets.settingsView.value, "form")
    assets.setSettingsView("json")
    assert.equal(assets.settingsView.value, "json")
  })
})
