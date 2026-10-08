import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { signal } from "@preact/signals-core"
import type { EditResultResponse } from "../protocol/protocol.generated"
import { EmptyHistoryStatus, HistoryStatus } from "../protocol/edit-history"
import { EditController } from "../renderer/edit-controller"
import { EditGroups } from "../renderer/edit-groups"
import { editMenuItems, editShortcutOf, isTextEntry, runEditAction } from "../renderer/edit-actions"

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const status = (extra: Partial<HistoryStatus> = {}): HistoryStatus => ({
  ...EmptyHistoryStatus,
  canUndo: true,
  label: "Create Cube",
  undoCount: 1,
  ...extra,
})

function setup(initial: HistoryStatus = status()) {
  const log: string[] = []
  const history = signal<HistoryStatus>(initial)
  /** What the host's history is: GetHistory's answer, which refreshHistory copies in */
  let host: HistoryStatus = initial
  let enabled = true
  const results: EditResultResponse[] = []
  const errors: string[] = []
  const groups = new EditGroups({
    isConnected: () => true,
    beginEditGroup: async (label: string) => void log.push(`begin ${label}`),
    endEditGroup: async () => void log.push("end"),
  })
  const controller = new EditController({
    engine: {
      undo: async () => {
        log.push("undo")
        const failure = errors.shift()
        if (failure) throw new Error(failure)
        return { label: "Create Cube", revision: 9, canUndo: false, canRedo: true, savedRevision: 9 }
      },
      redo: async () => {
        log.push("redo")
        return { label: "Create Cube", revision: 10, canUndo: true, canRedo: false, savedRevision: 9 }
      },
    },
    groups,
    history,
    enabled: () => enabled,
    settle: async () => void log.push("settle"),
    refreshHistory: async () => {
      log.push("refreshHistory")
      history.value = host
    },
    syncAfterEdit: async () => void log.push("sync"),
    applyResult: (result) => {
      results.push(result)
      log.push("apply")
    },
  })
  return {
    controller,
    groups,
    history,
    log,
    results,
    errors,
    setHost: (next: HistoryStatus) => (host = next),
    setEnabled: (value: boolean) => (enabled = value),
  }
}

