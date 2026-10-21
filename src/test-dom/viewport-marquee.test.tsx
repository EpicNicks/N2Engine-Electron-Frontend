/// <reference path="../renderer/globals.d.ts" />
import "./setup"
import { test, describe, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import { fireEvent } from "@testing-library/preact"
import { keymap } from "../renderer/keymap"
import { modalOpen } from "../renderer/ui"
import { ViewportKeyboard } from "../renderer/viewport-keys"
import { PointerAction, pointerActionFor } from "../renderer/viewport-input"
import type { ViewportController, PickBackend } from "../renderer/viewport-controller"
import type { Bounds } from "../renderer/viewport-camera"
import { Selection, emptySelection } from "../renderer/hierarchy-tree"
import { applyMarquee, selectGesture } from "../renderer/viewport-marquee"
import { vec3 } from "../renderer/viewport-math"
import { rig, settle } from "../test/viewport-rig"

// The marquee as the panel runs it (viewport-panel.tsx): real pointer and key events on a focused view, the left
// button's gesture forwarded through selectGesture, Escape through the keymap's viewport.cancel, and the marquee's hits
// applied to a selection through applyMarquee. The view is 800 x 600 frame pixels at client (0, 0).

const box = (min: [number, number, number], max: [number, number, number]): Bounds => ({ min: vec3(...min), max: vec3(...max) })
// "a" in the middle of the frame, "b" up and to the right of it (the rig's camera is at (0, 0, 10) looking down -Z)
const Boxes: Record<string, Bounds> = {
  a: box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]),
  b: box([2.5, 1.5, -0.5], [3.5, 2.5, 0.5]),
}

