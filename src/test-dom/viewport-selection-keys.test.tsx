/// <reference path="../renderer/globals.d.ts" />
// Delete, duplicate, copy, cut and paste from the viewport (selection-keys.ts), through the page's keymap and real DOM
// key presses: the same actions as the hierarchy's on the same selection, in the viewport's own scope.
import "./setup"
import { test, describe, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import { fireEvent } from "@testing-library/preact"
import { keymap } from "../renderer/keymap"
import { modalOpen } from "../renderer/ui"
import { SelectionEditor, selectionKeyHandlers } from "../renderer/selection-keys"

/** A key press as the browser makes it; fireEvent returns false when something prevented its default */
const press = (target: Element, key: string, init: KeyboardEventInit = {}): boolean =>
  fireEvent.keyDown(target, { key, code: init.code ?? "", ...init })

class FakeEditor implements SelectionEditor {
  calls: string[] = []
  reason: string | null = null
  canCopyPaste = true
  readonly readOnlyReason = { peek: () => this.reason }
  fail: string | null = null
  private act(name: string): Promise<boolean> {
    this.calls.push(name)
    return this.fail ? Promise.reject(new Error(this.fail)) : Promise.resolve(true)
  }
  deleteSelected = () => this.act("delete")
  duplicateSelected = () => this.act("duplicate")
  copySelected = () => this.act("copy")
  cutSelected = () => this.act("cut")
  pasteCopied = () => this.act("paste")
}

describe("the selection's keys in the viewport", () => {
  let view: HTMLElement
  let hierarchyList: HTMLElement
  let editor: FakeEditor
  let live: boolean
  let reports: string[]
  let off: Array<() => void>

  beforeEach(() => {
    document.body.innerHTML =
      '<div id="view" data-keymap-scope="viewport" tabindex="0"><input id="snap" type="text"><button id="tool"></button></div>' +
      '<div id="hierarchy" data-keymap-scope="hierarchy" tabindex="0"></div>' +
      '<div id="other"><input id="field" type="text"></div>'
    view = document.getElementById("view")!
    hierarchyList = document.getElementById("hierarchy")!
    editor = new FakeEditor()
    live = false
    reports = []
    // As viewport-panel.tsx and hierarchy-panel.tsx register them
    const register = (scope: "viewport" | "hierarchy", within: Element, passThrough?: () => boolean) =>
      Object.entries(selectionKeyHandlers(scope, editor, { report: (what) => void reports.push(what), passThrough })).map(
        ([id, handler]) => keymap.handle(id, handler, { within })
      )
    off = [...register("viewport", view, () => live), ...register("hierarchy", hierarchyList)]
    keymap.install(document, { isModalOpen: modalOpen })
  })

  afterEach(() => {
    off.forEach((unregister) => unregister())
    keymap.uninstall()
    keymap.resetAll()
    document.body.innerHTML = ""
  })

  test("Delete, Ctrl+D, Ctrl+C, Ctrl+X and Ctrl+V act on the selection from the view, and take the key", () => {
    assert.equal(press(view, "Delete"), false)
    assert.equal(press(view, "d", { ctrlKey: true }), false)
    assert.equal(press(view, "c", { ctrlKey: true }), false)
    assert.equal(press(view, "x", { ctrlKey: true }), false)
    assert.equal(press(view, "v", { metaKey: true }), false) // Cmd on macOS
    assert.deepEqual(editor.calls, ["delete", "duplicate", "copy", "cut", "paste"])
  })

  test("also from a control inside the view; never while typing in a field, in the view or elsewhere", () => {
    press(document.getElementById("tool")!, "c", { ctrlKey: true })
    assert.deepEqual(editor.calls, ["copy"])
    for (const id of ["snap", "field"]) {
      const field = document.getElementById(id)!
      assert.equal(press(field, "c", { ctrlKey: true }), true, "the field's own copy is left alone")
      assert.equal(press(field, "v", { ctrlKey: true }), true)
      assert.equal(press(field, "Delete"), true)
    }
    assert.deepEqual(editor.calls, ["copy"])
  })

  test("the hierarchy's keys still work there, once per press (the view's are not run for it)", () => {
    press(hierarchyList, "c", { ctrlKey: true })
    press(hierarchyList, "Delete")
    assert.deepEqual(editor.calls, ["copy", "delete"])
    // Outside both scopes nothing acts
    press(document.getElementById("other")!, "Delete")
    assert.deepEqual(editor.calls, ["copy", "delete"])
  })

  test("a held key acts once", () => {
    press(view, "Delete")
    press(view, "Delete", { repeat: true })
    press(view, "d", { ctrlKey: true, repeat: true })
    assert.deepEqual(editor.calls, ["delete"])
  })

  test("read-only (a running game's hierarchy): copy still works, the rest takes the key and does nothing", () => {
    editor.reason = "a game is running"
    assert.equal(press(view, "Delete"), false)
    assert.equal(press(view, "x", { ctrlKey: true }), false)
    assert.equal(press(view, "v", { ctrlKey: true }), false)
    press(view, "c", { ctrlKey: true })
    assert.deepEqual(editor.calls, ["copy"])
  })

  test("a host that can't copy objects leaves Ctrl+C, X and V alone", () => {
    editor.canCopyPaste = false
    assert.equal(press(view, "c", { ctrlKey: true }), true)
    assert.equal(press(view, "x", { ctrlKey: true }), true)
    assert.equal(press(view, "v", { ctrlKey: true }), true)
    assert.deepEqual(editor.calls, [])
  })

  test("while the game view is live the keys are the game's: nothing acts and nothing is taken", () => {
    live = true
    for (const [key, init] of [["Delete", {}], ["c", { ctrlKey: true }], ["v", { ctrlKey: true }], ["d", { ctrlKey: true }]] as const) {
      assert.equal(press(view, key, init), true, key)
    }
    assert.deepEqual(editor.calls, [])
  })

  test("a failure is reported", async () => {
    editor.fail = "the host refused"
    press(view, "v", { ctrlKey: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(reports, ["Failed to paste"])
  })

  test("the view's keys are listed under Viewport and can be rebound apart from the hierarchy's", () => {
    const rows = keymap.describe().filter((row) => row.id.startsWith("viewport.") && /delete|duplicate|copy|cut|paste/.test(row.id))
    assert.deepEqual(rows.map((row) => [row.id, row.scopeTitle, row.chords[0]]), [
      ["viewport.delete", "Viewport", "Del"],
      ["viewport.duplicate", "Viewport", "Ctrl+D"],
      ["viewport.copy", "Viewport", "Ctrl+C"],
      ["viewport.cut", "Viewport", "Ctrl+X"],
      ["viewport.paste", "Viewport", "Ctrl+V"],
    ])
    assert.equal(keymap.bind("viewport.copy", ["Mod+Shift+C"]).ok, true)
    press(view, "c", { ctrlKey: true })
    press(hierarchyList, "c", { ctrlKey: true })
    press(view, "c", { ctrlKey: true, shiftKey: true })
    assert.deepEqual(editor.calls, ["copy", "copy"])
    assert.deepEqual(keymap.conflicts(), [])
  })
})
