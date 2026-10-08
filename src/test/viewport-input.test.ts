import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import {
  ClickSlop,
  DomDeltaLine,
  DomDeltaPage,
  DomDeltaPixel,
  FlyKeys,
  isClick,
  pointerActionFor,
  shortcutFor,
  wheelPixels,
} from "../renderer/viewport-input"

const none = { altKey: false, ctrlKey: false, shiftKey: false, metaKey: false }

describe("pointerActionFor", () => {
  test("left selects, alt+left orbits", () => {
    assert.equal(pointerActionFor(0, none), "select")
    assert.equal(pointerActionFor(0, { ...none, altKey: true }), "orbit")
    // Ctrl and shift stay with the click (snap while dragging a handle)
    assert.equal(pointerActionFor(0, { ...none, ctrlKey: true }), "select")
    assert.equal(pointerActionFor(0, { ...none, shiftKey: true }), "select")
  })

  test("middle pans, right looks, alt+right dollies", () => {
    assert.equal(pointerActionFor(1, none), "pan")
    assert.equal(pointerActionFor(1, { ...none, altKey: true }), "pan")
    assert.equal(pointerActionFor(2, none), "look")
    assert.equal(pointerActionFor(2, { ...none, altKey: true }), "dolly")
  })

  test("the back and forward buttons do nothing", () => {
    assert.equal(pointerActionFor(3, none), "none")
    assert.equal(pointerActionFor(4, none), "none")
  })
})

describe("clicks", () => {
  test("a press that moved up to the slop is a click, further is a drag", () => {
    assert.equal(isClick({ x: 10, y: 10 }, { x: 10, y: 10 }), true)
    assert.equal(isClick({ x: 10, y: 10 }, { x: 10 + ClickSlop, y: 10 }), true)
    assert.equal(isClick({ x: 10, y: 10 }, { x: 10 + ClickSlop + 1, y: 10 }), false)
    assert.equal(isClick({ x: 0, y: 0 }, { x: 3, y: 3 }), false) // 4.24 pixels away
  })
})

describe("wheelPixels", () => {
  test("pixels pass, lines and pages are scaled, and the result is capped", () => {
    assert.equal(wheelPixels(100, DomDeltaPixel), 100)
    assert.equal(wheelPixels(3, DomDeltaLine), 48)
    assert.equal(wheelPixels(1, DomDeltaPage), 400)
    assert.equal(wheelPixels(-100000, DomDeltaPixel), -400)
    assert.equal(wheelPixels(NaN, DomDeltaPixel), 0)
  })
})

describe("FlyKeys", () => {
  test("W A S D Q E (and the arrows) make a direction; opposite keys cancel", () => {
    const keys = new FlyKeys()
    assert.equal(keys.any, false)
    assert.deepEqual(keys.direction(), { x: 0, y: 0, z: 0 })
    assert.equal(keys.down("KeyW"), true)
    assert.equal(keys.down("KeyD"), true)
    assert.equal(keys.down("KeyE"), true)
    assert.deepEqual(keys.direction(), { x: 1, y: 1, z: 1 })
    keys.down("KeyS")
    assert.deepEqual(keys.direction(), { x: 1, y: 1, z: 0 })
    keys.up("KeyW")
    assert.deepEqual(keys.direction(), { x: 1, y: 1, z: -1 })
    keys.clear()
    assert.equal(keys.any, false)
    keys.down("ArrowLeft")
    keys.down("KeyQ")
    assert.deepEqual(keys.direction(), { x: -1, y: -1, z: 0 })
  })

  test("a key that is not a fly key is not taken", () => {
    const keys = new FlyKeys()
    assert.equal(keys.down("KeyF"), false)
    assert.equal(keys.down("Space"), false)
    assert.equal(keys.down("constructor"), false)
    assert.equal(keys.any, false)
  })

  test("the same key twice is one key, and one release frees it", () => {
    const keys = new FlyKeys()
    keys.down("KeyW")
    keys.down("KeyW")
    assert.deepEqual(keys.direction(), { x: 0, y: 0, z: 1 })
    keys.up("KeyW")
    assert.equal(keys.any, false)
  })
})

describe("shortcutFor", () => {
  test("F frames the selection; with Ctrl, Alt or Meta it is someone else's", () => {
    const f = { code: "KeyF", ctrlKey: false, altKey: false, metaKey: false }
    assert.equal(shortcutFor(f), "frameSelected")
    assert.equal(shortcutFor({ ...f, ctrlKey: true }), null)
    assert.equal(shortcutFor({ ...f, altKey: true }), null)
    assert.equal(shortcutFor({ ...f, metaKey: true }), null)
    assert.equal(shortcutFor({ ...f, code: "KeyG" }), null)
  })
})
