import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import {
  BuiltinLayers,
  DeterminismFields,
  LayerCount,
  PhysicsFields,
  RestartFieldIds,
  applyMergePatch,
  buildFieldsPatch,
  touchesPath,
  buildInputPatch,
  buildLayersPatch,
  buildRawPatch,
  fieldById,
  layerNames,
  mergePatchDiff,
  parseField,
  patchTouchesDeterminism,
  type Json,
} from "../renderer/project-settings-schema"

const spec = (id: string) => {
  const f = fieldById(id)
  assert.ok(f, id)
  return f
}

describe("parseField mirrors the engine's ranges", () => {
  test("fixedTimestep is a number greater than 0", () => {
    const f = spec("physics.fixedTimestep")
    assert.deepEqual(parseField(f, "0.016"), { ok: true, value: 0.016 })
    assert.deepEqual(parseField(f, "1e-3"), { ok: true, value: 0.001 })
    assert.equal(parseField(f, "0").ok, false)
    assert.equal(parseField(f, "-1").ok, false)
    assert.equal(parseField(f, "abc").ok, false)
    assert.equal(parseField(f, "Infinity").ok, false)
    assert.deepEqual(parseField(f, "  "), { ok: true, value: undefined })
  })

  test("luaSeed is a whole number of 0 or more", () => {
    const f = spec("determinism.luaSeed")
    assert.deepEqual(parseField(f, "0"), { ok: true, value: 0 })
    assert.deepEqual(parseField(f, "12345"), { ok: true, value: 12345 })
    for (const bad of ["-1", "5.0", "1.5", "0x10", "1e3", "abc", "99999999999999999999"]) {
      assert.equal(parseField(f, bad).ok, false, bad)
    }
  })

  test("enums take only their names (any case) and empty is unset; bools are true or false", () => {
    assert.deepEqual(parseField(spec("physics.gpu"), "AUTO"), { ok: true, value: "auto" })
    assert.equal(parseField(spec("physics.gpu"), "maybe").ok, false)
    assert.deepEqual(parseField(spec("physics.gpu"), ""), { ok: true, value: undefined })
    assert.deepEqual(parseField(spec("physics.backend"), "jolt"), { ok: true, value: "jolt" })
    assert.deepEqual(parseField(spec("math.simdTier"), "sse4.1"), { ok: true, value: "sse4.1" })
    assert.equal(parseField(spec("math.simdTier"), "avx512").ok, false)
    assert.deepEqual(parseField(spec("physics.deterministic"), "true"), { ok: true, value: true })
    assert.deepEqual(parseField(spec("rendering.colorSpace"), "linear"), { ok: true, value: "linear" })
    assert.equal(parseField(spec("rendering.colorSpace"), "srgb").ok, false)
  })
})

describe("the restart badges match the engine docs", () => {
  test("only what the engine reads before Init", () => {
    // docs/application.html Init reads: determinism.luaSeed, math.simdTier, physics.gpu, physics.deterministic, physics.backend
    assert.deepEqual([...RestartFieldIds].sort(), [
      "determinism.luaSeed",
      "math.simdTier",
      "physics.backend",
      "physics.deterministic",
      "physics.gpu",
    ])
    assert.equal(spec("physics.fixedTimestep").restart, false)
    assert.equal(spec("rendering.colorSpace").restart, false)
    assert.ok(DeterminismFields.every((f) => f.restart))
  })
})

