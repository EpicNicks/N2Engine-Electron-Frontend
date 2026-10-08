import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { ComponentSchema, FieldSchema } from "../protocol/protocol.generated"
import {
  MaxFloat,
  applyPatch,
  checkNumber,
  checkValue,
  colorChannels,
  colorToHex,
  defaultFieldValue,
  displayTypeName,
  displayValue,
  fieldPatch,
  formatJson,
  formatNumber,
  getFieldValue,
  groupComponentTypes,
  groupOf,
  hexToColor,
  jsonEqual,
  kindOf,
  mergePatch,
  numberLimits,
  parseJsonText,
  parseNumberText,
  planRequests,
  pruneUnchanged,
  visibleFields,
} from "../renderer/inspector-fields"

const field = (kind: string, extra: Partial<FieldSchema> = {}): FieldSchema => ({
  name: "value",
  displayName: "Value",
  kind,
  typeName: "float",
  hidden: false,
  readOnly: false,
  ...extra,
})

const U1 = "9f1c0a2e-4f1b-5a3c-9e7d-1b0f2a6c4d81"
const U2 = "2c8d6e0a-4f1b-5a3c-9e7d-1b0f2a6c4d82"

describe("kinds", () => {
  test("an unknown kind is edited as JSON", () => {
    assert.equal(kindOf(field("Float")), "Float")
    assert.equal(kindOf(field("Matrix4")), "Json")
  })
})

describe("reading and writing a field", () => {
  const luaField = field("Float", { name: "speed", container: "scriptData" })
  const luaRef = field("GameObjectRef", { name: "target", container: "scriptData" })

  test("a field is at the top of the values, a Lua field inside its container", () => {
    assert.equal(getFieldValue(field("Float", { name: "intensity" }), { intensity: 2 }), 2)
    assert.equal(getFieldValue(luaField, { scriptData: { speed: 5 } }), 5)
    assert.equal(getFieldValue(luaField, { scriptData: {} }), undefined)
    assert.equal(getFieldValue(luaField, { scriptData: 3 }), undefined)
    assert.equal(getFieldValue(luaField, { speed: 5 }), undefined)
    assert.equal(getFieldValue(luaField, null), undefined)
  })

  test("a reference in a container is written {$ref}, and read unwrapped", () => {
    assert.equal(getFieldValue(luaRef, { scriptData: { target: { $ref: U1 } } }), U1)
    assert.equal(getFieldValue(luaRef, { scriptData: { target: { $ref: null } } }), null)
    assert.equal(getFieldValue(luaRef, { scriptData: { target: null } }), null)
    assert.deepEqual(fieldPatch(luaRef, U1), { scriptData: { target: { $ref: U1 } } })
    assert.deepEqual(fieldPatch(luaRef, null), { scriptData: { target: { $ref: null } } })
    // A C++ reference has no container and is the bare UUID
    const cpp = field("ComponentRef", { name: "_body" })
    assert.deepEqual(fieldPatch(cpp, U1), { _body: U1 })
    assert.equal(getFieldValue(cpp, { _body: U1 }), U1)
  })

  test("fieldPatch nests a Lua field in its container", () => {
    assert.deepEqual(fieldPatch(luaField, 6), { scriptData: { speed: 6 } })
    assert.deepEqual(fieldPatch(field("Bool", { name: "_loop" }), true), { _loop: true })
  })

  test("a field without a value shows the kind's neutral value", () => {
    assert.equal(displayValue(field("Bool"), {}), false)
    assert.equal(displayValue(field("Float"), {}), 0)
    assert.equal(displayValue(field("Float", { min: 0.5, max: 2 }), {}), 0.5)
    assert.equal(displayValue(field("String"), {}), "")
    assert.deepEqual(displayValue(field("Vector3"), {}), { x: 0, y: 0, z: 0 })
    assert.deepEqual(defaultFieldValue(field("Quaternion")), { x: 0, y: 0, z: 0, w: 1 })
    assert.equal(displayValue(field("Enum", { enumOptions: ["A", "B"] }), {}), "A")
    assert.deepEqual(displayValue(field("AssetRefList"), {}), [])
    assert.equal(displayValue(field("AssetRef"), {}), null)
    assert.equal(displayValue(field("Float"), { value: 3 }), 3)
    assert.deepEqual(defaultFieldValue(field("Color", { typeName: "Color" })), { r: 1, g: 1, b: 1, a: 1 })
    assert.deepEqual(defaultFieldValue(field("Color", { typeName: "Vector3" })), { x: 1, y: 1, z: 1 })
  })
})

