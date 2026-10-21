/// <reference path="../renderer/globals.d.ts" />
import "./setup"
import { test, describe, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { keymap } from "../renderer/keymap"
import { modalOpen } from "../renderer/ui"
import { ViewportToolbar } from "../renderer/viewport-toolbar"
import { PivotAction, SpaceAction, ViewportKeyboard } from "../renderer/viewport-keys"
import { ViewportController } from "../renderer/viewport-controller"
import { rig } from "../test/viewport-rig"

const button = (name: string | RegExp): HTMLButtonElement => screen.getByRole("button", { name }) as HTMLButtonElement
const toolIds = ["gizmo.translate", "gizmo.rotate", "gizmo.scale", "gizmo.none", SpaceAction, PivotAction]

describe("the viewport toolbar", () => {
  let controller: ViewportController
  let used: number

  const show = (canEdit = true) => render(<ViewportToolbar viewport={controller} canEdit={canEdit} onUsed={() => void used++} />)

  beforeEach(() => {
    controller = rig().controller
    used = 0
  })
  afterEach(() => {
    cleanup()
    for (const id of toolIds) keymap.reset(id)
  })

  test("a button for each tool shows the active one, and a click chooses it and gives the view its focus back", async () => {
    show()
    const pressed = () => ["Move", "Rotate", "Scale", "Select"].map((n) => button(n).getAttribute("aria-pressed"))
    assert.deepEqual(pressed(), ["true", "false", "false", "false"])
    await userEvent.click(button("Rotate"))
    assert.equal(controller.mode.value, "rotate")
    assert.deepEqual(pressed(), ["false", "true", "false", "false"])
    assert.equal(used, 1)
    await userEvent.click(button("Select"))
    assert.equal(controller.mode.value, "none")
    assert.deepEqual(pressed(), ["false", "false", "false", "true"])
  })

  test("the tooltips carry the current chords, and follow a rebinding", () => {
    show()
    assert.match(button("Move").title, /\(W\)$/)
    assert.match(button("Rotate").title, /\(E\)$/)
    assert.match(button("Scale").title, /\(R\)$/)
    assert.match(button("Select").title, /\(Q\)$/)
    assert.match(button("Space: World").title, /\(X\)$/)
    assert.match(button("Pivot: Pivot").title, /\(Z\)$/)
    keymap.bind("gizmo.rotate", ["KeyT"])
    cleanup()
    show()
    assert.match(button("Rotate").title, /\(T\)$/)
    keymap.bind("gizmo.rotate", [])
    cleanup()
    show()
    assert.doesNotMatch(button("Rotate").title, /\(/)
  })

  test("the tool is announced to a screen reader as it changes", () => {
    show()
    assert.equal(screen.getByRole("status").textContent, "Tool: Move (W)")
    act(() => void controller.setMode("scale"))
    assert.equal(screen.getByRole("status").textContent, "Tool: Scale (R)")
  })

  test("the space and pivot buttons toggle and name the current value", async () => {
    show()
    await userEvent.click(button("Space: World"))
    assert.equal(controller.space.value, "local")
    assert.ok(button("Space: Local"))
    await userEvent.click(button("Pivot: Pivot"))
    assert.equal(controller.pivot.value, "center")
    assert.ok(button("Pivot: Center"))
    act(() => void controller.toggleSpace())
    assert.ok(button("Space: World"))
    assert.equal(used, 2)
  })

  test("the space button is disabled for the scale and select tools, the pivot button for select", () => {
    show()
    assert.equal(button(/^Space/).disabled, false)
    act(() => void controller.setMode("rotate"))
    assert.equal(button(/^Space/).disabled, false)
    act(() => void controller.setMode("scale"))
    assert.equal(button(/^Space/).disabled, true)
    assert.equal(button(/^Pivot/).disabled, false)
    act(() => void controller.setMode("none"))
    assert.equal(button(/^Space/).disabled, true)
    assert.equal(button(/^Pivot/).disabled, true)
  })

  test("the snap toggles and the kind change the controller's settings", async () => {
    show()
    await userEvent.click(screen.getByRole("checkbox", { name: "Snap moves" }))
    assert.equal(controller.snap.value.translate.enabled, true)
    await userEvent.click(screen.getByRole("checkbox", { name: "Snap rotations" }))
    assert.equal(controller.snap.value.rotate.enabled, true)
    await userEvent.click(screen.getByRole("checkbox", { name: "Snap scales" }))
    assert.equal(controller.snap.value.scale.enabled, true)
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Move snap kind" }), "absolute")
    assert.equal(controller.snap.value.translate.kind, "absolute")
    await userEvent.click(screen.getByRole("checkbox", { name: "Snap moves" }))
    assert.equal(controller.snap.value.translate.enabled, false)
    assert.equal(controller.snap.value.translate.kind, "absolute", "the kind stays")
  })

  test("the increments show the defaults and accept a number; an unusable text marks the field and changes nothing", () => {
    show()
    const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement
    const move = field("Move snap increment")
    const rotate = field("Rotate snap increment")
    const scale = field("Scale snap increment")
    assert.deepEqual([move.value, rotate.value, scale.value], ["0.5", "15", "0.1"])
    fireEvent.input(move, { target: { value: "0.25" } })
    assert.equal(controller.snap.value.translate.step, 0.25)
    fireEvent.input(rotate, { target: { value: "22,5" } })
    assert.equal(controller.snap.value.rotate.stepDegrees, 22.5, "a decimal comma is read as a point")
    fireEvent.input(scale, { target: { value: "0" } })
    assert.equal(controller.snap.value.scale.step, 0.1, "zero is not an increment")
    assert.equal(scale.getAttribute("aria-invalid"), "true")
    fireEvent.input(scale, { target: { value: "abc" } })
    assert.equal(controller.snap.value.scale.step, 0.1)
    fireEvent.input(scale, { target: { value: "" } })
    assert.equal(controller.snap.value.scale.step, 0.1)
    assert.equal(scale.getAttribute("aria-invalid"), "true")
    fireEvent.blur(scale)
    assert.equal(scale.value, "0.1", "leaving the field puts the setting back")
    assert.equal(scale.getAttribute("aria-invalid"), null)
    fireEvent.input(scale, { target: { value: "0.05" } })
    assert.equal(controller.snap.value.scale.step, 0.05)
    assert.equal(scale.getAttribute("aria-invalid"), null)
  })

  test("settings that arrive from elsewhere (the saved ones) show in the fields and boxes", () => {
    show()
    act(() => {
      const now = controller.snap.value
      controller.setSnap({ ...now, translate: { enabled: true, step: 2, kind: "absolute" }, rotate: { enabled: true, stepDegrees: 90 } })
    })
    assert.equal((screen.getByRole("textbox", { name: "Move snap increment" }) as HTMLInputElement).value, "2")
    assert.equal((screen.getByRole("textbox", { name: "Rotate snap increment" }) as HTMLInputElement).value, "90")
    assert.equal((screen.getByRole("checkbox", { name: "Snap moves" }) as HTMLInputElement).checked, true)
    assert.equal((screen.getByRole("combobox", { name: "Move snap kind" }) as HTMLSelectElement).value, "absolute")
  })

  test("a host that can't be edited (read-only, viewer, play mode) disables every control; editable again enables them", () => {
    const view = show(false)
    const controls = () => Array.from(view.container.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button, input, select"))
    assert.ok(controls().length >= 12)
    for (const c of controls()) assert.equal(c.disabled, true, c.getAttribute("aria-label") ?? c.textContent ?? c.tagName)
    view.rerender(<ViewportToolbar viewport={controller} canEdit={true} />)
    assert.equal(button("Rotate").disabled, false)
    assert.equal((screen.getByRole("checkbox", { name: "Snap moves" }) as HTMLInputElement).disabled, false)
  })
})

describe("the space and pivot keys", () => {
  let host: HTMLElement
  let controller: ViewportController
  let live: boolean
  let off: () => void

  beforeEach(() => {
    document.body.innerHTML = '<div id="host" data-keymap-scope="viewport" tabindex="0"><input id="note" type="text"></div><div id="other"></div>'
    host = document.getElementById("host")!
    controller = rig().controller
    live = false
    const kb = new ViewportKeyboard({
      gesture: () => null,
      endGesture: () => {},
      frameSelected: () => {},
      live: () => live,
      setMode: (mode) => controller.setMode(mode),
      toggleSpace: () => controller.toggleSpace(),
      togglePivot: () => controller.togglePivot(),
    })
    off = kb.register(keymap, host)
    keymap.install(document, { isModalOpen: modalOpen })
  })
  afterEach(() => {
    off()
    keymap.uninstall()
    for (const id of toolIds) keymap.reset(id)
    document.body.innerHTML = ""
  })

  const press = (target: Element, code: string, init: KeyboardEventInit = {}): boolean =>
    fireEvent.keyDown(target, { key: init.key ?? "", code, ...init })

  test("X toggles world and local, Z pivot and center, by the physical key", () => {
    assert.equal(press(host, "KeyX"), false)
    assert.equal(controller.space.value, "local")
    press(host, "KeyX", { key: "ч" }) // the Russian layout's letter on the X key
    assert.equal(controller.space.value, "world")
    assert.equal(press(host, "KeyZ"), false)
    assert.equal(controller.pivot.value, "center")
    press(host, "KeyZ")
    assert.equal(controller.pivot.value, "pivot")
  })

  test("not in a text field, not outside the viewport, not with a modifier, not while a game is live", () => {
    press(document.getElementById("note")!, "KeyX", { key: "x" })
    press(document.getElementById("other")!, "KeyZ", { key: "z" })
    press(host, "KeyX", { ctrlKey: true })
    press(host, "KeyZ", { shiftKey: true })
    live = true
    press(host, "KeyX")
    press(host, "KeyZ")
    assert.equal(controller.space.value, "world")
    assert.equal(controller.pivot.value, "pivot")
  })

  test("during a drag the key is left alone and changes nothing", async () => {
    const r = rig()
    controller = r.controller
    await r.ready()
    const layout = controller.layout()!
    assert.equal(controller.pointerDown(layout.handles[0].to, false), true)
    assert.equal(press(host, "KeyX"), true, "not taken")
    assert.equal(controller.space.value, "world")
    await controller.pointerUp(layout.handles[0].to)
  })

  test("a rebinding moves the key", () => {
    assert.equal(keymap.bind(SpaceAction, ["KeyC"]).ok, true)
    press(host, "KeyX")
    assert.equal(controller.space.value, "world")
    press(host, "KeyC")
    assert.equal(controller.space.value, "local")
  })

  test("the shortcuts list names them in the viewport's section", () => {
    const rows = keymap.describe().filter((row) => row.id === SpaceAction || row.id === PivotAction)
    assert.deepEqual(
      rows.map((row) => [row.id, row.title, row.scopeTitle, row.chords]),
      [
        [SpaceAction, "Toggle world and local space", "Viewport", ["X"]],
        [PivotAction, "Toggle pivot and center", "Viewport", ["Z"]],
      ]
    )
  })
})
