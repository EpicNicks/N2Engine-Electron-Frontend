import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { checkForm, initialValues, visibleFields, type ItemForm } from "../renderer/extension-form"
import { parseExtensionsUi } from "../protocol/extensions"
import { Uuid, field } from "./fake-extensions"

/** The form the host builds for the design's example item (a number with bounds and a bool) */
const snapForm: ItemForm = {
  fields: [
    field("grid", "Float", { displayName: "Grid", min: 0.01, max: 100, tooltip: "Grid size in metres" }),
    field("snapY", "Bool", { displayName: "Snap Y" }),
  ],
  defaults: { grid: 1, snapY: false },
}

describe("initialValues", () => {
  test("the host's defaults, else the kind's neutral value", () => {
    assert.deepEqual(initialValues(snapForm), { grid: 1, snapY: false })
    const form: ItemForm = {
      fields: [
        field("n", "Float"),
        field("i", "Int", { min: 3 }),
        field("s", "String"),
        field("b", "Bool"),
        field("v", "Vector3"),
        field("e", "Enum", { enumOptions: ["a", "b"] }),
        field("g", "GameObjectRef"),
      ],
      defaults: {},
    }
    assert.deepEqual(initialValues(form), {
      n: 0,
      i: 3,
      s: "",
      b: false,
      v: { x: 0, y: 0, z: 0 },
      e: "a",
      g: null,
    })
  })

  test("a default of null (a GameObject has none) is kept, and inherited names are not defaults", () => {
    const form: ItemForm = { fields: [field("g", "GameObjectRef"), field("toString", "String")], defaults: { g: null } }
    assert.deepEqual(initialValues(form), { g: null, toString: "" })
  })
})

describe("visibleFields", () => {
  test("hidden fields are not shown but are still sent with their defaults", () => {
    const form: ItemForm = {
      fields: [field("shown", "Float"), field("secret", "Float", { hidden: true })],
      defaults: { shown: 2, secret: 9 },
    }
    assert.deepEqual(
      visibleFields(form).map((f) => f.name),
      ["shown"]
    )
    assert.deepEqual(checkForm(form, { shown: 5 }), { ok: true, params: { shown: 5, secret: 9 } })
  })
})

describe("checkForm", () => {
  test("a valid form gives the params, every field of it", () => {
    assert.deepEqual(checkForm(snapForm, { grid: 2.5, snapY: true }), { ok: true, params: { grid: 2.5, snapY: true } })
  })

  test("a field with no entered value takes its start value", () => {
    assert.deepEqual(checkForm(snapForm, {}), { ok: true, params: { grid: 1, snapY: false } })
  })

  test("a number past its bounds is clamped to them, as the host does", () => {
    assert.deepEqual(checkForm(snapForm, { grid: 1000 }), { ok: true, params: { grid: 100, snapY: false } })
    assert.deepEqual(checkForm(snapForm, { grid: -3 }), { ok: true, params: { grid: 0.01, snapY: false } })
  })

  test("a value of the wrong type is an error on that field, and the others are not", () => {
    const result = checkForm(snapForm, { grid: "wide", snapY: "yes" })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.deepEqual(Object.keys(result.errors).sort(), ["grid", "snapY"])
      assert.match(result.errors.grid, /must be a number/)
      assert.match(result.errors.snapY, /true or false/)
    }
    const one = checkForm(snapForm, { grid: Number.NaN })
    assert.equal(one.ok, false)
    if (!one.ok) assert.deepEqual(Object.keys(one.errors), ["grid"])
  })

  test("an int must be whole; an enum must be one of its options; a vector needs every axis", () => {
    const form: ItemForm = {
      fields: [field("count", "Int", { min: 1, max: 10 }), field("mode", "Enum", { enumOptions: ["fast", "slow"] }), field("at", "Vector3")],
      defaults: { count: 1, mode: "fast", at: { x: 0, y: 0, z: 0 } },
    }
    assert.equal(checkForm(form, { count: 2.5 }).ok, false)
    assert.equal(checkForm(form, { mode: "medium" }).ok, false)
    assert.equal(checkForm(form, { at: { x: 1, y: 2 } }).ok, false)
    assert.deepEqual(checkForm(form, { count: 99, mode: "slow", at: { x: 1, y: 2, z: 3 } }), {
      ok: true,
      params: { count: 10, mode: "slow", at: { x: 1, y: 2, z: 3 } },
    })
  })

  test("a GameObject is a UUID (lower-cased) or none; anything else is refused", () => {
    const form: ItemForm = { fields: [field("target", "GameObjectRef")], defaults: { target: null } }
    assert.deepEqual(checkForm(form, { target: null }), { ok: true, params: { target: null } })
    assert.deepEqual(checkForm(form, { target: Uuid(5).toUpperCase() }), { ok: true, params: { target: Uuid(5) } })
    assert.equal(checkForm(form, { target: "the player" }).ok, false)
    assert.equal(checkForm(form, { target: 7 }).ok, false)
  })

  test("a field named like an Object.prototype member is just a field", () => {
    const form: ItemForm = { fields: [field("__proto__", "Float")], defaults: {} }
    const result = checkForm(form, {})
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(Object.getPrototypeOf(result.params), Object.prototype)
      assert.deepEqual(Object.keys(result.params), ["__proto__"])
    }
  })

  test("a form that came through the host's parser works end to end", () => {
    const ui = parseExtensionsUi({
      uiRevision: 2,
      menuItems: [
        {
          id: "align.snap",
          extension: "Align Tools",
          path: "Tools/Align/Snap",
          title: "Snap",
          enabledWhen: { selection: "nonEmpty" },
          minRole: "editor",
          form: {
            fields: [{ name: "grid", displayName: "Grid", kind: "Float", typeName: "float", hidden: false, readOnly: false, min: 0.01, max: 100 }],
            defaults: { grid: 1 },
          },
        },
      ],
    })
    const form = ui?.menuItems[0].form
    assert.ok(form)
    assert.deepEqual(checkForm(form, {}), { ok: true, params: { grid: 1 } })
  })
})