describe("partial updates", () => {
  test("mergePatch merges a container key by key and replaces anything else whole", () => {
    assert.deepEqual(
      mergePatch(
        { scriptData: { a: 1, b: 2 }, color: { x: 1, y: 1, z: 1 } },
        { scriptData: { b: 3 }, color: { x: 0, y: 0, z: 0 } }
      ),
      { scriptData: { a: 1, b: 3 }, color: { x: 0, y: 0, z: 0 } }
    )
    assert.deepEqual(mergePatch({ list: [1, 2] }, { list: [3] }), { list: [3] })
    assert.deepEqual(mergePatch({}, { a: 1 }), { a: 1 })
    const base = { scriptData: { a: 1 } }
    mergePatch(base, { scriptData: { a: 2 } })
    assert.deepEqual(base, { scriptData: { a: 1 } }) // not changed in place
  })

  test("applyPatch shows an edit over the stored values", () => {
    assert.deepEqual(applyPatch({ isActive: true, volume: 1 }, { volume: 0.5 }), { isActive: true, volume: 0.5 })
  })

  test("pruneUnchanged leaves out what the component already has", () => {
    const values = { isActive: true, intensity: 1, color: { x: 1, y: 1, z: 1 }, scriptData: { speed: 5, name: "a" } }
    assert.deepEqual(pruneUnchanged(values, { intensity: 1 }), {})
    assert.deepEqual(pruneUnchanged(values, { intensity: 2, isActive: true }), { intensity: 2 })
    assert.deepEqual(pruneUnchanged(values, { color: { z: 1, y: 1, x: 1 } }), {}) // key order doesn't matter
    assert.deepEqual(pruneUnchanged(values, { color: { x: 1, y: 1, z: 0 } }), { color: { x: 1, y: 1, z: 0 } })
    assert.deepEqual(pruneUnchanged(values, { scriptData: { speed: 5, name: "b" } }), { scriptData: { name: "b" } })
    assert.deepEqual(pruneUnchanged(values, { scriptData: { speed: 5 } }), {})
    assert.deepEqual(pruneUnchanged({}, { scriptData: { speed: 5 } }), { scriptData: { speed: 5 } })
  })

  test("planRequests sends only what changed, and nothing for a no-op", () => {
    const values = { uuid: "c1", isActive: true, volume: 1 }
    assert.deepEqual(planRequests(values, { volume: 1 }), { requests: [], droppedScriptData: [] })
    assert.deepEqual(planRequests(values, { volume: 0.5, isActive: true }), {
      requests: [{ volume: 0.5 }],
      droppedScriptData: [],
    })
  })

  test("planRequests never sends the echo keys, uuid and scriptPath", () => {
    const values = { uuid: "c1", scriptUUID: U1, scriptPath: "res://a.lua", scriptData: {} }
    assert.deepEqual(planRequests(values, { uuid: "other", scriptPath: "res://b.lua", scriptData: { speed: 1 } }), {
      requests: [{ scriptData: { speed: 1 } }],
      droppedScriptData: [],
    })
    assert.deepEqual(planRequests(values, { uuid: "c1", scriptPath: "res://a.lua" }), {
      requests: [],
      droppedScriptData: [],
    })
  })

  test("a new scriptUUID is sent alone: scriptData written for the old script is dropped", () => {
    const values = { scriptUUID: U1, scriptData: { speed: 1 } }
    assert.deepEqual(planRequests(values, { scriptUUID: U2, scriptData: { speed: 2, jump: true } }), {
      requests: [{ scriptUUID: U2 }],
      droppedScriptData: ["speed", "jump"],
    })
    // The same script again (an echo) with data is an ordinary data edit
    assert.deepEqual(planRequests(values, { scriptUUID: U1, scriptData: { speed: 2 } }), {
      requests: [{ scriptData: { speed: 2 } }],
      droppedScriptData: [],
    })
    // Clearing the script
    assert.deepEqual(planRequests(values, { scriptUUID: null }), {
      requests: [{ scriptUUID: null }],
      droppedScriptData: [],
    })
  })
})

