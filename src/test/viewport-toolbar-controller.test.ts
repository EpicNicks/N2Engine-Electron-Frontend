import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { Vec3 } from "../protocol/protocol.generated"
import type { Bounds } from "../renderer/viewport-camera"
import type { PickBackend } from "../renderer/viewport-controller"
import { Entity, rig, settle } from "./viewport-rig"
import { defaultSnapSettings } from "../renderer/viewport-snap"
import { ringPoint } from "../renderer/viewport-rotate"
import {
  IdentityQuat,
  Pixel,
  add,
  quatFromAxisAngle,
  quatMultiply,
  quatRotate,
  scale,
  vec3,
  worldToScreen,
} from "../renderer/viewport-math"

const near = (actual: number, expected: number, epsilon = 1e-6, what = ""): void =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${what} ${actual} is not ${expected}`)
const nearVec = (actual: Vec3, expected: Vec3, epsilon = 1e-6, what = ""): void => {
  near(actual.x, expected.x, epsilon, `${what} x`)
  near(actual.y, expected.y, epsilon, `${what} y`)
  near(actual.z, expected.z, epsilon, `${what} z`)
}

type Rig = ReturnType<typeof rig>

const pixelOf = (r: Rig, p: Vec3): Pixel => {
  const m = r.controller.matrices()!
  const s = worldToScreen(m.viewProjection, p, 800, 600)!
  return { x: s.x, y: s.y }
}
const lastSet = (r: Rig, id: string) => [...r.sets].reverse().find((s) => s.id === id)!

/** The snap settings with the move's, the rotation's and the scale's parts changed */
function snapWith(patch: { translate?: object; rotate?: object; scale?: object }) {
  const base = defaultSnapSettings()
  return {
    translate: { ...base.translate, ...patch.translate },
    rotate: { ...base.rotate, ...patch.rotate },
    scale: { ...base.scale, ...patch.scale },
  }
}

describe("the toolbar's settings on the controller", () => {
  test("the defaults: world space, the pivot, and the U4 snap settings", () => {
    const { controller } = rig()
    assert.equal(controller.space.value, "world")
    assert.equal(controller.pivot.value, "pivot")
    assert.deepEqual(controller.snap.value, defaultSnapSettings())
  })

  test("setSpace and setPivot change the value, clear the hovered handle and redraw; the same value is no change", async () => {
    const r = rig()
    await r.ready()
    const gizmo = r.controller.layout()!
    r.controller.hover(gizmo.handles[0].to)
    assert.notEqual(r.controller.hoverHandle.value, null)
    let version = r.controller.overlayVersion.value
    assert.equal(r.controller.setSpace("local"), true)
    assert.equal(r.controller.space.value, "local")
    assert.equal(r.controller.hoverHandle.value, null)
    assert.ok(r.controller.overlayVersion.value > version)
    version = r.controller.overlayVersion.value
    assert.equal(r.controller.setSpace("local"), true)
    assert.equal(r.controller.overlayVersion.value, version, "nothing changed, nothing redrawn")
    assert.equal(r.controller.setPivot("center"), true)
    assert.equal(r.controller.pivot.value, "center")
    assert.ok(r.controller.overlayVersion.value > version)
  })

  test("toggleSpace and togglePivot switch to the other", () => {
    const { controller } = rig()
    assert.equal(controller.toggleSpace(), true)
    assert.equal(controller.space.value, "local")
    assert.equal(controller.toggleSpace(), true)
    assert.equal(controller.space.value, "world")
    assert.equal(controller.togglePivot(), true)
    assert.equal(controller.pivot.value, "center")
    assert.equal(controller.togglePivot(), true)
    assert.equal(controller.pivot.value, "pivot")
  })

  test("the space and the pivot can't change during a drag (false), and can after it", async () => {
    const r = rig()
    await r.ready()
    const gizmo = r.controller.layout()!
    assert.equal(r.controller.pointerDown(gizmo.handles[0].to, false), true)
    assert.equal(r.controller.setSpace("local"), false)
    assert.equal(r.controller.toggleSpace(), false)
    assert.equal(r.controller.setPivot("center"), false)
    assert.equal(r.controller.togglePivot(), false)
    assert.equal(r.controller.space.value, "world")
    assert.equal(r.controller.pivot.value, "pivot")
    await r.controller.cancel()
    assert.equal(r.controller.toggleSpace(), true)
    assert.equal(r.controller.space.value, "local")
  })
})

describe("local space", () => {
  const origin = vec3(1, 2, 3)
  // Turned 45 degrees about z: local x runs up and to the right on screen, local y up and to the left
  const q = quatFromAxisAngle(vec3(0, 0, 1), Math.PI / 4)
  const entities = { a: { position: origin, rotation: q } }
  const localX = vec3(Math.SQRT1_2, Math.SQRT1_2, 0)

  test("the move gizmo's handles run along the object's own axes, the world's in world space", async () => {
    const r = rig({ entities })
    await r.ready()
    const world = r.controller.layout()!
    const worldX = world.handles.find((h) => h.axis === "x")!
    nearVec({ x: worldX.to.x, y: worldX.to.y, z: 0 }, { ...pixelOf(r, add(origin, vec3(world.worldLength, 0, 0))), z: 0 }, 1e-6, "world x")
    r.controller.setSpace("local")
    const local = r.controller.layout()!
    const localHandle = local.handles.find((h) => h.axis === "x")!
    const expected = pixelOf(r, add(origin, scale(localX, local.worldLength)))
    near(localHandle.to.x, expected.x, 1e-6, "local x end")
    near(localHandle.to.y, expected.y, 1e-6, "local x end")
    assert.ok(Math.abs(localHandle.to.y - worldX.to.y) > 10, "it is not where the world x handle was")
  })

  test("the rotate rings are about the object's own axes in local space", async () => {
    const tilted = quatFromAxisAngle(vec3(0, 1, 0), 0.5)
    const r = rig({ entities: { a: { position: origin, rotation: tilted } } })
    await r.ready()
    r.controller.setMode("rotate")
    assert.deepEqual(r.controller.rotateLayout()!.axes!.z, vec3(0, 0, 1))
    r.controller.setSpace("local")
    const axes = r.controller.rotateLayout()!.axes!
    nearVec(axes.z, vec3(Math.sin(0.5), 0, Math.cos(0.5)), 1e-9, "local z")
    nearVec(axes.x, vec3(Math.cos(0.5), 0, -Math.sin(0.5)), 1e-9, "local x")
  })

  test("the scale handles are the object's own in either space", async () => {
    const r = rig({ entities })
    await r.ready()
    r.controller.setMode("scale")
    const world = r.controller.scaleLayout()!
    r.controller.setSpace("local")
    const local = r.controller.scaleLayout()!
    assert.deepEqual(world.handles, local.handles)
    nearVec(local.directions.x, localX, 1e-9)
  })

  test("a drag of the local x handle moves the object along its own x axis, as one group", async () => {
    const r = rig({ entities })
    await r.ready()
    r.controller.setSpace("local")
    const layout = r.controller.layout()!
    const start = layout.handles.find((h) => h.axis === "x")!.to
    const end = pixelOf(r, add(origin, scale(localX, layout.worldLength + 0.9)))
    assert.equal(r.controller.pointerDown(start, false), true)
    assert.equal(r.controller.hoverHandle.value, "x")
    r.controller.pointerMove(end, false)
    await r.controller.pointerUp(end)
    assert.equal(r.log[0], "begin Move Cube")
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    const set = lastSet(r, "a")
    nearVec(set.position, add(origin, scale(localX, 0.9)), 1e-5, "moved along local x")
    assert.deepEqual(set.rotation, q, "the rotation went out as it was")
  })

  test("the same drag in world space moves it along the world x axis instead", async () => {
    const r = rig({ entities })
    await r.ready()
    const layout = r.controller.layout()!
    const start = layout.handles.find((h) => h.axis === "x")!.to
    const end = pixelOf(r, add(origin, vec3(layout.worldLength + 0.9, 0, 0)))
    r.controller.pointerDown(start, false)
    r.controller.pointerMove(end, false)
    await r.controller.pointerUp(end)
    nearVec(lastSet(r, "a").position, add(origin, vec3(0.9, 0, 0)), 1e-5)
  })

  test("a snapped move along a local axis rounds the distance along the axis (the move stays on its line)", async () => {
    const r = rig({ entities })
    await r.ready()
    r.controller.setSpace("local")
    const layout = r.controller.layout()!
    const start = layout.handles.find((h) => h.axis === "x")!.to
    const end = pixelOf(r, add(origin, scale(localX, layout.worldLength + 0.9)))
    r.controller.pointerDown(start, true)
    r.controller.pointerMove(end, true)
    await r.controller.pointerUp(end)
    nearVec(lastSet(r, "a").position, add(origin, scale(localX, 1)), 1e-5, "0.9 along the axis is 1.0 at a step of 0.5")
  })

  test("a rotate drag in local space turns about the object's own axis; Escape puts it back", async () => {
    const tilted = quatFromAxisAngle(vec3(0, 1, 0), 0.5)
    const r = rig({ entities: { a: { position: origin, rotation: tilted } } })
    await r.ready()
    r.controller.setMode("rotate")
    r.controller.setSpace("local")
    r.controller.setSnap(snapWith({ rotate: { enabled: true, stepDegrees: 30 } }))
    const layout = r.controller.rotateLayout()!
    const axes = layout.axes!
    const start = pixelOf(r, ringPoint("z", origin, layout.radiusWorld, (5 * Math.PI) / 4, axes))
    const end = pixelOf(r, ringPoint("z", origin, layout.radiusWorld, (5 * Math.PI) / 4 + 0.5, axes))
    assert.equal(r.controller.pointerDown(start, false), true)
    assert.equal(r.controller.hoverHandle.value, "z")
    r.controller.pointerMove(end, false)
    // 0.5 rad is 28.6 degrees: the 30 degree step makes it 30
    assert.equal(r.controller.dragReadout(), "Z +30.0 deg")
    await r.controller.pointerUp(end)
    const set = lastSet(r, "a")
    const expected = quatMultiply(tilted, quatFromAxisAngle(vec3(0, 0, 1), Math.PI / 6))
    for (const probe of [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]) nearVec(quatRotate(set.rotation, probe), quatRotate(expected, probe), 1e-4, "turned about local z")
    nearVec(set.position, origin, 1e-9, "about its own origin")

    // Escape: the transform goes back exactly
    const r2 = rig({ entities: { a: { position: origin, rotation: tilted } } })
    await r2.ready()
    r2.controller.setMode("rotate")
    r2.controller.setSpace("local")
    const layout2 = r2.controller.rotateLayout()!
    r2.controller.pointerDown(pixelOf(r2, ringPoint("z", origin, layout2.radiusWorld, (5 * Math.PI) / 4, layout2.axes!)), false)
    r2.controller.pointerMove(pixelOf(r2, ringPoint("z", origin, layout2.radiusWorld, (5 * Math.PI) / 4 + 0.5, layout2.axes!)), false)
    await r2.controller.cancel()
    const back = lastSet(r2, "a")
    assert.deepEqual(back.rotation, tilted)
    assert.deepEqual(back.position, origin)
    assert.equal(r2.log.filter((l) => l.startsWith("begin")).length, 1)
    assert.equal(r2.log.filter((l) => l === "end").length, 1)
  })
})

describe("snap settings in a drag", () => {
  const origin = vec3(1.3, 2, 3)
  const entities = { a: { position: origin } }

  /** Drags the world x handle by `by` (world units) with Ctrl `first` at the press and `during` at the moves, and returns the last position */
  async function dragX(r: Rig, by: number, ctrl: { press?: boolean; move?: boolean } = {}): Promise<Vec3> {
    const layout = r.controller.layout()!
    const start = layout.handles.find((h) => h.axis === "x")!.to
    const end = pixelOf(r, add(origin, vec3(layout.worldLength + by, 0, 0)))
    r.controller.pointerDown(start, ctrl.press ?? false)
    r.controller.pointerMove(end, ctrl.move ?? false)
    await r.controller.pointerUp(end)
    return lastSet(r, "a").position
  }

  test("with the toggle off nothing snaps, and Ctrl snaps to the move's increment", async () => {
    const r = rig({ entities })
    await r.ready()
    nearVec(await dragX(r, 0.9), vec3(2.2, 2, 3), 1e-5, "free")
    const c = rig({ entities })
    await c.ready()
    nearVec(await dragX(c, 0.9, { press: true, move: true }), vec3(2.3, 2, 3), 1e-5, "0.9 is 1.0 at 0.5, from 1.3")
  })

  test("with the toggle on it snaps, and Ctrl inverts it: no snap while held", async () => {
    const on = rig({ entities })
    await on.ready()
    on.controller.setSnap(snapWith({ translate: { enabled: true } }))
    nearVec(await dragX(on, 0.9), vec3(2.3, 2, 3), 1e-5, "snapped without Ctrl")
    const inverted = rig({ entities })
    await inverted.ready()
    inverted.controller.setSnap(snapWith({ translate: { enabled: true } }))
    nearVec(await dragX(inverted, 0.9, { press: true, move: true }), vec3(2.2, 2, 3), 1e-5, "free with Ctrl")
  })

  test("Ctrl pressed or released during the drag takes effect at the next move", async () => {
    const r = rig({ entities })
    await r.ready()
    r.controller.setSnap(snapWith({ translate: { enabled: true } }))
    const layout = r.controller.layout()!
    const start = layout.handles.find((h) => h.axis === "x")!.to
    const at = (by: number) => pixelOf(r, add(origin, vec3(layout.worldLength + by, 0, 0)))
    r.controller.pointerDown(start, false)
    r.controller.pointerMove(at(0.9), false)
    await settle()
    nearVec(lastSet(r, "a").position, vec3(2.3, 2, 3), 1e-5, "snapped")
    r.controller.pointerMove(at(0.9), true)
    await settle()
    nearVec(lastSet(r, "a").position, vec3(2.2, 2, 3), 1e-5, "Ctrl held: free")
    r.controller.pointerMove(at(0.9), false)
    await settle()
    await r.controller.pointerUp(at(0.9))
    nearVec(lastSet(r, "a").position, vec3(2.3, 2, 3), 1e-5, "Ctrl released: snapped again")
  })

  test("the increment is the setting's, not the default 0.5", async () => {
    const r = rig({ entities })
    await r.ready()
    r.controller.setSnap(snapWith({ translate: { enabled: true, step: 0.25 } }))
    nearVec(await dragX(r, 0.7), vec3(2.05, 2, 3), 1e-5, "0.7 is 0.75 at a step of 0.25 (0.5 at the default)")
  })

  test("absolute: the position lands on the world grid; relative keeps the offset it began with", async () => {
    const absolute = rig({ entities })
    await absolute.ready()
    absolute.controller.setSnap(snapWith({ translate: { enabled: true, kind: "absolute" } }))
    nearVec(await dragX(absolute, 0.4), vec3(1.5, 2, 3), 1e-5, "1.3 + 0.4 is 1.7, nearest grid point 1.5")
    const relative = rig({ entities })
    await relative.ready()
    relative.controller.setSnap(snapWith({ translate: { enabled: true, kind: "relative" } }))
    nearVec(await dragX(relative, 0.4), vec3(1.8, 2, 3), 1e-5, "the move 0.4 is 0.5")
  })

  test("absolute in local space of a rotated object stays relative (the move stays on its own axis)", async () => {
    const q = quatFromAxisAngle(vec3(0, 0, 1), Math.PI / 4)
    const r = rig({ entities: { a: { position: origin, rotation: q } } })
    await r.ready()
    r.controller.setSpace("local")
    r.controller.setSnap(snapWith({ translate: { enabled: true, kind: "absolute" } }))
    const layout = r.controller.layout()!
    const dir = vec3(Math.SQRT1_2, Math.SQRT1_2, 0)
    const start = layout.handles.find((h) => h.axis === "x")!.to
    const end = pixelOf(r, add(origin, scale(dir, layout.worldLength + 0.4)))
    r.controller.pointerDown(start, false)
    r.controller.pointerMove(end, false)
    await r.controller.pointerUp(end)
    nearVec(lastSet(r, "a").position, add(origin, scale(dir, 0.5)), 1e-5)
  })

  test("absolute in local space of an unrotated object is the world grid (its axes are the world's)", async () => {
    const r = rig({ entities })
    await r.ready()
    r.controller.setSpace("local")
    r.controller.setSnap(snapWith({ translate: { enabled: true, kind: "absolute" } }))
    nearVec(await dragX(r, 0.4), vec3(1.5, 2, 3), 1e-5)
  })

  test("a setting changed during a drag does not change that drag (the next one has it)", async () => {
    const r = rig({ entities })
    await r.ready()
    r.controller.setSnap(snapWith({ translate: { enabled: true, step: 0.5 } }))
    const layout = r.controller.layout()!
    const start = layout.handles.find((h) => h.axis === "x")!.to
    const end = pixelOf(r, add(origin, vec3(layout.worldLength + 0.9, 0, 0)))
    r.controller.pointerDown(start, false)
    r.controller.setSnap(snapWith({ translate: { enabled: false, step: 4 } }))
    r.controller.pointerMove(end, false)
    await r.controller.pointerUp(end)
    nearVec(lastSet(r, "a").position, vec3(2.3, 2, 3), 1e-5, "still snapped at 0.5")
  })

  test("a snapped drag is still one group, and Escape puts the object back exactly", async () => {
    const r = rig({ entities })
    await r.ready()
    r.controller.setSnap(snapWith({ translate: { enabled: true } }))
    const layout = r.controller.layout()!
    const start = layout.handles.find((h) => h.axis === "x")!.to
    r.controller.pointerDown(start, false)
    for (const by of [0.3, 0.9, 1.4]) r.controller.pointerMove(pixelOf(r, add(origin, vec3(layout.worldLength + by, 0, 0))), false)
    await r.controller.cancel()
    assert.deepEqual(lastSet(r, "a").position, origin)
    assert.equal(r.log.filter((l) => l.startsWith("begin")).length, 1)
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    assert.deepEqual(r.errors, [])
  })

  test("the scale step is the setting's: the centre handle at 0.25 gives a ratio of 1.25 where 0.1 gives 1.3", async () => {
    const scaled = async (step: number): Promise<number> => {
      const r = rig({ entities: { a: { position: vec3(1, 2, 3) } } })
      await r.ready()
      r.controller.setMode("scale")
      r.controller.setSnap(snapWith({ scale: { enabled: true, step } }))
      const centre = r.controller.scaleLayout()!.origin
      assert.equal(r.controller.pointerDown(centre, false), true)
      r.controller.pointerMove({ x: centre.x + 20, y: centre.y }, false)
      await r.controller.pointerUp(centre)
      return lastSet(r, "a").scale.x
    }
    near(await scaled(0.1), 1.3, 1e-9)
    near(await scaled(0.25), 1.25, 1e-9)
  })

  test("the rotate step is the setting's: 45 degrees makes a 57 degree turn 45", async () => {
    const r = rig({ entities: { a: { position: vec3(1, 2, 3) } } })
    await r.ready()
    r.controller.setMode("rotate")
    r.controller.setSnap(snapWith({ rotate: { enabled: true, stepDegrees: 45 } }))
    const layout = r.controller.rotateLayout()!
    const o = vec3(1, 2, 3)
    const start = pixelOf(r, ringPoint("z", o, layout.radiusWorld, (5 * Math.PI) / 4))
    const end = pixelOf(r, ringPoint("z", o, layout.radiusWorld, (5 * Math.PI) / 4 + 1))
    assert.equal(r.controller.pointerDown(start, false), true)
    r.controller.pointerMove(end, false)
    assert.equal(r.controller.dragReadout(), "Z +45.0 deg")
    await r.controller.pointerUp(end)
    nearVec(quatRotate(lastSet(r, "a").rotation, vec3(1, 0, 0)), quatRotate(quatFromAxisAngle(vec3(0, 0, 1), Math.PI / 4), vec3(1, 0, 0)), 1e-4)
  })

  test("the select-only tool has no snap and no drag", async () => {
    const r = rig({ entities })
    await r.ready()
    r.controller.setMode("none")
    r.controller.setSnap(snapWith({ translate: { enabled: true } }))
    assert.equal(r.controller.pointerDown({ x: 400, y: 300 }, true), false)
    assert.deepEqual(r.log, [])
  })
})

describe("the pivot", () => {
  const boxes: Record<string, Bounds> = {
    a: { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) },
    b: { min: vec3(3, -1, -1), max: vec3(5, 1, 1) },
  }
  const picking: PickBackend = {
    pick: async () => null,
    bounds: async (ids) => new Map(ids.filter((id) => boxes[id]).map((id) => [id, boxes[id]])),
  }
  const entities: Record<string, Entity> = { a: { position: vec3(0, 0, 0) }, b: { position: vec3(4, 0, 0) } }
  const center = vec3(2, 0, 0)

  test("pivot: the gizmo is at the primary object; center: at the centre of the selection's bounds", async () => {
    const r = rig({ entities, selection: ["a", "b"], picking })
    await r.ready()
    near(r.controller.layout()!.origin.x, pixelOf(r, vec3(0, 0, 0)).x, 1e-6, "at the primary")
    r.controller.setPivot("center")
    const layout = r.controller.layout()!
    near(layout.origin.x, pixelOf(r, center).x, 1e-6, "at the centre")
    near(layout.origin.y, pixelOf(r, center).y, 1e-6, "at the centre")
    r.controller.setMode("rotate")
    near(r.controller.rotateLayout()!.origin.x, pixelOf(r, center).x, 1e-6, "the rings too")
    r.controller.setMode("scale")
    near(r.controller.scaleLayout()!.origin.x, pixelOf(r, center).x, 1e-6, "and the scale handles")
  })

  test("center without bounds (a host that can't measure) is the primary object's origin", async () => {
    const r = rig({ entities, selection: ["a", "b"] })
    await r.ready()
    r.controller.setPivot("center")
    near(r.controller.layout()!.origin.x, pixelOf(r, vec3(0, 0, 0)).x, 1e-6)
  })

  test("a rotation turns the objects about the center, not the primary: both move", async () => {
    const turned = async (pivot: "pivot" | "center") => {
      const r = rig({ entities, selection: ["a", "b"], picking })
      await r.ready()
      r.controller.setMode("rotate")
      r.controller.setPivot(pivot)
      r.controller.setSnap(snapWith({ rotate: { enabled: true, stepDegrees: 90 } }))
      const layout = r.controller.rotateLayout()!
      const o = pivot === "center" ? center : vec3(0, 0, 0)
      const start = pixelOf(r, ringPoint("z", o, layout.radiusWorld, (5 * Math.PI) / 4))
      const end = pixelOf(r, ringPoint("z", o, layout.radiusWorld, (5 * Math.PI) / 4 + 1))
      assert.equal(r.controller.pointerDown(start, false), true)
      r.controller.pointerMove(end, false)
      assert.equal(r.controller.dragReadout(), "Z +90.0 deg")
      await r.controller.pointerUp(end)
      return { a: lastSet(r, "a").position, b: lastSet(r, "b").position, log: r.log }
    }
    // About the centre (2, 0, 0): a (-2 from it) goes to 2 below it, b (+2 from it) to 2 above it
    const c = await turned("center")
    nearVec(c.a, vec3(2, -2, 0), 1e-4, "a about the centre")
    nearVec(c.b, vec3(2, 2, 0), 1e-4, "b about the centre")
    assert.equal(c.log.filter((l) => l.startsWith("begin")).length, 1, "one group for both")
    // About the primary (0, 0, 0): a stays, b (4 from it) goes to 4 above it
    const p = await turned("pivot")
    nearVec(p.a, vec3(0, 0, 0), 1e-4, "a about itself")
    nearVec(p.b, vec3(0, 4, 0), 1e-4, "b about the primary")
  })

  test("after a drag the gizmo stays where it was put until the boxes are read again (no jump back, no stale press)", async () => {
    const r = rig({ entities, selection: ["a", "b"], picking })
    await r.ready()
    r.controller.setPivot("center")
    const layout = r.controller.layout()!
    const start = layout.handles.find((h) => h.axis === "y")!.to
    const end = pixelOf(r, add(center, vec3(0, layout.worldLength + 1, 0)))
    assert.equal(r.controller.pointerDown(start, false), true)
    r.controller.pointerMove(end, false)
    const up = r.controller.pointerUp(end)
    // The host has not answered yet: its boxes are the old ones, the gizmo is still at the moved centre
    near(r.controller.layout()!.origin.y, pixelOf(r, add(center, vec3(0, 1, 0))).y, 1e-6, "not back at the old centre")
    await up
  })

  test("a move is the same whatever the pivot (the pivot only places the gizmo)", async () => {
    const moved = async (pivot: "pivot" | "center") => {
      const r = rig({ entities, selection: ["a", "b"], picking })
      await r.ready()
      r.controller.setPivot(pivot)
      const layout = r.controller.layout()!
      const o = pivot === "center" ? center : vec3(0, 0, 0)
      const start = layout.handles.find((h) => h.axis === "y")!.to
      const end = pixelOf(r, add(o, vec3(0, layout.worldLength + 1, 0)))
      assert.equal(r.controller.pointerDown(start, false), true)
      r.controller.pointerMove(end, false)
      await r.controller.pointerUp(end)
      return { a: lastSet(r, "a").position, b: lastSet(r, "b").position }
    }
    for (const pivot of ["pivot", "center"] as const) {
      const m = await moved(pivot)
      nearVec(m.a, vec3(0, 1, 0), 1e-4, `a, ${pivot}`)
      nearVec(m.b, vec3(4, 1, 0), 1e-4, `b, ${pivot}`)
    }
  })

  test("the gizmo follows a move of the center during the drag", async () => {
    const r = rig({ entities, selection: ["a", "b"], picking })
    await r.ready()
    r.controller.setPivot("center")
    const layout = r.controller.layout()!
    const start = layout.handles.find((h) => h.axis === "y")!.to
    r.controller.pointerDown(start, false)
    r.controller.pointerMove(pixelOf(r, add(center, vec3(0, layout.worldLength + 1, 0))), false)
    const during = r.controller.layout()!
    near(during.origin.y, pixelOf(r, add(center, vec3(0, 1, 0))).y, 1e-3, "the gizmo has moved up with the objects")
    await r.controller.cancel()
  })

  test("with the primary alone selected the centre is its own box's, not its origin", async () => {
    const offcenter: Record<string, Bounds> = { a: { min: vec3(0, 0, 0), max: vec3(2, 4, 6) } }
    const only: PickBackend = { pick: async () => null, bounds: async (ids) => new Map(ids.filter((id) => offcenter[id]).map((id) => [id, offcenter[id]])) }
    const r = rig({ entities: { a: { position: vec3(0, 0, 0), rotation: IdentityQuat } }, selection: ["a"], picking: only })
    await r.ready()
    r.controller.setPivot("center")
    near(r.controller.layout()!.origin.x, pixelOf(r, vec3(1, 2, 3)).x, 1e-6)
    near(r.controller.layout()!.origin.y, pixelOf(r, vec3(1, 2, 3)).y, 1e-6)
  })
})
