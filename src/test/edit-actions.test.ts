import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { EditActions, editActions, editMenuItems, editShortcutOf, isTextEntry, runEditAction } from "../renderer/edit-actions"

const noErrors = () => {}

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
    assert.deepEqual(editMenuItems(editActions.value, noErrors), [])
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
    const items = editMenuItems(actions, noErrors)
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
    assert.equal(editMenuItems(actions, noErrors)[0].disabled, true)
  })
})

describe("where Ctrl+Z is the field's own undo", () => {
  test("text-like inputs, text areas and editable content are; other elements and inputs aren't", () => {
    for (const type of ["text", "search", "number", "password", "email", "url", "tel", "", "TEXT"]) {
      assert.equal(isTextEntry({ tagName: "INPUT", type }), true, type)
    }
    assert.equal(isTextEntry({ tagName: "TEXTAREA" }), true)
    assert.equal(isTextEntry({ tagName: "DIV", isContentEditable: true }), true)
    for (const type of ["checkbox", "radio", "range", "color", "button", "file"]) {
      assert.equal(isTextEntry({ tagName: "INPUT", type }), false, type)
    }
    assert.equal(isTextEntry({ tagName: "SELECT" }), false)
    assert.equal(isTextEntry({ tagName: "BUTTON" }), false)
    assert.equal(isTextEntry({ tagName: "DIV" }), false)
    assert.equal(isTextEntry(null), false)
  })
})

describe("running an edit action", () => {
  const actions = (undo: () => Promise<void> | void): EditActions => ({
    undo,
    redo: () => {},
    canUndo: () => true,
    canRedo: () => true,
  })

  test("a rejection or a throw goes to onError, and nothing is left unhandled", async () => {
    const seen: Array<[string, unknown]> = []
    const onError = (what: string, e: unknown) => seen.push([what, e])
    await runEditAction(actions(() => Promise.reject(new Error("nothing to undo"))), "undo", onError)
    await runEditAction(
      actions(() => {
        throw new Error("boom")
      }),
      "undo",
      onError
    )
    assert.deepEqual(
      seen.map(([what, e]) => [what, (e as Error).message]),
      [
        ["Failed to undo", "nothing to undo"],
        ["Failed to undo", "boom"],
      ]
    )
    // The menu's items report the same way
    const menu = editMenuItems(actions(() => Promise.reject(new Error("menu"))), onError)
    menu[0].action()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(seen.length, 3)
  })
})
