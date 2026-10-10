import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { FieldSchema } from "../protocol/protocol.generated"
import {
  addPass,
  defaultPass,
  movePass,
  readPassList,
  removePass,
  replacePass,
  usesPassList,
} from "../renderer/inspector-fields"

const field = (over: Partial<FieldSchema>): FieldSchema => ({
  name: "effectPasses",
  displayName: "Effect Passes",
  kind: "Json",
  typeName: "TextPass[]",
  hidden: false,
  readOnly: false,
  ...over,
})

const pass = (width: number, order = 0) => ({ ...defaultPass(), width, order })

describe("pass list dispatch", () => {
  test("only a Json field whose typeName is TextPass[] gets the pass list editor", () => {
    assert.equal(usesPassList(field({})), true)
    // by type, not by name
    assert.equal(usesPassList(field({ name: "somethingElse" })), true)
    assert.equal(usesPassList(field({ typeName: "json" })), false)
    assert.equal(usesPassList(field({ typeName: "" })), false)
    assert.equal(usesPassList(field({ kind: "String" })), false)
    assert.equal(usesPassList(field({ name: "effectPasses", typeName: "TextPass" })), false)
  })
})

describe("readPassList", () => {
  test("one row per pass", () => {
    assert.equal(readPassList([])?.length, 0)
    assert.equal(readPassList([{}, {}, {}])?.length, 3)
  })

  test("missing keys take the engine defaults", () => {
    const [p] = readPassList([{ width: 2 }])!
    assert.deepEqual(p, { ...defaultPass(), width: 2 })
    assert.deepEqual(p.color, { r: 0, g: 0, b: 0, a: 1 })
    const [q] = readPassList([{ color: { r: 1 }, offset: { y: 3 } }])!
    assert.deepEqual(q.color, { r: 1, g: 0, b: 0, a: 1 })
    assert.deepEqual(q.offset, { x: 0, y: 3 })
  })

  test("a value that is not a pass list is refused, so the JSON box is shown", () => {
    for (const bad of [undefined, null, 5, "x", {}, [1], [null], [[]], [{ width: "2" }], [{ color: 3 }], [{ offset: { x: "a" } }], [{ order: 1.5 }], [{ width: null }]]) {
      assert.equal(readPassList(bad), null, JSON.stringify(bad))
    }
  })

  test("orders above 0 are shown as they are", () => {
    assert.equal(readPassList([{ order: 2 }])![0].order, 2)
  })
})

describe("pass list edits", () => {
  test("add appends a default pass", () => {
    const next = addPass([pass(1)])
    assert.equal(next.length, 2)
    assert.deepEqual(next[1], defaultPass())
    assert.deepEqual(addPass([]), [defaultPass()])
  })

  test("remove drops that pass only", () => {
    assert.deepEqual(removePass([pass(1), pass(2), pass(3)], 1).map((p) => p.width), [1, 3])
    assert.equal(removePass([pass(1)], 5).length, 1)
  })

  test("reorder moves a pass and leaves the ends alone", () => {
    const list = [pass(1), pass(2), pass(3)]
    assert.deepEqual(movePass(list, 2, -1).map((p) => p.width), [1, 3, 2])
    assert.deepEqual(movePass(list, 0, 1).map((p) => p.width), [2, 1, 3])
    assert.deepEqual(movePass(list, 0, -1).map((p) => p.width), [1, 2, 3])
    assert.deepEqual(movePass(list, 2, 1).map((p) => p.width), [1, 2, 3])
  })

  test("an edit gives the whole array with one pass changed, and does not change the input", () => {
    const list = readPassList([{ width: 1 }, { width: 2 }])!
    const next = replacePass(list, 1, { ...list[1], softness: 0.5, offset: { x: 1, y: -1 } })
    assert.equal(next.length, 2)
    assert.deepEqual(next[0], list[0])
    assert.equal(next[1].softness, 0.5)
    assert.equal(next[1].width, 2)
    assert.equal(list[1].softness, 0)
  })
})
