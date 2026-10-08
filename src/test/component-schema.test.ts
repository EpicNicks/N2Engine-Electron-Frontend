import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import {
  FieldKinds,
  checkComponentValues,
  checkId,
  isFieldKind,
  parseComponentSchema,
  parseComponentTypes,
  parseFieldSchema,
} from "../protocol/component-schema"

const field = {
  name: "intensity",
  displayName: "Intensity",
  kind: "Float",
  typeName: "float",
  hidden: false,
  readOnly: false,
}

describe("parseFieldSchema", () => {
  test("keeps the keys it knows and the optional ones that are present", () => {
    const full = {
      ...field,
      kind: "Enum",
      enumOptions: ["A", "B"],
      assetType: "Font",
      min: 0,
      max: 10,
      tooltip: "Tip",
      container: "scriptData",
      extra: "dropped",
    }
    const { extra: _dropped, ...expected } = full
    assert.deepEqual(parseFieldSchema(full, "f"), expected)
    assert.deepEqual(parseFieldSchema(field, "f"), field)
  })

  test("refuses a field of the wrong shape, naming it", () => {
    const bad: Array<[unknown, RegExp]> = [
      [null, /must be an object/],
      [[], /must be an object/],
      [{ ...field, name: "" }, /name must not be empty/],
      [{ ...field, name: 5 }, /name must be a string/],
      [{ ...field, kind: undefined }, /kind must be a string/],
      [{ ...field, hidden: "no" }, /hidden must be a boolean/],
      [{ ...field, readOnly: undefined }, /readOnly must be a boolean/],
      [{ ...field, enumOptions: "A" }, /enumOptions/],
      [{ ...field, enumOptions: [1] }, /enumOptions/],
      [{ ...field, min: "0" }, /min must be a number/],
      [{ ...field, max: Infinity }, /max must be a number/],
      [{ ...field, container: 1 }, /container must be a string/],
    ]
    for (const [value, message] of bad) assert.throws(() => parseFieldSchema(value, "f"), message, JSON.stringify(value))
  })

  test("keeps a kind it doesn't know (a newer protocol minor may add some)", () => {
    assert.equal(parseFieldSchema({ ...field, kind: "Matrix" }, "f").kind, "Matrix")
    assert.equal(isFieldKind("Matrix"), false)
    for (const kind of FieldKinds) assert.equal(isFieldKind(kind), true)
  })
})

describe("parseComponentSchema and parseComponentTypes", () => {
  const schema = { typeName: "Light", singleton: false, fields: [field], defaults: { isActive: true } }

  test("a schema, with or without defaults", () => {
    assert.deepEqual(parseComponentSchema(schema, "s"), schema)
    const { defaults: _defaults, ...bare } = schema
    assert.deepEqual(parseComponentSchema(bare, "s"), bare)
  })

  test("a malformed schema is refused", () => {
    assert.throws(() => parseComponentSchema({ ...schema, typeName: "" }, "s"), /typeName must not be empty/)
    assert.throws(() => parseComponentSchema({ ...schema, singleton: 1 }, "s"), /singleton must be a boolean/)
    assert.throws(() => parseComponentSchema({ ...schema, fields: {} }, "s"), /fields must be an array/)
    assert.throws(() => parseComponentSchema({ ...schema, fields: [{}] }, "s"), /Light/)
    assert.throws(() => parseComponentSchema(7, "s"), /must be an object/)
  })

  test("the type list is an array of schemas, each type once", () => {
    assert.deepEqual(parseComponentTypes([schema, { ...schema, typeName: "Canvas", singleton: true }]).length, 2)
    assert.deepEqual(parseComponentTypes([]), [])
    assert.throws(() => parseComponentTypes({}), /must be an array/)
    assert.throws(() => parseComponentTypes([schema, schema]), /listed twice/)
  })
})

describe("argument checks", () => {
  test("ids are non-empty strings without NUL", () => {
    checkId("a", "id")
    for (const bad of ["", "a\0b", 5, null, undefined, {}]) assert.throws(() => checkId(bad, "id"), /id must be/)
  })

  test("component values are a plain object", () => {
    checkComponentValues({})
    checkComponentValues({ a: [1, { b: null }] })
    checkComponentValues(Object.create(null))
    for (const bad of [null, undefined, [], "{}", 3, new Map(), new Date(0)]) {
      assert.throws(() => checkComponentValues(bad), /JSON object/)
    }
  })
})