describe("numbers", () => {
  test("limits come from the range, else from the C++ type", () => {
    assert.deepEqual(numberLimits(field("Float", { min: 0, max: 1 })), { min: 0, max: 1, integer: false, ranged: true })
    assert.deepEqual(numberLimits(field("Float", { min: 0 })), { min: 0, max: MaxFloat, integer: false, ranged: false })
    assert.deepEqual(numberLimits(field("Int", { typeName: "int" })), {
      min: -2147483648,
      max: 2147483647,
      integer: true,
      ranged: false,
    })
    assert.equal(numberLimits(field("Int", { typeName: "unsigned int" })).min, 0)
    assert.equal(numberLimits(field("Int", { typeName: "unsigned int" })).max, 4294967295)
    assert.equal(numberLimits(field("Int", { typeName: "uint8_t" })).max, 255)
    assert.equal(numberLimits(field("Int", { typeName: "int16_t" })).min, -32768)
    assert.equal(numberLimits(field("Int", { typeName: "int64_t" })).max, Number.MAX_SAFE_INTEGER)
    assert.equal(numberLimits(field("Int", { typeName: "uint32_t" })).max, 4294967295)
  })

  test("checkNumber clamps a ranged field and refuses what the C++ type can't hold", () => {
    const ranged = field("Float", { min: 0, max: 1 })
    assert.deepEqual(checkNumber(ranged, 0.25), { ok: true, value: 0.25 })
    assert.deepEqual(checkNumber(ranged, 5), { ok: true, value: 1 })
    assert.deepEqual(checkNumber(ranged, -5), { ok: true, value: 0 })
    assert.equal(checkNumber(field("Float"), 1e39).ok, false)
    assert.equal(checkNumber(field("Float"), NaN).ok, false)
    assert.equal(checkNumber(field("Float"), Infinity).ok, false)
    assert.equal(checkNumber(field("Float"), "1" as never).ok, false)
    const int = field("Int", { typeName: "int" })
    assert.equal(checkNumber(int, 1.5).ok, false)
    assert.equal(checkNumber(int, 2 ** 31).ok, false)
    assert.deepEqual(checkNumber(int, 3), { ok: true, value: 3 })
    assert.equal(checkNumber(field("Int", { typeName: "unsigned int" }), -1).ok, false)
    assert.deepEqual(checkNumber(field("Int", { typeName: "int", min: 1, max: 4 }), 9), { ok: true, value: 4 })
  })

  test("typed text must be a plain decimal number", () => {
    const f = field("Float")
    assert.deepEqual(parseNumberText(f, " 2.5 "), { ok: true, value: 2.5 })
    assert.deepEqual(parseNumberText(f, "-.5"), { ok: true, value: -0.5 })
    assert.deepEqual(parseNumberText(f, "1e3"), { ok: true, value: 1000 })
    for (const bad of ["", "  ", "abc", "0x10", "1,5", "1 2", "Infinity", "NaN", "--1", "."]) {
      assert.equal(parseNumberText(f, bad).ok, false, JSON.stringify(bad))
    }
    assert.equal(parseNumberText(field("Int", { typeName: "int" }), "1.5").ok, false)
    assert.deepEqual(parseNumberText(field("Int", { typeName: "int" }), "7"), { ok: true, value: 7 })
  })

  test("numbers show with at most four decimals", () => {
    assert.equal(formatNumber(1), "1")
    assert.equal(formatNumber(0.5), "0.5")
    assert.equal(formatNumber(1 / 3), "0.3333")
    assert.equal(formatNumber(2.00001), "2")
    assert.equal(formatNumber(NaN), "")
    assert.equal(formatNumber("x"), "")
  })
})

