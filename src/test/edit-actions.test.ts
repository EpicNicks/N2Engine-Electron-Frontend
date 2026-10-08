import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { EditActions, editActions, editMenuItems, editShortcutOf } from "../renderer/edit-actions"

const key = (k: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  key: k,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
})

describe("edit shortcuts", () => {
  test("Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo (Cmd too)", () => {
    assert.equal(editShortcutOf(key("z", { ctrl: true })), "undo")
    assert.equal(editShortcutOf(key("Z", { ctrl: true })), "undo")
    assert.equal(editShortcutOf(key("z", { meta: true })), "undo")
    assert.equal(editShortcutOf(key("z", { ctrl: true, shift: true })), "redo")
    assert.equal(editShortcutOf(key("Z", { ctrl: true, shift: true })), "redo")
    assert.equal(editShortcutOf(key("y", { ctrl: true })), "redo")
  })

  test("other keys, no modifier, Alt, and Ctrl+Shift+Y are nothing", () => {
    assert.equal(editShortcutOf(key("z")), null)
    assert.equal(editShortcutOf(key("y")), null)
    assert.equal(editShortcutOf(key("x", { ctrl: true })), null)
    assert.equal(editShortcutOf(key("z", { ctrl: true, alt: true })), null)
    assert.equal(editShortcutOf(key("y", { ctrl: true, shift: true })), null)
  })
})

describe("the Edit menu hook", () => {
  test("nothing is registered before undo and redo exist: no items", () => {
    assert.equal(editActions.value, null)
    assert.deepEqual(editMenuItems(editActions.value), [])
  })

  test("registered actions give Undo and Redo, disabled when they can't", () => {
    const calls: string[] = []
    let canUndo = true
    const actions: EditActions = {
      undo: () => void calls.push("undo"),
      redo: () => void calls.push("redo"),
      canUndo: () => canUndo,
      canRedo: () => false,
    }
    const items = editMenuItems(actions)
    assert.deepEqual(
      items.map((i) => [i.label, i.disabled]),
      [
        ["Undo (Ctrl+Z)", false],
        ["Redo (Ctrl+Shift+Z)", true],
      ]
    )
    items[0].action()
    items[1].action()
    assert.deepEqual(calls, ["undo", "redo"])
    canUndo = false
    assert.equal(editMenuItems(actions)[0].disabled, true)
  })
})