describe("buildFieldsPatch", () => {
  const settings = { physics: { fixedTimestep: 0.02, gpu: "Auto", gravity: { x: 0, y: -9.81, z: 0 } } }

  test("only the changed keys, nested", () => {
    const built = buildFieldsPatch(PhysicsFields, settings, { "physics.fixedTimestep": "0.01", "physics.deterministic": "true" })
    assert.deepEqual(built.patch, { physics: { fixedTimestep: 0.01, deterministic: true } })
    assert.deepEqual([...built.changed].sort(), ["physics.deterministic", "physics.fixedTimestep"])
    assert.deepEqual(built.restart, ["physics.deterministic"])
  })

  test("an edit that equals the host's value is not a change (an enum in another case too)", () => {
    const built = buildFieldsPatch(PhysicsFields, settings, { "physics.fixedTimestep": "0.02", "physics.gpu": "auto" })
    assert.equal(built.patch, null)
    assert.deepEqual(built.changed, [])
  })

  test("clearing a set value is a null", () => {
    const built = buildFieldsPatch(PhysicsFields, settings, { "physics.gpu": "" })
    assert.deepEqual(built.patch, { physics: { gpu: null } })
  })

  test("a change to one component of gravity sends all three", () => {
    const built = buildFieldsPatch(PhysicsFields, settings, { "physics.gravity.y": "-20" })
    assert.deepEqual(built.patch, { physics: { gravity: { x: 0, y: -20, z: 0 } } })
  })

  test("gravity not in the project needs all three components", () => {
    const built = buildFieldsPatch(PhysicsFields, {}, { "physics.gravity.y": "-20" })
    assert.equal(built.patch, null)
    assert.ok(built.errors["physics.gravity.x"])
    assert.ok(built.errors["physics.gravity.z"])
    const all = buildFieldsPatch(
      PhysicsFields,
      {},
      { "physics.gravity.x": "0", "physics.gravity.y": "-20", "physics.gravity.z": "0" }
    )
    assert.deepEqual(all.patch, { physics: { gravity: { x: 0, y: -20, z: 0 } } })
  })

  test("an invalid value blocks the patch and is named", () => {
    const built = buildFieldsPatch(PhysicsFields, settings, { "physics.fixedTimestep": "-1", "physics.deterministic": "true" })
    assert.equal(built.patch, null)
    assert.match(built.errors["physics.fixedTimestep"], /greater than 0/)
    assert.deepEqual(built.restart, [])
  })

  test("a settings value that is missing or not an object is treated as empty", () => {
    assert.deepEqual(buildFieldsPatch(PhysicsFields, null, { "physics.backend": "jolt" }).patch, { physics: { backend: "jolt" } })
    assert.deepEqual(buildFieldsPatch(PhysicsFields, "x", { "physics.backend": "jolt" }).patch, { physics: { backend: "jolt" } })
  })
})

describe("layers", () => {
  test("names are the built-in ones where the project says nothing", () => {
    const names = layerNames({})
    assert.equal(names.length, LayerCount)
    assert.equal(names[0], "Default")
    assert.equal(names[5], "UI")
    assert.equal(names[3], "")
  })

  test("a rename sends all 32 names and never the matrix", () => {
    const settings = {
      layers: { layers: ["Default", "TransparentFX", "Ignore Raycast", "", "Water", "UI", "Enemies"], collisionMatrix: [1] },
    }
    const built = buildLayersPatch(settings, { "layer.3": "Props" })
    assert.deepEqual(built.changed, ["layer.3"])
    const layers = (built.patch as { layers: { layers: string[]; collisionMatrix?: unknown } }).layers
    assert.equal(layers.layers.length, 32)
    assert.equal(layers.layers[3], "Props")
    assert.equal(layers.layers[6], "Enemies")
    assert.equal("collisionMatrix" in layers, false)
  })

  test("a name used twice is refused, the built-in ones count, empty names may repeat", () => {
    assert.match(buildLayersPatch({}, { "layer.6": "Water" }).errors["layer.6"], /used twice/)
    const twice = buildLayersPatch({}, { "layer.6": "A", "layer.7": "A" })
    assert.equal(twice.patch, null)
    assert.ok(twice.errors["layer.7"])
    assert.equal(buildLayersPatch({}, { "layer.6": "", "layer.7": "" }).patch, null)
  })

  test("a built-in layer's edit is ignored", () => {
    assert.equal(buildLayersPatch({}, { "layer.0": "Renamed" }).patch, null)
    assert.ok(0 in BuiltinLayers)
  })
})

describe("merge patch diff", () => {
  const roundTrip = (before: Json, after: Json) => {
    const diff = mergePatchDiff(before, after)
    return diff === undefined ? before : applyMergePatch(before, diff)
  }

  test("is the smallest patch and applies back to the target", () => {
    const before = { a: 1, b: { c: 2, d: 3 }, e: [1, 2] }
    const after = { a: 1, b: { c: 2, d: 4 }, e: [1, 2, 3], f: { g: true } }
    assert.deepEqual(mergePatchDiff(before, after), { b: { d: 4 }, e: [1, 2, 3], f: { g: true } })
    assert.deepEqual(roundTrip(before, after), after)
  })

  test("removed keys are null, and equal values are no patch", () => {
    assert.deepEqual(mergePatchDiff({ a: 1, b: { c: 1 } }, { a: 1 }), { b: null })
    assert.equal(mergePatchDiff({ a: 1 }, { a: 1 }), undefined)
    assert.deepEqual(roundTrip({ a: 1, b: 2 }, { b: 2 }), { b: 2 })
  })

  test("a null in the target means absent", () => {
    assert.deepEqual(mergePatchDiff({ a: 1 }, { a: null }), { a: null })
    assert.equal(mergePatchDiff({ a: 1 }, { a: 1, b: null }), undefined)
  })
})

