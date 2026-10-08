import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import {
  IdentityMat4,
  IdentityQuat,
  closestParamOnLine,
  distanceToSegment,
  mat4Compose,
  mat4Invert,
  mat4Multiply,
  mat4TransformDirection,
  mat4TransformPoint,
  projectionMatrix,
  quatFromAxisAngle,
  quatMultiply,
  quatRotate,
  screenRay,
  vec3,
  viewMatrix,
  worldToScreen,
} from "../renderer/viewport-math"

const near = (actual: number, expected: number, epsilon = 1e-6, what = ""): void =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${what} ${actual} is not ${expected}`)
const nearVec = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, epsilon = 1e-6): void => {
  near(a.x, b.x, epsilon, "x")
  near(a.y, b.y, epsilon, "y")
  near(a.z, b.z, epsilon, "z")
}

const perspective = { fovY: 90, orthographic: false, orthoSize: 5, nearPlane: 0.1, farPlane: 100 }

describe("quaternions", () => {
  test("a quarter turn about Y takes +X to -Z, and composes", () => {
    const q = quatFromAxisAngle(vec3(0, 1, 0), Math.PI / 2)
    nearVec(quatRotate(q, vec3(1, 0, 0)), vec3(0, 0, -1))
    nearVec(quatRotate(quatMultiply(q, q), vec3(1, 0, 0)), vec3(-1, 0, 0))
    nearVec(quatRotate(IdentityQuat, vec3(1, 2, 3)), vec3(1, 2, 3))
  })
})

describe("matrices", () => {
  test("compose puts the translation in elements 12 to 14 and applies scale, then rotation, then translation", () => {
    const m = mat4Compose(vec3(1, 2, 3), quatFromAxisAngle(vec3(0, 1, 0), Math.PI / 2), vec3(2, 2, 2))
    assert.deepEqual([m[12], m[13], m[14]], [1, 2, 3])
    // (1, 0, 0) is scaled to (2, 0, 0), turned to (0, 0, -2), moved to (1, 2, 1)
    nearVec(mat4TransformPoint(m, vec3(1, 0, 0))!.point, vec3(1, 2, 1))
  })

  test("invert undoes a transform; a zero scale has no inverse", () => {
    const m = mat4Compose(vec3(4, -5, 6), quatFromAxisAngle(vec3(1, 1, 0), 0.7), vec3(2, 3, 0.5))
    const inverse = mat4Invert(m)!
    const product = mat4Multiply(m, inverse)
    product.forEach((value, i) => near(value, IdentityMat4[i], 1e-9, `element ${i}`))
    assert.equal(mat4Invert(mat4Compose(vec3(0, 0, 0), IdentityQuat, vec3(1, 0, 1))), null)
  })

  test("directions take no translation", () => {
    const m = mat4Compose(vec3(10, 10, 10), quatFromAxisAngle(vec3(0, 0, 1), Math.PI / 2), vec3(1, 1, 1))
    nearVec(mat4TransformDirection(m, vec3(1, 0, 0)), vec3(0, 1, 0))
  })
})

describe("the camera's matrices", () => {
  test("the view matrix takes the camera's position to the origin and its forward to -Z", () => {
    const rotation = quatFromAxisAngle(vec3(0, 1, 0), Math.PI / 2) // looks down -X
    const view = viewMatrix(vec3(5, 1, 2), rotation)
    nearVec(mat4TransformPoint(view, vec3(5, 1, 2))!.point, vec3(0, 0, 0))
    nearVec(mat4TransformPoint(view, vec3(4, 1, 2))!.point, vec3(0, 0, -1))
  })

  test("the engine's default camera, 10 in front of the origin, sees the origin in the middle", () => {
    const view = viewMatrix(vec3(0, 0, 10), IdentityQuat)
    const projection = projectionMatrix(perspective, 2)
    const viewProjection = mat4Multiply(projection, view)
    const centre = worldToScreen(viewProjection, vec3(0, 0, 0), 800, 400)!
    near(centre.x, 400)
    near(centre.y, 200)
  })

  test("screen y runs down: a point above the origin is above the centre; +X is right", () => {
    const viewProjection = mat4Multiply(projectionMatrix(perspective, 1), viewMatrix(vec3(0, 0, 10), IdentityQuat))
    const up = worldToScreen(viewProjection, vec3(0, 1, 0), 600, 600)!
    const right = worldToScreen(viewProjection, vec3(1, 0, 0), 600, 600)!
    assert.ok(up.y < 300)
    near(up.x, 300)
    assert.ok(right.x > 300)
    near(right.y, 300)
    // fov 90 at distance 10: one unit is a tenth of the half height, 30 pixels
    near(right.x, 330, 1e-6)
  })

  test("a point behind the camera is not on the screen", () => {
    const viewProjection = mat4Multiply(projectionMatrix(perspective, 1), viewMatrix(vec3(0, 0, 10), IdentityQuat))
    assert.equal(worldToScreen(viewProjection, vec3(0, 0, 11), 600, 600), null)
    assert.equal(worldToScreen(viewProjection, vec3(0, 0, 10), 600, 600), null)
  })

  test("an orthographic projection keeps parallel lines parallel: size doesn't depend on depth", () => {
    const projection = projectionMatrix({ ...perspective, orthographic: true, orthoSize: 5 }, 1)
    const viewProjection = mat4Multiply(projection, viewMatrix(vec3(0, 0, 10), IdentityQuat))
    const near1 = worldToScreen(viewProjection, vec3(1, 0, 5), 500, 500)!
    const far1 = worldToScreen(viewProjection, vec3(1, 0, -20), 500, 500)!
    near(near1.x, far1.x)
    near(near1.x, 250 + 50) // one unit of five half-heights: a fifth of 250
  })
})

describe("rays", () => {
  const viewProjection = mat4Multiply(projectionMatrix(perspective, 16 / 9), viewMatrix(vec3(1, 2, 10), IdentityQuat))

  test("the ray through a point's pixel passes through the point", () => {
    const point = vec3(3, -1, 2)
    const pixel = worldToScreen(viewProjection, point, 1280, 720)!
    const ray = screenRay(viewProjection, pixel.x, pixel.y, 1280, 720)!
    // The distance from the point to the ray's line
    const toPoint = vec3(point.x - ray.origin.x, point.y - ray.origin.y, point.z - ray.origin.z)
    const along = toPoint.x * ray.direction.x + toPoint.y * ray.direction.y + toPoint.z * ray.direction.z
    const off = vec3(
      toPoint.x - ray.direction.x * along,
      toPoint.y - ray.direction.y * along,
      toPoint.z - ray.direction.z * along
    )
    near(Math.hypot(off.x, off.y, off.z), 0, 1e-4)
    assert.ok(along > 0, "in front of the origin")
  })

  test("a ray's closest point on an axis line", () => {
    // A ray down -Z from (2, 0, 10) meets the X axis line at x = 2
    const t = closestParamOnLine({ origin: vec3(2, 0, 10), direction: vec3(0, 0, -1) }, vec3(0, 0, 0), vec3(1, 0, 0))!
    near(t, 2)
    // Starting at (2, 5, 10) the nearest point of the X axis is still x = 2
    near(closestParamOnLine({ origin: vec3(2, 5, 10), direction: vec3(0, 0, -1) }, vec3(0, 0, 0), vec3(1, 0, 0))!, 2)
    // Parallel: no answer
    assert.equal(closestParamOnLine({ origin: vec3(0, 1, 0), direction: vec3(1, 0, 0) }, vec3(0, 0, 0), vec3(1, 0, 0)), null)
  })

  test("screenRay refuses a singular matrix and an empty viewport", () => {
    assert.equal(screenRay(new Array(16).fill(0), 1, 1, 100, 100), null)
    assert.equal(screenRay(viewProjection, 1, 1, 0, 100), null)
  })
})

test("distanceToSegment", () => {
  near(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3)
  near(distanceToSegment({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5) // beyond the start: to the end point
  near(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }), 5) // a point
})
