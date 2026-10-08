import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { Mat4, Quat, Vec3 } from "../protocol/protocol.generated"
import {
  AxisDrag,
  GizmoDrag,
  GizmoSizePixels,
  GizmoTarget,
  boxCorners,
  gizmoLayout,
  hitTestGizmo,
  localPositionAfterMove,
  projectBox,
  snapTo,
} from "../renderer/viewport-gizmo"
import {
  IdentityQuat,
  mat4Compose,
  mat4Multiply,
  mat4Translation,
  projectionMatrix,
  quatFromAxisAngle,
  quatMultiply,
  quatRotate,
  vec3,
  viewMatrix,
  worldToScreen,
} from "../renderer/viewport-math"

const near = (actual: number, expected: number, epsilon = 1e-6, what = ""): void =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${what} ${actual} is not ${expected}`)
const nearVec = (a: Vec3, b: Vec3, epsilon = 1e-6): void => {
  near(a.x, b.x, epsilon, "x")
  near(a.y, b.y, epsilon, "y")
  near(a.z, b.z, epsilon, "z")
}

const W = 800
const H = 600
const settings = { fovY: 60, orthographic: false, orthoSize: 5, nearPlane: 0.1, farPlane: 1000 }

/** A camera at the position looking down -Z (no rotation) */
function camera(position: Vec3) {
  const view = viewMatrix(position, IdentityQuat)
  const projection = projectionMatrix(settings, W / H)
  return { view, viewProjection: mat4Multiply(projection, view) }
}

/** A transform as the engine keeps it */
interface Trs {
  position: Vec3
  rotation: Quat
  scale: Vec3
}

/** Transform::Combine: position = pPos + pRot * (pScale * lPos), rotation = pRot * lRot, scale = pScale * lScale */
function combine(parent: Trs, child: Trs): Trs {
  const scaled = vec3(child.position.x * parent.scale.x, child.position.y * parent.scale.y, child.position.z * parent.scale.z)
  const rotated = quatRotate(parent.rotation, scaled)
  return {
    position: vec3(parent.position.x + rotated.x, parent.position.y + rotated.y, parent.position.z + rotated.z),
    rotation: quatMultiply(parent.rotation, child.rotation),
    scale: vec3(parent.scale.x * child.scale.x, parent.scale.y * child.scale.y, parent.scale.z * child.scale.z),
  }
}

const rootTrs: Trs = { position: vec3(0, 0, 0), rotation: IdentityQuat, scale: vec3(1, 1, 1) }

/** An object under the given parent: its world matrix is what the engine builds (T * R * S of the combined transform) */
function targetUnder(parent: Trs, localPosition: Vec3, localRotation: Quat = IdentityQuat, localScale = vec3(1, 1, 1)): GizmoTarget {
  const world = combine(parent, { position: localPosition, rotation: localRotation, scale: localScale })
  return {
    id: "obj",
    name: "Cube",
    localPosition,
    localRotation,
    localScale,
    worldMatrix: mat4Compose(world.position, world.rotation, world.scale),
  }
}

/** Where the object is in the world if its local position were this (the engine's own composition) */
function worldPositionWith(parent: Trs, target: GizmoTarget, local: Vec3): Vec3 {
  return combine(parent, { position: local, rotation: target.localRotation, scale: target.localScale }).position
}


describe("gizmoLayout", () => {
  test("the handles are GizmoSizePixels long on screen, at any distance", () => {
    for (const z of [5, 20, 200]) {
      const c = camera(vec3(0, 0, z))
      const layout = gizmoLayout(c.view, c.viewProjection, vec3(0, 0, 0), W, H)!
      const x = layout.handles.find((h) => h.axis === "x")!
      near(Math.hypot(x.to.x - x.from.x, x.to.y - x.from.y), GizmoSizePixels, 0.5, `at ${z}`)
      near(layout.origin.x, W / 2, 1e-6)
      near(layout.origin.y, H / 2, 1e-6)
    }
  })

  test("+X goes right, +Y goes up the screen", () => {
    const c = camera(vec3(0, 0, 10))
    const layout = gizmoLayout(c.view, c.viewProjection, vec3(0, 0, 0), W, H)!
    const x = layout.handles.find((h) => h.axis === "x")!
    const y = layout.handles.find((h) => h.axis === "y")!
    assert.ok(x.to.x > x.from.x)
    assert.ok(y.to.y < y.from.y)
  })

  test("the handle that points at the camera is left out", () => {
    const c = camera(vec3(0, 0, 10))
    const layout = gizmoLayout(c.view, c.viewProjection, vec3(0, 0, 0), W, H)!
    assert.deepEqual(layout.handles.map((h) => h.axis).sort(), ["x", "y"])
  })

  test("an object behind the camera has no gizmo", () => {
    const c = camera(vec3(0, 0, 10))
    assert.equal(gizmoLayout(c.view, c.viewProjection, vec3(0, 0, 20), W, H), null)
  })
})

describe("hitTestGizmo", () => {
  const c = camera(vec3(0, 0, 10))
  const layout = gizmoLayout(c.view, c.viewProjection, vec3(0, 0, 0), W, H)!

  test("a pixel on a handle hits it, one near it hits it, one far from them hits nothing", () => {
    const x = layout.handles.find((h) => h.axis === "x")!
    const y = layout.handles.find((h) => h.axis === "y")!
    assert.equal(hitTestGizmo(layout, { x: (x.from.x + x.to.x) / 2, y: (x.from.y + x.to.y) / 2 }), "x")
    assert.equal(hitTestGizmo(layout, { x: (y.from.x + y.to.x) / 2 + 5, y: (y.from.y + y.to.y) / 2 }), "y")
    assert.equal(hitTestGizmo(layout, { x: (x.from.x + x.to.x) / 2, y: x.from.y + 40 }), null)
    assert.equal(hitTestGizmo(layout, { x: 10, y: 10 }), null)
  })

  test("where handles cross, the nearer one wins", () => {
    // Just above the X handle's start and left of the Y handle: nearer the Y handle
    const x = layout.handles.find((h) => h.axis === "x")!
    const pixel = { x: x.from.x + 2, y: x.from.y - 3 }
    assert.equal(hitTestGizmo(layout, pixel), "y")
    assert.equal(hitTestGizmo(layout, { x: x.from.x + 20, y: x.from.y + 1 }), "x")
  })
})

describe("AxisDrag", () => {
  test("the object follows the pointer along the axis: the world move is the pointer's, not a guess", () => {
    const c = camera(vec3(0, 0, 10))
    const origin = vec3(0, 0, 0)
    const start = worldToScreen(c.viewProjection, vec3(1, 0, 0), W, H)!
    const drag = AxisDrag.begin("x", origin, c.viewProjection, start, W, H)!
    // The pointer ends where the point (4, 0, 0) is on screen: the object moved 3 units
    const end = worldToScreen(c.viewProjection, vec3(4, 0, 0), W, H)!
    near(drag.moveAt(end)!, 3, 1e-4)
    near(drag.moveAt(start)!, 0, 1e-9)
    const back = worldToScreen(c.viewProjection, vec3(-2, 0, 0), W, H)!
    near(drag.moveAt(back)!, -3, 1e-4)
  })

  test("depth doesn't fool it: dragging a handle along Z from a camera off to the side", () => {
    const c = camera(vec3(15, 3, 10))
    const origin = vec3(0, 0, 0)
    const start = worldToScreen(c.viewProjection, vec3(0, 0, 1), W, H)!
    const drag = AxisDrag.begin("z", origin, c.viewProjection, start, W, H)!
    const end = worldToScreen(c.viewProjection, vec3(0, 0, 5), W, H)!
    near(drag.moveAt(end)!, 4, 1e-4)
  })

  test("a ray that runs along the axis gives no answer, and the drag can't begin there", () => {
    const c = camera(vec3(0, 0, 10))
    // Looking down Z at the middle of the screen: the Z axis is a point
    assert.equal(AxisDrag.begin("z", vec3(0, 0, 0), c.viewProjection, { x: W / 2, y: H / 2 }, W, H), null)
  })
})

describe("local position under a parent (the engine's Transform::Combine)", () => {
  const quarterY = quatFromAxisAngle(vec3(0, 1, 0), Math.PI / 2)
  const quarterZ = quatFromAxisAngle(vec3(0, 0, 1), Math.PI / 2)

  /** After the move the engine's own composition puts the object exactly deltaWorld from where it was */
  function assertMoves(parent: Trs, target: GizmoTarget, delta: Vec3): void {
    const local = localPositionAfterMove(target, delta)!
    assert.ok(local, "a local position")
    const before = mat4Translation(target.worldMatrix)
    nearVec(worldPositionWith(parent, target, local), vec3(before.x + delta.x, before.y + delta.y, before.z + delta.z), 1e-9)
  }

  test("a root moves by the world move", () => {
    const target = targetUnder(rootTrs, vec3(1, 2, 3))
    nearVec(localPositionAfterMove(target, vec3(5, 0, 0))!, vec3(6, 2, 3))
  })

  test("a parent turned a quarter about Y: a world +X move is a local +Z move", () => {
    const parent: Trs = { position: vec3(10, 0, 0), rotation: quarterY, scale: vec3(1, 1, 1) }
    const target = targetUnder(parent, vec3(1, 0, 0), quatFromAxisAngle(vec3(1, 1, 1), 0.9)) // its own rotation doesn't matter
    nearVec(localPositionAfterMove(target, vec3(2, 0, 0))!, vec3(1, 0, 2))
    assertMoves(parent, target, vec3(2, 0, 0))
  })

  test("a uniformly scaled parent: a world move of 6 under a scale of 3 is 2 in local units", () => {
    const parent: Trs = { position: vec3(0, 0, 0), rotation: IdentityQuat, scale: vec3(3, 3, 3) }
    const target = targetUnder(parent, vec3(1, 1, 1))
    nearVec(localPositionAfterMove(target, vec3(0, 6, 0))!, vec3(1, 3, 1))
  })

  test("a parent scaled (2, 1, 1) with a child turned a quarter about Z: the child's rotation is not the parent's frame", () => {
    const parent: Trs = { position: vec3(1, 2, 3), rotation: IdentityQuat, scale: vec3(2, 1, 1) }
    const target = targetUnder(parent, vec3(1, 1, 0), quarterZ)
    // The world X move of 4 is 2 local units of X; Y and Z are unscaled
    nearVec(localPositionAfterMove(target, vec3(4, 0, 0))!, vec3(3, 1, 0))
    nearVec(localPositionAfterMove(target, vec3(0, 3, 0))!, vec3(1, 4, 0))
    for (const d of [vec3(4, 0, 0), vec3(0, 3, 0), vec3(0, 0, -2), vec3(1, 2, 3)]) assertMoves(parent, target, d)
  })

  test("a rotated and non-uniformly scaled parent with a rotated, scaled child", () => {
    const parent: Trs = { position: vec3(-4, 5, 6), rotation: quatFromAxisAngle(vec3(1, 2, 3), 0.8), scale: vec3(2, 0.5, 3) }
    const target = targetUnder(parent, vec3(3, -2, 1), quatFromAxisAngle(vec3(0, 1, 1), 1.3), vec3(1.5, 2, 0.25))
    for (const d of [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1), vec3(-3, 2, 5)]) assertMoves(parent, target, d)
  })

  test("a zero scale (the object's or the parent's) can't be moved", () => {
    assert.equal(localPositionAfterMove(targetUnder(rootTrs, vec3(0, 0, 0), IdentityQuat, vec3(1, 0, 1)), vec3(1, 0, 0)), null)
    const flat: Trs = { position: vec3(0, 0, 0), rotation: IdentityQuat, scale: vec3(1, 0, 1) }
    assert.equal(localPositionAfterMove(targetUnder(flat, vec3(1, 1, 1)), vec3(1, 0, 0)), null)
  })
})

describe("snapTo", () => {
  test("rounds to the step, and a zero step leaves it", () => {
    assert.equal(snapTo(1.3, 0.5), 1.5)
    assert.equal(snapTo(-0.3, 0.5), -0.5)
    assert.equal(snapTo(1.3, 0), 1.3)
  })
})

describe("GizmoDrag", () => {
  /** The engine and the edit groups, recording what they were asked in order */
  function rig(options: { beginDelay?: Promise<void> } = {}) {
    const log: string[] = []
    const sets: Array<{ position: Vec3; rotation: Quat; scale: Vec3 }> = []
    const errors: string[] = []
    let moved = 0
    const deps = {
      engine: {
        setLocalTransform: async (id: string, position: Vec3, rotation: Quat, scale: Vec3) => {
          log.push(`set ${id} ${position.x.toFixed(3)}`)
          sets.push({ position, rotation, scale })
        },
      },
      groups: {
        begin: async (label: string) => {
          log.push(`begin ${label}`)
          await options.beginDelay
          return 1
        },
        end: async (handle: number | null) => {
          log.push(`end ${handle}`)
        },
      },
      onError: (what: string) => errors.push(what),
      onMoved: () => moved++,
    }
    return { deps, log, sets, errors, moved: () => moved }
  }

  const c = camera(vec3(0, 0, 10))
  const target = targetUnder(rootTrs, vec3(1, 0, 0), quatFromAxisAngle(vec3(0, 1, 0), 0.5), vec3(2, 2, 2))
  const pixelAt = (x: number) => worldToScreen(c.viewProjection, vec3(x, 0, 0), W, H)!
  const begin = () => AxisDrag.begin("x", mat4Translation(target.worldMatrix), c.viewProjection, pixelAt(2), W, H)!

  test("a drag is one group: begin first, the moves, then end after the last move", async () => {
    const { deps, log, sets } = rig()
    const drag = new GizmoDrag(deps, target, begin())
    drag.update(pixelAt(3))
    drag.update(pixelAt(4))
    drag.update(pixelAt(5))
    await drag.end()
    assert.equal(log[0], "begin Move Cube")
    assert.equal(log[log.length - 1], "end 1")
    assert.ok(log.slice(1, -1).every((entry) => entry.startsWith("set obj")))
    // The last position is what the pointer ended on: a move of 3 along X from 1
    near(sets[sets.length - 1].position.x, 4, 1e-3)
    // The rotation and the scale are the object's own, untouched
    assert.deepEqual(sets[sets.length - 1].rotation, target.localRotation)
    assert.deepEqual(sets[sets.length - 1].scale, target.localScale)
    nearVec(drag.worldDelta, vec3(3, 0, 0), 1e-3)
  })

  test("no edit goes before the group is open, even when the group is slow to open", async () => {
    let open!: () => void
    const delay = new Promise<void>((resolve) => (open = resolve))
    const { deps, log } = rig({ beginDelay: delay })
    const drag = new GizmoDrag(deps, target, begin())
    drag.update(pixelAt(3))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(log, ["begin Move Cube"])
    open()
    await drag.end()
    assert.deepEqual(
      log.map((l) => l.split(" ")[0]),
      ["begin", "set", "end"]
    )
  })

  test("only the newest position is sent while one is on its way: many moves, few requests", async () => {
    const { deps, sets } = rig()
    const drag = new GizmoDrag(deps, target, begin())
    for (let i = 0; i < 100; i++) drag.update(pixelAt(2 + i / 50))
    await drag.end()
    assert.ok(sets.length <= 3, `${sets.length} requests`)
    near(sets[sets.length - 1].position.x, 1 + (2 + 99 / 50 - 2), 1e-3)
  })

  test("releasing without moving sends no edit, and still ends the group", async () => {
    const { deps, log } = rig()
    const drag = new GizmoDrag(deps, target, begin())
    await drag.end()
    assert.deepEqual(log, ["begin Move Cube", "end 1"])
  })

  test("escape puts the object back and ends the group", async () => {
    const { deps, log, sets } = rig()
    const drag = new GizmoDrag(deps, target, begin())
    drag.update(pixelAt(5))
    await drag.cancel()
    near(sets[sets.length - 1].position.x, 1, 1e-9)
    assert.equal(log[log.length - 1], "end 1")
    assert.deepEqual(drag.worldDelta, vec3(0, 0, 0))
    // Nothing more goes after it ended
    const count = sets.length
    drag.update(pixelAt(6))
    await drag.end()
    assert.equal(sets.length, count)
  })

  test("ending twice is one end", async () => {
    const { deps, log } = rig()
    const drag = new GizmoDrag(deps, target, begin())
    await Promise.all([drag.end(), drag.end()])
    assert.equal(log.filter((l) => l.startsWith("end")).length, 1)
  })

  test("ctrl snaps the move to the step", async () => {
    const { deps, sets } = rig()
    const drag = new GizmoDrag(deps, target, begin(), true)
    drag.update(pixelAt(2.8)) // a move of 0.8: snapped to 1
    await drag.end()
    near(sets[sets.length - 1].position.x, 2, 1e-3)
  })

  test("a refused move is reported and the group still ends", async () => {
    const { deps, log, errors } = rig()
    deps.engine.setLocalTransform = async () => {
      throw new Error("refused")
    }
    const drag = new GizmoDrag(deps, target, begin())
    drag.update(pixelAt(3))
    await drag.end()
    assert.deepEqual(errors, ["Failed to move the object"])
    assert.equal(log[log.length - 1], "end 1")
  })

  test("a group the host refused still lets the drag move the object (ungrouped)", async () => {
    const { deps, sets } = rig()
    deps.groups.begin = async () => null as unknown as number
    const drag = new GizmoDrag(deps, target, begin())
    drag.update(pixelAt(3))
    await drag.end()
    assert.equal(sets.length, 1)
  })

  test("the frame is asked for after each move that was sent", async () => {
    const { deps, moved } = rig()
    const drag = new GizmoDrag(deps, target, begin())
    drag.update(pixelAt(3))
    await drag.end()
    assert.ok(moved() >= 1)
  })
})

describe("the selection box", () => {
  test("a box has eight corners and twelve edges, all of them on screen in front of the camera", () => {
    const corners = boxCorners(vec3(-1, -1, -1), vec3(1, 2, 3))
    assert.equal(corners.length, 8)
    assert.deepEqual(corners[0], vec3(-1, -1, -1))
    assert.deepEqual(corners[7], vec3(1, 2, 3))
    const c = camera(vec3(0, 0, 10))
    assert.equal(projectBox(c.viewProjection, vec3(-1, -1, -1), vec3(1, 1, 1), W, H).length, 12)
  })

  test("an edge with an end behind the camera is dropped", () => {
    const c = camera(vec3(0, 0, 10))
    const edges = projectBox(c.viewProjection, vec3(-1, -1, 5), vec3(1, 1, 15), W, H)
    assert.ok(edges.length < 12)
    assert.ok(edges.length > 0)
  })
})

describe("AxisDrag limits", () => {
  const c = camera(vec3(0, 0, 10))
  const pixelAt = (x: number) => worldToScreen(c.viewProjection, vec3(x, 0, 0), W, H)!

  test("a ray that meets the axis beyond the far plane is not followed", () => {
    const drag = AxisDrag.begin("x", vec3(0, 0, 0), c.viewProjection, pixelAt(1), W, H, 5)!
    assert.equal(drag.moveAt(pixelAt(3)), null) // the nearest point is about 10 from the camera
    const roomy = AxisDrag.begin("x", vec3(0, 0, 0), c.viewProjection, pixelAt(1), W, H, 50)!
    near(roomy.moveAt(pixelAt(3))!, 2, 1e-4)
  })

  test("near the axis's vanishing point every answer is finite or null", () => {
    // The camera looks down -X from (20, 1, 0): the X axis runs along its view direction
    const view = viewMatrix(vec3(20, 1, 0), quatFromAxisAngle(vec3(0, 1, 0), Math.PI / 2))
    const vp = mat4Multiply(projectionMatrix(settings, W / H), view)
    const start = worldToScreen(vp, vec3(10, 0, 0), W, H)!
    const drag = AxisDrag.begin("x", vec3(0, 0, 0), vp, start, W, H, 1000, 100)
    assert.ok(drag)
    for (let x = 0; x < W; x += 20) {
      for (let y = 0; y < H; y += 20) {
        const move = drag!.moveAt({ x, y })
        assert.ok(move === null || (Number.isFinite(move) && Math.abs(move) <= 100 * 1000), `${x},${y}: ${move}`)
      }
    }
  })

  test("one update moves the object by at most maxStep: a flick stays bounded", () => {
    const drag = AxisDrag.begin("x", vec3(0, 0, 0), c.viewProjection, pixelAt(1), W, H, Infinity, 2)!
    near(drag.moveAt(pixelAt(100))!, 2, 1e-9)
    near(drag.moveAt(pixelAt(100))!, 4, 1e-9) // the next update goes on from there
    near(drag.moveAt(pixelAt(-100))!, 2, 1e-9)
  })
})

describe("the gizmo at other pixel ratios", () => {
  test("the handles are twice as long in frame pixels at ratio 2, and so is the pick distance", () => {
    const c = camera(vec3(0, 0, 10))
    const one = gizmoLayout(c.view, c.viewProjection, vec3(0, 0, 0), W, H, 1)!
    const two = gizmoLayout(c.view, c.viewProjection, vec3(0, 0, 0), W, H, 2)!
    const len = (l: typeof one) => Math.hypot(l.handles[0].to.x - l.handles[0].from.x, l.handles[0].to.y - l.handles[0].from.y)
    near(len(two) / len(one), 2, 0.02)
    const x = two.handles.find((h) => h.axis === "x")!
    const pixel = { x: (x.from.x + x.to.x) / 2, y: x.from.y + 14 }
    assert.equal(hitTestGizmo(two, pixel, 1), null) // 14 frame pixels is out of reach at ratio 1
    assert.equal(hitTestGizmo(two, pixel, 2), "x") // and within 16 at ratio 2
  })
})