describe("checkValue per kind", () => {
  test("Bool, String", () => {
    assert.deepEqual(checkValue(field("Bool"), true), { ok: true, value: true })
    assert.equal(checkValue(field("Bool"), 1).ok, false)
    assert.deepEqual(checkValue(field("String"), ""), { ok: true, value: "" })
    assert.equal(checkValue(field("String"), 5).ok, false)
  })

  test("vectors need every axis, as finite numbers; extra keys are dropped", () => {
    assert.deepEqual(checkValue(field("Vector3"), { x: 1, y: 2, z: 3, extra: 9 }), {
      ok: true,
      value: { x: 1, y: 2, z: 3 },
    })
    assert.equal(checkValue(field("Vector3"), { x: 1, y: 2 }).ok, false)
    assert.equal(checkValue(field("Vector3"), { x: 1, y: 2, z: NaN }).ok, false)
    assert.equal(checkValue(field("Vector3"), { x: 1, y: 2, z: 1e39 }).ok, false)
    assert.equal(checkValue(field("Vector3"), [1, 2, 3]).ok, false)
    assert.deepEqual(checkValue(field("Vector2"), { x: 1, y: 2 }), { ok: true, value: { x: 1, y: 2 } })
    assert.deepEqual(checkValue(field("Quaternion"), { w: 1, x: 0, y: 0, z: 0 }), {
      ok: true,
      value: { x: 0, y: 0, z: 0, w: 1 },
    })
    assert.equal(checkValue(field("Vector4"), { x: 1, y: 2, z: 3 }).ok, false)
  })

  test("colours follow the field's typeName: {r,g,b,a}, {x,y,z} or {x,y,z,w}", () => {
    const rgba = field("Color", { typeName: "Color" })
    assert.deepEqual(colorChannels(rgba), { keys: ["r", "g", "b", "a"], hasAlpha: true })
    assert.deepEqual(checkValue(rgba, { r: 1, g: 0, b: 0, a: 0.5 }), { ok: true, value: { r: 1, g: 0, b: 0, a: 0.5 } })
    // The alpha of {r,g,b,a} is optional
    assert.deepEqual(checkValue(rgba, { r: 1, g: 0, b: 0 }), { ok: true, value: { r: 1, g: 0, b: 0 } })
    assert.equal(checkValue(rgba, { r: 1, g: 0 }).ok, false)
    const light = field("Color", { typeName: "Vector3" })
    assert.deepEqual(colorChannels(light), { keys: ["x", "y", "z"], hasAlpha: false })
    assert.deepEqual(checkValue(light, { x: 1, y: 1, z: 0 }), { ok: true, value: { x: 1, y: 1, z: 0 } })
    assert.equal(checkValue(light, { r: 1, g: 1, b: 0 }).ok, false)
    assert.deepEqual(colorChannels(field("Color", { typeName: "Vector4" })).keys, ["x", "y", "z", "w"])
  })

  test("an enum is one of its options", () => {
    const e = field("Enum", { enumOptions: ["Static", "Dynamic"] })
    assert.deepEqual(checkValue(e, "Dynamic"), { ok: true, value: "Dynamic" })
    const bad = checkValue(e, "Warp")
    assert.equal(bad.ok, false)
    assert.match(bad.ok ? "" : bad.error, /'Warp' is not one of Static, Dynamic/)
    assert.equal(checkValue(e, 1).ok, false)
  })

  test("references are a UUID or null; lists are lists of those", () => {
    for (const kind of ["AssetRef", "GameObjectRef", "ComponentRef"]) {
      assert.deepEqual(checkValue(field(kind), null), { ok: true, value: null })
      assert.deepEqual(checkValue(field(kind), U1.toUpperCase()), { ok: true, value: U1 })
      assert.equal(checkValue(field(kind), "").ok, false)
      assert.equal(checkValue(field(kind), "not a uuid").ok, false)
      assert.equal(checkValue(field(kind), 5).ok, false)
    }
    for (const kind of ["AssetRefList", "GameObjectRefList", "ComponentRefList"]) {
      assert.deepEqual(checkValue(field(kind), [U1, null, U2]), { ok: true, value: [U1, null, U2] })
      assert.deepEqual(checkValue(field(kind), []), { ok: true, value: [] })
      assert.equal(checkValue(field(kind), [U1, "x"]).ok, false)
      assert.equal(checkValue(field(kind), U1).ok, false)
    }
  })

  test("JSON is anything that can be sent as JSON", () => {
    const j = field("Json")
    assert.deepEqual(checkValue(j, { a: [1, { b: null }] }), { ok: true, value: { a: [1, { b: null }] } })
    assert.equal(checkValue(j, undefined).ok, false)
    assert.equal(checkValue(j, { a: NaN }).ok, false)
    assert.equal(checkValue(field("Matrix"), { a: 1 }).ok, true) // an unknown kind is JSON
    let deep: unknown = 1
    for (let i = 0; i < 100; i++) deep = [deep]
    assert.equal(checkValue(j, deep).ok, false)
  })
})