describe("marquee selection in the view", () => {
  let host: HTMLElement
  let controller: ViewportController
  let selection: Selection
  let gesture: { action: PointerAction } | null
  let pending: Promise<void>
  let asked: number
  let off: () => void
  let detach: () => void

  const pixel = (e: MouseEvent) => ({ x: e.clientX, y: e.clientY })

  beforeEach(async () => {
    document.body.innerHTML = '<div id="host" data-keymap-scope="viewport" tabindex="0"></div>'
    host = document.getElementById("host")!
    selection = emptySelection
    gesture = null
    pending = Promise.resolve()
    asked = 0
    const picking: PickBackend = {
      pick: async () => null,
      bounds: async (ids) => {
        asked++
        return new Map(ids.filter((id) => Boxes[id]).map((id) => [id, Boxes[id]]))
      },
    }
    // The editor's wiring (index.tsx): the hierarchy's candidates, and the hits applied to its selection
    const target = {
      selection: { peek: () => selection },
      setSelection: (s: Selection) => void (selection = s),
      expandAncestors: () => {},
    }
    const r = rig({ picking, selection: [], marquee: { ids: ["a", "b"], revision: 1, select: (ids, op) => applyMarquee(target, ids, op) } })
    controller = r.controller
    await r.ready()

    const kb = new ViewportKeyboard({
      gesture: () => gesture?.action ?? null,
      endGesture: () => {
        const ended = gesture
        gesture = null
        if (ended?.action === "select") pending = controller.cancel()
      },
      frameSelected: () => {},
      live: () => false,
    })
    off = kb.register(keymap, host)
    keymap.install(document, { isModalOpen: modalOpen })
    // The panel's pointer handlers for the left button (the other gestures are the camera's)
    const down = (e: PointerEvent): void => {
      if (gesture) return
      const action = pointerActionFor(e.button, e)
      gesture = { action }
      if (action === "select") selectGesture.down(controller, pixel(e), e)
    }
    const move = (e: PointerEvent): void => {
      if (gesture?.action === "select") selectGesture.move(controller, pixel(e), e)
      else if (gesture?.action === "orbit") controller.orbit(1, 0)
    }
    const up = (e: PointerEvent): void => {
      const ended = gesture
      gesture = null
      if (ended?.action === "select") pending = selectGesture.up(controller, pixel(e), e)
    }
    host.addEventListener("pointerdown", down)
    host.addEventListener("pointermove", move)
    host.addEventListener("pointerup", up)
    detach = () => {
      host.removeEventListener("pointerdown", down)
      host.removeEventListener("pointermove", move)
      host.removeEventListener("pointerup", up)
    }
    host.focus()
  })

  afterEach(() => {
    detach()
    off()
    keymap.uninstall()
    document.body.innerHTML = ""
  })

  /** A left-button drag from one client point to another, with the keys held at each event */
  async function drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    keys: { down?: PointerEventInit; move?: PointerEventInit; up?: PointerEventInit } = {}
  ): Promise<void> {
    fireEvent.pointerDown(host, { button: 0, clientX: from.x, clientY: from.y, ...keys.down })
    fireEvent.pointerMove(host, { button: 0, clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2, ...keys.move })
    fireEvent.pointerMove(host, { button: 0, clientX: to.x, clientY: to.y, ...keys.move })
    fireEvent.pointerUp(host, { button: 0, clientX: to.x, clientY: to.y, ...keys.up })
    await pending
    await settle()
  }

  const ids = (): string[] => [...selection.ids].sort()

  test("a drag over both objects selects both; a drag over empty space clears the selection", async () => {
    await drag({ x: 5, y: 5 }, { x: 795, y: 595 })
    assert.deepEqual(ids(), ["a", "b"])
    assert.equal(selection.primary, "b")
    await drag({ x: 5, y: 590 }, { x: 100, y: 500 })
    assert.deepEqual(ids(), [])
  })

  test("Shift at the release adds, Ctrl removes, Cmd removes", async () => {
    await drag({ x: 380, y: 280 }, { x: 420, y: 320 })
    assert.deepEqual(ids(), ["a"])
    await drag({ x: 795, y: 5 }, { x: 500, y: 200 }, { up: { shiftKey: true } })
    assert.deepEqual(ids(), ["a", "b"])
    assert.equal(selection.primary, "a", "adding keeps the primary")
    await drag({ x: 380, y: 280 }, { x: 420, y: 320 }, { up: { ctrlKey: true } })
    assert.deepEqual(ids(), ["b"])
    await drag({ x: 795, y: 5 }, { x: 500, y: 200 }, { up: { metaKey: true } })
    assert.deepEqual(ids(), [])
  })

  test("Alt held while dragging takes only what is wholly inside; Alt at the press orbits instead", async () => {
    // a rectangle over the middle of "a" only: intersect takes it, inside does not
    await drag({ x: 395, y: 295 }, { x: 405, y: 305 }, { move: { altKey: true }, up: { altKey: true } })
    assert.deepEqual(ids(), [])
    assert.equal(controller.isMarquee, false)
    await drag({ x: 395, y: 295 }, { x: 405, y: 305 })
    assert.deepEqual(ids(), ["a"])
    // Alt at the press is the orbit: no rectangle, and the selection stays
    const before = { ...controller.camera.rotation }
    await drag({ x: 5, y: 5 }, { x: 795, y: 595 }, { down: { altKey: true }, move: { altKey: true }, up: { altKey: true } })
    assert.deepEqual(ids(), ["a"])
    assert.notDeepEqual(controller.camera.rotation, before)
  })

  test("Escape during the drag cancels: the rectangle goes and the selection is kept", async () => {
    await drag({ x: 380, y: 280 }, { x: 420, y: 320 })
    assert.deepEqual(ids(), ["a"])
    fireEvent.pointerDown(host, { button: 0, clientX: 5, clientY: 5 })
    fireEvent.pointerMove(host, { button: 0, clientX: 795, clientY: 595 })
    assert.equal(controller.isMarquee, true)
    assert.notEqual(controller.marqueeShape(), null)
    fireEvent.keyDown(host, { key: "Escape", code: "Escape" })
    await pending
    assert.equal(controller.isMarquee, false)
    fireEvent.pointerUp(host, { button: 0, clientX: 795, clientY: 595 })
    await pending
    await settle()
    assert.deepEqual(ids(), ["a"])
  })

  test("a press that stays within the click slop is a click, not a marquee", async () => {
    fireEvent.pointerDown(host, { button: 0, clientX: 400, clientY: 300 })
    fireEvent.pointerMove(host, { button: 0, clientX: 402, clientY: 301 })
    assert.equal(controller.isMarquee, false)
    fireEvent.pointerUp(host, { button: 0, clientX: 402, clientY: 301 })
    await pending
    await settle()
    assert.equal(asked, 0, "no boxes were asked for")
  })

  test("repeated marquees over an unchanged scene measure the objects once", async () => {
    await drag({ x: 5, y: 5 }, { x: 795, y: 595 })
    await drag({ x: 5, y: 5 }, { x: 400, y: 300 })
    await drag({ x: 795, y: 5 }, { x: 500, y: 200 })
    assert.equal(asked, 1)
    controller.objectsChanged(["a"], false)
    await settle()
    await drag({ x: 5, y: 5 }, { x: 795, y: 595 })
    assert.equal(asked, 2)
  })
})
