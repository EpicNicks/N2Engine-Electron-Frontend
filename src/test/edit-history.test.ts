import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import {
  EmptyHistoryStatus,
  checkEditGroupLabel,
  historyStatusOf,
  parseAutosaveInfo,
  parseEditResult,
  parseHistory,
} from "../protocol/edit-history"
import { parseStateEvent } from "../protocol/editor-events"

describe("the answers of the undo commands are validated", () => {
  const result = { label: "Create Cube", revision: 7, canUndo: true, canRedo: false, savedRevision: 3 }

  test("an EditResult is taken whole, and a wrong field is named", () => {
    assert.deepEqual(parseEditResult({ ...result, extra: 1 }), result)
    assert.throws(() => parseEditResult(null), /must be an object/)
    assert.throws(() => parseEditResult({ ...result, canUndo: 1 }), /canUndo must be a boolean/)
    assert.throws(() => parseEditResult({ ...result, label: 5 }), /label must be a string/)
    assert.throws(() => parseEditResult({ ...result, revision: -1 }), /revision must be an unsigned/)
    assert.throws(() => parseEditResult({ ...result, savedRevision: 1.5 }), /savedRevision must be an unsigned/)
    assert.throws(() => parseEditResult({ ...result, revision: undefined }), /revision/)
  })

  test("a history's cursor can't pass its entries", () => {
    const entries = [
      { label: "a", bytes: 1 },
      { label: "b", bytes: 2 },
    ]
    assert.deepEqual(parseHistory({ cursor: 2, entries }), { cursor: 2, entries })
    assert.deepEqual(parseHistory({ cursor: 0, entries: [] }), { cursor: 0, entries: [] })
    assert.throws(() => parseHistory({ cursor: 3, entries }), /past its 2 entries/)
    assert.throws(() => parseHistory({ cursor: 0, entries: "x" }), /entries must be an array/)
    assert.throws(() => parseHistory({ cursor: 0, entries: [{ label: "a" }] }), /bytes/)
    assert.throws(() => parseHistory({ cursor: 0, entries: [3] }), /entry 0 must be an object/)
    assert.throws(() => parseHistory([]), /must be an object/)
  })

  test("autosave info: none, or a file with its path, size and time", () => {
    assert.deepEqual(parseAutosaveInfo({ exists: false, path: "ignored" }), { exists: false })
    const found = { exists: true, path: "/p/.n2/autosave/a.scene", size: 12, modified: 1_790_000_000_000 }
    assert.deepEqual(parseAutosaveInfo(found), found)
    assert.deepEqual(parseAutosaveInfo({ exists: true }), { exists: true })
    assert.throws(() => parseAutosaveInfo({ exists: "yes" }), /exists must be a boolean/)
    assert.throws(() => parseAutosaveInfo({ exists: true, size: -1 }), /size must be a non-negative number/)
    assert.throws(() => parseAutosaveInfo({ exists: true, modified: NaN }), /modified/)
    assert.throws(() => parseAutosaveInfo({ exists: true, path: 3 }), /path must be a string/)
    assert.throws(() => parseAutosaveInfo(undefined), /must be an object/)
  })

  test("a group's label is text without NUL", () => {
    checkEditGroupLabel("Move 3 objects")
    checkEditGroupLabel("") // the host names it "Edit"
    for (const bad of ["a\0b", 5, null, undefined]) assert.throws(() => checkEditGroupLabel(bad), /label/)
  })
})

describe("the history status", () => {
  test("is read from GetHistory: the first cursor steps are done", () => {
    const entries = [
      { label: "Create Cube", bytes: 1 },
      { label: "Move Cube", bytes: 1 },
      { label: "Delete Cube", bytes: 1 },
    ]
    assert.deepEqual(historyStatusOf({ cursor: 2, entries }), {
      canUndo: true,
      canRedo: true,
      label: "Move Cube",
      redoLabel: "Delete Cube",
      undoCount: 2,
      redoCount: 1,
    })
    assert.deepEqual(historyStatusOf({ cursor: 0, entries }), {
      canUndo: false,
      canRedo: true,
      label: "",
      redoLabel: "Create Cube",
      undoCount: 0,
      redoCount: 3,
    })
    assert.deepEqual(historyStatusOf({ cursor: 3, entries }), {
      canUndo: true,
      canRedo: false,
      label: "Delete Cube",
      redoLabel: "",
      undoCount: 3,
      redoCount: 0,
    })
    assert.deepEqual(historyStatusOf({ cursor: 0, entries: [] }), EmptyHistoryStatus)
  })
})

describe("the historyChanged event", () => {
  test("is parsed leniently: a missing or mistyped field takes its default", () => {
    assert.deepEqual(
      parseStateEvent({
        seq: 61,
        kind: "historyChanged",
        canUndo: true,
        canRedo: true,
        label: "Create Cube",
        redoLabel: "Delete Cube",
        undoCount: 3,
        redoCount: 1,
      }),
      {
        kind: "historyChanged",
        canUndo: true,
        canRedo: true,
        label: "Create Cube",
        redoLabel: "Delete Cube",
        undoCount: 3,
        redoCount: 1,
      }
    )
    assert.deepEqual(parseStateEvent({ seq: 2, kind: "historyChanged", canUndo: "yes", label: 4, undoCount: -1 } as never), {
      kind: "historyChanged",
      canUndo: false,
      canRedo: false,
      label: "",
      redoLabel: "",
      undoCount: 0,
      redoCount: 0,
    })
  })
})