describe("JSON text", () => {
  const j = field("Json")

  test("parses valid JSON of any type", () => {
    assert.deepEqual(parseJsonText(j, ' {"a": 1} '), { ok: true, value: { a: 1 } })
    assert.deepEqual(parseJsonText(j, "null"), { ok: true, value: null })
    assert.deepEqual(parseJsonText(j, "[1,2]"), { ok: true, value: [1, 2] })
  })

  test("refuses invalid, empty and oversized text", () => {
    assert.equal(parseJsonText(j, "{a:1}").ok, false)
    assert.equal(parseJsonText(j, "").ok, false)
    assert.equal(parseJsonText(j, "undefined").ok, false)
    assert.equal(parseJsonText(j, '"' + "x".repeat(1024 * 1024) + '"').ok, false)
  })

  test("formats a value with indentation", () => {
    assert.equal(formatJson({ a: 1 }), '{\n  "a": 1\n}')
    assert.equal(formatJson(undefined), "null")
  })

  test("jsonEqual compares structure", () => {
    assert.equal(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true)
    assert.equal(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true)
    assert.equal(jsonEqual({ a: 1 }, { a: 1, b: 2 }), false)
    assert.equal(jsonEqual([1], { 0: 1 }), false)
    assert.equal(jsonEqual(null, undefined), false)
  })
})

describe("colours as hex", () => {
  const light = field("Color", { typeName: "Vector3" })
  const rgba = field("Color", { typeName: "Color" })

  test("a colour as #rrggbb", () => {
    assert.equal(colorToHex(light, { x: 1, y: 0.5, z: 0 }), "#ff8000")
    assert.equal(colorToHex(rgba, { r: 0, g: 0, b: 1, a: 0.2 }), "#0000ff")
    assert.equal(colorToHex(rgba, { r: 2, g: -1, b: 0 }), "#ff0000") // HDR and negative channels are clamped for display
    assert.equal(colorToHex(rgba, null), "#000000")
  })

  test("#rrggbb back to a colour keeps the alpha", () => {
    assert.deepEqual(hexToColor(rgba, "#ff0000", { r: 0, g: 0, b: 0, a: 0.25 }), {
      ok: true,
      value: { r: 1, g: 0, b: 0, a: 0.25 },
    })
    assert.deepEqual(hexToColor(light, "#000000", { x: 1, y: 1, z: 1 }), { ok: true, value: { x: 0, y: 0, z: 0 } })
    assert.deepEqual(hexToColor(rgba, "#0080ff", undefined), { ok: true, value: { r: 0, g: 0.502, b: 1, a: 1 } })
    assert.equal(hexToColor(rgba, "red", {}).ok, false)
    assert.equal(hexToColor(rgba, "#fff", {}).ok, false)
  })
})

