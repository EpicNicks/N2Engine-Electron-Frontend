import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { diffHistory, formatBytes, planJump, rowsOf, totalBytes } from "../renderer/history-jump"
import { entries } from "./fake-history-host"

describe("rowsOf", () => {
  test("the initial state first, done steps normal, undone ones after the cursor, the current one marked", () => {
    const rows = rowsOf({ cursor: 2, entries: entries("A", "B", "C") })
    assert.deepEqual(
      rows.map((r) => [r.cursor, r.label, r.state, r.current]),
      [
        [0, "Initial state", "initial", false],
        [1, "A", "done", false],
        [2, "B", "done", true],
        [3, "C", "undone", false],
      ]
    )
  })

  test("an empty history is the initial state, current", () => {
    const rows = rowsOf({ cursor: 0, entries: [] })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].current, true)
  })

  test("everything undone: the initial state is current", () => {
    const rows = rowsOf({ cursor: 0, entries: entries("A") })
    assert.deepEqual(
      rows.map((r) => r.current),
      [true, false]
    )
    assert.equal(rows[1].state, "undone")
  })
})

describe("planJump", () => {
  test("backward is undos, forward is redos, the same place is nothing", () => {
    assert.deepEqual(planJump(5, 8, 2), { kind: "undo", steps: 3 })
    assert.deepEqual(planJump(2, 8, 8), { kind: "redo", steps: 6 })
    assert.deepEqual(planJump(3, 8, 3), { kind: "none", steps: 0 })
    assert.deepEqual(planJump(8, 8, 0), { kind: "undo", steps: 8 })
  })

  test("a target past the history, or an invalid position, is refused", () => {
    assert.throws(() => planJump(1, 3, 4), /past/)
    assert.throws(() => planJump(4, 3, 1), /Invalid/)
    assert.throws(() => planJump(1, 3, -1), /Invalid/)
    assert.throws(() => planJump(1.5, 3, 1), /Invalid/)
  })
})

describe("diffHistory", () => {
  const base = { cursor: 2, entries: entries("A", "B", "C") }

  test("nothing known is a rewrite; identical is the same", () => {
    assert.equal(diffHistory(null, base), "rewritten")
    assert.equal(diffHistory(base, { cursor: 2, entries: entries("A", "B", "C") }), "same")
  })

  test("another cursor over the same steps is a cursor change", () => {
    assert.equal(diffHistory(base, { ...base, cursor: 0 }), "cursor")
  })

  test("a new edit (redo steps dropped, one added) extends", () => {
    assert.equal(diffHistory(base, { cursor: 3, entries: entries("A", "B", "D") }), "extended")
  })

  test("a done step that differs, or a capped oldest end, is a rewrite", () => {
    assert.equal(diffHistory(base, { cursor: 2, entries: entries("A", "X", "C") }), "rewritten")
    assert.equal(diffHistory(base, { cursor: 2, entries: entries("B", "C", "D") }), "rewritten")
  })
})

test("bytes are summed and shown with a unit", () => {
  assert.equal(totalBytes({ cursor: 0, entries: entries("A", "B") }), 200)
  assert.equal(formatBytes(512), "512 B")
  assert.equal(formatBytes(2048), "2.0 KiB")
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MiB")
})
