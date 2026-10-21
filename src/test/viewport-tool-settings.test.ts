import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { Mat4 } from "../protocol/protocol.generated"
import {
  GizmoPivotTitles,
  GizmoPivots,
  GizmoSpaceTitles,
  GizmoSpaces,
  boundsCenter,
  gizmoAxes,
  otherPivot,
  otherSpace,
  pivotPosition,
} from "../renderer/viewport-tool-settings"
import { WorldAxes } from "../renderer/viewport-gizmo"
import { IdentityMat4, IdentityQuat, mat4Compose, quatFromAxisAngle, vec3 } from "../renderer/viewport-math"

const near = (actual: number, expected: number, epsilon = 1e-9, what = ""): void =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${what} ${actual} is not ${expected}`)

describe("space and pivot values", () => {
  test("world and local, pivot and center, each with a name to show, and the other of each", () => {
    assert.deepEqual([...GizmoSpaces], ["world", "local"])
    assert.deepEqual([...GizmoPivots], ["pivot", "center"])
    assert.deepEqual(GizmoSpaces.map((s) => GizmoSpaceTitles[s]), ["World", "Local"])
    assert.deepEqual(GizmoPivots.map((p) => GizmoPivotTitles[p]), ["Pivot", "Center"])
    assert.equal(otherSpace("world"), "local")
    assert.equal(otherSpace("local"), "world")
    assert.equal(otherPivot("pivot"), "center")
    assert.equal(otherPivot("center"), "pivot")
  })
})

describe("gizmoAxes", () => {
  test("world space is the world's axes, whatever the object's matrix", () => {
    const m = mat4Compose(vec3(1, 2, 3), quatFromAxisAngle(vec3(0, 1, 0), 1), vec3(2, 2, 2))
    assert.equal(gizmoAxes("world", m), WorldAxes)
    assert.equal(gizmoAxes("world", null), WorldAxes)
  })

  test("local space with no object is the world's axes (nothing to follow)", () => {
    assert.equal(gizmoAxes("local", null), WorldAxes)
  })

  test("local space of an unrotated object is the world's axes in value", () => {
    const axes = gizmoAxes("local", IdentityMat4)
    assert.deepEqual(axes.x, vec3(1, 0, 0))
    assert.deepEqual(axes.y, vec3(0, 1, 0))
    assert.deepEqual(axes.z, vec3(0, 0, 1))
  })

  test("local space follows the object's rotation, with the scale stripped", () => {
    // 90 degrees about y turns x to -z and z to x
    const m = mat4Compose(vec3(5, 6, 7), quatFromAxisAngle(vec3(0, 1, 0), Math.PI / 2), vec3(2, 3, 4))
    const axes = gizmoAxes("local", m)
    near(axes.x.x, 0)
    near(axes.x.z, -1)
    near(axes.y.y, 1)
    near(axes.z.x, 1)
    near(axes.z.z, 0)
    for (const a of [axes.x, axes.y, axes.z]) near(Math.hypot(a.x, a.y, a.z), 1, 1e-9, "unit length")
  })

  test("a column with no length (a scale of zero) falls back to the world axis for that handle", () => {
    const m = mat4Compose(vec3(0, 0, 0), IdentityQuat, vec3(0, 1, 1))
    const axes = gizmoAxes("local", m)
    assert.deepEqual(axes.x, vec3(1, 0, 0))
    assert.deepEqual(axes.y, vec3(0, 1, 0))
  })
})

describe("pivotPosition", () => {
  const world: Mat4 = mat4Compose(vec3(1, 2, 3), IdentityQuat, vec3(1, 1, 1))
  const a = { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) }
  const b = { min: vec3(3, 0, -2), max: vec3(5, 4, 2) }

  test("pivot: the primary object's world position, bounds or not", () => {
    assert.deepEqual(pivotPosition("pivot", world, [a, b]), vec3(1, 2, 3))
    assert.deepEqual(pivotPosition("pivot", world, []), vec3(1, 2, 3))
  })

  test("center: the centre of the union of the bounds of a multi-selection", () => {
    // The union is -1..5 by -1..4 by -2..2
    assert.deepEqual(pivotPosition("center", world, [a, b]), vec3(2, 1.5, 0))
    // Order does not matter
    assert.deepEqual(pivotPosition("center", world, [b, a]), vec3(2, 1.5, 0))
  })

  test("center of one object is the centre of its box, which need not be its origin", () => {
    assert.deepEqual(pivotPosition("center", world, [b]), vec3(4, 2, 0))
    assert.deepEqual(boundsCenter(b), vec3(4, 2, 0))
  })

  test("center with no bounds (a host that can't measure) is the primary's position: the gizmo never goes missing", () => {
    assert.deepEqual(pivotPosition("center", world, []), vec3(1, 2, 3))
  })

  test("center with a box that is not a number is the primary's position", () => {
    const bad = { min: vec3(NaN, 0, 0), max: vec3(1, 1, 1) }
    assert.deepEqual(pivotPosition("center", world, [bad]), vec3(1, 2, 3))
  })

  test("a box of one point is that point", () => {
    const point = { min: vec3(2, 2, 2), max: vec3(2, 2, 2) }
    assert.deepEqual(pivotPosition("center", world, [point]), vec3(2, 2, 2))
  })
})
