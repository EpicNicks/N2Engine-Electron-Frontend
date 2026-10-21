import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import {
  DefaultSnapSettings,
  StepLimits,
  defaultSnapSettings,
  degreesToRadians,
  formatStep,
  parseStep,
  snapActive,
  snapAngle,
  snapDeltaAbsolute,
  snapDeltaRelative,
  snapScaleRatio,
  snapValue,
  stepRadians,
  validStep,
} from "../renderer/viewport-snap"
import { quatFromAxisAngle, vec3 } from "../renderer/viewport-math"

const near = (actual: number, expected: number, epsilon = 1e-9, what = ""): void =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${what} ${actual} is not ${expected}`)

describe("the snap defaults (U4)", () => {
  test("move 0.5 relative, rotate 15 degrees, scale 0.1, all off until Ctrl or the toolbar turns them on", () => {
    assert.deepEqual(DefaultSnapSettings, {
      translate: { enabled: false, step: 0.5, kind: "relative" },
      rotate: { enabled: false, stepDegrees: 15 },
      scale: { enabled: false, step: 0.1 },
    })
    near(stepRadians(DefaultSnapSettings), (15 * Math.PI) / 180)
  })

  test("a fresh copy is not the shared defaults: changing it leaves them alone", () => {
    const copy = defaultSnapSettings()
    copy.translate.step = 3
    copy.rotate.enabled = true
    assert.equal(DefaultSnapSettings.translate.step, 0.5)
    assert.equal(DefaultSnapSettings.rotate.enabled, false)
    assert.deepEqual(defaultSnapSettings(), DefaultSnapSettings)
  })
})

describe("snapValue", () => {
  test("rounds to the nearest multiple, halves away from zero, the same for a value and its negative", () => {
    assert.equal(snapValue(1.3, 0.5), 1.5)
    assert.equal(snapValue(1.2, 0.5), 1)
    assert.equal(snapValue(-0.3, 0.5), -0.5)
    assert.equal(snapValue(0.25, 0.5), 0.5)
    assert.equal(snapValue(-0.25, 0.5), -0.5)
    assert.equal(snapValue(0.75, 0.5), 1)
  })

  test("leaves no floating-point tail: 3 steps of 0.1 are 0.3, not 0.30000000000000004", () => {
    assert.equal(snapValue(0.29, 0.1), 0.3)
    assert.equal(snapValue(0.71, 0.1), 0.7)
    assert.equal(snapValue(1.04, 0.1), 1)
    assert.equal(snapValue(2.34, 0.1), 2.3)
    assert.equal(snapValue(-0.61, 0.1), -0.6)
    assert.equal(snapValue(123456.78, 0.01), 123456.78)
  })

  test("never gives a negative zero", () => {
    assert.ok(Object.is(snapValue(-0.1, 0.5), 0))
    assert.ok(Object.is(snapValue(-0, 0.5), 0))
    assert.ok(Object.is(snapValue(-0.001, 0.1), 0))
  })

  test("a step that is not positive and finite, or a value that is not finite, leaves the value as it is", () => {
    assert.equal(snapValue(1.3, 0), 1.3)
    assert.equal(snapValue(1.3, -0.5), 1.3)
    assert.equal(snapValue(1.3, NaN), 1.3)
    assert.equal(snapValue(1.3, Infinity), 1.3)
    assert.ok(Number.isNaN(snapValue(NaN, 0.5)))
    assert.equal(snapValue(Infinity, 0.5), Infinity)
  })

  test("a step of one is a plain rounding, and a step larger than the value rounds to zero or one step", () => {
    assert.equal(snapValue(2.6, 1), 3)
    assert.equal(snapValue(0.2, 5), 0)
    assert.equal(snapValue(2.6, 5), 5)
  })
})

describe("snapDeltaRelative", () => {
  const X = vec3(1, 0, 0)
  const Y = vec3(0, 1, 0)
  const Z = vec3(0, 0, 1)

  test("along the world axes it rounds the components of the axes the handle moves along, as the move always did", () => {
    const snapped = snapDeltaRelative(vec3(1.3, 0, 0), [X], 0.5)
    assert.deepEqual(snapped, vec3(1.5, 0, 0))
    const plane = snapDeltaRelative(vec3(0.7, 0, -1.2), [X, Z], 0.5)
    assert.deepEqual(plane, vec3(0.5, 0, -1))
  })

  test("a component the handle does not move along is left as it is", () => {
    const snapped = snapDeltaRelative(vec3(1.3, 0.77, 0), [X], 0.5)
    near(snapped.x, 1.5)
    near(snapped.y, 0.77)
  })

  test("along an object's own (rotated) axis the distance along that axis is what is rounded", () => {
    // The axis turned 90 degrees about y: local x is world -z
    const local = vec3(0, 0, -1)
    const delta = vec3(0, 0, -1.3)
    const snapped = snapDeltaRelative(delta, [local], 0.5)
    near(snapped.x, 0)
    near(snapped.z, -1.5)
    // A diagonal axis: the move stays on its line, its length is a multiple of the step
    const d = vec3(Math.SQRT1_2, Math.SQRT1_2, 0)
    const on = snapDeltaRelative(vec3(d.x * 1.3, d.y * 1.3, 0), [d], 0.5)
    near(on.x, d.x * 1.5)
    near(on.y, d.y * 1.5)
    near(on.z, 0)
  })

  test("a plane of an object's own axes rounds the distance along each", () => {
    const a = vec3(Math.SQRT1_2, Math.SQRT1_2, 0)
    const b = vec3(-Math.SQRT1_2, Math.SQRT1_2, 0)
    // 0.8 along a and -1.3 along b
    const delta = vec3(a.x * 0.8 + b.x * -1.3, a.y * 0.8 + b.y * -1.3, 0)
    const snapped = snapDeltaRelative(delta, [a, b], 0.5)
    const along = (v: { x: number; y: number }, axis: { x: number; y: number }) => v.x * axis.x + v.y * axis.y
    near(along(snapped, a), 1, 1e-9)
    near(along(snapped, b), -1.5, 1e-9)
  })

  test("no axes: nothing is rounded", () => {
    assert.deepEqual(snapDeltaRelative(vec3(1.3, 2.2, 3.1), [], 0.5), vec3(1.3, 2.2, 3.1))
  })
})

describe("snapDeltaAbsolute", () => {
  test("the position the move leads to is on the grid, not the move: from 0.3 a move of 0.4 ends at 1, not at 0.8", () => {
    const origin = vec3(0.3, 2, 3)
    const delta = snapDeltaAbsolute(origin, vec3(0.4, 0, 0), { x: true, y: false, z: false }, 0.5)
    near(origin.x + delta.x, 0.5)
    const far = snapDeltaAbsolute(origin, vec3(0.95, 0, 0), { x: true, y: false, z: false }, 0.5)
    near(origin.x + far.x, 1.5)
    const relative = snapDeltaRelative(vec3(0.4, 0, 0), [vec3(1, 0, 0)], 0.5)
    near(origin.x + relative.x, 0.8, 1e-12, "relative keeps the offset of where it began")
  })

  test("only the axes the handle moves along are put on the grid", () => {
    const origin = vec3(0.3, 0.3, 0.3)
    const delta = snapDeltaAbsolute(origin, vec3(0.4, 0.4, 0.4), { x: true, y: false, z: true }, 0.5)
    near(origin.x + delta.x, 0.5)
    near(delta.y, 0.4)
    near(origin.z + delta.z, 0.5)
  })

  test("negative positions and floating point: the result is on the grid exactly", () => {
    const origin = vec3(-0.35, 0, 0)
    const delta = snapDeltaAbsolute(origin, vec3(-0.87, 0, 0), { x: true, y: false, z: false }, 0.1)
    near(origin.x + delta.x, -1.2, 1e-12)
  })
})

describe("snapAngle across the wrap", () => {
  const step = degreesToRadians(15)

  test("the drag's total angle snaps to multiples of the step, also past half a turn and past a full one", () => {
    near(snapAngle(degreesToRadians(17), step), degreesToRadians(15))
    near(snapAngle(degreesToRadians(23), step), degreesToRadians(30))
    near(snapAngle(degreesToRadians(-100), step), degreesToRadians(-105))
    near(snapAngle(degreesToRadians(200), step), degreesToRadians(195))
    near(snapAngle(degreesToRadians(358), step), degreesToRadians(360))
    near(snapAngle(degreesToRadians(722), step), degreesToRadians(720))
  })

  test("a turn that snaps to a full circle is the identity rotation", () => {
    const full = snapAngle(degreesToRadians(358.5), step)
    near(full, 2 * Math.PI)
    const q = quatFromAxisAngle(vec3(0, 1, 0), full)
    near(Math.abs(q.w), 1, 1e-9)
    near(q.x, 0, 1e-9)
    near(q.y, 0, 1e-9)
    near(q.z, 0, 1e-9)
  })

  test("just either side of a multiple snaps to it; just either side of a half step snaps apart", () => {
    near(snapAngle(degreesToRadians(14.99), step), step)
    near(snapAngle(degreesToRadians(15.01), step), step)
    near(snapAngle(degreesToRadians(7.4), step), 0)
    near(snapAngle(degreesToRadians(7.6), step), step)
    assert.ok(Object.is(snapAngle(-0.001, step), 0))
  })

  test("other steps (1 degree, 45 degrees, 90 degrees) are multiples of themselves", () => {
    for (const degrees of [1, 5, 45, 90]) {
      const s = degreesToRadians(degrees)
      for (const k of [-5, -1, 0, 1, 3, 9]) near(snapAngle(k * s + s * 0.2, s), k * s, 1e-9, `${degrees} x ${k}`)
    }
  })
})

describe("snapScaleRatio", () => {
  test("rounds the ratio to the step and never below one step", () => {
    near(snapScaleRatio(1.04, 0.1), 1.0, 1e-12)
    near(snapScaleRatio(1.06, 0.1), 1.1, 1e-12)
    near(snapScaleRatio(0.02, 0.1), 0.1, 1e-12)
    near(snapScaleRatio(0.001, 0.1), 0.1, 1e-12)
    near(snapScaleRatio(2.34, 0.1), 2.3, 1e-12)
    near(snapScaleRatio(1.3, 0.25), 1.25, 1e-12)
    near(snapScaleRatio(0.1, 0.25), 0.25, 1e-12)
  })

  test("a step that is no step leaves the ratio", () => {
    assert.equal(snapScaleRatio(1.37, 0), 1.37)
    assert.equal(snapScaleRatio(1.37, NaN), 1.37)
  })
})

describe("Ctrl inverts the toggle", () => {
  test("toggle off: Ctrl snaps; toggle on: Ctrl does not; neither: no snap; both: no snap", () => {
    assert.equal(snapActive(false, false), false)
    assert.equal(snapActive(false, true), true)
    assert.equal(snapActive(true, false), true)
    assert.equal(snapActive(true, true), false)
  })
})

describe("the increment fields", () => {
  test("parseStep takes a positive number within the limits, a decimal comma too", () => {
    assert.equal(parseStep("0.5", StepLimits.translate), 0.5)
    assert.equal(parseStep(" 2 ", StepLimits.translate), 2)
    assert.equal(parseStep("0,25", StepLimits.translate), 0.25)
    assert.equal(parseStep(".5", StepLimits.translate), 0.5)
    assert.equal(parseStep("1e-2", StepLimits.scale), 0.01)
    assert.equal(parseStep("90", StepLimits.rotateDegrees), 90)
  })

  test("parseStep refuses empty, text, zero, negative, infinite and out-of-range values", () => {
    for (const bad of ["", "  ", "abc", "0", "-1", "0.0", "1x", "Infinity", "NaN", "1,2,3", "--1", "0x10", "1e999"]) {
      assert.equal(parseStep(bad, StepLimits.translate), null, JSON.stringify(bad))
    }
    assert.equal(parseStep("181", StepLimits.rotateDegrees), null, "more than half a turn")
    assert.equal(parseStep("0.001", StepLimits.rotateDegrees), null, "below the least")
    assert.equal(parseStep("100001", StepLimits.translate), null)
  })

  test("validStep is for numbers only", () => {
    assert.equal(validStep(0.5, StepLimits.translate), true)
    assert.equal(validStep("0.5", StepLimits.translate), false)
    assert.equal(validStep(NaN, StepLimits.translate), false)
    assert.equal(validStep(null, StepLimits.translate), false)
    assert.equal(validStep(0, StepLimits.translate), false)
  })

  test("formatStep shows a step without a floating-point tail", () => {
    assert.equal(formatStep(0.5), "0.5")
    assert.equal(formatStep(15), "15")
    assert.equal(formatStep(0.1 + 0.2), "0.3")
    assert.equal(formatStep(0.0001), "0.0001")
  })
})
