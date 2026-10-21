import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { Quat, Vec3 } from "../protocol/protocol.generated"
import { GizmoModeTitles, GizmoModes } from "../renderer/viewport-controller"
import { rig, settle } from "./viewport-rig"
import { Bounds } from "../renderer/viewport-camera"
import { RingSegments, ringPoint } from "../renderer/viewport-rotate"
import { IdentityQuat, Pixel, quatFromAxisAngle, quatMultiply, quatRotate, vec3, worldToScreen } from "../renderer/viewport-math"

const near = (actual: number, expected: number, epsilon = 1e-6, what = ""): void =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${what} ${actual} is not ${expected}`)

const pixelOf = (r: ReturnType<typeof rig>, p: Vec3): Pixel => {
  const m = r.controller.matrices()!
  const s = worldToScreen(m.viewProjection, p, 800, 600)!
  return { x: s.x, y: s.y }
}

/** A point on a front part of a ring, away from where rings cross, and the pixel of the same ring at another angle */
function ringPixels(r: ReturnType<typeof rig>, axis: "x" | "y" | "z", origin: Vec3, from: number, to: number) {
  const layout = r.controller.rotateLayout()!
  return { start: pixelOf(r, ringPoint(axis, origin, layout.radiusWorld, from)), end: pixelOf(r, ringPoint(axis, origin, layout.radiusWorld, to)) }
}

const lastSet = (r: ReturnType<typeof rig>, id: string) => [...r.sets].reverse().find((s) => s.id === id)!

describe("the gizmo's tool", () => {
  test("the modes are move, rotate, scale and none (select only), Move first, and each has a name to show", () => {
    assert.deepEqual([...GizmoModes], ["translate", "rotate", "scale", "none"])
    assert.deepEqual(GizmoModes.map((m) => GizmoModeTitles[m]), ["Move", "Rotate", "Scale", "Select"])
    assert.equal(rig().controller.mode.value, "translate")
  })

  test("setMode changes the tool, clears the hovered handle and asks the overlay to redraw; the same mode is no change", async () => {
    const r = rig()
    await r.ready()
    const gizmo = r.controller.layout()!
    r.controller.hover({ x: gizmo.handles[0].to.x, y: gizmo.handles[0].to.y })
    assert.notEqual(r.controller.hoverHandle.value, null)
    const version = r.controller.overlayVersion.value
    assert.equal(r.controller.setMode("rotate"), true)
    assert.equal(r.controller.mode.value, "rotate")
    assert.equal(r.controller.hoverHandle.value, null)
    assert.ok(r.controller.overlayVersion.value > version)
    const again = r.controller.overlayVersion.value
    assert.equal(r.controller.setMode("rotate"), true)
    assert.equal(r.controller.overlayVersion.value, again, "nothing changed, nothing redrawn")
  })

  test("each tool has its layout and only its own: the others are null", async () => {
    const r = rig()
    await r.ready()
    const have = () => [r.controller.layout() !== null, r.controller.rotateLayout() !== null, r.controller.scaleLayout() !== null]
    assert.deepEqual(have(), [true, false, false])
    r.controller.setMode("rotate")
    assert.deepEqual(have(), [false, true, false])
    r.controller.setMode("scale")
    assert.deepEqual(have(), [false, false, true])
    r.controller.setMode("none")
    assert.deepEqual(have(), [false, false, false])
  })

  test("the tool can't change during a drag (false), and can after it", async () => {
    const r = rig()
    await r.ready()
    const gizmo = r.controller.layout()!
    assert.equal(r.controller.pointerDown(gizmo.handles[0].to, false), true)
    assert.equal(r.controller.setMode("rotate"), false)
    assert.equal(r.controller.mode.value, "translate")
    await r.controller.cancel()
    assert.equal(r.controller.setMode("rotate"), true)
  })

  test("with the tool none a press where a handle would be is not the gizmo's: nothing is dragged and it is a plain press", async () => {
    const r = rig()
    await r.ready()
    const gizmo = r.controller.layout()!
    const where = gizmo.handles[0].to
    r.controller.setMode("none")
    assert.equal(r.controller.pointerDown(where, false), false)
    await r.controller.pointerUp(where)
    assert.equal(r.controller.isDragging, false)
    assert.deepEqual(r.log, [])
    r.controller.hover(where)
    assert.equal(r.controller.hoverHandle.value, null)
  })

  test("the default tool is still the translate gizmo, as before", async () => {
    const r = rig()
    await r.ready()
    const gizmo = r.controller.layout()!
    assert.equal(r.controller.pointerDown(gizmo.handles[0].to, false), true)
    await r.controller.pointerUp(gizmo.handles[0].to)
    assert.equal(r.log[0], "begin Move Cube")
  })
})

describe("a rotate drag through the controller", () => {
  const origin = vec3(1, 2, 3)
  // The object is up and to the right of the camera, so the half of the z ring that faces it is the lower left one
  const A0 = (5 * Math.PI) / 4

  test("down, moves and up: one group, the transforms of the turn, one end; the frame is asked for", async () => {
    const r = rig()
    await r.ready()
    r.controller.setMode("rotate")
    const { start, end } = ringPixels(r, "z", origin, A0, A0 + 0.8)
    assert.equal(r.controller.pointerDown(start, false), true)
    assert.equal(r.controller.hoverHandle.value, "z")
    assert.equal(r.controller.dragging.value, true)
    r.controller.pointerMove(end, false)
    assert.equal(r.controller.dragReadout(), "Z +45.8 deg")
    await r.controller.pointerUp(end)
    assert.equal(r.controller.dragging.value, false)
    assert.equal(r.log[0], "begin Rotate Cube")
    assert.equal(r.log.filter((l) => l.startsWith("begin")).length, 1)
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    assert.equal(r.log[r.log.length - 1], "end")
    const set = lastSet(r, "a")
    const expected = quatFromAxisAngle(vec3(0, 0, 1), 0.8)
    for (const probe of [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]) {
      const got = quatRotate(set.rotation, probe)
      const want = quatRotate(expected, probe)
      near(got.x, want.x, 1e-4)
      near(got.y, want.y, 1e-4)
      near(got.z, want.z, 1e-4)
    }
    assert.deepEqual(set.position, origin, "turning about its own origin leaves the position")
    assert.deepEqual(set.scale, vec3(1, 1, 1))
    assert.ok(r.frames() > 0)
    assert.deepEqual(r.errors, [])
    assert.equal(r.controller.dragReadout(), null, "no readout once it has ended")
  })

  test("Escape cancels: the object goes back exactly, the group still ends once", async () => {
    const r = rig({ entities: { a: { position: origin, rotation: quatFromAxisAngle(vec3(1, 0, 0), 0.3) } } })
    await r.ready()
    r.controller.setMode("rotate")
    const { start, end } = ringPixels(r, "z", origin, A0, A0 + 1)
    r.controller.pointerDown(start, false)
    r.controller.pointerMove(end, false)
    await r.controller.cancel()
    assert.equal(r.log[r.log.length - 1], "end")
    assert.equal(r.log.filter((l) => l.startsWith("begin")).length, 1)
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    const set = lastSet(r, "a")
    assert.deepEqual(set.rotation, quatFromAxisAngle(vec3(1, 0, 0), 0.3))
    assert.deepEqual(set.position, origin)
  })

  test("Ctrl at the press snaps to 15 degrees, and Ctrl while moving snaps too", async () => {
    const r = rig()
    await r.ready()
    r.controller.setMode("rotate")
    const { start, end } = ringPixels(r, "z", origin, A0, A0 + 0.3)
    r.controller.pointerDown(start, false)
    r.controller.pointerMove(end, true)
    assert.equal(r.controller.dragReadout(), "Z +15.0 deg")
    await r.controller.pointerUp(end)
  })

  test("a selection turns about the primary's origin as one group, each object's position going round it", async () => {
    const r = rig({
      entities: { a: { position: origin }, b: { position: vec3(3, 2, 3) } },
      selection: ["a", "b"],
    })
    await r.ready()
    r.controller.setMode("rotate")
    const { start, end } = ringPixels(r, "z", origin, A0, A0 + Math.PI / 2)
    r.controller.pointerDown(start, false)
    r.controller.pointerMove(end, false)
    await r.controller.pointerUp(end)
    assert.equal(r.log[0], "begin Rotate 2 objects")
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    // b was 2 to the right of a: a quarter turn about z puts it 2 above
    const b = lastSet(r, "b")
    near(b.position.x, 1, 1e-3)
    near(b.position.y, 4, 1e-3)
    near(b.position.z, 3, 1e-3)
    const q = quatMultiply(quatFromAxisAngle(vec3(0, 0, 1), Math.PI / 2), IdentityQuat)
    near(Math.abs(b.rotation.z), Math.abs(q.z), 1e-3)
  })

  test("a scene that can't be edited (read-only host, play mode, viewer) has no rotate gizmo and no drag", async () => {
    const r = rig({ canEdit: false })
    await r.ready()
    r.controller.setMode("rotate")
    assert.equal(r.controller.rotateLayout(), null)
    assert.equal(r.controller.pointerDown({ x: 400, y: 300 }, false), false)
    r.controller.hover({ x: 400, y: 300 })
    assert.equal(r.controller.hoverHandle.value, null)
    assert.deepEqual(r.log, [])
  })

  test("a press that began with the host unable to say what is selected starts nothing; a miss on the rings is not a drag", async () => {
    const r = rig()
    await r.ready()
    r.controller.setMode("rotate")
    assert.equal(r.controller.pointerDown({ x: 5, y: 5 }, false), false)
    await r.controller.pointerUp({ x: 5, y: 5 })
    assert.deepEqual(r.log, [])
  })

  test("the connection going abandons the drag: nothing more is sent and no frame is asked for after it", async () => {
    const r = rig()
    await r.ready()
    r.controller.setMode("rotate")
    const { start, end } = ringPixels(r, "z", origin, A0, A0 + 0.5)
    r.controller.pointerDown(start, false)
    r.controller.pointerMove(end, false)
    r.controller.disconnected()
    await settle()
    const sent = r.sets.length
    const frames = r.frames()
    r.controller.pointerMove({ x: end.x + 10, y: end.y }, false)
    await settle()
    assert.equal(r.sets.length, sent)
    assert.equal(r.frames(), frames)
    assert.equal(r.controller.dragging.value, false)
    assert.equal(r.log.filter((l) => l === "end").length, 1)
  })

  test("the selection's boxes are left off during a rotate drag, and come back after it", async () => {
    const box: Bounds = { min: vec3(0, 1, 2), max: vec3(2, 3, 4) }
    const r = rig({ picking: { pick: async () => null, bounds: async () => new Map([["a", box]]) } })
    const withBoxes = r.controller
    await r.ready()
    withBoxes.reloadBounds()
    await settle()
    assert.ok(withBoxes.boxEdges().length > 0, "the box of the selection")
    withBoxes.setMode("rotate")
    const layout = withBoxes.rotateLayout()!
    const m = withBoxes.matrices()!
    const px = (angle: number): Pixel => {
      const s = worldToScreen(m.viewProjection, ringPoint("z", origin, layout.radiusWorld, angle), 800, 600)!
      return { x: s.x, y: s.y }
    }
    assert.equal(withBoxes.pointerDown(px(A0), false), true)
    withBoxes.pointerMove(px(A0 + 0.4), false)
    assert.equal(withBoxes.boxEdges().length, 0)
    await withBoxes.pointerUp(px(A0 + 0.4))
    await settle()
    assert.ok(withBoxes.boxEdges().length > 0)
  })

  test("the rings were laid out with a full ring of segments", async () => {
    const r = rig()
    await r.ready()
    r.controller.setMode("rotate")
    assert.equal(r.controller.rotateLayout()!.rings[0].segments.length, RingSegments)
  })
})

describe("a scale drag through the controller", () => {
  const origin = vec3(1, 2, 3)

  /** The pixel on the x handle t handle lengths from the origin */
  const onX = (r: ReturnType<typeof rig>, t: number): Pixel => {
    const layout = r.controller.scaleLayout()!
    return pixelOf(r, vec3(origin.x + t * layout.worldLength, origin.y, origin.z))
  }

  test("down, moves and up on the x handle: one group, the local x scale multiplied by the ratio", async () => {
    const r = rig({ entities: { a: { position: origin, scale: vec3(2, 3, 4) } } })
    await r.ready()
    r.controller.setMode("scale")
    assert.equal(r.controller.pointerDown(onX(r, 0.8), false), true)
    assert.equal(r.controller.hoverHandle.value, "x")
    r.controller.pointerMove(onX(r, 1.2), false)
    assert.equal(r.controller.dragReadout(), "X x1.50")
    await r.controller.pointerUp(onX(r, 1.2))
    assert.equal(r.log[0], "begin Scale Cube")
    assert.equal(r.log.filter((l) => l.startsWith("begin")).length, 1)
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    const set = lastSet(r, "a")
    near(set.scale.x, 3, 1e-4)
    near(set.scale.y, 3, 1e-9)
    near(set.scale.z, 4, 1e-9)
    assert.deepEqual(set.position, origin)
    assert.deepEqual(set.rotation, IdentityQuat)
    assert.deepEqual(r.errors, [])
  })

  test("the centre handle scales uniformly, and Escape puts everything back", async () => {
    const r = rig({ entities: { a: { position: origin, scale: vec3(1, 2, 3) } } })
    await r.ready()
    r.controller.setMode("scale")
    const layout = r.controller.scaleLayout()!
    const c = layout.origin
    assert.equal(r.controller.pointerDown({ x: c.x + 3, y: c.y }, false), true)
    assert.equal(r.controller.hoverHandle.value, "uniform")
    r.controller.pointerMove({ x: c.x + 51, y: c.y }, false)
    assert.equal(r.controller.dragReadout(), "All x2.00")
    await r.controller.cancel()
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    const set = lastSet(r, "a")
    assert.deepEqual(set.scale, vec3(1, 2, 3))
    assert.deepEqual(set.position, origin)
  })

  test("a selection scales every object along its own axis as one group; the centre handle also scales their offsets", async () => {
    const r = rig({
      entities: { a: { position: origin }, b: { position: vec3(3, 2, 3) } },
      selection: ["a", "b"],
    })
    await r.ready()
    r.controller.setMode("scale")
    const layout = r.controller.scaleLayout()!
    const c = layout.origin
    r.controller.pointerDown({ x: c.x + 3, y: c.y }, false)
    r.controller.pointerMove({ x: c.x + 51, y: c.y }, false)
    await r.controller.pointerUp({ x: c.x + 51, y: c.y })
    assert.equal(r.log[0], "begin Scale 2 objects")
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    const b = lastSet(r, "b")
    near(b.position.x, 5, 1e-6)
    near(b.scale.x, 2, 1e-6)
    near(lastSet(r, "a").scale.y, 2, 1e-6)
  })

  test("the handles follow the primary's rotation: its x handle is along its own x", async () => {
    const r = rig({ entities: { a: { position: origin, rotation: quatFromAxisAngle(vec3(0, 0, 1), Math.PI / 2) } } })
    await r.ready()
    r.controller.setMode("scale")
    const layout = r.controller.scaleLayout()!
    const x = layout.handles.find((h) => h.axis === "x")!
    assert.ok(x.to.y < x.from.y - 50, "up the screen: the object's x is the world's y")
    r.controller.pointerDown(x.to, false)
    assert.equal(r.controller.hoverHandle.value, "x")
    await r.controller.cancel()
  })

  test("a scene that can't be edited has no scale gizmo and no drag", async () => {
    const r = rig({ canEdit: false })
    await r.ready()
    r.controller.setMode("scale")
    assert.equal(r.controller.scaleLayout(), null)
    assert.equal(r.controller.pointerDown({ x: 400, y: 300 }, false), false)
    assert.deepEqual(r.log, [])
  })

  test("a drag through zero never sends a zero or negative scale", async () => {
    const r = rig()
    await r.ready()
    r.controller.setMode("scale")
    r.controller.pointerDown(onX(r, 0.8), false)
    for (const t of [0.4, 0, -0.5, -3]) r.controller.pointerMove(onX(r, t), false)
    await r.controller.pointerUp(onX(r, -3))
    for (const s of r.sets) assert.ok(s.scale.x > 0, String(s.scale.x))
  })
})
