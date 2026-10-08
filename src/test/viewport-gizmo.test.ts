import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { Mat4, Quat, Vec3 } from "../protocol/protocol.generated"
import {
  AxisDrag,
  GizmoLayout,
  PlaneDrag,
  PlaneMinFacing,
  hitTestGizmo as hitTest,
  pointInQuad,
  rayPlane,
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
function targetUnder(
  parent: Trs,
  localPosition: Vec3,
  localRotation: Quat = IdentityQuat,
  localScale = vec3(1, 1, 1),
  id = "obj"
): GizmoTarget {
  const world = combine(parent, { position: localPosition, rotation: localRotation, scale: localScale })
  return {
    id,
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

/** A camera orbiting the origin: yaw and pitch in radians, at a distance */
function orbitCamera(yaw: number, pitch: number, distance = 10, target = vec3(0, 0, 0)) {
  const q = quatMultiply(quatFromAxisAngle(vec3(0, 1, 0), yaw), quatFromAxisAngle(vec3(1, 0, 0), pitch))
  const forward = quatRotate(q, vec3(0, 0, -1))
  const position = vec3(target.x - forward.x * distance, target.y - forward.y * distance, target.z - forward.z * distance)
  const view = viewMatrix(position, q)
  const projection = projectionMatrix(settings, W / H)
  return { view, viewProjection: mat4Multiply(projection, view), position }
}

describe("plane handles", () => {
  const origin = vec3(0, 0, 0)

  test("from an oblique camera all three squares are there, and each lies on the side that faces the camera", () => {
    for (const [yaw, pitch] of [
      [0.6, -0.5],
      [-0.6, -0.5],
      [2.5, -0.5],
      [0.6, 0.5],
    ]) {
      const c = orbitCamera(yaw, pitch)
      const layout = gizmoLayout(c.view, c.viewProjection, origin, W, H)!
      assert.equal(layout.planes.length, 3, `${yaw}, ${pitch}`)
      const L = layout.worldLength
      for (const handle of layout.planes) {
        const axes = { xy: ["x", "y"], xz: ["x", "z"], yz: ["y", "z"] }[handle.plane]
        const toCamera = vec3(c.position.x, c.position.y, c.position.z)
        const dir = (a: string) => (a === "x" ? vec3(1, 0, 0) : a === "y" ? vec3(0, 1, 0) : vec3(0, 0, 1))
        const side = (a: string) => (dir(a).x * toCamera.x + dir(a).y * toCamera.y + dir(a).z * toCamera.z >= 0 ? 1 : -1)
        const mid = (a: string, b: string) =>
          worldToScreen(
            c.viewProjection,
            vec3(
              (dir(a).x * side(a) + dir(b).x * side(b)) * 0.475 * L,
              (dir(a).y * side(a) + dir(b).y * side(b)) * 0.475 * L,
              (dir(a).z * side(a) + dir(b).z * side(b)) * 0.475 * L
            ),
            W,
            H
          )!
        assert.ok(pointInQuad(mid(axes[0], axes[1]), handle.corners), `${handle.plane} at ${yaw}, ${pitch}`)
        // The square on the far side of the axes is not where it was drawn
        const wrong = worldToScreen(
          c.viewProjection,
          vec3(
            (-dir(axes[0]).x * side(axes[0]) - dir(axes[1]).x * side(axes[1])) * 0.475 * L,
            (-dir(axes[0]).y * side(axes[0]) - dir(axes[1]).y * side(axes[1])) * 0.475 * L,
            (-dir(axes[0]).z * side(axes[0]) - dir(axes[1]).z * side(axes[1])) * 0.475 * L
          ),
          W,
          H
        )!
        assert.ok(!pointInQuad(wrong, handle.corners), `${handle.plane} is not on the far side`)
      }
    }
  })

  test("a plane seen edge-on is hidden, and fades in as it turns toward the camera", () => {
    const edgeOn = orbitCamera(0, 0) // looking along -Z at the origin: the XZ and YZ planes are edge-on
    const layout = gizmoLayout(edgeOn.view, edgeOn.viewProjection, origin, W, H)!
    assert.deepEqual(layout.planes.map((p) => p.plane), ["xy"])
    assert.equal(layout.planes[0].alpha, 1)

    // The XZ plane's facing is sin(pitch): just under the limit it is hidden, just over it is faint, well over it is solid
    const pitchFor = (facing: number) => -Math.asin(facing)
    const hidden = orbitCamera(0, pitchFor(PlaneMinFacing * 0.9))
    assert.equal(gizmoLayout(hidden.view, hidden.viewProjection, origin, W, H)!.planes.find((p) => p.plane === "xz"), undefined)
    const f = orbitCamera(0, pitchFor(0.2))
    const faint = gizmoLayout(f.view, f.viewProjection, origin, W, H)!
    const xz = faint.planes.find((p) => p.plane === "xz")!
    assert.ok(xz.alpha > 0 && xz.alpha < 1, `alpha ${xz.alpha}`)
    const solid = orbitCamera(0, pitchFor(0.6))
    assert.equal(gizmoLayout(solid.view, solid.viewProjection, origin, W, H)!.planes.find((p) => p.plane === "xz")!.alpha, 1)
  })

  test("an edge-on plane can't be grabbed: a pixel where its square would be hits nothing", () => {
    const c = orbitCamera(0, 0)
    const layout = gizmoLayout(c.view, c.viewProjection, origin, W, H)!
    // Where the XZ square would be if it were drawn (below the origin, toward the camera's side)
    const where = worldToScreen(c.viewProjection, vec3(0.5 * layout.worldLength, 0, 0.5 * layout.worldLength), W, H)!
    const hit = hitTest(layout, where)
    assert.ok(hit === null || hit === "x" || hit === "xy")
    assert.notEqual(hit, "xz")
  })
})

describe("hit priority between axes and planes", () => {
  const quad = (x0: number, y0: number, x1: number, y1: number): GizmoLayout["planes"][number]["corners"] => [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]
  const layout: GizmoLayout = {
    origin: { x: 0, y: 0 },
    worldLength: 1,
    handles: [{ axis: "x", from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }],
    planes: [
      { plane: "xy", corners: quad(20, -30, 60, 30), alpha: 0.5 },
      { plane: "xz", corners: quad(40, -10, 80, 50), alpha: 1 },
    ],
  }

  test("an axis within reach beats a square under the pointer", () => {
    assert.equal(hitTest(layout, { x: 30, y: 2 }), "x") // inside the xy square, and on the axis
    assert.equal(hitTest(layout, { x: 30, y: 7 }), "x") // within the 8 pixels
  })

  test("outside the axis's reach the square that holds the pixel is taken", () => {
    assert.equal(hitTest(layout, { x: 30, y: 20 }), "xy")
    assert.equal(hitTest(layout, { x: 30, y: 9 }), "xy") // 9 pixels: just out of reach
    assert.equal(hitTest(layout, { x: 70, y: 40 }), "xz")
  })

  test("where two squares overlap the one facing the camera more wins; elsewhere nothing", () => {
    assert.equal(hitTest(layout, { x: 50, y: 20 }), "xz")
    assert.equal(hitTest(layout, { x: 200, y: 200 }), null)
  })

  test("the pick distance scales with the pixel ratio", () => {
    assert.equal(hitTest(layout, { x: 30, y: 9 }, 2), "x")
  })

  test("pointInQuad: inside, on the edge, outside, either winding", () => {
    const q = quad(0, 0, 10, 10)
    assert.equal(pointInQuad({ x: 5, y: 5 }, q), true)
    assert.equal(pointInQuad({ x: 10, y: 5 }, q), true)
    assert.equal(pointInQuad({ x: 11, y: 5 }, q), false)
    assert.equal(pointInQuad({ x: 5, y: 5 }, [...q].reverse()), true)
  })
})

describe("PlaneDrag", () => {
  const c = orbitCamera(0.7, -0.6, 12)
  const origin = vec3(1, 2, 3)
  const pixelOf = (p: Vec3) => worldToScreen(c.viewProjection, p, W, H)!

  test("the object follows the pointer in the plane: the world move is the pointer's, and has nothing out of the plane", () => {
    for (const [plane, a, b] of [
      ["xz", vec3(1, 0, 0), vec3(0, 0, 1)],
      ["xy", vec3(1, 0, 0), vec3(0, 1, 0)],
      ["yz", vec3(0, 1, 0), vec3(0, 0, 1)],
    ] as const) {
      const at = (u: number, v: number) =>
        vec3(origin.x + a.x * u + b.x * v, origin.y + a.y * u + b.y * v, origin.z + a.z * u + b.z * v)
      const drag = PlaneDrag.begin(plane, origin, c.viewProjection, pixelOf(at(0.5, 0.5)), W, H)!
      const delta = drag.deltaAt(pixelOf(at(2.5, -1.5)))!
      nearVec(delta, vec3(a.x * 2 + b.x * -2, a.y * 2 + b.y * -2, a.z * 2 + b.z * -2), 1e-4)
      nearVec(drag.deltaAt(pixelOf(at(0.5, 0.5)))!, vec3(0, 0, 0), 1e-9)
    }
  })

  test("the handle's name is the plane", () => {
    assert.equal(PlaneDrag.begin("xz", origin, c.viewProjection, pixelOf(origin), W, H)!.handle, "xz")
  })

  test("a ray nearly parallel to the plane is rejected: at the start, and later in the drag", () => {
    // From just above the XZ plane looking along -Z: the plane is edge-on for every ray
    const low = orbitCamera(0, -0.01, 12, origin)
    const start = worldToScreen(low.viewProjection, origin, W, H)!
    assert.equal(PlaneDrag.begin("xz", origin, low.viewProjection, start, W, H), null)
    // Begun from a good view, a later pixel whose ray runs along the plane is no answer
    const drag = PlaneDrag.begin("xz", origin, c.viewProjection, pixelOf(origin), W, H)!
    assert.equal(rayPlane({ origin: vec3(0, 5, 0), direction: vec3(1, 0.001, 0) }, origin, vec3(0, 1, 0)), null)
    assert.ok(drag.deltaAt(pixelOf(vec3(2, 2, 4))))
  })

  test("a ray that meets the plane behind the camera, or beyond the far plane, is not followed", () => {
    // The plane through the origin seen from above: pixels above the horizon of a tilted-up camera meet it behind
    const up = orbitCamera(0, 0.5, 12)
    assert.equal(rayPlane({ origin: up.position, direction: vec3(0, -1, 0) }, origin, vec3(0, 1, 0)), null)
    const near = PlaneDrag.begin("xz", origin, c.viewProjection, pixelOf(origin), W, H, 5)
    assert.equal(near, null) // the plane's point is about 12 away
    const drag = PlaneDrag.begin("xz", origin, c.viewProjection, pixelOf(origin), W, H, 100)!
    assert.equal(drag.deltaAt(pixelOf(vec3(-1000, 2, -1000))), null) // meets it too far out
  })

  test("one update moves the object by at most maxStep", () => {
    const drag = PlaneDrag.begin("xz", origin, c.viewProjection, pixelOf(origin), W, H, Infinity, 2)!
    const first = drag.deltaAt(pixelOf(vec3(-10, 2, -10)))!
    near(Math.hypot(first.x, first.y, first.z), 2, 1e-9)
    const second = drag.deltaAt(pixelOf(vec3(-10, 2, -10)))!
    near(Math.hypot(second.x, second.y, second.z), 4, 1e-9)
    // And it can come back
    const back = drag.deltaAt(pixelOf(origin))!
    near(Math.hypot(back.x, back.y, back.z), 2, 1e-9)
  })

  test("the vanishing line of the plane: pixels near the horizon give finite answers or none, never huge ones", () => {
    const low = orbitCamera(0, -0.2, 12, origin)
    const start = worldToScreen(low.viewProjection, vec3(1.5, 2, 4), W, H)!
    const drag = PlaneDrag.begin("xz", origin, low.viewProjection, start, W, H, 1000, 50)
    assert.ok(drag)
    for (let y = 0; y < H; y += 10) {
      const d = drag!.deltaAt({ x: W / 2, y })
      assert.ok(d === null || Math.hypot(d.x, d.y, d.z) <= 50 * 61, `${y}`)
    }
  })
})

describe("GizmoDrag with a plane, and with several objects", () => {
  function rig() {
    const log: string[] = []
    const calls: Array<{ id: string; position: Vec3 }> = []
    const errors: string[] = []
    const refuse = new Set<string>()
    const deps = {
      engine: {
        setLocalTransform: async (id: string, position: Vec3) => {
          if (refuse.has(id)) throw new Error("No such object")
          log.push(`set ${id}`)
          calls.push({ id, position })
        },
      },
      groups: {
        begin: async (label: string) => (log.push(`begin ${label}`), 1),
        end: async () => void log.push("end"),
      },
      onError: (what: string) => errors.push(what),
    }
    return { deps, log, calls, errors, refuse }
  }

  const c = orbitCamera(0.7, -0.6, 12)
  const pixelOf = (p: Vec3) => worldToScreen(c.viewProjection, p, W, H)!

  test("a plane drag moves along both of its axes, and ctrl snaps those two (not the third)", async () => {
    const { deps, calls } = rig()
    const target = targetUnder(rootTrs, vec3(1, 2, 3))
    const origin = mat4Translation(target.worldMatrix)
    const drag = new GizmoDrag(deps, target, PlaneDrag.begin("xy", origin, c.viewProjection, pixelOf(vec3(1.3, 2.3, 3)), W, H)!)
    drag.update(pixelOf(vec3(1.3 + 0.8, 2.3 + 0.3, 3)), true) // a move of (0.8, 0.3): snapped to (1, 0.5)
    await drag.end()
    const last = calls[calls.length - 1].position
    nearVec(last, vec3(2, 2.5, 3), 1e-3)
    nearVec(drag.worldDelta, vec3(1, 0.5, 0), 1e-3)
  })

  test("several objects: each goes by the same world delta through its own parents (rotated, scaled, nested)", async () => {
    const { deps, log, calls } = rig()
    const quarterZ = quatFromAxisAngle(vec3(0, 0, 1), Math.PI / 2)
    const parentA: Trs = { position: vec3(1, 2, 3), rotation: IdentityQuat, scale: vec3(2, 1, 1) }
    const parentB: Trs = { position: vec3(-4, 5, 6), rotation: quatFromAxisAngle(vec3(1, 2, 3), 0.8), scale: vec3(2, 0.5, 3) }
    const a = targetUnder(parentA, vec3(1, 1, 0), quarterZ, vec3(1, 1, 1), "a")
    const b = targetUnder(parentB, vec3(3, -2, 1), quatFromAxisAngle(vec3(0, 1, 1), 1.3), vec3(1.5, 2, 0.25), "b")
    const root = targetUnder(rootTrs, vec3(7, 7, 7), IdentityQuat, vec3(1, 1, 1), "c")
    const targets = [a, b, root]
    const origin = mat4Translation(a.worldMatrix)
    const drag = new GizmoDrag(deps, targets, PlaneDrag.begin("xz", origin, c.viewProjection, pixelOf(vec3(origin.x + 0.4, origin.y, origin.z + 0.4)), W, H)!)
    drag.update(pixelOf(vec3(origin.x + 2.4, origin.y, origin.z - 0.6)))
    await drag.end()
    assert.equal(log.filter((l) => l.startsWith("begin")).length, 1)
    assert.equal(log[0], "begin Move 3 objects")
    assert.equal(log[log.length - 1], "end")
    const delta = drag.worldDelta
    for (const [t, parent] of [
      [a, parentA],
      [b, parentB],
      [root, rootTrs],
    ] as const) {
      const call = calls.filter((x) => x.id === t.id).pop()!
      const before = mat4Translation(t.worldMatrix)
      nearVec(worldPositionWith(parent, t, call.position), vec3(before.x + delta.x, before.y + delta.y, before.z + delta.z), 1e-6)
    }
  })

  test("an object the host refuses is reported once and left out; the others go on, and the group ends", async () => {
    const { deps, calls, errors, refuse, log } = rig()
    const a = targetUnder(rootTrs, vec3(0, 0, 0), IdentityQuat, vec3(1, 1, 1), "a")
    const b = targetUnder(rootTrs, vec3(5, 0, 0), IdentityQuat, vec3(1, 1, 1), "b")
    refuse.add("b")
    const drag = new GizmoDrag(deps, [a, b], AxisDrag.begin("x", vec3(0, 0, 0), c.viewProjection, pixelOf(vec3(0.5, 0, 0)), W, H)!)
    for (const x of [1.5, 2.5, 3.5]) {
      drag.update(pixelOf(vec3(x, 0, 0)))
      await new Promise((resolve) => setImmediate(resolve))
    }
    await drag.end()
    assert.deepEqual(errors, ["Failed to move the object"])
    assert.ok(calls.filter((x) => x.id === "a").length >= 1)
    nearVec(calls.filter((x) => x.id === "a").pop()!.position, vec3(3, 0, 0), 1e-3)
    assert.equal(log[log.length - 1], "end")
  })

  test("an object with no usable parent chain (zero scale) is skipped while the others move", async () => {
    const { deps, calls } = rig()
    const flat = targetUnder(rootTrs, vec3(0, 0, 0), IdentityQuat, vec3(1, 0, 1), "flat")
    const fine = targetUnder(rootTrs, vec3(0, 0, 0), IdentityQuat, vec3(1, 1, 1), "fine")
    const drag = new GizmoDrag(deps, [flat, fine], AxisDrag.begin("x", vec3(0, 0, 0), c.viewProjection, pixelOf(vec3(0.5, 0, 0)), W, H)!)
    drag.update(pixelOf(vec3(1.5, 0, 0)))
    await drag.end()
    assert.deepEqual([...new Set(calls.map((x) => x.id))], ["fine"])
  })

  test("cancel puts every object back, and abandon drops what is waiting", async () => {
    const { deps, calls } = rig()
    const a = targetUnder(rootTrs, vec3(1, 0, 0), IdentityQuat, vec3(1, 1, 1), "a")
    const b = targetUnder(rootTrs, vec3(5, 0, 0), IdentityQuat, vec3(1, 1, 1), "b")
    const drag = new GizmoDrag(deps, [a, b], AxisDrag.begin("x", vec3(1, 0, 0), c.viewProjection, pixelOf(vec3(1.5, 0, 0)), W, H)!)
    drag.update(pixelOf(vec3(4.5, 0, 0)))
    await drag.cancel()
    nearVec(calls.filter((x) => x.id === "a").pop()!.position, vec3(1, 0, 0))
    nearVec(calls.filter((x) => x.id === "b").pop()!.position, vec3(5, 0, 0))
  })
})

describe("negative scales", () => {
  const mirrorX: Trs = { position: vec3(0, 0, 0), rotation: IdentityQuat, scale: vec3(-1, 1, 1) }

  function assertMoves(parent: Trs, target: GizmoTarget, delta: Vec3, withParent: boolean): void {
    const t = withParent ? { ...target, parentWorld: mat4Compose(parent.position, parent.rotation, parent.scale) } : target
    const local = localPositionAfterMove(t, delta)!
    assert.ok(local, "a local position")
    const before = mat4Translation(target.worldMatrix)
    nearVec(worldPositionWith(parent, target, local), vec3(before.x + delta.x, before.y + delta.y, before.z + delta.z), 1e-9)
  }

  test("a root mirrored on X, dragged +1 on X, moves +1 (the column's sign is the object's own scale's)", () => {
    const target = targetUnder(rootTrs, vec3(2, 0, 0), IdentityQuat, vec3(-1, 1, 1))
    nearVec(localPositionAfterMove(target, vec3(1, 0, 0))!, vec3(3, 0, 0))
    assertMoves(rootTrs, target, vec3(1, 0, 0), false)
  })

  test("a rotated root with a scale of (1, -2, 1) moves by the world delta, from the matrix alone", () => {
    const rotation = quatFromAxisAngle(vec3(1, 2, 3), 0.9)
    const target = targetUnder(rootTrs, vec3(1, 2, 3), rotation, vec3(1, -2, 1))
    for (const d of [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1), vec3(2, -3, 4)]) assertMoves(rootTrs, target, d, false)
  })

  test("a mirrored child under a rotated, scaled parent, derived from the child's matrix", () => {
    const parent: Trs = { position: vec3(-4, 5, 6), rotation: quatFromAxisAngle(vec3(1, 2, 3), 0.8), scale: vec3(2, 0.5, 3) }
    const target = targetUnder(parent, vec3(3, -2, 1), quatFromAxisAngle(vec3(0, 1, 1), 1.3), vec3(-1.5, 2, -0.25))
    for (const d of [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1), vec3(-3, 2, 5)]) assertMoves(parent, target, d, false)
  })

  test("a mirrored parent with a rotated child: can be wrong from the child's matrix alone, exact with the parent's", () => {
    const parent: Trs = { position: vec3(1, 2, 3), rotation: quatFromAxisAngle(vec3(0, 1, 0), 0.6), scale: vec3(-1, 1, 1) }
    const target = targetUnder(parent, vec3(2, 1, 0), quatFromAxisAngle(vec3(0, 0, 1), 0.7), vec3(1, -1, 1))
    const before = mat4Translation(target.worldMatrix)
    let off = 0
    for (const d of [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]) {
      const guessed = localPositionAfterMove(target, d)!
      const after = worldPositionWith(parent, target, guessed)
      off += Math.hypot(after.x - (before.x + d.x), after.y - (before.y + d.y), after.z - (before.z + d.z))
    }
    assert.ok(off > 1e-3, "nothing in the child's matrix says the parent is mirrored")
    for (const d of [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1), vec3(2, -3, 4)]) assertMoves(parent, target, d, true)
  })

  test("a parent with its own scale (2, -1, 3) and a child with (1, -1, -2), through the parent's world matrix", () => {
    const parent: Trs = { position: vec3(0, 1, 0), rotation: quatFromAxisAngle(vec3(1, 1, 0), 1.1), scale: vec3(2, -1, 3) }
    const target = targetUnder(parent, vec3(1, 2, 3), quatFromAxisAngle(vec3(0, 0, 1), 0.4), vec3(1, -1, -2))
    for (const d of [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1), vec3(-2, 3, 1)]) assertMoves(parent, target, d, true)
  })

  test("with the parent's world matrix, a child with a zero scale on one axis moves; a parent with no inverse can't", () => {
    const parent: Trs = { position: vec3(0, 0, 0), rotation: IdentityQuat, scale: vec3(2, 1, 1) }
    const flat = { ...targetUnder(parent, vec3(1, 1, 1), IdentityQuat, vec3(1, 0, 1)), parentWorld: mat4Compose(parent.position, parent.rotation, parent.scale) }
    nearVec(localPositionAfterMove(flat, vec3(4, 0, 0))!, vec3(3, 1, 1))
    const singular = { ...flat, parentWorld: mat4Compose(vec3(0, 0, 0), IdentityQuat, vec3(1, 0, 1)) }
    assert.equal(localPositionAfterMove(singular, vec3(1, 0, 0)), null)
  })
})

