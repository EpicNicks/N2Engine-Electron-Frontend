import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import {
  DefaultCamera,
  EditorCameraController,
  FrameMargin,
  MaxDistance,
  MaxPosition,
  MaxPitch,
  MinDistance,
  PointFrameDistance,
} from "../renderer/viewport-camera"
import { length, quatFromAxisAngle, sub, vec3 } from "../renderer/viewport-math"

const near = (actual: number, expected: number, epsilon = 1e-6, what = ""): void =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${what} ${actual} is not ${expected}`)
const nearVec = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  epsilon = 1e-6
): void => {
  near(a.x, b.x, epsilon, "x")
  near(a.y, b.y, epsilon, "y")
  near(a.z, b.z, epsilon, "z")
}

describe("the orbit pose", () => {
  test("a new camera is at (0, 0, 10) looking at the origin: the host's default", () => {
    const camera = new EditorCameraController()
    nearVec(camera.position, DefaultCamera.position)
    nearVec(camera.forward, vec3(0, 0, -1))
    const request = camera.toRequest()
    assert.equal(request.orthographic, false)
    assert.equal(request.fovY, 60)
    near(request.rotation.w, 1)
  })

  test("adopt takes the host's pose back: the position is kept, and the target is in front of it", () => {
    const camera = new EditorCameraController()
    const rotation = quatFromAxisAngle(vec3(0, 1, 0), 0.8)
    camera.adopt({ position: vec3(3, 4, 5), rotation, fovY: 50, nearPlane: 0.2, farPlane: 300 }, 7)
    nearVec(camera.position, vec3(3, 4, 5), 1e-5)
    near(camera.distance, 7)
    near(length(sub(camera.target, camera.position)), 7, 1e-5)
    assert.equal(camera.fovY, 50)
    const out = camera.toRequest()
    assert.equal(out.nearPlane, 0.2)
    assert.equal(out.farPlane, 300)
    near(out.rotation.y, Math.sin(0.4), 1e-6)
  })

  test("adopt of a pose looking straight down is kept below the pitch limit", () => {
    const camera = new EditorCameraController()
    camera.adopt({
      position: vec3(0, 10, 0),
      rotation: quatFromAxisAngle(vec3(1, 0, 0), -Math.PI / 2),
      fovY: 60,
      nearPlane: 0.1,
      farPlane: 100,
    })
    near(camera.pitch, -MaxPitch)
  })
})

describe("orbit", () => {
  test("keeps the target and the distance, and dragging right moves the camera to the left of it", () => {
    const camera = new EditorCameraController()
    camera.orbit(100, 0)
    nearVec(camera.target, vec3(0, 0, 0))
    near(length(sub(camera.position, camera.target)), 10, 1e-9)
    assert.ok(camera.position.x < 0, "the camera went to the left")
    // And it still looks at the target
    const f = camera.forward
    nearVec(sub(camera.target, camera.position), vec3(f.x * 10, f.y * 10, f.z * 10), 1e-9)
  })

  test("dragging down raises the camera over the target, and the pitch is limited", () => {
    const camera = new EditorCameraController()
    camera.orbit(0, 100)
    assert.ok(camera.position.y > 0)
    camera.orbit(0, 1e6)
    near(camera.pitch, -MaxPitch)
    camera.orbit(0, -1e7)
    near(camera.pitch, MaxPitch)
  })

  test("bumps the version", () => {
    const camera = new EditorCameraController()
    const before = camera.version
    camera.orbit(1, 1)
    assert.ok(camera.version > before)
  })
})

describe("look", () => {
  test("turns the camera where it stands", () => {
    const camera = new EditorCameraController()
    const position = camera.position
    camera.look(200, -50)
    nearVec(camera.position, position, 1e-9)
    assert.ok(camera.forward.x > 0, "dragging right turns the view right")
    assert.ok(camera.forward.y > 0, "dragging up looks up")
  })
})

describe("pan", () => {
  test("moves the camera and the target together, by a pixel's world size, opposite to the drag", () => {
    const camera = new EditorCameraController()
    // fov 60, distance 10, a 600 pixel high viewport: a pixel is 2 * 10 * tan(30 deg) / 600 units
    const perPixel = (2 * 10 * Math.tan(Math.PI / 6)) / 600
    camera.pan(100, 0, 600)
    near(camera.target.x, -100 * perPixel)
    nearVec(sub(camera.position, camera.target), vec3(0, 0, 10), 1e-9)
    camera.pan(0, 50, 600)
    near(camera.target.y, 50 * perPixel)
  })

  test("a viewport with no height does nothing", () => {
    const camera = new EditorCameraController()
    camera.pan(10, 10, 0)
    nearVec(camera.target, vec3(0, 0, 0))
  })
})

describe("zoom", () => {
  test("scrolling down moves away, up moves closer, never past the limits", () => {
    const camera = new EditorCameraController()
    camera.zoom(100)
    assert.ok(camera.distance > 10)
    const out = camera.distance
    camera.zoom(-100)
    near(camera.distance, 10, 1e-9)
    assert.ok(out > camera.distance)
    camera.zoom(-1e9)
    assert.equal(camera.distance, MinDistance)
    camera.zoom(1e9)
    assert.equal(camera.distance, MaxDistance)
  })

  test("is multiplicative: the same scroll is the same fraction at any distance", () => {
    const a = new EditorCameraController()
    const b = new EditorCameraController()
    b.distance = 1000
    a.zoom(50)
    b.zoom(50)
    near(a.distance / 10, b.distance / 1000, 1e-9)
  })
})

describe("fly", () => {
  test("forward goes along the view, up along the world's Y, and diagonals are no faster", () => {
    const camera = new EditorCameraController()
    camera.fly(vec3(0, 0, 1), 1, 4)
    nearVec(camera.position, vec3(0, 0, 6))
    near(camera.distance, 10)
    camera.fly(vec3(0, 1, 0), 0.5, 4)
    near(camera.position.y, 2)
    const before = camera.position
    camera.fly(vec3(1, 0, 1), 1, 4)
    near(length(sub(camera.position, before)), 4, 1e-9)
  })

  test("follows where the camera looks, not the world's Z", () => {
    const camera = new EditorCameraController()
    camera.yaw = Math.PI / 2 // looks down -X
    camera.fly(vec3(0, 0, 1), 1, 3)
    nearVec(camera.target, vec3(-3, 0, 0), 1e-9)
    // Its right is -Z (forward x up)
    camera.fly(vec3(1, 0, 0), 1, 2)
    nearVec(camera.target, vec3(-3, 0, -2), 1e-9)
  })

  test("does nothing with no time, no speed or no keys", () => {
    const camera = new EditorCameraController()
    const version = camera.version
    camera.fly(vec3(0, 0, 1), 0, 4)
    camera.fly(vec3(0, 0, 1), 1, 0)
    camera.fly(vec3(0, 0, 0), 1, 4)
    assert.equal(camera.version, version)
  })

  test("a camera far away flies faster; boost is four times", () => {
    const camera = new EditorCameraController()
    assert.equal(camera.flySpeed(false), 10)
    assert.equal(camera.flySpeed(true), 40)
    camera.distance = 0.5
    assert.equal(camera.flySpeed(false), 2)
  })
})

describe("frame", () => {
  test("bounds: the centre is the target, and the bounding sphere fits the field of view", () => {
    const camera = new EditorCameraController()
    camera.orbit(30, 10)
    camera.frameBounds({ min: vec3(-1, -1, -1), max: vec3(3, 1, 1) }) // centre (1, 0, 0)
    nearVec(camera.target, vec3(1, 0, 0))
    const radius = Math.hypot(4, 2, 2) / 2
    near(camera.distance, (radius * FrameMargin) / Math.sin(Math.PI / 6), 1e-9)
    // The camera stands that far from the centre, so the whole sphere is inside the view
    near(length(sub(camera.position, vec3(1, 0, 0))), camera.distance, 1e-9)
  })

  test("a box with no size takes the point distance; nonsense changes nothing", () => {
    const camera = new EditorCameraController()
    camera.frameBounds({ min: vec3(2, 2, 2), max: vec3(2, 2, 2) })
    nearVec(camera.target, vec3(2, 2, 2))
    assert.equal(camera.distance, PointFrameDistance)
    const version = camera.version
    camera.frameBounds({ min: vec3(NaN, 0, 0), max: vec3(1, 1, 1) })
    camera.framePoint(vec3(Infinity, 0, 0))
    assert.equal(camera.version, version)
  })

  test("a point: the camera stands PointFrameDistance away and keeps its direction", () => {
    const camera = new EditorCameraController()
    camera.orbit(50, 20)
    const forward = camera.forward
    camera.framePoint(vec3(10, 20, 30))
    nearVec(camera.target, vec3(10, 20, 30))
    near(camera.distance, PointFrameDistance)
    nearVec(camera.forward, forward, 1e-9)
  })
})

describe("the host's position limit", () => {
  test("flying or panning far keeps the position inside it, and the look direction", () => {
    const camera = new EditorCameraController()
    camera.distance = 90000
    for (let i = 0; i < 50; i++) camera.fly(vec3(0, 0, -1), 1, 1e6)
    const request = camera.toRequest()
    for (const v of [request.position.x, request.position.y, request.position.z]) assert.ok(Math.abs(v) <= MaxPosition)
    nearVec(camera.forward, vec3(0, 0, -1))
    camera.pan(1e9, 1e9, 1)
    for (const v of [camera.position.x, camera.position.y, camera.position.z]) assert.ok(Math.abs(v) <= MaxPosition)
  })
})
