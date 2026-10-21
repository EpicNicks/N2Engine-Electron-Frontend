import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { describeInvokeFailure } from "../renderer/extension-actions"
import { MaxInvokeSelection, type ExtensionErrorKind } from "../protocol/extensions"
import { Uuid, fakeExtensions, field, invokeResult, menuItem } from "./fake-extensions"

const snap = menuItem("align.snap", "Tools/Align/Snap", {
  title: "Snap to grid",
  form: { fields: [field("grid", "Float", { min: 0.01, max: 100 })], defaults: { grid: 1 } },
})

describe("running a menu item", () => {
  test("settles, ends the edit groups, asks the form, invokes with the selection and the menu's revision, then follows the host", async () => {
    const f = fakeExtensions({ items: [snap] })
    f.answers.form = { grid: 2 }
    f.invokeAnswer = { status: "ok", value: invokeResult({ message: "Snapped 2 objects", select: [Uuid(8), Uuid(9)] }) }
    await f.state.refresh()
    f.log.length = 0

    const outcome = await f.state.run(snap, 4)

    assert.equal(outcome, "ok")
    assert.deepEqual(f.log, ["settle", "closeGroups", "form", "invoke", "applyEdit", "sync", "select"])
    assert.deepEqual(f.invokes, [{ itemId: "align.snap", selection: [Uuid(1), Uuid(2)], params: { grid: 2 }, uiRevision: 4 }])
    assert.deepEqual(f.edits, [{ revision: 7, savedRevision: 3 }])
    assert.deepEqual(f.selected, [[Uuid(8), Uuid(9)]])
    assert.deepEqual(f.state.notice.value, { title: "Snap to grid", message: "Snapped 2 objects", warnings: [] })
    assert.deepEqual(f.notes, [["info", "Snap to grid: Snapped 2 objects"]])
    assert.equal(f.state.running.value, null, "not running any more")
    assert.deepEqual(f.failures, [])
  })

  test("an item with no form and no confirm sends no params and asks nothing", async () => {
    const plain = menuItem("p", "Tools/P", { title: "Plain" })
    const f = fakeExtensions({ items: [plain] })
    await f.state.run(plain, 4)
    assert.deepEqual(f.log, ["settle", "closeGroups", "invoke", "applyEdit", "sync"])
    assert.deepEqual(f.invokes[0].params, {})
    assert.deepEqual(f.confirms, [])
    assert.deepEqual(f.selected, [], "an empty select changes nothing")
  })

  test("a form with no fields is no dialog", async () => {
    const empty = menuItem("e", "Tools/E", { form: { fields: [], defaults: {} } })
    const f = fakeExtensions({ items: [empty] })
    await f.state.run(empty, 4)
    assert.ok(!f.log.includes("form"))
  })

  test("confirm comes before the form; No stops there and nothing is sent", async () => {
    const item = menuItem("c", "Tools/C", { title: "Danger", confirm: "Snap 40 objects?", form: snap.form })
    const f = fakeExtensions({ items: [item] })
    f.answers.confirm = false
    const outcome = await f.state.run(item, 4)
    assert.equal(outcome, "cancelled")
    assert.deepEqual(f.confirms, ["Snap 40 objects?"])
    assert.deepEqual(f.log, ["settle", "closeGroups", "confirm"])
    assert.deepEqual(f.invokes, [])
    assert.equal(f.state.running.value, null)

    f.answers.confirm = true
    f.answers.form = { grid: 3 }
    f.log.length = 0
    assert.equal(await f.state.run(item, 4), "ok")
    assert.deepEqual(f.log.slice(0, 5), ["settle", "closeGroups", "confirm", "form", "invoke"])
  })

  test("Cancel in the form sends nothing", async () => {
    const f = fakeExtensions({ items: [snap] })
    f.answers.form = null
    assert.equal(await f.state.run(snap, 4), "cancelled")
    assert.deepEqual(f.invokes, [])
    assert.deepEqual(f.failures, [], "a cancel is not an error")
  })

  test("refused before anything is sent: read-only or viewer, an edit group that will not end, too many objects", async () => {
    const f = fakeExtensions({ items: [snap] })
    f.blocked.reason = "you are signed in as a viewer"
    assert.equal(await f.state.run(snap, 4), "refused")
    assert.match(f.failures[0].message, /can't run now: you are signed in as a viewer/)
    assert.deepEqual(f.log, [], "not even settled")

    f.blocked.reason = null
    f.stuckGroups.count = 1
    f.failures.length = 0
    assert.equal(await f.state.run(snap, 4), "refused")
    assert.match(f.failures[0].message, /edit is still in progress/)
    assert.deepEqual(f.invokes, [])

    f.stuckGroups.count = 0
    f.failures.length = 0
    f.selection.ids = Array.from({ length: MaxInvokeSelection + 1 }, (_, i) => Uuid(i))
    assert.equal(await f.state.run(snap, 4), "refused")
    assert.match(f.failures[0].message, /at most 4096 objects/)
    assert.deepEqual(f.invokes, [])
  })

  test("the editor turning read-only while the dialogs were open stops it before the send", async () => {
    const f = fakeExtensions({ items: [snap] })
    f.answers.form = { grid: 1 }
    f.hooks.onForm = () => {
      f.blocked.reason = "the host is read-only (started with --read-only)"
    }
    assert.equal(await f.state.run(snap, 4), "refused")
    assert.match(f.failures[0].message, /read-only/)
    assert.deepEqual(f.invokes, [])
  })

  test("the selection sent is the one when the item was chosen, even if it changes while a dialog is open", async () => {
    const f = fakeExtensions({ items: [snap] })
    const chosen = [Uuid(1), Uuid(2)]
    f.selection.ids = chosen
    f.answers.form = { grid: 2 }
    f.hooks.onForm = () => {
      f.selection.ids = [Uuid(50)]
    }
    await f.state.run(snap, 4)
    assert.deepEqual(f.invokes[0].selection, chosen)
  })

  test("a second run while one is going is refused, and the flag is cleared when it ends", async () => {
    const f = fakeExtensions({ items: [snap] })
    f.answers.form = { grid: 1 }
    let release: () => void = () => {}
    f.invokeAnswer = () =>
      new Promise((resolve) => {
        release = () => resolve({ status: "ok", value: invokeResult() })
      })
    const first = f.state.run(snap, 4)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.state.running.value, "align.snap")
    assert.equal(await f.state.run(snap, 4), "refused", "one at a time")
    release()
    assert.equal(await first, "ok")
    assert.equal(f.state.running.value, null)
  })

  test("a run that throws still clears the running flag", async () => {
    const f = fakeExtensions({ items: [snap] })
    f.answers.form = { grid: 1 }
    f.invokeAnswer = () => {
      throw new Error("boom")
    }
    await assert.rejects(f.state.run(snap, 4), /boom/)
    assert.equal(f.state.running.value, null)
  })

  test("warnings are shown and noted as warnings; a result with no message says done", async () => {
    const f = fakeExtensions({ items: [snap] })
    f.answers.form = { grid: 1 }
    f.invokeAnswer = { status: "ok", value: invokeResult({ warnings: ["two were skipped", "<b>not html</b>"] }) }
    await f.state.run(snap, 4)
    assert.deepEqual(f.state.notice.value?.warnings, ["two were skipped", "<b>not html</b>"])
    assert.deepEqual(f.notes, [
      ["info", "Snap to grid: done"],
      ["warn", "Snap to grid: two were skipped"],
      ["warn", "Snap to grid: <b>not html</b>"],
    ])
  })

  test("a host that cannot run items (unsupported) is a refusal, not a crash", async () => {
    const f = fakeExtensions({ items: [snap] })
    f.answers.form = { grid: 1 }
    f.invokeAnswer = { status: "unsupported" }
    assert.equal(await f.state.run(snap, 4), "refused")
    assert.match(f.failures[0].message, /protocol 1\.15\.0/)
  })
})