describe("GizmoDrag: abandon, batches and failures", () => {
  const c = orbitCamera(0.7, -0.6, 12)
  const pixelOf = (p: Vec3) => worldToScreen(c.viewProjection, p, W, H)!
  const at = (id: string, x = 0) => targetUnder(rootTrs, vec3(x, 0, 0), IdentityQuat, vec3(1, 1, 1), id)
  const source = () => AxisDrag.begin("x", vec3(0, 0, 0), c.viewProjection, pixelOf(vec3(0.5, 0, 0)), W, H)!
  const turn = () => new Promise((resolve) => setImmediate(resolve))

  /** An engine whose calls wait on gates the test opens, and fail on demand */
  function gated() {
    const started: string[] = []
    const done: string[] = []
    const errors: string[] = []
    const gates = new Map<string, () => void>()
    const fail = new Map<string, string>()
    const hold = new Set<string>()
    const deps = {
      engine: {
        setLocalTransform: async (id: string) => {
          started.push(id)
          if (hold.has(id)) await new Promise<void>((resolve) => gates.set(id, resolve))
          if (fail.has(id)) throw new Error(fail.get(id))
          done.push(id)
        },
      },
      groups: { begin: async () => 1, end: async () => {} },
      onError: (what: string, e: unknown) => errors.push(`${what}: ${(e as Error).message}`),
    }
    return { deps, started, done, errors, gates, fail, hold }
  }

  test("a batch's calls are sent together, not one after the other", async () => {
    const { deps, started, hold, gates } = gated()
    hold.add("a").add("b").add("c")
    const drag = new GizmoDrag(deps, [at("a"), at("b"), at("c")], source())
    drag.update(pixelOf(vec3(1.5, 0, 0)))
    for (let i = 0; i < 5; i++) await turn()
    assert.deepEqual(started, ["a", "b", "c"], "all three are out before any answer")
    for (const open of gates.values()) open()
    await drag.end()
  })

  test("abandon with a batch in flight: the calls not yet sent are not, nothing waits for the host, nobody is told", async () => {
    const { deps, started, done, errors, hold, gates, fail } = gated()
    hold.add("a")
    fail.set("a", "connection closed")
    // Two batches: the first is held on "a"; abandon happens while it is
    const drag = new GizmoDrag(deps, [at("a"), at("b")], source())
    drag.update(pixelOf(vec3(1.5, 0, 0)))
    for (let i = 0; i < 5; i++) await turn()
    drag.update(pixelOf(vec3(2.5, 0, 0))) // waiting behind the first
    const abandoned = drag.abandon()
    gates.get("a")!() // the call that was on its way fails: the connection is gone
    await abandoned
    assert.deepEqual(started.filter((id) => id === "b").length, 1, "the waiting batch was dropped")
    assert.equal(started.length, 2)
    assert.deepEqual(done, ["b"])
    assert.deepEqual(errors, [], "silent")
  })

  test("a batch cut short by abandon sends no more calls", async () => {
    const { deps, started } = gated()
    const drag = new GizmoDrag(deps, [at("a"), at("b"), at("c")], source())
    void drag.abandon() // before anything is sent
    drag.update(pixelOf(vec3(1.5, 0, 0)))
    await drag.end()
    assert.deepEqual(started, [])
  })

  test("a transient failure is reported once and the object is tried again; 'not found' leaves it out", async () => {
    const { deps, started, errors, fail } = gated()
    fail.set("a", "timed out")
    fail.set("b", "Entity not found: b")
    const drag = new GizmoDrag(deps, [at("a"), at("b")], source())
    for (const x of [1.5, 2.5, 3.5]) {
      drag.update(pixelOf(vec3(x, 0, 0)))
      for (let i = 0; i < 4; i++) await turn()
    }
    await drag.end()
    assert.ok(started.filter((id) => id === "a").length >= 2, "a is tried again")
    assert.equal(started.filter((id) => id === "b").length, 1, "b is not tried again")
    assert.equal(errors.length, 2, "one report each")
  })

  test("escape puts back an object whose move failed transiently, and one that was moved", async () => {
    const { deps, started, fail } = gated()
    fail.set("a", "timed out")
    const drag = new GizmoDrag(deps, [at("a", 1), at("b", 5)], source())
    drag.update(pixelOf(vec3(2.5, 0, 0)))
    for (let i = 0; i < 4; i++) await turn()
    fail.delete("a") // the host is back
    await drag.cancel()
    assert.ok(started.filter((id) => id === "a").length >= 2, "a was restored")
    assert.ok(started.filter((id) => id === "b").length >= 2, "b was restored")
  })

  test("an object that can't be moved (a zero scale, with no parent matrix) is reported once, the others move", async () => {
    const { deps, started, errors } = gated()
    const flat = targetUnder(rootTrs, vec3(0, 0, 0), IdentityQuat, vec3(1, 0, 1), "flat")
    const drag = new GizmoDrag(deps, [flat, at("ok")], source())
    for (const x of [1.5, 2.5, 3.5]) drag.update(pixelOf(vec3(x, 0, 0)))
    await drag.end()
    assert.ok(started.every((id) => id === "ok"))
    assert.equal(errors.length, 1)
    assert.match(errors[0], /Cube can't be moved/)
  })
})