describe("EditController", () => {
  test("undo ends open groups, sends the pending edits, reads the history, then asks the host, and the panels follow", async () => {
    const { controller, groups, log, results } = setup()
    await groups.begin("Edit Intensity") // a slider is being dragged
    log.length = 0
    await controller.undo()
    assert.deepEqual(log, ["end", "settle", "refreshHistory", "undo", "apply", "sync"])
    assert.deepEqual(results, [{ label: "Create Cube", revision: 9, canUndo: false, canRedo: true, savedRevision: 9 }])
    assert.equal(groups.depth, 0)
  })

  test("redo is the same, with redo", async () => {
    const { controller, log, setHost } = setup(status({ canUndo: false, canRedo: true, redoLabel: "Create Cube" }))
    setHost(status({ canUndo: false, canRedo: true, redoLabel: "Create Cube" }))
    await controller.redo()
    assert.deepEqual(log, ["settle", "refreshHistory", "redo", "apply", "sync"])
  })

  test("with nothing to undo (what settling sent made no step) the host is not asked", async () => {
    const { controller, log, setHost } = setup()
    setHost(EmptyHistoryStatus) // the host's history, read after the pending edits were sent
    await controller.undo()
    assert.deepEqual(log, ["settle", "refreshHistory"])
  })

  test("an edit that settling sent is a step to undo, though the history held had none", async () => {
    const { controller, log, setHost } = setup(EmptyHistoryStatus)
    setHost(status()) // the inspector's pending edit became a step
    await controller.undo()
    assert.deepEqual(log, ["settle", "refreshHistory", "undo", "apply", "sync"])
  })

  test("canUndo and canRedo follow the history, and the editor being editable; the labels are the history's", () => {
    const { controller, history, setEnabled } = setup(status({ canRedo: true, redoLabel: "Move Cube" }))
    assert.equal(controller.canUndo(), true)
    assert.equal(controller.canRedo(), true)
    assert.equal(controller.undoLabel(), "Create Cube")
    assert.equal(controller.redoLabel(), "Move Cube")
    history.value = EmptyHistoryStatus
    assert.equal(controller.canUndo(), false)
    assert.equal(controller.canRedo(), false)
    history.value = status()
    setEnabled(false) // not connected, no scene, or a play session
    assert.equal(controller.canUndo(), false)
  })

  test("it does nothing when the editor can't edit (the host would refuse: not edit mode)", async () => {
    const { controller, log, setEnabled } = setup()
    setEnabled(false)
    await controller.undo()
    await controller.redo()
    assert.deepEqual(log, [])
  })

  test("the host's refusal is thrown, after the panels are told (a failed undo may have cleared the history)", async () => {
    const { controller, log, errors } = setup()
    errors.push("Couldn't undo 'Create Cube': Entity not found (the edit history was cleared)")
    await assert.rejects(controller.undo(), /Couldn't undo 'Create Cube'/)
    assert.deepEqual(log, ["settle", "refreshHistory", "undo", "sync"])
    // And the next one works
    log.length = 0
    await controller.undo()
    assert.ok(log.includes("apply"))
  })

  test("presses that come together run one after the other, in order", async () => {
    const { controller, log } = setup(status({ canRedo: true, redoLabel: "Move Cube" }))
    const first = controller.undo()
    const second = controller.undo()
    const third = controller.redo()
    await Promise.all([first, second, third])
    const verbs = log.filter((c) => c === "undo" || c === "redo")
    assert.deepEqual(verbs, ["undo", "undo", "redo"])
    // No step started before the one before it was done
    const sync = log.indexOf("sync")
    assert.ok(log.indexOf("settle", 1) > sync)
  })

  test("a failure doesn't stop the presses behind it", async () => {
    const { controller, log, errors } = setup()
    errors.push("nope")
    const failed = controller.undo()
    const next = controller.undo()
    await assert.rejects(failed, /nope/)
    await next
    assert.equal(log.filter((c) => c === "apply").length, 1)
  })
})

describe("the Edit menu and shortcuts with the controller", () => {
  const key = (k: string, mods: { ctrl?: boolean; shift?: boolean } = {}) => ({
    key: k,
    ctrlKey: mods.ctrl ?? false,
    metaKey: false,
    shiftKey: mods.shift ?? false,
    altKey: false,
  })

  test("the menu names the steps, and disables what can't be done", () => {
    const { controller, history } = setup(status({ canRedo: true, redoLabel: "Move Cube" }))
    const items = editMenuItems(controller, () => {})
    assert.deepEqual(
      items.map((i) => [i.label, i.disabled]),
      [
        ["Undo Create Cube (Ctrl+Z)", false],
        ["Redo Move Cube (Ctrl+Shift+Z)", false],
      ]
    )
    history.value = EmptyHistoryStatus
    assert.deepEqual(
      editMenuItems(controller, () => {}).map((i) => [i.label, i.disabled]),
      [
        ["Undo (Ctrl+Z)", true],
        ["Redo (Ctrl+Shift+Z)", true],
      ]
    )
  })

  test("the menu's items and the shortcuts run the controller, and a failure goes to onError", async () => {
    const { controller, log, errors } = setup(status({ canRedo: true, redoLabel: "Move Cube" }))
    const seen: string[] = []
    const items = editMenuItems(controller, (what, e) => seen.push(`${what}: ${(e as Error).message}`))
    items[0].action()
    await settle()
    await settle()
    assert.ok(log.includes("undo"))

    assert.equal(editShortcutOf(key("z", { ctrl: true })), "undo")
    errors.push("Nothing to undo")
    await runEditAction(controller, "undo", (what, e) => seen.push(`${what}: ${(e as Error).message}`))
    assert.deepEqual(seen, ["Failed to undo: Nothing to undo"])
  })

  test("Ctrl+Z is the field's own undo in a text field, the editor's elsewhere", () => {
    assert.equal(isTextEntry({ tagName: "INPUT", type: "text" }), true)
    assert.equal(isTextEntry({ tagName: "INPUT", type: "range" }), false)
    assert.equal(isTextEntry({ tagName: "DIV" }), false)
  })
})
