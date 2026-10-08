import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { MaxViewportDimension, cssSizeForPixels, framePixelOf, insideFrame, viewportPixelSize } from "../renderer/viewport-size"

describe("viewportPixelSize", () => {
  test("the container's CSS size in device pixels", () => {
    assert.deepEqual(viewportPixelSize(800, 600, 1), { width: 800, height: 600 })
    assert.deepEqual(viewportPixelSize(800, 600, 2), { width: 1600, height: 1200 })
    assert.deepEqual(viewportPixelSize(800, 600, 1.25), { width: 1000, height: 750 })
  })

  test("rounds fractional sizes to whole pixels", () => {
    assert.deepEqual(viewportPixelSize(801.4, 600.6, 1), { width: 801, height: 601 })
    assert.deepEqual(viewportPixelSize(333, 222, 1.5), { width: 500, height: 333 })
  })

  test("scales down to the engine's limit, keeping the aspect ratio", () => {
    assert.deepEqual(viewportPixelSize(5000, 1000, 1), { width: MaxViewportDimension, height: 819 })
    assert.deepEqual(viewportPixelSize(3000, 2500, 2), { width: MaxViewportDimension, height: 3413 })
    assert.deepEqual(viewportPixelSize(100, 100, 1, 64), { width: 64, height: 64 })
  })

  test("never goes below one pixel for a container with any area", () => {
    assert.deepEqual(viewportPixelSize(0.2, 500, 1), { width: 1, height: 500 })
    assert.deepEqual(viewportPixelSize(10000, 1, 1), { width: MaxViewportDimension, height: 1 })
  })

  test("null for a container with no area (hidden)", () => {
    assert.equal(viewportPixelSize(0, 600, 1), null)
    assert.equal(viewportPixelSize(800, 0, 2), null)
    assert.equal(viewportPixelSize(NaN, 600, 1), null)
  })

  test("an unusable devicePixelRatio counts as 1", () => {
    assert.deepEqual(viewportPixelSize(800, 600, 0), { width: 800, height: 600 })
    assert.deepEqual(viewportPixelSize(800, 600, NaN), { width: 800, height: 600 })
  })
})

describe("cssSizeForPixels", () => {
  test("shows the frame 1:1 in device pixels", () => {
    assert.deepEqual(cssSizeForPixels({ width: 1600, height: 1200 }, 2), { width: 800, height: 600 })
    assert.deepEqual(cssSizeForPixels({ width: 1000, height: 750 }, 1.25), { width: 800, height: 600 })
    assert.deepEqual(cssSizeForPixels({ width: 640, height: 480 }, 0), { width: 640, height: 480 })
  })
})

describe("framePixelOf", () => {
  const rect = { left: 100, top: 50, width: 800, height: 600 }

  test("the origin is the frame's top-left corner and y points down", () => {
    assert.deepEqual(framePixelOf({ x: 100, y: 50 }, rect, { width: 800, height: 600 }), { x: 0, y: 0 })
    assert.deepEqual(framePixelOf({ x: 300, y: 450 }, rect, { width: 800, height: 600 }), { x: 200, y: 400 })
    assert.deepEqual(framePixelOf({ x: 899, y: 649 }, rect, { width: 800, height: 600 }), { x: 799, y: 599 })
  })

  test("a frame of device pixels is scaled up by the device pixel ratio (the canvas shows it 1:1)", () => {
    // A 800x600 CSS canvas at ratio 2 shows a 1600x1200 frame
    assert.deepEqual(framePixelOf({ x: 300, y: 450 }, rect, { width: 1600, height: 1200 }), { x: 400, y: 800 })
    // At 1.25 the frame is 1000x750
    assert.deepEqual(framePixelOf({ x: 500, y: 350 }, rect, { width: 1000, height: 750 }), { x: 500, y: 375 })
  })

  test("fractions are kept (the host takes float pixels), and a zero-size rectangle doesn't divide by zero", () => {
    const p = framePixelOf({ x: 100.5, y: 50.25 }, rect, { width: 1600, height: 1200 })
    assert.equal(p.x, 1)
    assert.equal(p.y, 0.5)
    const flat = framePixelOf({ x: 5, y: 5 }, { left: 0, top: 0, width: 0, height: 0 }, { width: 10, height: 10 })
    assert.ok(Number.isFinite(flat.x) && Number.isFinite(flat.y))
  })

  test("outside the frame is outside the viewport: 0 up to, not including, its size", () => {
    const frame = { width: 800, height: 600 }
    assert.equal(insideFrame({ x: 0, y: 0 }, frame), true)
    assert.equal(insideFrame({ x: 799.9, y: 599.9 }, frame), true)
    assert.equal(insideFrame({ x: 800, y: 10 }, frame), false)
    assert.equal(insideFrame({ x: 10, y: 600 }, frame), false)
    assert.equal(insideFrame({ x: -0.1, y: 10 }, frame), false)
    assert.equal(insideFrame({ x: 10, y: -1 }, frame), false)
  })
})
