import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { Mat4, Quat, Vec3 } from "../protocol/protocol.generated"
import { GizmoDragDeps, GizmoTarget } from "../renderer/viewport-drag"
import {
  RingBasis,
  RingRadius,
  RingSegments,
  RotateDrag,
  RotateGizmoDrag,
  RotateLayout,
  RotateSnapRadians,
  formatAngle,
  hitTestRotate,
  parentRotationOf,
  ringPoint,
  ringTangentAt,
  rotateLayout,
  rotatedTransform,
} from "../renderer/viewport-rotate"
import { GizmoSizePixels, AxisDirections, Axis } from "../renderer/viewport-gizmo"
import {
  IdentityQuat,
  Pixel,
  cross,
  dot,
  length,
  mat4Compose,
  mat4Multiply,
  normalize,
  projectionMatrix,
  quatConjugate,
  quatFromAxes,
  quatFromAxisAngle,
  quatMultiply,
  quatRotate,
  sub,
  vec3,
  viewMatrix,
  wrapAngle,
  worldToScreen,
} from "../renderer/viewport-math"

const W = 800
const H = 600

const near = (actual: number, expected: number, epsilon = 1e-6, what = ""): void =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${what} ${actual} is not ${expected}`)

const nearVec = (a: Vec3, b: Vec3, epsilon = 1e-6, what = ""): void => {
  near(a.x, b.x, epsilon, `${what} x`)
  near(a.y, b.y, epsilon, `${what} y`)
  near(a.z, b.z, epsilon, `${what} z`)
}

/** Two quaternions are one rotation: they rotate every probe vector alike (q and -q are the same) */
const sameRotation = (a: Quat, b: Quat, what = ""): void => {
  for (const probe of [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1), vec3(1, 2, 3)]) {
    nearVec(quatRotate(a, probe), quatRotate(b, probe), 1e-6, what)
  }
}

const settings = { fovY: 60, orthographic: false, orthoSize: 5, nearPlane: 0.1, farPlane: 1000 }

/** A camera at position looking at target (+Y up), and what the gizmo maths takes of it */
function camera(position: Vec3, target: Vec3 = vec3(0, 0, 0)) {
  const z = normalize(sub(position, target))
  const x = normalize(cross(vec3(0, 1, 0), z))
  const y = cross(z, x)
  const rotation = quatFromAxes(x, y, z)!
  const view = viewMatrix(position, rotation)
  const projection = projectionMatrix(settings, W / H)
  return { view, viewProjection: mat4Multiply(projection, view) }
}

const front = camera(vec3(0, 0, 10))
const oblique = camera(vec3(6, 7, 8))

const screenOf = (vp: Mat4, p: Vec3): Pixel => {
  const s = worldToScreen(vp, p, W, H)
  assert.ok(s, "on screen")
  return { x: s.x, y: s.y }
}

// ==================== Quaternion and angle helpers ====================

describe("quatFromAxes and wrapAngle", () => {
  test("a rotation's axes give the rotation back, in every branch of the conversion", () => {
    const turns: Quat[] = [
      IdentityQuat,
      quatFromAxisAngle(vec3(1, 0, 0), Math.PI),
      quatFromAxisAngle(vec3(0, 1, 0), Math.PI),
      quatFromAxisAngle(vec3(0, 0, 1), Math.PI),
      quatFromAxisAngle(vec3(1, 2, 3), 0.7),
      quatFromAxisAngle(vec3(-1, 0.2, 0.1), 2.9),
      quatFromAxisAngle(vec3(0.1, -1, 0.3), 3.0),
      quatFromAxisAngle(vec3(0.1, 0.2, -1), 3.1),
      quatFromAxisAngle(vec3(1, 1, 1), 1e-4),
    ]
    for (const q of turns) {
      const got = quatFromAxes(quatRotate(q, vec3(1, 0, 0)), quatRotate(q, vec3(0, 1, 0)), quatRotate(q, vec3(0, 0, 1)))
      assert.ok(got, JSON.stringify(q))
      sameRotation(got!, q, JSON.stringify(q))
      near(length(vec3(got!.x, got!.y, got!.z)) ** 2 + got!.w ** 2, 1, 1e-9, "unit")
    }
  })

  test("axes that are not a rotation give null: a mirror (left-handed), a length that is not 1", () => {
    assert.equal(quatFromAxes(vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, -1)), null)
    assert.equal(quatFromAxes(vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)), null)
    assert.equal(quatFromAxes(vec3(2, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)), null)
    assert.equal(quatFromAxes(vec3(1, 0, 0), vec3(1, 0, 0), vec3(0, 0, 1)), null, "not perpendicular")
  })

  test("wrapAngle brings an angle into (-pi, pi], and +pi stays +pi", () => {
    near(wrapAngle(0), 0)
    near(wrapAngle(Math.PI), Math.PI)
    near(wrapAngle(-Math.PI), Math.PI)
    near(wrapAngle(3 * Math.PI), Math.PI)
    near(wrapAngle(2 * Math.PI + 0.1), 0.1)
    near(wrapAngle(-2 * Math.PI - 0.1), -0.1)
    near(wrapAngle(Math.PI + 0.1), -Math.PI + 0.1)
    near(wrapAngle(-Math.PI - 0.1), Math.PI - 0.1)
  })

  test("quaternion composition: a conjugate undoes, and the product applies the right one first", () => {
    const a = quatFromAxisAngle(vec3(0, 1, 0), 0.9)
    const b = quatFromAxisAngle(vec3(1, 0, 0), -0.4)
    sameRotation(quatMultiply(a, quatConjugate(a)), IdentityQuat)
    const v = vec3(0.3, -1, 2)
    nearVec(quatRotate(quatMultiply(a, b), v), quatRotate(a, quatRotate(b, v)))
  })

  test("the rings' basis is right-handed: the first axis turned toward the second is a positive turn about the ring's axis", () => {
    for (const axis of ["x", "y", "z"] as Axis[]) {
      const [e1, e2] = RingBasis[axis]
      nearVec(cross(e1, e2), AxisDirections[axis], 1e-12, axis)
      // and a positive rotation about the axis carries e1 to e2
      nearVec(quatRotate(quatFromAxisAngle(AxisDirections[axis], Math.PI / 2), e1), e2, 1e-9, axis)
    }
  })
})

// ==================== Layout and hit testing ====================

describe("the rings' layout", () => {
  test("a ring is the same size on screen at any distance (constant screen size), and scales with the pixel ratio", () => {
    for (const distance of [2, 10, 100, 900]) {
      const cam = camera(vec3(0, 0, distance))
      const layout = rotateLayout(cam.view, cam.viewProjection, vec3(0, 0, 0), W, H)!
      near(layout.radiusPixels, GizmoSizePixels * RingRadius, 1e-6, `distance ${distance}`)
      // The z ring faces the camera: its points are about that far from the centre on screen
      const ring = layout.rings.find((r) => r.axis === "z")!
      for (const segment of ring.segments) {
        const d = Math.hypot(segment.from.x - layout.origin.x, segment.from.y - layout.origin.y)
        assert.ok(Math.abs(d - layout.radiusPixels) < layout.radiusPixels * 0.05, `distance ${distance}: ${d}`)
      }
    }
    const cam = camera(vec3(0, 0, 10))
    const doubled = rotateLayout(cam.view, cam.viewProjection, vec3(0, 0, 0), W, H, 2)!
    near(doubled.radiusPixels, GizmoSizePixels * RingRadius * 2, 1e-6)
  })

  test("away from the screen's centre it is the same size too, and it follows the origin", () => {
    const cam = camera(vec3(0, 0, 10))
    const layout = rotateLayout(cam.view, cam.viewProjection, vec3(1.5, -1, 0), W, H)!
    near(layout.radiusPixels, GizmoSizePixels * RingRadius, 1e-6)
    const s = screenOf(cam.viewProjection, vec3(1.5, -1, 0))
    near(layout.origin.x, s.x, 1e-9)
    near(layout.origin.y, s.y, 1e-9)
  })

  test("three rings of the full number of segments; half of each faces the camera", () => {
    const layout = rotateLayout(oblique.view, oblique.viewProjection, vec3(0, 0, 0), W, H)!
    assert.deepEqual(layout.rings.map((r) => r.axis), ["x", "y", "z"])
    for (const ring of layout.rings) {
      assert.equal(ring.segments.length, RingSegments)
      const fronts = ring.segments.filter((s) => s.front).length
      assert.equal(fronts, RingSegments / 2, ring.axis)
    }
  })

  test("front is decided by the half of the ring on the camera's side of the pivot", () => {
    // Camera on +Z: the x ring (in the YZ plane) has its +Z half in front
    const layout = rotateLayout(front.view, front.viewProjection, vec3(0, 0, 0), W, H)!
    const x = layout.rings.find((r) => r.axis === "x")!
    // The x ring's angle runs from +Y toward +Z: the segment about angle pi/2 is at +Z (front), about 3 pi/2 at -Z (back)
    assert.equal(x.segments[RingSegments / 4].front, true)
    assert.equal(x.segments[(3 * RingSegments) / 4].front, false)
  })

  test("nothing when the origin is behind the camera", () => {
    assert.equal(rotateLayout(front.view, front.viewProjection, vec3(0, 0, 20), W, H), null)
  })
})

describe("hit testing the rings", () => {
  const layout = rotateLayout(front.view, front.viewProjection, vec3(0, 0, 0), W, H)!
  const r = layout.radiusWorld

  test("a point on a ring hits it, within the pick distance and not beyond", () => {
    const onZ = screenOf(front.viewProjection, ringPoint("z", vec3(0, 0, 0), r, Math.PI / 4))
    assert.equal(hitTestRotate(layout, onZ), "z")
    // Outward from the ring along the radius
    const dir = { x: Math.SQRT1_2, y: -Math.SQRT1_2 }
    assert.equal(hitTestRotate(layout, { x: onZ.x + dir.x * 6, y: onZ.y + dir.y * 6 }), "z", "6 px off")
    assert.equal(hitTestRotate(layout, { x: onZ.x + dir.x * 14, y: onZ.y + dir.y * 14 }), null, "14 px off")
    // The tolerance scales with the pixel ratio
    assert.equal(hitTestRotate(layout, { x: onZ.x + dir.x * 14, y: onZ.y + dir.y * 14 }, 2), "z")
  })

  test("the middle of a ring and far outside it hit nothing", () => {
    assert.equal(hitTestRotate(layout, { x: layout.origin.x + 30, y: layout.origin.y - 30 }), null)
    assert.equal(hitTestRotate(layout, { x: 5, y: 5 }), null)
  })

  test("only the half that faces the camera can be grabbed", () => {
    // A hand-made ring: a front segment on the left, a back segment on the right
    const made: RotateLayout = {
      origin: { x: 100, y: 100 },
      worldLength: 1,
      radiusWorld: 1,
      radiusPixels: 50,
      rings: [
        {
          axis: "x",
          segments: [
            { from: { x: 50, y: 50 }, to: { x: 50, y: 150 }, front: true },
            { from: { x: 150, y: 50 }, to: { x: 150, y: 150 }, front: false },
          ],
        },
      ],
    }
    assert.equal(hitTestRotate(made, { x: 52, y: 100 }), "x")
    assert.equal(hitTestRotate(made, { x: 148, y: 100 }), null)
  })

  test("where two rings cross, the nearer wins", () => {
    const made: RotateLayout = {
      origin: { x: 100, y: 100 },
      worldLength: 1,
      radiusWorld: 1,
      radiusPixels: 50,
      rings: [
        { axis: "x", segments: [{ from: { x: 0, y: 100 }, to: { x: 200, y: 100 }, front: true }] },
        { axis: "y", segments: [{ from: { x: 100, y: 0 }, to: { x: 100, y: 200 }, front: true }] },
      ],
    }
    // Nearer the horizontal ring's line, or the vertical one's
    assert.equal(hitTestRotate(made, { x: 130, y: 103 }), "x")
    assert.equal(hitTestRotate(made, { x: 103, y: 130 }), "y")
    // At the crossing: 1 px from the horizontal line, 2 px from the vertical one
    assert.equal(hitTestRotate(made, { x: 102, y: 101 }), "x")
    assert.equal(hitTestRotate(made, { x: 101, y: 102 }), "y")
  })

  test("the tangent at a pixel is the direction of increasing angle, unit length", () => {
    // z ring facing the camera, at angle 0 (the +X side): increasing angle goes toward +Y, which is up the screen
    const at0 = screenOf(front.viewProjection, ringPoint("z", vec3(0, 0, 0), r, 0))
    const t = ringTangentAt(layout, "z", at0)!
    near(Math.hypot(t.x, t.y), 1, 1e-9)
    assert.ok(t.y < -0.99, `up the screen: ${t.y}`)
    assert.equal(ringTangentAt({ ...layout, rings: [{ axis: "z", segments: [] }] }, "z", at0), null)
  })
})

// ==================== The angle of a drag ====================

describe("the angle of a drag", () => {
  const origin = vec3(0, 0, 0)

  for (const axis of ["x", "y", "z"] as Axis[]) {
    test(`about ${axis}, in the ring's plane the pointer's turn is the angle, positive by the right-hand rule`, () => {
      const layout = rotateLayout(oblique.view, oblique.viewProjection, origin, W, H)!
      const r = layout.radiusWorld
      const start = screenOf(oblique.viewProjection, ringPoint(axis, origin, r, 0.3))
      const drag = RotateDrag.begin(axis, layout, origin, oblique.viewProjection, start, W, H)!
      assert.equal(drag.mode, "plane")
      near(drag.angleAt(start)!, 0, 1e-9, "at the start")
      for (const turn of [0.5, 1, Math.PI / 2, 2.5]) {
        near(drag.angleAt(screenOf(oblique.viewProjection, ringPoint(axis, origin, r, 0.3 + turn)))!, turn, 1e-6, `+${turn}`)
      }
      // Back down in steps (a single jump of more than half a turn is ambiguous: it is taken as the short way round)
      for (const back of [2.0, 1.0, 0, -0.8]) {
        near(drag.angleAt(screenOf(oblique.viewProjection, ringPoint(axis, origin, r, 0.3 + back)))!, back, 1e-6, `back to ${back}`)
      }
    })
  }

  test("the total goes past half a turn and stays continuous (a full turn is 2 pi, two are 4 pi), and wraps back down", () => {
    const layout = rotateLayout(oblique.view, oblique.viewProjection, origin, W, H)!
    const r = layout.radiusWorld
    const start = screenOf(oblique.viewProjection, ringPoint("y", origin, r, 0))
    const drag = RotateDrag.begin("y", layout, origin, oblique.viewProjection, start, W, H)!
    let last = 0
    for (let step = 1; step <= 80; step++) {
      const angle = (step * Math.PI * 4) / 80
      const got = drag.angleAt(screenOf(oblique.viewProjection, ringPoint("y", origin, r, angle)))!
      near(got, angle, 1e-5, `step ${step}`)
      assert.ok(got > last)
      last = got
    }
    near(last, 4 * Math.PI, 1e-5)
    for (let step = 79; step >= 0; step--) {
      const angle = (step * Math.PI * 4) / 80
      near(drag.angleAt(screenOf(oblique.viewProjection, ringPoint("y", origin, r, angle)))!, angle, 1e-5, `back ${step}`)
    }
  })

  test("a ring edge-on to the pointer's ray is followed along the on-screen tangent, and that is decided when the drag begins", () => {
    // From the front the x ring (the YZ plane) is edge-on
    const layout = rotateLayout(front.view, front.viewProjection, origin, W, H)!
    const centreFront = screenOf(front.viewProjection, ringPoint("x", origin, layout.radiusWorld, Math.PI / 2))
    const drag = RotateDrag.begin("x", layout, origin, front.viewProjection, centreFront, W, H)!
    assert.equal(drag.mode, "tangent")
    // Down the screen by a ring radius is one radian, positive: the front of the x ring turns toward -Y
    near(drag.angleAt({ x: centreFront.x, y: centreFront.y + layout.radiusPixels })!, 1, 1e-6, "down")
    near(drag.angleAt({ x: centreFront.x, y: centreFront.y - layout.radiusPixels * 2 })!, -2, 1e-6, "up")
    // Sideways is across the tangent: no turn
    near(drag.angleAt({ x: centreFront.x + 200, y: centreFront.y })!, 0, 1e-6, "across")
    // Stable at a grazing angle: tiny pointer moves are tiny turns, never a jump
    let last = drag.angleAt(centreFront)!
    for (let dy = 1; dy <= 40; dy++) {
      const a = drag.angleAt({ x: centreFront.x, y: centreFront.y + dy })!
      assert.ok(Math.abs(a - last) < 0.05, `step ${dy}: ${a - last}`)
      last = a
    }
  })

  test("a plane that is only a little off edge-on is still followed in the plane; one more edge-on than the limit is not", () => {
    const gentle = camera(vec3(0, 6, 10)) // the z ring's plane faces it well; the x ring's is close to edge-on but not past it
    const layout = rotateLayout(gentle.view, gentle.viewProjection, origin, W, H)!
    const p = screenOf(gentle.viewProjection, ringPoint("z", origin, layout.radiusWorld, 0.4))
    assert.equal(RotateDrag.begin("z", layout, origin, gentle.viewProjection, p, W, H)!.mode, "plane")
    const grazing = camera(vec3(1, 0.5, 10))
    const gl = rotateLayout(grazing.view, grazing.viewProjection, origin, W, H)!
    const q = screenOf(grazing.viewProjection, ringPoint("x", origin, gl.radiusWorld, Math.PI / 2))
    assert.equal(RotateDrag.begin("x", gl, origin, grazing.viewProjection, q, W, H)!.mode, "tangent")
  })

  test("a pointer ray that goes edge-on to the plane mid-drag keeps the last angle (null)", () => {
    const layout = rotateLayout(oblique.view, oblique.viewProjection, origin, W, H)!
    const start = screenOf(oblique.viewProjection, ringPoint("z", origin, layout.radiusWorld, 0))
    const drag = RotateDrag.begin("z", layout, origin, oblique.viewProjection, start, W, H)!
    assert.equal(drag.mode, "plane")
    // A pixel far below the screen: its ray points away from the z plane (it would meet it behind the camera)
    assert.equal(drag.angleAt({ x: 400, y: 4000 }), null)
    near(drag.angleAt(start)!, 0, 1e-9, "the drag is still alive")
  })

  test("nothing to follow: the ring is edge-on and has no front segment on screen", () => {
    const layout = rotateLayout(front.view, front.viewProjection, origin, W, H)!
    const empty: RotateLayout = { ...layout, rings: layout.rings.map((r) => ({ ...r, segments: [] })) }
    assert.equal(RotateDrag.begin("x", empty, origin, front.viewProjection, layout.origin, W, H), null)
  })

  test("the format shows degrees with a sign", () => {
    assert.equal(formatAngle(Math.PI / 4), "+45.0 deg")
    assert.equal(formatAngle(-Math.PI / 2), "-90.0 deg")
    assert.equal(formatAngle(0), "0.0 deg")
  })
})

// ==================== Applying a rotation to objects ====================

/** An object's world transform by the engine's Transform::Combine: position = pPos + pRot (pScale lPos), rotation = pRot lRot, scale = pScale lScale */
function engineWorld(parent: { position: Vec3; rotation: Quat; scale: Vec3 }, local: { position: Vec3; rotation: Quat; scale: Vec3 }) {
  const scaled = vec3(parent.scale.x * local.position.x, parent.scale.y * local.position.y, parent.scale.z * local.position.z)
  const rotated = quatRotate(parent.rotation, scaled)
  return {
    position: vec3(parent.position.x + rotated.x, parent.position.y + rotated.y, parent.position.z + rotated.z),
    rotation: quatMultiply(parent.rotation, local.rotation),
    scale: vec3(parent.scale.x * local.scale.x, parent.scale.y * local.scale.y, parent.scale.z * local.scale.z),
  }
}

interface Spec {
  position: Vec3
  rotation: Quat
  scale: Vec3
}

function targetOf(id: string, parent: Spec | null, local: Spec, withParent = true): GizmoTarget {
  const p: Spec = parent ?? { position: vec3(0, 0, 0), rotation: IdentityQuat, scale: vec3(1, 1, 1) }
  const world = engineWorld(p, local)
  return {
    id,
    name: id,
    localPosition: local.position,
    localRotation: local.rotation,
    localScale: local.scale,
    worldMatrix: mat4Compose(world.position, world.rotation, world.scale),
    ...(withParent ? { parentWorld: mat4Compose(p.position, p.rotation, p.scale) } : {}),
  }
}

const unit: Spec = { position: vec3(0, 0, 0), rotation: IdentityQuat, scale: vec3(1, 1, 1) }

function asMove(r: ReturnType<typeof rotatedTransform>) {
  assert.equal(typeof r, "object", String(r))
  return r as Exclude<typeof r, string>
}

describe("rotating objects", () => {
  test("one root object turns about its own origin: position exactly as it was, world rotation R q", () => {
    const q0 = quatFromAxisAngle(vec3(1, 0, 0), 0.5)
    const t = targetOf("a", null, { position: vec3(1, 2, 3), rotation: q0, scale: vec3(1, 1, 1) })
    const pivot = vec3(1, 2, 3)
    const move = asMove(rotatedTransform(t, 0, pivot, AxisDirections.y, 0.7))
    assert.deepEqual(move.position, t.localPosition, "untouched, not recomputed")
    assert.deepEqual(move.scale, t.localScale)
    sameRotation(move.rotation, quatMultiply(quatFromAxisAngle(vec3(0, 1, 0), 0.7), q0))
    near(move.rotation.x ** 2 + move.rotation.y ** 2 + move.rotation.z ** 2 + move.rotation.w ** 2, 1, 1e-12, "unit")
  })

  test("a selection turns about the shared pivot: positions go round it, rotations compose", () => {
    const pivot = vec3(0, 0, 0)
    const b = targetOf("b", null, { position: vec3(2, 0, 0), rotation: IdentityQuat, scale: vec3(1, 1, 1) })
    const move = asMove(rotatedTransform(b, 1, pivot, AxisDirections.z, Math.PI / 2))
    assert.equal(move.index, 1)
    nearVec(move.position, vec3(0, 2, 0), 1e-9)
    sameRotation(move.rotation, quatFromAxisAngle(vec3(0, 0, 1), Math.PI / 2))
    // A pivot that is not the origin
    const c = targetOf("c", null, { position: vec3(5, 1, 0), rotation: IdentityQuat, scale: vec3(1, 1, 1) })
    nearVec(asMove(rotatedTransform(c, 0, vec3(4, 1, 0), AxisDirections.y, Math.PI)).position, vec3(3, 1, 0), 1e-9)
  })

  test("under a rotated, non-uniformly scaled parent the engine's own composition gives the world rotation R q and position pivot + R (p - pivot)", () => {
    const parent: Spec = {
      position: vec3(3, -1, 2),
      rotation: quatFromAxisAngle(vec3(0.3, 1, -0.4), 1.1),
      scale: vec3(2, 0.5, 3),
    }
    const local: Spec = { position: vec3(1, 2, -1), rotation: quatFromAxisAngle(vec3(1, 0, 0), 0.6), scale: vec3(1.5, 1, 0.7) }
    for (const withParent of [true, false]) {
      const t = targetOf("k", parent, local, withParent)
      const before = engineWorld(parent, local)
      const pivot = vec3(-1, 0.5, 0.25)
      const axis = normalize(vec3(0, 0, 1))
      const angle = 0.83
      const move = asMove(rotatedTransform(t, 0, pivot, axis, angle))
      const after = engineWorld(parent, { position: move.position, rotation: move.rotation, scale: move.scale })
      const R = quatFromAxisAngle(axis, angle)
      // the world rotation is R * before
      sameRotation(after.rotation, quatMultiply(R, before.rotation), `rotation, parentWorld ${withParent}`)
      // and the world position is the old one turned about the pivot
      nearVec(after.position, add3(pivot, quatRotate(R, sub(before.position, pivot))), 1e-9, `position, parentWorld ${withParent}`)
      // scale untouched
      nearVec(after.scale, before.scale, 1e-12)
    }
  })

  test("the parent's rotation is read from its world matrix, or derived from the object's own when it wasn't read", () => {
    const parent: Spec = { position: vec3(1, 1, 1), rotation: quatFromAxisAngle(vec3(0, 1, 0), 0.9), scale: vec3(2, 3, 4) }
    const local: Spec = { position: vec3(0, 1, 0), rotation: quatFromAxisAngle(vec3(0, 0, 1), 0.4), scale: vec3(1, -2, 1) }
    sameRotation(parentRotationOf(targetOf("a", parent, local, true))!, parent.rotation, "from the parent")
    sameRotation(parentRotationOf(targetOf("a", parent, local, false))!, parent.rotation, "derived, a mirrored child")
    // A root: the identity
    sameRotation(parentRotationOf(targetOf("a", null, local, true))!, IdentityQuat)
  })

  test("a mirrored parent (an odd number of negative scales) can't be told from its matrix: the object is refused, with a reason", () => {
    const mirrored: Spec = { position: vec3(0, 0, 0), rotation: IdentityQuat, scale: vec3(-1, 1, 1) }
    const t = targetOf("m", mirrored, unit)
    assert.equal(parentRotationOf(t), null)
    const result = rotatedTransform(t, 0, vec3(0, 0, 0), AxisDirections.y, 0.5)
    assert.equal(typeof result, "string")
    assert.match(result as string, /can't be rotated/)
    // A zero scale in the parent: no rotation either
    assert.equal(parentRotationOf(targetOf("z", { ...mirrored, scale: vec3(0, 1, 1) }, unit)), null)
  })

  test("an object with a zero scale is moved nowhere when it is away from the pivot (it can't be divided by), but turns at the pivot", () => {
    const t = targetOf("z", { position: vec3(0, 0, 0), rotation: IdentityQuat, scale: vec3(0, 1, 1) }, { position: vec3(1, 0, 0), rotation: IdentityQuat, scale: vec3(1, 1, 1) }, false)
    const away = rotatedTransform(t, 0, vec3(5, 5, 5), AxisDirections.z, 0.5)
    assert.equal(typeof away, "string")
    assert.match(away as string, /can't be/)
  })

  test("the new rotation keeps the sign of the old (q and -q are one rotation, nothing flips for no reason)", () => {
    const old = { x: 0, y: 0.6, z: 0, w: -0.8 }
    const t = targetOf("s", null, { position: vec3(0, 0, 0), rotation: old, scale: vec3(1, 1, 1) })
    const move = asMove(rotatedTransform(t, 0, vec3(0, 0, 0), AxisDirections.y, 0.01))
    assert.ok(move.rotation.x * old.x + move.rotation.y * old.y + move.rotation.z * old.z + move.rotation.w * old.w > 0)
  })

  test("a rotation by nothing is the object as it was", () => {
    const parent: Spec = { position: vec3(1, 2, 3), rotation: quatFromAxisAngle(vec3(1, 1, 0), 0.4), scale: vec3(1, 2, 1) }
    const local: Spec = { position: vec3(0, 1, 0), rotation: quatFromAxisAngle(vec3(0, 1, 1), 1.3), scale: vec3(1, 1, 1) }
    const t = targetOf("n", parent, local)
    const move = asMove(rotatedTransform(t, 0, vec3(9, 9, 9), AxisDirections.x, 0))
    sameRotation(move.rotation, local.rotation)
    nearVec(move.position, local.position, 1e-9)
  })
})

const add3 = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z)

// ==================== The drag, against a fake engine and fake edit groups ====================

function fakes() {
  const log: string[] = []
  const sets: Array<{ id: string; position: Vec3; rotation: Quat; scale: Vec3 }> = []
  const errors: string[] = []
  let moved = 0
  const refuse = new Set<string>()
  const deps: GizmoDragDeps = {
    engine: {
      setLocalTransform: async (id, position, rotation, scale) => {
        if (refuse.has(id)) throw new Error(`Entity not found: ${id}`)
        log.push(`set ${id}`)
        sets.push({ id, position, rotation, scale })
      },
    },
    groups: {
      begin: async (label) => {
        log.push(`begin ${label}`)
        return 1
      },
      end: async () => {
        log.push("end")
      },
    },
    onError: (what, e) => errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`),
    onMoved: () => void moved++,
  }
  return { deps, log, sets, errors, moved: () => moved, refuse }
}

