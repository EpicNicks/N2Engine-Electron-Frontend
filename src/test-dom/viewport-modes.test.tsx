/// <reference path="../renderer/globals.d.ts" />
import "./setup"
import { test, describe, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import { fireEvent } from "@testing-library/preact"
import { keymap } from "../renderer/keymap"
import { modalOpen } from "../renderer/ui"
import { ModeActions, ViewportKeyboard, toolLabel } from "../renderer/viewport-keys"
import type { PointerAction } from "../renderer/viewport-input"
import { GizmoMode, ViewportController } from "../renderer/viewport-controller"
import { rig } from "../test/viewport-rig"

/** A key press as the browser makes it; fireEvent returns false when something prevented its default */
const press = (target: Element, code: string, init: KeyboardEventInit = {}): boolean =>
  fireEvent.keyDown(target, { key: init.key ?? "", code, ...init })

describe("the gizmo's tool keys", () => {
  let host: HTMLElement
  let gesture: PointerAction | null
  let live: boolean
  let r: ReturnType<typeof rig>
  let controller: ViewportController
  let kb: ViewportKeyboard
  let off: () => void
  let onKeyDown: (e: KeyboardEvent) => void

  beforeEach(() => {
    document.body.innerHTML =
      '<div id="host" data-keymap-scope="viewport" tabindex="0"><input id="note" type="text"><button id="tool"></button></div>' +
      '<div id="hierarchy" data-keymap-scope="hierarchy" tabindex="0"></div><div id="other"></div>'
    host = document.getElementById("host")!
    gesture = null
    live = false
    r = rig()
    controller = r.controller
    kb = new ViewportKeyboard({
      gesture: () => gesture,
      endGesture: () => {
        gesture = null
        void controller.cancel()
      },
      frameSelected: () => {},
      live: () => live,
      setMode: (mode) => controller.setMode(mode),
    })
    off = kb.register(keymap, host)
    // The view's own listener, as viewport-panel.tsx has it (outside a game): the fly keys while the right button is held
    onKeyDown = (e) => {
      if (live) return
      if (kb.keyDown(e)) e.preventDefault()
    }
    host.addEventListener("keydown", onKeyDown)
    keymap.install(document, { isModalOpen: modalOpen })
  })

  afterEach(() => {
    off()
    host.removeEventListener("keydown", onKeyDown)
    keymap.uninstall()
    for (const mode of Object.values(ModeActions)) keymap.reset(mode)
    document.body.innerHTML = ""
  })

  test("W, E, R and Q choose move, rotate, scale and none, and the label says which", () => {
    assert.equal(toolLabel(keymap, controller.mode.value), "Tool: Move (W)")
    const expected: Array<[string, GizmoMode, string]> = [
      ["KeyE", "rotate", "Tool: Rotate (E)"],
      ["KeyR", "scale", "Tool: Scale (R)"],
      ["KeyQ", "none", "Tool: Select (Q)"],
      ["KeyW", "translate", "Tool: Move (W)"],
    ]
    for (const [code, mode, label] of expected) {
      assert.equal(press(host, code), false, `${code} was taken`)
      assert.equal(controller.mode.value, mode)
      assert.equal(toolLabel(keymap, controller.mode.value), label)
    }
  })

  test("also from a control inside the view; the key is the physical one, whatever the layout types", () => {
    press(document.getElementById("tool")!, "KeyE", { key: "e" })
    assert.equal(controller.mode.value, "rotate")
    press(host, "KeyR", { key: "к" }) // the Russian layout's letter on the R key
    assert.equal(controller.mode.value, "scale")
    press(host, "KeyW", { key: "ц" })
    assert.equal(controller.mode.value, "translate")
    // A key that types "e" but is not the E key is not a tool key
    press(host, "KeyK", { key: "e" })
    assert.equal(controller.mode.value, "translate")
  })

  test("typing in the view's text field is not a shortcut", () => {
    press(document.getElementById("note")!, "KeyE", { key: "e" })
    assert.equal(controller.mode.value, "translate")
  })

  test("outside the viewport (the hierarchy, the page) the keys are not the tool's", () => {
    press(document.getElementById("hierarchy")!, "KeyE", { key: "e" })
    press(document.getElementById("other")!, "KeyR", { key: "r" })
    assert.equal(controller.mode.value, "translate")
  })

  test("modifiers are matched exactly: Ctrl+E, Alt+R and Shift+Q are not tool keys", () => {
    press(host, "KeyE", { ctrlKey: true })
    press(host, "KeyR", { altKey: true })
    press(host, "KeyQ", { shiftKey: true })
    press(host, "KeyE", { metaKey: true })
    assert.equal(controller.mode.value, "translate")
  })

  test("while the right button is held W, E and Q fly the camera and keep the mode; R is not a fly key and still chooses scale", () => {
    gesture = "look"
    for (const code of ["KeyW", "KeyE", "KeyQ"]) {
      assert.equal(press(host, code), false, code)
      assert.equal(controller.mode.value, "translate", `${code} flew`)
    }
    assert.equal(kb.keys.any, true)
    kb.keys.clear()
    press(host, "KeyR")
    assert.equal(controller.mode.value, "scale")
    // once the button is released the same keys choose tools again
    gesture = null
    press(host, "KeyE")
    assert.equal(controller.mode.value, "rotate")
  })

  test("while a game is live the keys are the game's: no tool changes", () => {
    live = true
    press(host, "KeyE")
    press(host, "KeyR")
    assert.equal(controller.mode.value, "translate")
  })

  test("during a drag the tool does not change and the key is left alone (not taken)", async () => {
    await r.ready()
    const layout = controller.layout()!
    assert.equal(controller.pointerDown(layout.handles[0].to, false), true)
    assert.equal(press(host, "KeyE"), true, "not taken: its default is not prevented")
    assert.equal(controller.mode.value, "translate")
    await controller.pointerUp(layout.handles[0].to)
    assert.equal(press(host, "KeyE"), false)
    assert.equal(controller.mode.value, "rotate")
  })

  test("a rebinding moves the key: the new chord chooses the tool, the old one no longer does; unbound shows no key in the label", () => {
    assert.equal(keymap.bind("gizmo.rotate", ["KeyT"]).ok, true)
    press(host, "KeyE")
    assert.equal(controller.mode.value, "translate")
    press(host, "KeyT")
    assert.equal(controller.mode.value, "rotate")
    assert.equal(toolLabel(keymap, "rotate"), "Tool: Rotate (T)")
    assert.equal(keymap.bind("gizmo.rotate", []).ok, true)
    assert.equal(toolLabel(keymap, "rotate"), "Tool: Rotate")
  })

  test("a chord another viewport action has can't be given to a tool", () => {
    const refused = keymap.bind("gizmo.scale", ["KeyF"])
    assert.equal(refused.ok, false)
    assert.match(refused.problems[0], /also viewport\.frame/)
  })

  test("a host that can't be edited (read-only, viewer, play mode) still switches the tool, but has no gizmo and starts no drag", async () => {
    const ro = rig({ canEdit: false })
    const roKb = new ViewportKeyboard({
      gesture: () => null,
      endGesture: () => {},
      frameSelected: () => {},
      live: () => false,
      setMode: (mode) => ro.controller.setMode(mode),
    })
    off()
    off = roKb.register(keymap, host)
    await ro.ready()
    press(host, "KeyE")
    assert.equal(ro.controller.mode.value, "rotate")
    assert.equal(ro.controller.rotateLayout(), null)
    assert.equal(ro.controller.pointerDown({ x: 400, y: 300 }, false), false)
    press(host, "KeyR")
    assert.equal(ro.controller.scaleLayout(), null)
    assert.equal(ro.controller.pointerDown({ x: 400, y: 300 }, false), false)
    assert.deepEqual(ro.log, [], "no edit group, no transform")
    ro.setCanEdit(true)
    assert.notEqual(ro.controller.scaleLayout(), null, "editable again: the gizmo is back")
  })

  test("a keyboard without setMode (a host that doesn't give one) registers no tool keys", () => {
    off()
    const plain = new ViewportKeyboard({ gesture: () => null, endGesture: () => {}, frameSelected: () => {}, live: () => false })
    off = plain.register(keymap, host)
    press(host, "KeyE")
    assert.equal(controller.mode.value, "translate")
  })

  test("the shortcuts list names the four tools in the viewport's section, with their keys", () => {
    const rows = keymap.describe().filter((row) => row.id.startsWith("gizmo."))
    assert.deepEqual(
      rows.map((row) => [row.id, row.title, row.scopeTitle, row.chords]),
      [
        ["gizmo.translate", "Move tool", "Viewport", ["W"]],
        ["gizmo.rotate", "Rotate tool", "Viewport", ["E"]],
        ["gizmo.scale", "Scale tool", "Viewport", ["R"]],
        ["gizmo.none", "Select only (no gizmo)", "Viewport", ["Q"]],
      ]
    )
  })
})