describe("a failed item", () => {
  async function fail(kind: ExtensionErrorKind, message: string, code?: string) {
    const f = fakeExtensions({ items: [snap] })
    f.answers.form = { grid: 1 }
    f.invokeAnswer = { status: "error", kind, message, code }
    await f.state.refresh()
    f.log.length = 0
    const outcome = await f.state.run(snap, 4)
    return { f, outcome }
  }

  test("stale UI: the menu is refreshed (not retried) and the person is told to run it again", async () => {
    const { f, outcome } = await fail("staleUi", "The extensions changed", "staleUiRevision")
    assert.equal(outcome, "failed")
    assert.match(f.failures[0].message, /The menu was refreshed: run the item again/)
    assert.equal(f.failures[0].code, "staleUiRevision")
    assert.deepEqual(f.log.filter((s) => s === "list" || s === "ui" || s === "invoke"), ["invoke", "list", "ui"], "one send, then a refetch")
  })

  test("edit group open: nothing ran, and the person is told why", async () => {
    const { f } = await fail("editGroupOpen", "An edit group is open", "editGroupOpen")
    assert.match(f.failures[0].message, /edit is still in progress/)
    assert.ok(!f.log.includes("list"), "no refetch needed")
  })

  test("failed: the host's own message (its changes were taken back) is shown, and the panels follow", async () => {
    const hostMessage = "The menu item align.snap of the extension Align Tools failed and its changes were taken back: align.lua:12: boom"
    const { f } = await fail("failed", hostMessage, "extensionFailed")
    assert.equal(f.failures[0].message, hostMessage)
    assert.deepEqual(f.notes[0], ["error", `Snap to grid: ${hostMessage}`])
    assert.ok(f.log.includes("sync"), "the scene moved and came back: the panels hear of it")
    assert.ok(f.log.includes("list"), "the extension may have become faulted")
    assert.deepEqual(f.edits, [], "no step was made")
  })

  test("faulted: says the extension is disabled and an admin can reload it", async () => {
    const { f } = await fail("faulted", "disabled", "extensionFaulted")
    assert.match(f.failures[0].message, /Snap to grid did not run: its extension is disabled until it is reloaded/)
    assert.match(f.failures[0].message, /Project Settings, Extensions/)
    assert.ok(f.log.includes("list"))
  })

  test("forbidden and readOnly keep the host's code, so the page learns the host is read-only", async () => {
    const forbidden = await fail("forbidden", "Forbidden: editors may not do this", "forbidden")
    assert.match(forbidden.f.failures[0].message, /Your role may not run Snap to grid: Forbidden/)
    assert.equal(forbidden.f.failures[0].code, "forbidden")
    const readOnly = await fail("readOnly", "The host is read-only", "readOnly")
    assert.match(readOnly.f.failures[0].message, /Snap to grid did not run: The host is read-only/)
    assert.equal(readOnly.f.failures[0].code, "readOnly")
  })

  test("extensions disabled, invalid, malformed and other errors say what the host said", async () => {
    assert.match((await fail("disabled", "x", "extensionsDisabled")).f.failures[0].message, /not enabled on this host/)
    for (const kind of ["invalid", "malformed", "other"] as const) {
      assert.equal((await fail(kind, `msg ${kind}`)).f.failures[0].message, `msg ${kind}`)
    }
  })

  test("every failure ends the run and clears the flag", async () => {
    const { f } = await fail("failed", "x")
    assert.equal(f.state.running.value, null)
  })
})

describe("describeInvokeFailure", () => {
  test("which failures refetch the menu and which refresh the scene", () => {
    const item = { title: "T" }
    const flags = (kind: ExtensionErrorKind) => {
      const { refreshUi, syncScene } = describeInvokeFailure(kind, "m", item)
      return [refreshUi, syncScene]
    }
    assert.deepEqual(flags("staleUi"), [true, false])
    assert.deepEqual(flags("failed"), [true, true])
    assert.deepEqual(flags("faulted"), [true, false])
    assert.deepEqual(flags("disabled"), [true, false])
    assert.deepEqual(flags("editGroupOpen"), [false, false])
    assert.deepEqual(flags("forbidden"), [false, false])
    assert.deepEqual(flags("other"), [false, false])
  })
})
