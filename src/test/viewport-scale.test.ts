import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { Mat4, Quat, Vec3 } from "../protocol/protocol.generated"
import { GizmoDragDeps, GizmoTarget } from "../renderer/viewport-drag"
import {
  MaxScaleRatio,
  MinScaleRatio,
  ScaleDrag,
  ScaleGizmoDrag,
  ScaleLayout,
  ScaleSnapStep,
  formatRatio,
  hitTestScale,
  scaleLayout,
  scaledTransform,
  snapRatio,
  worldAxesOf,
} from "../renderer/viewport-scale"
import { AxisDirections, GizmoSizePixels } from "../renderer/viewport-gizmo"
import {
  IdentityQuat,
  Pixel,
  add,
  cross,
  mat4Compose,
  mat4Multiply,
  normalize,
  projectionMatrix,
  quatFromAxes,
  quatFromAxisAngle,
  quatMultiply,
  quatRotate,
  scale,
  sub,
  vec3,
  viewMatrix,
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

const settings = { fovY: 60, orthographic: false, orthoSize: 5, nearPlane: 0.1, farPlane: 1000 }

function camera(position: Vec3, target: Vec3 = vec3(0, 0, 0)) {
  const z = normalize(sub(position, target))
  const x = normalize(cross(vec3(0, 1, 0), z))
  const y = cross(z, x)
  const view = viewMatrix(position, quatFromAxes(x, y, z)!)
  return { view, viewProjection: mat4Multiply(projectionMatrix(settings, W / H), view) }
}

const front = camera(vec3(0, 0, 10))
const oblique = camera(vec3(6, 7, 8))
const world = { x: AxisDirections.x, y: AxisDirections.y, z: AxisDirections.z }

const screenOf = (vp: Mat4, p: Vec3): Pixel => {
  const s = worldToScreen(vp, p, W, H)
  assert.ok(s, "on screen")
  return { x: s.x, y: s.y }
}

interface Spec {
  position: Vec3
  rotation: Quat
  scale: Vec3
}

const unit: Spec = { position: vec3(0, 0, 0), rotation: IdentityQuat, scale: vec3(1, 1, 1) }

function targetOf(id: string, parent: Spec | null, local: Spec): GizmoTarget {
  const p = parent ?? unit
  const rotated = quatRotate(p.rotation, vec3(p.scale.x * local.position.x, p.scale.y * local.position.y, p.scale.z * local.position.z))
  const worldPos = add(p.position, rotated)
  const worldRot = quatMultiply(p.rotation, local.rotation)
  const worldScale = vec3(p.scale.x * local.scale.x, p.scale.y * local.scale.y, p.scale.z * local.scale.z)
  return {
    id,
    name: id,
    localPosition: local.position,
    localRotation: local.rotation,
    localScale: local.scale,
    worldMatrix: mat4Compose(worldPos, worldRot, worldScale),
    parentWorld: mat4Compose(p.position, p.rotation, p.scale),
  }
}

// ==================== Layout and hit testing ====================

describe("the scale gizmo's layout", () => {
  test("the handles follow the primary object's own axes: its world matrix's columns, scale stripped", () => {
    const q = quatFromAxisAngle(vec3(0, 1, 0), Math.PI / 2)
    const m = mat4Compose(vec3(1, 2, 3), q, vec3(2, 3, 4))
    const axes = worldAxesOf(m)
    nearVec(axes.x, vec3(0, 0, -1), 1e-9)
    nearVec(axes.y, vec3(0, 1, 0), 1e-9)
    nearVec(axes.z, vec3(1, 0, 0), 1e-9)
    // A column with no length falls back to the world axis (a zero scale)
    nearVec(worldAxesOf(mat4Compose(vec3(0, 0, 0), q, vec3(0, 1, 1))).x, AxisDirections.x)
  })

  test("a constant size on screen at any distance: the handle ends are the gizmo's size from the centre", () => {
    for (const distance of [3, 10, 200]) {
      const cam = camera(vec3(0, 0, distance))
      const layout = scaleLayout(cam.view, cam.viewProjection, vec3(0, 0, 0), world, W, H)!
      const x = layout.handles.find((h) => h.axis === "x")!
      near(Math.hypot(x.to.x - x.from.x, x.to.y - x.from.y), GizmoSizePixels, 1.5, `distance ${distance}`)
    }
    const cam = camera(vec3(0, 0, 10))
    const doubled = scaleLayout(cam.view, cam.viewProjection, vec3(0, 0, 0), world, W, H, 2)!
    const x = doubled.handles.find((h) => h.axis === "x")!
    near(Math.hypot(x.to.x - x.from.x, x.to.y - x.from.y), GizmoSizePixels * 2, 3)
  })

  test("a handle that points at the camera is left out; nothing when the origin is behind it", () => {
    const layout = scaleLayout(front.view, front.viewProjection, vec3(0, 0, 0), world, W, H)!
    assert.deepEqual(layout.handles.map((h) => h.axis), ["x", "y"], "z points at the camera")
    assert.equal(scaleLayout(front.view, front.viewProjection, vec3(0, 0, 20), world, W, H), null)
  })

  test("the handles are in the primary's axes, not the world's", () => {
    const q = quatFromAxisAngle(vec3(0, 0, 1), Math.PI / 2)
    const axes = worldAxesOf(mat4Compose(vec3(0, 0, 0), q, vec3(1, 1, 1)))
    const layout = scaleLayout(front.view, front.viewProjection, vec3(0, 0, 0), axes, W, H)!
    const x = layout.handles.find((h) => h.axis === "x")!
    // The object's x is the world's y: up the screen
    assert.ok(x.to.y < x.from.y - 50, "up")
    near(x.to.x, x.from.x, 1e-6)
  })
})

describe("hit testing the scale gizmo", () => {
  const layout = scaleLayout(front.view, front.viewProjection, vec3(0, 0, 0), world, W, H)!
  const x = layout.handles.find((h) => h.axis === "x")!

  test("the centre takes the press first (a square of its own size), then the nearest axis handle", () => {
    assert.equal(hitTestScale(layout, { x: layout.origin.x + 5, y: layout.origin.y - 5 }), "uniform")
    assert.equal(hitTestScale(layout, { x: layout.origin.x + 8, y: layout.origin.y + 8 }), "uniform")
    // Along the x handle, past the centre square
    assert.equal(hitTestScale(layout, { x: (x.from.x + x.to.x) / 2, y: x.from.y + 3 }), "x")
    assert.equal(hitTestScale(layout, x.to), "x", "the cube at the end")
    assert.equal(hitTestScale(layout, { x: x.to.x + 5, y: x.to.y + 5 }), "x", "within the pick distance of the end")
  })

  test("away from every handle hits nothing; the pick distance scales with the pixel ratio", () => {
    assert.equal(hitTestScale(layout, { x: 5, y: 5 }), null)
    const off = { x: (x.from.x + x.to.x) / 2, y: x.from.y + 14 }
    assert.equal(hitTestScale(layout, off), null)
    assert.equal(hitTestScale(layout, off, 2), "x")
    // The centre's reach scales too
    assert.equal(hitTestScale(layout, { x: layout.origin.x + 15, y: layout.origin.y }, 2), "uniform")
  })

  test("the nearest handle wins where two are close", () => {
    const made: ScaleLayout = {
      origin: { x: 0, y: 0 },
      worldLength: 1,
      directions: world,
      handles: [
        { axis: "x", from: { x: 100, y: 100 }, to: { x: 200, y: 100 } },
        { axis: "y", from: { x: 100, y: 100 }, to: { x: 200, y: 108 } },
      ],
    }
    assert.equal(hitTestScale(made, { x: 150, y: 101 }), "x")
    assert.equal(hitTestScale(made, { x: 150, y: 108 }), "y")
  })
})

// ==================== The ratio of a drag ====================

describe("the ratio of a drag", () => {
  const origin = vec3(0, 0, 0)
  const layout = scaleLayout(front.view, front.viewProjection, origin, world, W, H)!
  const L = layout.worldLength
  const at = (t: number): Pixel => screenOf(front.viewProjection, vec3(t, 0, 0))

  test("an axis drag's ratio is where the pointer meets the axis now over where it began: 1 at the start, double at twice the distance, half at half", () => {
    const drag = ScaleDrag.begin("x", layout, origin, front.viewProjection, at(0.8 * L), W, H)!
    near(drag.ratioAt(at(0.8 * L))!, 1, 1e-9, "start")
    near(drag.ratioAt(at(1.6 * L))!, 2, 1e-6, "twice")
    near(drag.ratioAt(at(0.4 * L))!, 0.5, 1e-6, "half")
    near(drag.ratioAt(at(2.4 * L))!, 3, 1e-6, "three times")
  })

  test("dragging through the pivot stops at a small positive ratio: it never flips the sign or reaches zero", () => {
    const drag = ScaleDrag.begin("x", layout, origin, front.viewProjection, at(0.8 * L), W, H)!
    near(drag.ratioAt(at(0))!, MinScaleRatio, 1e-12, "at the pivot")
    near(drag.ratioAt(at(-1 * L))!, MinScaleRatio, 1e-12, "through it")
    near(drag.ratioAt(at(-5 * L))!, MinScaleRatio, 1e-12, "far through it")
    assert.ok(MinScaleRatio > 0)
  })

  test("a grab near the pivot is measured over a minimum reference, so it doesn't jump: 0.1 handle lengths begins at 1", () => {
    const drag = ScaleDrag.begin("x", layout, origin, front.viewProjection, at(0.1 * L), W, H)!
    near(drag.ratioAt(at(0.1 * L))!, 1, 1e-9, "start")
    // 0.3 handle lengths further is a full reference: double
    near(drag.ratioAt(at(0.4 * L))!, 2, 1e-6)
    // A grab on the negative side of the pivot likewise
    const behind = ScaleDrag.begin("x", layout, origin, front.viewProjection, at(-0.2 * L), W, H)!
    near(behind.ratioAt(at(-0.2 * L))!, 1, 1e-9)
    near(behind.ratioAt(at(0.1 * L))!, 2, 1e-6)
  })

  test("the largest ratio is bounded", () => {
    const drag = ScaleDrag.begin("x", layout, origin, front.viewProjection, at(0.8 * L), W, H)!
    const got = drag.ratioAt({ x: 100000, y: layout.origin.y })
    assert.ok(got === null || got <= MaxScaleRatio)
  })

  test("a ray along the axis can't begin a drag; a ray that meets the axis behind the camera is not followed", () => {
    // z points at the camera: its handle is not even drawn, and a ray along it has no nearest point
    assert.equal(ScaleDrag.begin("z", layout, origin, front.viewProjection, layout.origin, W, H), null)
    const oblq = scaleLayout(oblique.view, oblique.viewProjection, origin, world, W, H)!
    const drag = ScaleDrag.begin("y", oblq, origin, oblique.viewProjection, screenOf(oblique.viewProjection, vec3(0, oblq.worldLength, 0)), W, H)!
    // A pixel far to the side and down meets the y axis's line behind the eye: kept as it was (null)
    assert.equal(drag.ratioAt({ x: -90000, y: 90000 }), null)
  })

  test("the centre handle's ratio is the pointer's distance from the pivot on screen over where it began, over at least half the gizmo's size", () => {
    const c = layout.origin
    const drag = ScaleDrag.begin("uniform", layout, origin, front.viewProjection, { x: c.x + 5, y: c.y }, W, H)!
    near(drag.ratioAt({ x: c.x + 5, y: c.y })!, 1, 1e-9, "start")
    // A grab 5 px away is measured over 48 px (half the gizmo's size): 48 px further doubles it
    near(drag.ratioAt({ x: c.x + 53, y: c.y })!, 2, 1e-9)
    near(drag.ratioAt({ x: c.x, y: c.y - 53 })!, 2, 1e-9, "any direction")
    near(drag.ratioAt(c)!, 1 - 5 / 48, 1e-9)
    // A grab farther out is measured over where it began
    const far = ScaleDrag.begin("uniform", layout, origin, front.viewProjection, { x: c.x + 100, y: c.y }, W, H)!
    near(far.ratioAt({ x: c.x + 200, y: c.y })!, 2, 1e-9)
    near(far.ratioAt({ x: c.x, y: c.y })!, MinScaleRatio, 1e-12, "clamped")
  })

  test("snapping rounds the ratio to the step and never to zero", () => {
    assert.equal(ScaleSnapStep, 0.1)
    near(snapRatio(1.04), 1.0, 1e-12)
    near(snapRatio(1.06), 1.1, 1e-12)
    near(snapRatio(0.02), 0.1, 1e-12)
    near(snapRatio(0.001), 0.1, 1e-12)
    near(snapRatio(2.34), 2.3, 1e-12)
  })

  test("the format shows the ratio", () => {
    assert.equal(formatRatio(1.254), "x1.25")
    assert.equal(formatRatio(0.5), "x0.50")
  })
})

// ==================== Applying a ratio to objects ====================

const asMove = (r: ReturnType<typeof scaledTransform>) => {
  assert.equal(typeof r, "object", String(r))
  return r as Exclude<typeof r, string>
}

describe("scaling objects", () => {
  test("an axis handle multiplies the local scale along that axis only; position and rotation are as they were", () => {
    const q = quatFromAxisAngle(vec3(1, 1, 0), 0.4)
    const t = targetOf("a", null, { position: vec3(1, 2, 3), rotation: q, scale: vec3(2, 1, 4) })
    const move = asMove(scaledTransform(t, 3, vec3(1, 2, 3), "y", 1.5))
    assert.equal(move.index, 3)
    assert.deepEqual(move.scale, vec3(2, 1.5, 4))
    assert.deepEqual(move.position, t.localPosition)
    assert.deepEqual(move.rotation, q)
    assert.deepEqual(asMove(scaledTransform(t, 0, vec3(0, 0, 0), "x", 0.5)).scale, vec3(1, 1, 4), "the pivot doesn't matter for an axis")
    assert.deepEqual(asMove(scaledTransform(t, 0, vec3(0, 0, 0), "z", 2)).scale, vec3(2, 1, 8))
  })

  test("a mirrored object stays mirrored, and a zero scale stays zero: the scale is multiplied, never set", () => {
    const t = targetOf("m", null, { position: vec3(0, 0, 0), rotation: IdentityQuat, scale: vec3(-2, 0, 1) })
    assert.deepEqual(asMove(scaledTransform(t, 0, vec3(0, 0, 0), "x", MinScaleRatio)).scale.x, -2 * MinScaleRatio)
    assert.equal(asMove(scaledTransform(t, 0, vec3(0, 0, 0), "x", 3)).scale.x, -6)
    assert.equal(asMove(scaledTransform(t, 0, vec3(0, 0, 0), "y", 3)).scale.y, 0)
    // the sign never changes for any ratio the drag can give
    for (const ratio of [MinScaleRatio, 0.5, 1, 7, MaxScaleRatio]) {
      assert.ok(asMove(scaledTransform(t, 0, vec3(0, 0, 0), "x", ratio)).scale.x < 0)
    }
  })

  test("the centre handle multiplies all three; an object at the pivot keeps its position exactly, one away has its offset scaled", () => {
    const pivot = vec3(1, 1, 1)
    const at = targetOf("p", null, { position: vec3(1, 1, 1), rotation: IdentityQuat, scale: vec3(1, 2, 3) })
    const a = asMove(scaledTransform(at, 0, pivot, "uniform", 2))
    assert.deepEqual(a.scale, vec3(2, 4, 6))
    assert.deepEqual(a.position, at.localPosition)
    const away = targetOf("q", null, { position: vec3(4, 1, -2), rotation: IdentityQuat, scale: vec3(1, 1, 1) })
    const b = asMove(scaledTransform(away, 0, pivot, "uniform", 2))
    nearVec(b.position, vec3(7, 1, -5), 1e-9, "pivot + 2 (p - pivot)")
    assert.deepEqual(b.scale, vec3(2, 2, 2))
  })

  test("the offset is scaled in the world, through the object's parent the way the engine composes", () => {
    const parent: Spec = { position: vec3(1, 0, 0), rotation: quatFromAxisAngle(vec3(0, 1, 0), 0.8), scale: vec3(2, 3, 0.5) }
    const local: Spec = { position: vec3(1, 2, 1), rotation: IdentityQuat, scale: vec3(1, 1, 1) }
    const t = targetOf("k", parent, local)
    const pivot = vec3(-1, 0, 2)
    const ratio = 1.7
    const move = asMove(scaledTransform(t, 0, pivot, "uniform", ratio))
    // the engine's world position for the new local position
    const scaledLocal = vec3(parent.scale.x * move.position.x, parent.scale.y * move.position.y, parent.scale.z * move.position.z)
    const worldAfter = add(parent.position, quatRotate(parent.rotation, scaledLocal))
    const m = t.worldMatrix
    const before = vec3(m[12], m[13], m[14])
    nearVec(worldAfter, add(pivot, scale(sub(before, pivot), ratio)), 1e-9)
  })

  test("a zero scale in the chain stops the centre handle's move of an object away from the pivot, with a reason", () => {
    const t = targetOf("z", { position: vec3(0, 0, 0), rotation: IdentityQuat, scale: vec3(0, 1, 1) }, { position: vec3(1, 0, 0), rotation: IdentityQuat, scale: vec3(1, 1, 1) })
    const result = scaledTransform(t, 0, vec3(5, 5, 5), "uniform", 2)
    assert.equal(typeof result, "string")
    // but its scale along an axis can still be changed
    assert.equal(typeof scaledTransform(t, 0, vec3(5, 5, 5), "x", 2), "object")
  })
})

// ==================== The drag, against a fake engine and fake edit groups ====================

function fakes() {
  const log: string[] = []
  const sets: Array<{ id: string; position: Vec3; rotation: Quat; scale: Vec3 }> = []
  const errors: string[] = []
  const deps: GizmoDragDeps = {
    engine: {
      setLocalTransform: async (id, position, rotation, scale) => {
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
  }
  return { deps, log, sets, errors }
}

function scaleRig(targets: GizmoTarget[], handle: "x" | "uniform" = "x") {
  const origin = vec3(0, 0, 0)
  const layout = scaleLayout(front.view, front.viewProjection, origin, world, W, H)!
  const at = (t: number): Pixel => screenOf(front.viewProjection, vec3(t, 0, 0))
  const L = layout.worldLength
  const start = handle === "x" ? at(0.8 * L) : { x: layout.origin.x + 5, y: layout.origin.y }
  const source = ScaleDrag.begin(handle, layout, origin, front.viewProjection, start, W, H)!
  const f = fakes()
  return { ...f, drag: new ScaleGizmoDrag(f.deps, targets, source, origin), at, L, layout }
}

describe("a scale drag", () => {
  const cube = targetOf("a", null, { position: vec3(0, 0, 0), rotation: IdentityQuat, scale: vec3(1, 2, 3) })

  test("one group around the whole drag, labelled for the object; the last ratio wins", async () => {
    const r = scaleRig([cube])
    near(r.drag.update(r.at(1.2 * r.L))!, 1.5, 1e-6)
    r.drag.update(r.at(1.6 * r.L))
    await r.drag.end()
    assert.equal(r.log[0], "begin Scale a")
    assert.equal(r.log[r.log.length - 1], "end")
    assert.equal(r.log.filter((l) => l.startsWith("begin")).length, 1)
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    const last = r.sets[r.sets.length - 1]
    nearVec(last.scale, vec3(2, 2, 3), 1e-6)
    assert.deepEqual(last.rotation, cube.localRotation)
    assert.deepEqual(r.errors, [])
  })

  test("a selection scales each object along its own axis, in one group named for its size", async () => {
    const b = targetOf("b", null, { position: vec3(2, 0, 0), rotation: quatFromAxisAngle(vec3(0, 1, 0), 1), scale: vec3(3, 1, 1) })
    const r = scaleRig([cube, b])
    r.drag.update(r.at(1.6 * r.L))
    await r.drag.end()
    assert.equal(r.log[0], "begin Scale 2 objects")
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    const forB = [...r.sets].reverse().find((s) => s.id === "b")!
    nearVec(forB.scale, vec3(6, 1, 1), 1e-6)
    assert.deepEqual(forB.position, b.localPosition, "an axis handle doesn't move objects")
  })

  test("the centre handle scales offsets from the shared pivot too", async () => {
    const b = targetOf("b", null, { position: vec3(2, 0, 0), rotation: IdentityQuat, scale: vec3(1, 1, 1) })
    const r = scaleRig([cube, b], "uniform")
    const c = r.layout.origin
    r.drag.update({ x: c.x + 53, y: c.y })
    await r.drag.end()
    const forB = [...r.sets].reverse().find((s) => s.id === "b")!
    nearVec(forB.position, vec3(4, 0, 0), 1e-6)
    nearVec(forB.scale, vec3(2, 2, 2), 1e-6)
  })

  test("Escape puts every changed object back exactly and ends the group", async () => {
    const b = targetOf("b", null, { position: vec3(2, 0, 0), rotation: IdentityQuat, scale: vec3(1, 1, 1) })
    const r = scaleRig([cube, b], "uniform")
    r.drag.update({ x: r.layout.origin.x + 80, y: r.layout.origin.y })
    await r.drag.cancel()
    assert.equal(r.log[r.log.length - 1], "end")
    assert.equal(r.log.filter((l) => l.startsWith("begin")).length, 1)
    for (const t of [cube, b]) {
      const last = [...r.sets].reverse().find((s) => s.id === t.id)!
      assert.deepEqual(last.position, t.localPosition)
      assert.deepEqual(last.rotation, t.localRotation)
      assert.deepEqual(last.scale, t.localScale)
    }
    assert.equal(r.drag.ratio, 1)
  })

  test("Ctrl snaps the ratio to 0.1", async () => {
    const r = scaleRig([cube])
    r.drag.update(r.at(0.8 * r.L * 1.234), true)
    near(r.drag.ratio, 1.2, 1e-9)
    r.drag.update(r.at(0.8 * r.L * 1.234), false)
    near(r.drag.ratio, 1.234, 1e-6)
    await r.drag.end()
  })

  test("releasing without a change sends nothing but still ends the group; after the end updates do nothing", async () => {
    const r = scaleRig([cube])
    await r.drag.end()
    assert.deepEqual(r.log, ["begin Scale a", "end"])
    assert.equal(r.drag.update(r.at(1.2 * r.L)), null)
    assert.equal(r.sets.length, 0)
  })

  test("a drag through zero never sends a zero or negative scale", async () => {
    const r = scaleRig([cube])
    for (const t of [0.5, 0.2, 0, -0.5, -2]) r.drag.update(r.at(t * r.L))
    await r.drag.end()
    for (const s of r.sets) assert.ok(s.scale.x > 0 && s.scale.y > 0 && s.scale.z > 0, JSON.stringify(s.scale))
    near(r.sets[r.sets.length - 1].scale.x, MinScaleRatio, 1e-12)
  })

  test("an abandoned drag sends nothing more and ends the group once", async () => {
    const r = scaleRig([cube])
    r.drag.update(r.at(1.2 * r.L))
    await r.drag.abandon()
    const sent = r.sets.length
    r.drag.update(r.at(1.6 * r.L))
    await r.drag.end()
    assert.equal(r.sets.length, sent)
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    assert.deepEqual(r.errors, [])
  })
})