describe("the schema's fields and the Add Component menu", () => {
  test("hidden fields aren't shown", () => {
    const schema: ComponentSchema = {
      typeName: "T",
      singleton: false,
      fields: [
        field("Float", { name: "a" }),
        field("Float", { name: "b", hidden: true }),
        field("Bool", { name: "c" }),
      ],
    }
    assert.deepEqual(
      visibleFields(schema).map((f) => f.name),
      ["a", "c"]
    )
  })

  test("a type's group is the first pattern it matches; a game's own types are Other", () => {
    assert.equal(groupOf("MeshRenderer"), "Rendering")
    assert.equal(groupOf("Light"), "Rendering")
    assert.equal(groupOf("BoxCollider"), "Physics")
    assert.equal(groupOf("Rigidbody"), "Physics")
    assert.equal(groupOf("AudioListener"), "Audio")
    assert.equal(groupOf("RectTransform"), "UI")
    assert.equal(groupOf("LuaComponent"), "Scripting")
    assert.equal(groupOf("Spinner"), "Other")
  })

  test("type names show with spaces", () => {
    assert.equal(displayTypeName("MeshRenderer"), "Mesh Renderer")
    assert.equal(displayTypeName("UIText"), "UI Text")
    assert.equal(displayTypeName("Light"), "Light")
    assert.equal(displayTypeName("Rigidbody"), "Rigidbody")
  })

  const types: ComponentSchema[] = [
    "Spinner",
    "UIText",
    "Canvas",
    "Light",
    "AudioSource",
    "AudioListener",
    "Rigidbody",
  ].map((typeName) => ({
    typeName,
    singleton: typeName === "Canvas" || typeName === "AudioListener",
    fields: [],
  }))

  test("grouped in a fixed order, by name within a group, Other last", () => {
    const groups = groupComponentTypes(types, "", new Set())
    assert.deepEqual(
      groups.map((g) => [g.name, g.items.map((i) => i.typeName)]),
      [
        ["Rendering", ["Light"]],
        ["Physics", ["Rigidbody"]],
        ["Audio", ["AudioListener", "AudioSource"]],
        ["UI", ["Canvas", "UIText"]],
        ["Other", ["Spinner"]],
      ]
    )
  })

  test("the search ignores case and spaces, and drops empty groups", () => {
    const names = (q: string) =>
      groupComponentTypes(types, q, new Set()).flatMap((g) => g.items.map((i) => i.typeName))
    assert.deepEqual(names("audio"), ["AudioListener", "AudioSource"])
    assert.deepEqual(names("ui text"), ["UIText"])
    assert.deepEqual(names("  SPIN"), ["Spinner"])
    assert.deepEqual(names("zzz"), [])
    assert.deepEqual(groupComponentTypes(types, "zzz", new Set()), [])
  })

  test("a singleton the object has is listed but disabled", () => {
    const groups = groupComponentTypes(types, "", new Set(["Canvas", "Light", "AudioListener"]))
    const items = groups.flatMap((g) => g.items)
    assert.match(items.find((i) => i.typeName === "Canvas")!.disabledReason ?? "", /only one Canvas/)
    assert.match(items.find((i) => i.typeName === "AudioListener")!.disabledReason ?? "", /only one/)
    assert.equal(items.find((i) => i.typeName === "Light")!.disabledReason, null) // not a singleton: a second is fine
    assert.equal(items.find((i) => i.typeName === "AudioSource")!.disabledReason, null)
    const none = groupComponentTypes(types, "", new Set()).flatMap((g) => g.items)
    assert.equal(
      none.every((i) => i.disabledReason === null),
      true
    )
  })
})
