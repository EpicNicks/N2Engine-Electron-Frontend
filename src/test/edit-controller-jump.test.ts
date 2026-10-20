import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { JumpFailed } from "../renderer/edit-controller"
import { entries, fakeHistoryHost } from "./fake-history-host"

const four = { cursor: 3, entries: entries("A", "B", "C", "D") }

describe("EditController.jumpTo", () => {
  test("settles and closes the groups once, then undoes step by step, reporting progress", async () => {
    const h = fakeHistoryHost(four)
    await h.groups.begin("drag")
    h.log.length = 0
    const progress: Array<[number, number]> = []
    const result = await h.controller.jumpTo(0, { onProgress: (d, t) => progress.push([d, t]) })
    assert.deepEqual(h.log, ["settle", "end", "refreshHistory", "undo", "undo", "undo", "sync"])
    assert.deepEqual(result, { outcome: "completed", done: 3, total: 3 })
    assert.deepEqual(progress, [
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ])
    assert.equal(h.host().cursor, 0)
  })

  test("forward is redos", async () => {
    const h = fakeHistoryHost({ cursor: 1, entries: four.entries })
    const result = await h.controller.jumpTo(4)
    assert.equal(h.log.filter((l) => l === "redo").length, 3)
    assert.equal(result.outcome, "completed")
    assert.equal(h.host().cursor, 4)
  })

  test("the same place sends nothing and syncs nothing", async () => {
    const h = fakeHistoryHost(four)
    const result = await h.controller.jumpTo(3)
    assert.deepEqual(result, { outcome: "completed", done: 0, total: 0 })
    assert.deepEqual(h.log, ["settle", "refreshHistory"])
  })

  test("a target past the end is the end", async () => {
    const h = fakeHistoryHost(four)
    await h.controller.jumpTo(99)
    assert.equal(h.host().cursor, 4)
  })

  test("a refusal mid-jump stops there, brings the history up to date and rejects with how far it got", async () => {
    const h = fakeHistoryHost(four)
    h.failures.set(2, "cannot undo step")
    await assert.rejects(h.controller.jumpTo(0), (e: unknown) => {
      assert.ok(e instanceof JumpFailed)
      assert.equal(e.done, 1)
      assert.equal(e.total, 3)
      assert.match(e.message, /cannot undo step.*after 1 of 3/)
      return true
    })
    assert.equal(h.host().cursor, 2)
    assert.equal(h.log.at(-1), "sync")
    assert.equal(h.history.value.undoCount, 2)
    // The controller is free again
    assert.equal(h.controller.busy(), false)
    await h.controller.jumpTo(0)
    assert.equal(h.host().cursor, 0)
  })

  test("cancel is honoured between steps; the steps done stay done", async () => {
    const h = fakeHistoryHost(four)
    let cancel = false
    const result = await h.controller.jumpTo(0, {
      onProgress: (done) => {
        if (done === 1) cancel = true
      },
      cancelled: () => cancel,
    })
    assert.deepEqual(result, { outcome: "cancelled", done: 1, total: 3 })
    assert.equal(h.host().cursor, 2)
    assert.equal(h.log.at(-1), "sync")
  })

  test("another client editing mid-jump (the step total changes) stops it", async () => {
    const h = fakeHistoryHost(four)
    h.setBeforeStep((n) => {
      if (n === 1) h.hostChanges({ cursor: 2, entries: entries("A", "B", "X") })
    })
    const result = await h.controller.jumpTo(0)
    assert.equal(result.outcome, "changed")
    assert.equal(result.done, 1)
  })

  test("editing becoming unavailable mid-jump stops it", async () => {
    const h = fakeHistoryHost(four)
    const result = await h.controller.jumpTo(0, {
      onProgress: (d) => {
        if (d === 1) h.canEdit.value = false
      },
    })
    assert.deepEqual(result, { outcome: "disabled", done: 1, total: 3 })
  })

  test("not enabled at the start: nothing is sent", async () => {
    const h = fakeHistoryHost(four)
    h.canEdit.value = false
    const result = await h.controller.jumpTo(0)
    assert.equal(result.outcome, "refused")
    assert.deepEqual(h.log, [])
  })

  test("a jump is exclusive: a second one is refused, undo and redo asked meanwhile are ignored", async () => {
    const h = fakeHistoryHost(four)
    const first = h.controller.jumpTo(0)
    await assert.rejects(h.controller.jumpTo(1), /running/)
    await h.controller.undo()
    await first
    assert.equal(h.host().cursor, 0)
    assert.equal(h.log.filter((l) => l === "undo").length, 3)
  })
})
