import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { EditorCameraResponse, EntityDataResponse, Mat4, Quat, Vec3 } from "../protocol/protocol.generated"
import { PickBackend, ViewportController, ViewportDeps, maxMatrixDifference } from "../renderer/viewport-controller"
import { Bounds, DefaultCamera, PointFrameDistance } from "../renderer/viewport-camera"
import { IdentityQuat, mat4Compose, vec3, worldToScreen } from "../renderer/viewport-math"

const near = (actual: number, expected: number, epsilon = 1e-6, what = ""): void =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${what} ${actual} is not ${expected}`)

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

function entityAt(position: Vec3, name = "Cube"): EntityDataResponse {
  return {
    entity: {
      header: { id: "a", parentId: "", index: 0, name, active: true, activeInHierarchy: true, layer: 0, tag: "" },
      transform: { position, rotation: IdentityQuat, scale: vec3(1, 1, 1) },
      components: [],
    },
    worldMatrix: mat4Compose(position, IdentityQuat, vec3(1, 1, 1)),
  }
}

function rig(
  options: {
    picking?: PickBackend | null
    hostCamera?: Partial<EditorCameraResponse>
    /** The selection beyond the primary: every selected id, and the topmost of them (what a drag moves) */
    selection?: { all: string[]; top: string[] }
  } = {}
) {
  const log: string[] = []
  const cameras: Array<{ position: Vec3; rotation: Quat; fovY: number }> = []
  const errors: string[] = []
  const notes: string[] = []
  const selected: Array<string | null> = []
  let frames = 0
  let current: string | null = "a"
  let connected = true
  let entity = entityAt(vec3(1, 2, 3))
  const others = new Map<string, EntityDataResponse>()
  /** Objects whose SetLocalTransform the host refuses (they are gone) */
  const gone = new Set<string>()
  let entityReads = 0
  // The matrices the host reports: filled by the test from the controller's own, unless it wants them wrong
  const host: { view?: Mat4; projection?: Mat4 } = {}
  const controllerRef: { current?: ViewportController } = {}

  const deps: ViewportDeps = {
    engine: {
      isConnected: () => connected,
      setEditorCamera: async (position, rotation, fovY) => {
        log.push("setEditorCamera")
        cameras.push({ position, rotation, fovY })
      },
      getEditorCamera: async () => {
        const mine = controllerRef.current!.matrices()
        return {
          position: vec3(0, 0, 10),
          rotation: IdentityQuat,
          fovY: 60,
          orthographic: false,
          orthoSize: 5,
          nearPlane: 0.1,
          farPlane: 1000,
          view: host.view ?? mine?.view ?? new Array(16).fill(0),
          projection: host.projection ?? mine?.projection ?? new Array(16).fill(0),
          ...options.hostCamera,
        }
      },
      getEntity: async (id) => {
        entityReads++
        return others.get(id) ?? entity
      },
      setLocalTransform: async (id, position) => {
        if (gone.has(id)) throw new Error(`No such object ${id}`)
        log.push(`setLocalTransform ${id} ${position.x.toFixed(2)} ${position.y.toFixed(2)} ${position.z.toFixed(2)}`)
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
    picking: options.picking ?? null,
    onError: (what) => errors.push(what),
    onNote: (message) => notes.push(message),
    canEdit: () => true,
    selected: () => current,
    moveIds: () => options.selection?.top ?? (current === null ? [] : [current]),
    selectionIds: () => options.selection?.all ?? (current === null ? [] : [current]),
    select: (id) => selected.push(id),
  }
  const controller = new ViewportController(deps)
  controllerRef.current = controller
  controller.onFrameNeeded(() => frames++)
  controller.setSize({ width: 800, height: 600 })
  return {
    controller,
    log,
    cameras,
    errors,
    notes,
    selected,
    host,
    frames: () => frames,
    entityReads: () => entityReads,
    setSelected: (id: string | null) => (current = id),
    setEntity: (e: EntityDataResponse) => (entity = e),
    setOther: (id: string, e: EntityDataResponse) => others.set(id, e),
    gone,
    disconnect: () => (connected = false),
  }
}

describe("the camera", () => {
  test("connecting starts the camera where the host's is", async () => {
    const r = rig({ hostCamera: { position: vec3(0, 5, 20), rotation: IdentityQuat } })
    await r.controller.connected()
    assert.deepEqual(
      [r.controller.camera.position.x, r.controller.camera.position.y, r.controller.camera.position.z].map((v) => Math.round(v * 1e4) / 1e4),
      [0, 5, 20]
    )
  })

  test("moving the camera sends the pose, one request at a time with the newest winning, and asks for a frame after each", async () => {
    const r = rig()
    for (let i = 0; i < 30; i++) r.controller.orbit(5, 0)
    await settle()
    assert.ok(r.cameras.length >= 1 && r.cameras.length <= 3, `${r.cameras.length} SetEditorCamera calls`)
    // The host ends on the final pose
    const last = r.cameras[r.cameras.length - 1]
    near(last.position.x, r.controller.camera.position.x, 1e-9)
    assert.ok(r.frames() >= 1)
    assert.equal(r.frames(), r.cameras.length)
  })

  test("a disconnected host is not sent a pose", async () => {
    const r = rig()
    r.disconnect()
    r.controller.zoom(100)
    await settle()
    assert.equal(r.cameras.length, 0)
  })

  test("pan needs a viewport size", () => {
    const r = rig()
    r.controller.setSize(null)
    const before = r.controller.camera.version
    r.controller.pan(10, 10)
    assert.equal(r.controller.camera.version, before)
  })

  test("the matrices follow the viewport's aspect ratio", () => {
    const r = rig()
    const wide = r.controller.matrices()!.projection
    r.controller.setSize({ width: 400, height: 600 })
    const narrow = r.controller.matrices()!.projection
    assert.ok(Math.abs(wide[0] - narrow[0]) > 0.1)
    r.controller.setSize(null)
    assert.equal(r.controller.matrices(), null)
  })
})

describe("verifyMatrices", () => {
  test("says nothing when the host's matrices are the ones computed here", async () => {
    const r = rig()
    await r.controller.verifyMatrices()
    assert.deepEqual(r.notes, [])
  })

  test("says so once when they differ", async () => {
    const r = rig()
    const mine = r.controller.matrices()!
    r.host.view = mine.view.map((v, i) => (i === 12 ? v + 5 : v))
    r.host.projection = mine.projection
    await r.controller.verifyMatrices()
    await r.controller.verifyMatrices()
    assert.equal(r.notes.length, 1)
    assert.match(r.notes[0], /differs from the editor host's/)
  })

  test("maxMatrixDifference", () => {
    assert.equal(maxMatrixDifference([1, 2, 3], [1, 2.5, 3]), 0.5)
    assert.equal(maxMatrixDifference([1], [1, 2]), Infinity)
  })
})

describe("frame selected", () => {
  test("without bounds from the host it frames the object's world position", async () => {
    const r = rig()
    await r.controller.connected()
    assert.equal(await r.controller.frameSelected(), true)
    const camera = r.controller.camera
    near(camera.target.x, 1)
    near(camera.target.y, 2)
    near(camera.target.z, 3)
    near(camera.distance, PointFrameDistance)
    await settle()
    assert.ok(r.cameras.length >= 1, "the new pose was sent")
  })

  test("nothing selected: nothing to frame", async () => {
    const r = rig()
    r.setSelected(null)
    assert.equal(await r.controller.frameSelected(), false)
    assert.equal(r.cameras.length, 0)
  })

  test("with the host's bounds it frames those", async () => {
    const bounds: Bounds = { min: vec3(0, 0, 0), max: vec3(10, 10, 10) }
    const asked: string[][] = []
    const r = rig({
      picking: {
        pick: async () => null,
        bounds: async (ids) => {
          asked.push(ids)
          return new Map([["a", bounds]])
        },
      },
    })
    assert.equal(await r.controller.frameSelected(), true)
    assert.deepEqual(asked[0], ["a"])
    near(r.controller.camera.target.x, 5)
    assert.ok(r.controller.camera.distance > PointFrameDistance, "the box is bigger than a point")
  })

  test("bounds the host can't give fall back to the position; so does a failing bounds call", async () => {
    const r = rig({
      picking: {
        pick: async () => null,
        bounds: async () => {
          throw new Error("no such command")
        },
      },
    })
    assert.equal(await r.controller.frameSelected(), true)
    near(r.controller.camera.target.x, 1)
    const none = rig({ picking: { pick: async () => null, bounds: async () => null } })
    assert.equal(await none.controller.frameSelected(), true)
    near(none.controller.camera.target.y, 2)
  })

  test("an object that has no transform can't be framed", async () => {
    const r = rig()
    const entity = entityAt(vec3(0, 0, 0))
    r.setEntity({ ...entity, entity: { ...entity.entity, transform: undefined } })
    assert.equal(await r.controller.frameSelected(), false)
  })
})

describe("the selected object", () => {
  test("is read for the gizmo, and read again when a change names it, not when one names others", async () => {
    const r = rig()
    await r.controller.loadTarget("a")
    assert.equal(r.controller.target.value?.name, "Cube")
    const reads = r.entityReads()
    r.controller.objectsChanged(["b"], false)
    await settle()
    assert.equal(r.entityReads(), reads)
    r.controller.objectsChanged(["a"], false)
    await settle()
    assert.equal(r.entityReads(), reads + 1)
    r.controller.objectsChanged([], true)
    await settle()
    assert.equal(r.entityReads(), reads + 2)
  })

  test("none selected, or no connection: no gizmo", async () => {
    const r = rig()
    await r.controller.loadTarget("a")
    await r.controller.loadTarget(null)
    assert.equal(r.controller.target.value, null)
    assert.equal(r.controller.layout(), null)
  })

  test("disconnecting forgets it", async () => {
    const r = rig()
    await r.controller.loadTarget("a")
    r.controller.disconnected()
    assert.equal(r.controller.target.value, null)
  })

  test("a slow answer for an earlier selection doesn't replace the newer one", async () => {
    const r = rig()
    const first = r.controller.loadTarget("a")
    r.setEntity(entityAt(vec3(9, 9, 9), "Newer"))
    await r.controller.loadTarget("a")
    await first
    assert.equal(r.controller.target.value?.name, "Newer")
  })
})

describe("the gizmo drag", () => {
  /** A controller with an object at (1, 2, 3) in front of the default camera, and where its X handle is on screen */
  async function withGizmo() {
    const r = rig()
    await r.controller.loadTarget("a")
    const layout = r.controller.layout()!
    const handle = layout.handles.find((h) => h.axis === "x")!
    // On the X handle: the screen position of a point 0.6 units along X from the object (the handle is longer than that)
    const onHandle = worldToScreen(r.controller.matrices()!.viewProjection, vec3(1.6, 2, 3), 800, 600)!
    return { r, layout, handle, onHandle }
  }

  test("a press on a handle takes the drag; a press elsewhere doesn't", async () => {
    const { r, onHandle } = await withGizmo()
    assert.equal(r.controller.pointerDown({ x: 5, y: 5 }, false), false)
    await r.controller.pointerUp({ x: 5, y: 5 })
    assert.equal(r.controller.pointerDown(onHandle, false), true)
    assert.equal(r.controller.dragging.value, true)
    await r.controller.pointerUp(onHandle)
    assert.equal(r.controller.dragging.value, false)
  })

  test("a drag is one edit group of moves along the axis, and the gizmo follows the pointer at once", async () => {
    const { r, onHandle } = await withGizmo()
    const m = r.controller.matrices()!
    r.controller.pointerDown(onHandle, false)
    // Move the pointer to where the world point two units further along X is
    const further = worldToScreen(m.viewProjection, vec3(1.6 + 2, 2, 3), 800, 600)!
    const before = r.controller.layout()!.origin.x
    r.controller.pointerMove(further, false)
    assert.ok(r.controller.layout()!.origin.x > before, "the gizmo moved with the drag, before any answer")
    await r.controller.pointerUp(further)
    assert.equal(r.log[0], "begin Move Cube")
    assert.equal(r.log[r.log.length - 1], "end")
    const sets = r.log.filter((l) => l.startsWith("setLocalTransform"))
    assert.ok(sets.length >= 1)
    assert.equal(sets[sets.length - 1], "setLocalTransform a 3.00 2.00 3.00") // 1 + 2
    assert.ok(r.frames() >= 1, "a frame was asked for after the move")
  })

  test("a change of the scene during a drag doesn't replace the object under the pointer", async () => {
    const { r, onHandle } = await withGizmo()
    r.controller.pointerDown(onHandle, false)
    const reads = r.entityReads()
    r.controller.objectsChanged(["a"], false) // the echo of the drag's own edit
    await settle()
    assert.equal(r.entityReads(), reads)
    await r.controller.pointerUp(onHandle)
    // After the drag the host's reading is taken again
    assert.ok(r.entityReads() > reads)
  })

  test("cancel ends the group and puts the object back", async () => {
    const { r, onHandle } = await withGizmo()
    const m = r.controller.matrices()!
    r.controller.pointerDown(onHandle, false)
    r.controller.pointerMove(worldToScreen(m.viewProjection, vec3(4, 2, 3), 800, 600)!, false)
    await r.controller.cancel()
    assert.equal(r.controller.dragging.value, false)
    assert.equal(r.log[r.log.length - 1], "end")
    const sets = r.log.filter((l) => l.startsWith("setLocalTransform"))
    assert.equal(sets[sets.length - 1], "setLocalTransform a 1.00 2.00 3.00")
  })

  test("gestureEnded resolves when the group has ended (what an undo waits for)", async () => {
    const { r, onHandle } = await withGizmo()
    r.controller.pointerDown(onHandle, false)
    const up = r.controller.pointerUp(onHandle)
    await r.controller.gestureEnded
    assert.equal(r.log[r.log.length - 1], "end")
    await up
  })

  test("hovering a handle lights it up, and leaving clears it", async () => {
    const { r, onHandle } = await withGizmo()
    const before = r.controller.overlayVersion.value
    r.controller.hover(onHandle)
    assert.equal(r.controller.hoverHandle.value, "x")
    assert.ok(r.controller.overlayVersion.value > before)
    r.controller.hover({ x: 5, y: 5 })
    assert.equal(r.controller.hoverHandle.value, null)
  })
})

describe("click to select (the E7b seam)", () => {
  test("with no picking backend a click selects nothing and asks the host nothing", async () => {
    const r = rig()
    assert.equal(r.controller.canPick, false)
    r.controller.pointerDown({ x: 100, y: 100 }, false)
    await r.controller.pointerUp({ x: 101, y: 100 })
    assert.deepEqual(r.selected, [])
    assert.deepEqual(r.errors, [])
  })

  test("with one, a click selects what is under the pointer; empty space selects none; a drag doesn't select", async () => {
    const picked: Array<[number, number, boolean]> = []
    let answer: string | null = "b"
    const r = rig({
      picking: {
        pick: async (x, y, includeInactive) => {
          picked.push([x, y, includeInactive])
          return answer
        },
        bounds: async () => null,
      },
    })
    assert.equal(r.controller.canPick, true)
    r.controller.pointerDown({ x: 100, y: 100 }, false)
    await r.controller.pointerUp({ x: 102, y: 101 })
    assert.deepEqual(r.selected, ["b"])
    assert.deepEqual(picked, [[102, 101, false]])

    answer = null
    r.controller.pointerDown({ x: 300, y: 300 }, false)
    await r.controller.pointerUp({ x: 300, y: 300 })
    assert.deepEqual(r.selected, ["b", null])

    r.controller.pointerDown({ x: 300, y: 300 }, false)
    await r.controller.pointerUp({ x: 340, y: 300 }) // dragged: not a click
    assert.equal(picked.length, 2)
  })

  test("a failed pick is reported, not thrown", async () => {
    const r = rig({
      picking: {
        pick: async () => {
          throw new Error("boom")
        },
        bounds: async () => null,
      },
    })
    r.controller.pointerDown({ x: 1, y: 1 }, false)
    await r.controller.pointerUp({ x: 1, y: 1 })
    assert.deepEqual(r.errors, ["Failed to pick an object"])
  })

  test("the selection box is drawn from the host's bounds when it has them", async () => {
    const r = rig({
      picking: {
        pick: async () => null,
        bounds: async () => new Map([["a", { min: vec3(0, 0, 0), max: vec3(2, 2, 2) }]]),
      },
    })
    await r.controller.loadTarget("a")
    assert.equal(r.controller.boxEdges().length, 12)
    const plain = rig()
    await plain.controller.loadTarget("a")
    assert.equal(plain.controller.boxEdges().length, 0)
  })
})

test("the defaults match the host's documented camera", () => {
  assert.deepEqual(DefaultCamera.position, vec3(0, 0, 10))
  assert.equal(DefaultCamera.fovY, 60)
  assert.equal(DefaultCamera.nearPlane, 0.1)
  assert.equal(DefaultCamera.farPlane, 1000)
})

describe("a drag and what happens around it", () => {
  async function dragging() {
    const r = rig()
    await r.controller.loadTarget("a")
    const m = r.controller.matrices()!
    const onHandle = worldToScreen(m.viewProjection, vec3(1.6, 2, 3), 800, 600)!
    r.controller.pointerDown(onHandle, false)
    r.controller.pointerMove(worldToScreen(m.viewProjection, vec3(3.6, 2, 3), 800, 600)!, false)
    return { r, onHandle, m }
  }

  test("endActiveDrag finishes the drag (its group ends) before an undo goes on, and the release after it does nothing", async () => {
    const { r, onHandle } = await dragging()
    await r.controller.endActiveDrag()
    assert.equal(r.controller.dragging.value, false)
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    const sets = r.log.filter((l) => l.startsWith("setLocalTransform")).length
    assert.ok(sets >= 1, "the move so far was sent before the group ended")
    assert.ok(r.log.lastIndexOf("end") > r.log.map((l) => l.startsWith("setLocalTransform")).lastIndexOf(true))
    r.controller.pointerMove(onHandle, false) // the pointer is still down: nothing is sent any more
    await r.controller.pointerUp(onHandle)
    await settle()
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    assert.equal(r.log.filter((l) => l.startsWith("setLocalTransform")).length, sets)
    assert.equal(r.log.filter((l) => l.startsWith("begin")).length, 1)
  })

  test("endActiveDrag with no drag resolves", async () => {
    const r = rig()
    await r.controller.endActiveDrag()
  })

  test("the camera is frozen while a handle is dragged: wheel, orbit, pan, look, fly and frame do nothing", async () => {
    const { r } = await dragging()
    const version = r.controller.camera.version
    r.controller.zoom(100)
    r.controller.orbit(10, 10)
    r.controller.pan(10, 10)
    r.controller.look(10, 10)
    r.controller.fly(vec3(0, 0, 1), 1, false)
    assert.equal(await r.controller.frameSelected(), false)
    assert.equal(r.controller.camera.version, version)
    await r.controller.cancel()
    r.controller.zoom(100)
    assert.ok(r.controller.camera.version > version)
  })

  test("a disconnect mid-drag drops what is waiting and ends the group", async () => {
    const { r } = await dragging()
    r.disconnect()
    r.controller.disconnected()
    await r.controller.gestureEnded
    assert.equal(r.controller.dragging.value, false)
    assert.equal(r.controller.target.value, null)
    assert.ok(r.log.includes("end"))
    const sets = r.log.filter((l) => l.startsWith("setLocalTransform")).length
    await settle()
    assert.equal(r.log.filter((l) => l.startsWith("setLocalTransform")).length, sets)
  })

  test("another scene loaded mid-drag (a full change) abandons the drag; a change naming other objects does not", async () => {
    const { r } = await dragging()
    r.controller.objectsChanged(["other"], false)
    assert.equal(r.controller.dragging.value, true)
    r.controller.objectsChanged([], true)
    await r.controller.gestureEnded
    assert.equal(r.controller.dragging.value, false)
    assert.ok(r.log.includes("end"))
  })
})

describe("the pixel ratio and the frame's size", () => {
  test("setSize says whether the size changed, and only that redraws", () => {
    const r = rig()
    const version = r.controller.overlayVersion.value
    assert.equal(r.controller.setSize({ width: 800, height: 600 }), false)
    assert.equal(r.controller.overlayVersion.value, version)
    assert.equal(r.controller.setSize({ width: 1600, height: 1200 }), true)
    assert.ok(r.controller.overlayVersion.value > version)
  })

  test("a press that moved 6 frame pixels is a click at ratio 2 and a drag at ratio 1", async () => {
    const picked: number[] = []
    const picking: PickBackend = { pick: async (x) => (picked.push(x), null), bounds: async () => null }
    const two = rig({ picking })
    two.controller.setPixelRatio(2)
    two.controller.pointerDown({ x: 100, y: 100 }, false)
    await two.controller.pointerUp({ x: 106, y: 100 })
    assert.equal(picked.length, 1)
    const one = rig({ picking })
    one.controller.pointerDown({ x: 100, y: 100 }, false)
    await one.controller.pointerUp({ x: 106, y: 100 })
    assert.equal(picked.length, 1)
  })

  test("connecting verifies the matrices at the end, once the camera was adopted", async () => {
    const r = rig()
    const mine = r.controller.matrices()!
    r.host.view = mine.view.map((v, i) => (i === 12 ? v + 5 : v))
    r.host.projection = mine.projection
    await r.controller.connected()
    assert.equal(r.notes.length, 1)
  })
})

describe("plane handles through the controller", () => {
  test("a press on a plane square takes the drag and moves the object in that plane only, in one group", async () => {
    const r = rig()
    await r.controller.loadTarget("a")
    const layout = r.controller.layout()!
    const xy = layout.planes.find((p) => p.plane === "xy")!
    const centre = {
      x: xy.corners.reduce((sum, c) => sum + c.x, 0) / 4,
      y: xy.corners.reduce((sum, c) => sum + c.y, 0) / 4,
    }
    r.controller.hover(centre)
    assert.equal(r.controller.hoverHandle.value, "xy")
    assert.equal(r.controller.pointerDown(centre, false), true)
    r.controller.pointerMove({ x: centre.x + 40, y: centre.y - 20 }, false)
    await r.controller.pointerUp({ x: centre.x + 40, y: centre.y - 20 })
    assert.equal(r.log[0], "begin Move Cube")
    assert.equal(r.log[r.log.length - 1], "end")
    const sets = r.log.filter((l) => l.startsWith("setLocalTransform"))
    const last = sets[sets.length - 1].split(" ")
    assert.notEqual(last[2], "1.00", "x moved")
    assert.notEqual(last[3], "2.00", "y moved")
    assert.equal(last[4], "3.00", "z stays: the plane is XY")
  })

  test("the squares are hidden and can't be taken while the plane is edge-on", async () => {
    const r = rig()
    await r.controller.loadTarget("a")
    // Look from the object's own height straight along its XZ plane: that plane is edge-on
    r.controller.camera.adopt({ position: vec3(1, 2, 13), rotation: IdentityQuat, fovY: 60, nearPlane: 0.1, farPlane: 1000 }, 10)
    const layout = r.controller.layout()!
    assert.equal(layout.planes.find((p) => p.plane === "xz"), undefined)
    assert.ok(layout.planes.find((p) => p.plane === "xy"))
  })
})

describe("moving the whole selection", () => {
  const second = () => entityAt(vec3(10, 0, 0), "Sphere")

  /** Two selected objects, "a" and "b", both topmost; the gizmo on "a" */
  async function two(options: { top?: string[] } = {}) {
    const r = rig({ selection: { all: ["a", "b"], top: options.top ?? ["a", "b"] } })
    r.setOther("b", second())
    await r.controller.loadTarget("a")
    const m = r.controller.matrices()!
    const onHandle = worldToScreen(m.viewProjection, vec3(1.6, 2, 3), 800, 600)!
    return { r, m, onHandle }
  }

  test("every selected object moves by the same world delta, in one group", async () => {
    const { r, m, onHandle } = await two()
    r.controller.pointerDown(onHandle, false)
    const to = worldToScreen(m.viewProjection, vec3(3.6, 2, 3), 800, 600)!
    r.controller.pointerMove(to, false)
    await r.controller.pointerUp(to)
    assert.equal(r.log.filter((l) => l.startsWith("begin")).length, 1)
    assert.equal(r.log[0], "begin Move 2 objects")
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    const sets = r.log.filter((l) => l.startsWith("setLocalTransform"))
    assert.ok(sets.includes("setLocalTransform a 3.00 2.00 3.00"))
    assert.ok(sets.includes("setLocalTransform b 12.00 0.00 0.00"))
    // The group ended after the last move of either
    assert.ok(r.log.lastIndexOf("end") > r.log.map((l) => l.startsWith("setLocalTransform")).lastIndexOf(true))
  })

  test("an object under a selected one is not moved by itself: only the topmost the selection names", async () => {
    const { r, m, onHandle } = await two({ top: ["a"] })
    r.controller.pointerDown(onHandle, false)
    const to = worldToScreen(m.viewProjection, vec3(3.6, 2, 3), 800, 600)!
    r.controller.pointerMove(to, false)
    await r.controller.pointerUp(to)
    assert.equal(r.log[0], "begin Move Cube")
    assert.deepEqual(
      r.log.filter((l) => l.startsWith("setLocalTransform b")),
      []
    )
  })

  test("an object that vanishes mid-drag is reported once and the others go on", async () => {
    const { r, m, onHandle } = await two()
    r.controller.pointerDown(onHandle, false)
    r.gone.add("b")
    for (const x of [2.6, 3.6, 4.6]) r.controller.pointerMove(worldToScreen(m.viewProjection, vec3(x, 2, 3), 800, 600)!, false)
    await r.controller.pointerUp(worldToScreen(m.viewProjection, vec3(4.6, 2, 3), 800, 600)!)
    assert.deepEqual(r.errors, ["Failed to move the object"])
    const a = r.log.filter((l) => l.startsWith("setLocalTransform a"))
    assert.equal(a[a.length - 1], "setLocalTransform a 4.00 2.00 3.00")
    assert.equal(r.log[r.log.length - 1], "end")
  })

  test("cancel puts every object back", async () => {
    const { r, m, onHandle } = await two()
    r.controller.pointerDown(onHandle, false)
    r.controller.pointerMove(worldToScreen(m.viewProjection, vec3(4.6, 2, 3), 800, 600)!, false)
    await r.controller.cancel()
    const sets = r.log.filter((l) => l.startsWith("setLocalTransform"))
    assert.ok(sets.includes("setLocalTransform a 1.00 2.00 3.00"))
    assert.ok(sets.includes("setLocalTransform b 10.00 0.00 0.00"))
    assert.equal(r.log[r.log.length - 1], "end")
  })

  test("undo during a drag finishes it for every object first", async () => {
    const { r, m, onHandle } = await two()
    r.controller.pointerDown(onHandle, false)
    r.controller.pointerMove(worldToScreen(m.viewProjection, vec3(3.6, 2, 3), 800, 600)!, false)
    await r.controller.endActiveDrag()
    assert.equal(r.controller.dragging.value, false)
    assert.equal(r.log.filter((l) => l === "end").length, 1)
    assert.equal(r.log.filter((l) => l.startsWith("setLocalTransform")).length, 2)
  })

  test("a change to any selected object reloads the targets; one to another does not", async () => {
    const { r } = await two()
    const reads = r.entityReads()
    r.controller.objectsChanged(["zzz"], false)
    await settle()
    assert.equal(r.entityReads(), reads)
    r.controller.objectsChanged(["b"], false)
    await settle()
    assert.ok(r.entityReads() > reads)
  })

  test("the gizmo sits on the primary selection, and without a drag the primary needs no transform of its own", async () => {
    const { r } = await two()
    assert.equal(r.controller.target.value?.id, "a")
    const noTransform = rig({ selection: { all: ["a", "b"], top: ["b"] } })
    const e = entityAt(vec3(0, 0, 0))
    noTransform.setEntity({ ...e, entity: { ...e.entity, transform: undefined } })
    noTransform.setOther("b", second())
    await noTransform.controller.loadTarget("a")
    assert.equal(noTransform.controller.target.value?.id, "b")
  })
})