function rotateRig(targets: GizmoTarget[], axis: Axis = "z") {
  const origin = vec3(0, 0, 0)
  const layout = rotateLayout(oblique.view, oblique.viewProjection, origin, W, H)!
  const start = screenOf(oblique.viewProjection, ringPoint(axis, origin, layout.radiusWorld, 0))
  const source = RotateDrag.begin(axis, layout, origin, oblique.viewProjection, start, W, H)!
  const f = fakes()
  const drag = new RotateGizmoDrag(f.deps, targets, source, origin)
  const at = (angle: number): Pixel => screenOf(oblique.viewProjection, ringPoint(axis, origin, layout.radiusWorld, angle))
  return { ...f, drag, at, start }
}

describe("a rotate drag", () => {
  const cube = targetOf("a", null, { position: vec3(0, 0, 0), rotation: IdentityQuat, scale: vec3(1, 2, 3) })

  test("one group around the whole drag: begin, the transforms, end; the label names the object", async () => {
    const r = rotateRig([cube])
    near(r.drag.update(r.at(0.4))!, 0.4, 1e-6)
    near(r.drag.angle, 0.4, 1e-6)
    r.drag.update(r.at(0.9))
    await r.drag.end()
    assert.equal(r.log[0], "begin Rotate a")
    assert.equal(r.log[r.log.length - 1], "end")
    assert.equal(r.log.filter((l) => l.startsWith("begin")).length, 1)
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    const last = r.sets[r.sets.length - 1]
    sameRotation(last.rotation, quatFromAxisAngle(vec3(0, 0, 1), 0.9), "the last angle won")
    assert.deepEqual(last.scale, cube.localScale, "scale as it was")
    assert.equal(r.moved() > 0, true, "the frame was asked for")
    assert.deepEqual(r.errors, [])
  })

  test("releasing without a turn changes nothing but still ends the group", async () => {
    const r = rotateRig([cube])
    await r.drag.end()
    assert.deepEqual(r.log, ["begin Rotate a", "end"])
    assert.equal(r.drag.moved, false)
  })

  test("a selection is one group named for its size, every object turned about the shared pivot", async () => {
    const b = targetOf("b", null, { position: vec3(2, 0, 0), rotation: IdentityQuat, scale: vec3(1, 1, 1) })
    const r = rotateRig([cube, b])
    r.drag.update(r.at(Math.PI / 2))
    await r.drag.end()
    assert.equal(r.log[0], "begin Rotate 2 objects")
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    const forB = [...r.sets].reverse().find((s) => s.id === "b")!
    nearVec(forB.position, vec3(0, 2, 0), 1e-6)
    sameRotation(forB.rotation, quatFromAxisAngle(vec3(0, 0, 1), Math.PI / 2))
  })

  test("Escape puts every changed object back exactly and ends the group", async () => {
    const b = targetOf("b", null, { position: vec3(2, 0, 0), rotation: quatFromAxisAngle(vec3(1, 0, 0), 0.3), scale: vec3(1, 1, 1) })
    const r = rotateRig([cube, b])
    r.drag.update(r.at(1))
    await r.drag.cancel()
    assert.equal(r.log[r.log.length - 1], "end")
    for (const t of [cube, b]) {
      const last = [...r.sets].reverse().find((s) => s.id === t.id)!
      assert.deepEqual(last.position, t.localPosition)
      assert.deepEqual(last.rotation, t.localRotation)
      assert.deepEqual(last.scale, t.localScale)
    }
    assert.equal(r.drag.angle, 0)
    assert.equal(r.log.filter((l) => l.startsWith("begin")).length, 1)
  })

  test("Ctrl snaps the angle to 15 degrees", async () => {
    const r = rotateRig([cube])
    r.drag.update(r.at(0.3), true)
    near(r.drag.angle, RotateSnapRadians * 1, 1e-9, "0.3 rad is 17 degrees: 15")
    r.drag.update(r.at(0.5), true)
    near(r.drag.angle, RotateSnapRadians * 2, 1e-9, "0.5 rad is 28.6 degrees: 30")
    r.drag.update(r.at(0.5), false)
    near(r.drag.angle, 0.5, 1e-6, "released: free again")
    await r.drag.end()
  })

  test("an object the host does not have is left out of the rest of the drag, once reported; the others go on", async () => {
    const b = targetOf("b", null, { position: vec3(2, 0, 0), rotation: IdentityQuat, scale: vec3(1, 1, 1) })
    const r = rotateRig([cube, b])
    r.refuse.add("b")
    r.drag.update(r.at(0.3))
    r.drag.update(r.at(0.6))
    await r.drag.end()
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /Failed to rotate the object/)
    assert.ok(r.sets.every((s) => s.id === "a"))
  })

  test("an object that can't be rotated (a mirrored parent) is reported once and skipped; the rest still turn", async () => {
    const mirrored = targetOf("m", { position: vec3(0, 0, 0), rotation: IdentityQuat, scale: vec3(-1, 1, 1) }, unit)
    const r = rotateRig([cube, mirrored])
    r.drag.update(r.at(0.3))
    r.drag.update(r.at(0.6))
    await r.drag.end()
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /m can't be rotated/)
    assert.ok(r.sets.every((s) => s.id === "a"))
  })

  test("when nothing can be rotated the update says so (null) and nothing is sent", async () => {
    const mirrored = targetOf("m", { position: vec3(0, 0, 0), rotation: IdentityQuat, scale: vec3(-1, 1, 1) }, unit)
    const r = rotateRig([mirrored])
    assert.equal(r.drag.update(r.at(0.5)), null)
    await r.drag.end()
    assert.equal(r.sets.length, 0)
    assert.equal(r.drag.moved, false)
  })

  test("an abandoned drag sends nothing more, says nothing, and ends the group", async () => {
    const r = rotateRig([cube])
    r.drag.update(r.at(0.5))
    await r.drag.abandon()
    const sent = r.sets.length
    r.drag.update(r.at(0.9))
    await r.drag.end()
    assert.equal(r.sets.length, sent)
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    assert.deepEqual(r.errors, [])
  })

  test("after the end, updates do nothing", async () => {
    const r = rotateRig([cube])
    await r.drag.end()
    assert.equal(r.drag.update(r.at(0.5)), null)
    assert.equal(r.sets.length, 0)
  })
})

test("a ring's points lie in its plane, at the radius, going the positive way round", () => {
  for (const axis of ["x", "y", "z"] as Axis[]) {
    const o = vec3(1, 2, 3)
    for (const angle of [0, 1, 2, 4]) {
      const p = ringPoint(axis, o, 2, angle)
      near(length(sub(p, o)), 2, 1e-9)
      near(dot(sub(p, o), AxisDirections[axis]), 0, 1e-9)
    }
    // The next point is a positive turn about the axis
    const a = sub(ringPoint(axis, o, 1, 0.2), o)
    const b = sub(ringPoint(axis, o, 1, 0.3), o)
    assert.ok(dot(cross(a, b), AxisDirections[axis]) > 0)
  }
})
