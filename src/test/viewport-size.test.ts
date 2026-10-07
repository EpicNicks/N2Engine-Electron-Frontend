import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { MaxViewportDimension, cssSizeForPixels, viewportPixelSize } from "../renderer/viewport-size"

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
