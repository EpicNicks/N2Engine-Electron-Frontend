import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { entries, fakeHistoryHost, settleTasks } from "./fake-history-host"

const three = { cursor: 2, entries: entries("A", "B", "C") }

describe("HistoryModel", () => {
  test("reads the history when started and again, once, after a burst of history events", async () => {
    const h = fakeHistoryHost(three)
    const stop = h.model.start()
    await settleTasks()
    assert.equal(h.model.history.value?.cursor, 2)
    h.log.length = 0
    h.hostChanges({ cursor: 3, entries: entries("A", "B", "C", "D") })
    h.hostChanges({ cursor: 4, entries: entries("A", "B", "C", "D", "E") })
    assert.equal(h.timers.pending.size, 1, "one timer for the burst")
    await h.timers.fire()
    await settleTasks()
    assert.equal(h.log.filter((l) => l === "getHistory").length, 1)
    assert.equal(h.model.history.value?.entries.length, 5)
    stop()
  })

  test("stopping removes the listener and the timer", async () => {
    const h = fakeHistoryHost(three)
    const stop = h.model.start()
    await settleTasks()
    h.hostChanges({ cursor: 3, entries: entries("A", "B", "C", "D") })
    stop()
    assert.equal(h.timers.pending.size, 0)
    h.log.length = 0
    h.hostChanges({ cursor: 1, entries: entries("A") })
    await h.timers.fire()
    await settleTasks()
    assert.deepEqual(h.log, [])
  })

  test("not connected: nothing is shown and the rows are disabled", async () => {
    const h = fakeHistoryHost(three)
    h.model.start()
    await settleTasks()
    h.connected.value = false
    assert.equal(h.model.history.value, null)
    assert.equal(h.model.disabledReason.value, "Not connected")
  })

  test("disabled reasons: read-only, an open edit group, a scene that can't be edited", async () => {
    const h = fakeHistoryHost(three)
    assert.equal(h.model.disabledReason.value, null)
    h.readOnlyReason.value = "the host is read-only"
    assert.match(h.model.disabledReason.value ?? "", /Read-only: the host is read-only/)
    h.readOnlyReason.value = null
    await h.groups.begin("drag")
    assert.match(h.model.disabledReason.value ?? "", /edit group/)
    await h.groups.closeAll()
    assert.equal(h.model.disabledReason.value, null)
    h.canEdit.value = false
    assert.match(h.model.disabledReason.value ?? "", /can't be edited/)
  })

  test("jumpTo does nothing while disabled", async () => {
    const h = fakeHistoryHost(three)
    h.readOnlyReason.value = "viewer"
    await h.model.jumpTo(0)
    assert.deepEqual(h.log, [])
  })

  test("a jump shows progress, re-reads the history after, and leaves no error", async () => {
    const h = fakeHistoryHost(three)
    h.model.start()
    await settleTasks()
    const seen: string[] = []
    h.setBeforeStep(() => seen.push(JSON.stringify(h.model.progress.value)))
    await h.model.jumpTo(0)
    assert.equal(h.model.progress.value, null)
    assert.equal(h.model.error.value, null)
    assert.equal(h.model.history.value?.cursor, 0)
    assert.equal(seen.length, 2)
    assert.match(seen[1], /"done":1,"total":2/)
  })

  test("a failure mid-jump shows the error, stops, and shows the host's history as it is", async () => {
    const h = fakeHistoryHost(three)
    h.model.start()
    await settleTasks()
    h.failures.set(2, "snapshot is gone")
    await h.model.jumpTo(0)
    assert.match(h.model.error.value ?? "", /snapshot is gone/)
    assert.match(h.model.error.value ?? "", /after 1 of 2/)
    assert.equal(h.model.history.value?.cursor, 1)
    assert.equal(h.model.progress.value, null)
    h.model.dismissError()
    assert.equal(h.model.error.value, null)
  })

  test("cancel stops before the next step", async () => {
    const h = fakeHistoryHost(three)
    h.model.start()
    await settleTasks()
    h.setBeforeStep((n) => {
      if (n === 1) h.model.cancel()
    })
    await h.model.jumpTo(0)
    // The first step was already on its way when cancel was asked
    assert.equal(h.model.history.value?.cursor, 1)
    assert.equal(h.model.error.value, null)
  })

  test("the host changing mid-jump is reported and the new history is shown", async () => {
    const h = fakeHistoryHost(three)
    h.model.start()
    await settleTasks()
    h.setBeforeStep((n) => {
      if (n === 1) h.hostChanges({ cursor: 1, entries: entries("A", "Z") })
    })
    await h.model.jumpTo(0)
    assert.match(h.model.error.value ?? "", /another client/)
    assert.deepEqual(
      h.model.history.value?.entries.map((e) => e.label),
      ["A", "Z"]
    )
  })

  test("a refresh shows what the host has now", async () => {
    const h = fakeHistoryHost(three)
    h.model.start()
    await settleTasks()
    h.hostChanges({ cursor: 1, entries: entries("A") })
    await h.model.refresh()
    assert.equal(h.model.history.value?.entries.length, 1)
  })

  test("an empty history is the initial state only", async () => {
    const h = fakeHistoryHost()
    h.model.start()
    await settleTasks()
    assert.deepEqual(h.model.history.value, { cursor: 0, entries: [] })
  })
})