describe("input and raw JSON", () => {
  const settings = { input: { actionMaps: { play: { jump: "Space" } } }, window: { width: 800 } }

  test("input: the shape the host checks, and a minimal diff", () => {
    assert.match(buildInputPatch(settings, { json: "{" }).errors.json, /Not valid JSON/)
    assert.match(buildInputPatch(settings, { json: "[]" }).errors.json, /actionMaps/)
    assert.match(buildInputPatch(settings, { json: '{"actionMaps": 1}' }).errors.json, /actionMaps/)
    const built = buildInputPatch(settings, { json: '{"actionMaps": {"play": {"jump": "Space", "fire": "Ctrl"}}}' })
    assert.deepEqual(built.patch, { input: { actionMaps: { play: { fire: "Ctrl" } } } })
    assert.equal(buildInputPatch(settings, { json: JSON.stringify(settings.input) }).patch, null)
  })

  test("input: empty removes the block, and is nothing when it was absent", () => {
    assert.deepEqual(buildInputPatch(settings, { json: "  " }).patch, { input: null })
    assert.equal(buildInputPatch({}, { json: "" }).patch, null)
  })

  test("raw: a diff of the whole object", () => {
    const next = JSON.stringify({ ...settings, window: { width: 1024 }, extra: { x: 1 } })
    assert.deepEqual(buildRawPatch(settings, { json: next }, true).patch, { window: { width: 1024 }, extra: { x: 1 } })
    assert.match(buildRawPatch(settings, { json: "[]" }, true).errors.json, /object/)
    assert.match(buildRawPatch(settings, { json: "nope" }, true).errors.json, /Not valid JSON/)
  })

  test("raw: a patch that names determinism needs an admin, whatever the value", () => {
    const next = JSON.stringify({ ...settings, determinism: { luaSeed: 1 } })
    assert.ok(buildRawPatch(settings, { json: next }, false).errors.json)
    assert.equal(buildRawPatch(settings, { json: next }, false).patch, null)
    const admin = buildRawPatch(settings, { json: next }, true)
    assert.deepEqual(admin.patch, { determinism: { luaSeed: 1 } })
    assert.deepEqual(admin.restart, ["determinism.luaSeed"])
    // removing the block names it too
    assert.ok(buildRawPatch({ determinism: { luaSeed: 1 } }, { json: "{}" }, false).errors.json)
    assert.ok(patchTouchesDeterminism({ determinism: null }))
    assert.equal(patchTouchesDeterminism({ physics: {} }), false)
  })

  test("raw: an editor may change the other blocks", () => {
    const built = buildRawPatch(settings, { json: JSON.stringify({ ...settings, window: { width: 1 } }) }, false)
    assert.deepEqual(built.patch, { window: { width: 1 } })
  })
})

describe("review fixes", () => {
  test("clearing all of gravity removes the block", () => {
    const settings = { physics: { gravity: { x: 0, y: -9.81, z: 0 } } }
    const built = buildFieldsPatch(PhysicsFields, settings, {
      "physics.gravity.x": "",
      "physics.gravity.y": "",
      "physics.gravity.z": "",
    })
    assert.deepEqual(built.errors, {})
    assert.deepEqual(built.patch, { physics: { gravity: null } })
  })

  test("a Raw draft is diffed against the text it started from, not the current settings", () => {
    const base = { window: { width: 1 }, physics: { fixedTimestep: 0.02 } }
    const current = { window: { width: 1 }, physics: { fixedTimestep: 0.05 } }
    const draft = { window: { width: 2 }, physics: { fixedTimestep: 0.02 } }
    const built = buildRawPatch(current, { json: JSON.stringify(draft), "json.base": JSON.stringify(base) }, true)
    assert.deepEqual(built.patch, { window: { width: 2 } })
  })

  test("removing an Init-time key or its block in Raw counts as a restart", () => {
    const settings = { determinism: { luaSeed: 1 }, physics: { gpu: "Auto" } }
    const built = buildRawPatch(settings, { json: JSON.stringify({ physics: {} }) }, true)
    assert.deepEqual(built.patch, { determinism: null, physics: { gpu: null } })
    assert.ok(built.restart.includes("determinism.luaSeed"))
    assert.ok(built.restart.includes("physics.gpu"))
    assert.equal(touchesPath({ a: null }, ["a", "b"]), true)
    assert.equal(touchesPath({ a: { c: 1 } }, ["a", "b"]), false)
  })
})
