import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { act, screen, waitFor } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { signal } from "@preact/signals-core"
import type { ComponentSchema, EntityDetails, LocalTransform, Quat, Vec3 } from "../protocol/protocol.generated"
import type { JsonObject } from "../shared/api"
import { EditGroups } from "../renderer/edit-groups"
import { eulerToQuat, quatsEquivalent } from "../renderer/euler"
import { InspectorState } from "../renderer/inspector-state"
import { InspectorPanel } from "../renderer/inspector-panel"
import { MixedMark } from "../renderer/inspector-editors"
import type { Selection } from "../renderer/hierarchy-tree"
import { renderWithApp } from "./helpers"

const lightType: ComponentSchema = {
  typeName: "Light",
  singleton: false,
  fields: [
    { name: "intensity", displayName: "Intensity", kind: "Float", typeName: "float", hidden: false, readOnly: false },
  ],
}

const transformOf = (x: number, rotation: Quat, scale = 1): LocalTransform => ({
  position: { x, y: 2, z: 3 },
  rotation,
  scale: { x: scale, y: scale, z: scale },
})

/** A fake host: objects with a local transform, a light and a header, and a log of every command it received */
function host(initial: Record<string, { name: string; transform: LocalTransform; intensity: number; active?: boolean }>) {
  const objects = new Map(Object.entries(initial).map(([id, o]) => [id, { ...o, active: o.active ?? true }]))
  const calls: Array<[string, unknown[]]> = []
  const log = (name: string, ...args: unknown[]) => calls.push([name, args])
  const detailsOf = (id: string): EntityDetails => {
    const o = objects.get(id)!
    return {
      header: { id, parentId: "", index: 0, name: o.name, active: o.active, activeInHierarchy: o.active, layer: 0, tag: "" },
      transform: structuredClone(o.transform),
      components: [{ type: "Light", uuid: `${id}-light`, values: { isActive: true, intensity: o.intensity } }],
    }
  }
  const undoStack: Array<() => void> = []
  const engine = {
    isConnected: () => true,
    getEntity: async (id: string) => ({ entity: detailsOf(id), worldMatrix: [] }),
    getComponentTypes: async () => [lightType],
    addComponent: async () => ({ componentId: "x", values: {} }),
    removeComponent: async () => {},
    getLuaFields: async (): Promise<ComponentSchema> => ({ typeName: "LuaComponent", singleton: false, fields: [] }),
    setEntityProperties: async (id: string, properties: JsonObject) => {
      log("setEntityProperties", id, properties)
      Object.assign(objects.get(id)!, properties)
    },
    setComponentFields: async (id: string, _component: string, values: JsonObject) => {
      log("setComponentFields", id, values)
      const o = objects.get(id)!
      if (typeof values.intensity === "number") o.intensity = values.intensity
      return { isActive: true, intensity: o.intensity }
    },
    setLocalTransform: async (id: string, position: Vec3, rotation: Quat, scale: Vec3) => {
      log("setLocalTransform", id, position, rotation, scale)
      const o = objects.get(id)!
      const before = o.transform
      undoStack.push(() => (o.transform = before))
      o.transform = { position, rotation, scale }
    },
    beginEditGroup: async (label: string) => void log("beginEditGroup", label),
    endEditGroup: async () => void log("endEditGroup"),
  }
  const sent = (name: string) => calls.filter(([n]) => n === name)
  return { engine, calls, sent, undo: () => undoStack.pop()?.() }
}

async function render(
  initial: Parameters<typeof host>[0],
  options: { ids: string[]; readOnly?: string | null } = { ids: ["e1"] }
) {
  const fake = host(initial)
  const groups = new EditGroups(fake.engine)
  const errors: string[] = []
  const inspector = new InspectorState(
    fake.engine,
    { listAssets: async () => [] },
    { confirm: async () => true, onError: (what) => void errors.push(what), groups }
  )
  await inspector.loadTypes()
  const primary = options.ids[0]
  await inspector.select(primary)
  if (options.ids.length > 1) await inspector.multi.select(options.ids)
  if (options.readOnly) inspector.setReadOnly(options.readOnly)
  const selection = signal<Selection>({ ids: new Set(options.ids), anchor: primary, primary })
  const reported: string[] = []
  const view = renderWithApp(<InspectorPanel />, {
    store: { connected: signal(true), reportError: (what: string, e: unknown) => void reported.push(`${what}: ${e}`) } as never,
    scene: { selectedId: signal<string | null>(primary) },
    hierarchy: { selection, deleteSelected: async () => {} } as never,
    inspector,
    // The panel asks the extensions for the sections of each component: there are none here
    extensions: { sectionsFor: () => [] } as never,
  })
  return { ...fake, inspector, reported, errors, view, user: userEvent.setup() }
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement

/** Types into a number box and presses Enter */
async function typeInto(user: ReturnType<typeof userEvent.setup>, label: string, text: string) {
  const box = input(label)
  await user.clear(box)
  await user.type(box, `${text}{Enter}`)
}

const q = (x: number, y: number, z: number) => eulerToQuat({ x, y, z })
const two = {
  e1: { name: "A", transform: transformOf(1, q(10, 20, 30)), intensity: 1 },
  e2: { name: "B", transform: transformOf(5, q(10, 20, 30)), intensity: 2 },
}

describe("the inspector's transform row (one object)", () => {
  test("shows the LOCAL transform: position, rotation as Euler degrees, scale", async () => {
    await render({ e1: two.e1 })
    assert.equal(input("Position x").value, "1")
    assert.equal(input("Position y").value, "2")
    assert.equal(input("Rotation x").value, "10")
    assert.equal(input("Rotation y").value, "20")
    assert.equal(input("Rotation z").value, "30")
    assert.equal(input("Scale x").value, "1")
  })

  test("typing a position and pressing Enter is ONE SetLocalTransform that leaves the rotation as stored", async () => {
    const t = await render({ e1: two.e1 })
    const stored = t.inspector.transform.value!.rotation
    await typeInto(t.user, "Position x", "7.5")
    const sends = t.sent("setLocalTransform")
    assert.equal(sends.length, 1)
    assert.deepEqual(sends[0][1].slice(0, 2), ["e1", { x: 7.5, y: 2, z: 3 }])
    assert.deepEqual(sends[0][1][2], stored)
    // No legacy world-Euler command exists on this host; one group is not needed for one command
    assert.deepEqual(t.reported, [])
  })

  test("leaving the box commits, once (Tab after typing)", async () => {
    const t = await render({ e1: two.e1 })
    const box = input("Position z")
    await t.user.clear(box)
    await t.user.type(box, "9")
    await t.user.tab()
    assert.equal(t.sent("setLocalTransform").length, 1)
    assert.equal((t.sent("setLocalTransform")[0][1][1] as Vec3).z, 9)
  })

  test("pressing Enter without typing sends nothing (the box shows the value rounded)", async () => {
    const t = await render({ e1: two.e1 })
    await t.user.click(input("Position x"))
    await t.user.keyboard("{Enter}")
    assert.equal(t.sent("setLocalTransform").length, 0)
  })

  test("a rotation edit sends the quaternion of the angles; 180 stays 180 after the host's answer", async () => {
    const t = await render({ e1: { ...two.e1, transform: transformOf(1, q(0, 0, 0)) } })
    await typeInto(t.user, "Rotation x", "180")
    const sends = t.sent("setLocalTransform")
    assert.equal(sends.length, 1)
    assert.ok(quatsEquivalent(sends[0][1][2] as Quat, q(180, 0, 0)))
    await waitFor(() => assert.equal(input("Rotation x").value, "180"))
    // Another read of the object (the scene's change event) doesn't flip it to -180
    await act(async () => {
      await t.inspector.applyChange({ full: false, entityIds: ["e1"] })
    })
    assert.equal(input("Rotation x").value, "180")
    assert.equal(input("Rotation y").value, "0")
    assert.equal(input("Rotation z").value, "0")
  })

  test("a typed text that isn't a number sends nothing and says so", async () => {
    const t = await render({ e1: two.e1 })
    await typeInto(t.user, "Scale y", "abc")
    assert.equal(t.sent("setLocalTransform").length, 0)
    assert.equal(t.reported.length, 1)
    assert.match(t.reported[0], /must be a number/)
  })

  test("undo (the host puts the old transform back) is shown after the next read", async () => {
    const t = await render({ e1: two.e1 })
    await typeInto(t.user, "Position x", "40")
    await waitFor(() => assert.equal(input("Position x").value, "40"))
    t.undo()
    await act(async () => {
      await t.inspector.applyChange({ full: false, entityIds: ["e1"] })
    })
    assert.equal(input("Position x").value, "1")
    assert.equal(input("Rotation y").value, "20")
  })

  test("another client or the gizmo moving the object is shown", async () => {
    const t = await render({ e1: two.e1 })
    // The host's copy changes behind the inspector's back
    await t.engine.setLocalTransform("e1", { x: 11, y: 2, z: 3 }, q(0, 0, 45), { x: 1, y: 1, z: 1 })
    await act(async () => {
      await t.inspector.applyChange({ full: false, entityIds: ["e1"] })
    })
    assert.equal(input("Position x").value, "11")
    assert.equal(input("Rotation z").value, "45")
  })

  test("a refused edit goes back to the old value and shows the host's message", async () => {
    const t = await render({ e1: two.e1 })
    t.engine.setLocalTransform = async () => {
      throw new Error("The entity is locked")
    }
    await typeInto(t.user, "Position x", "3")
    await waitFor(() => assert.match(document.body.textContent ?? "", /The entity is locked/))
    await waitFor(() => assert.equal(input("Position x").value, "1"))
  })

  test("read-only: the boxes are disabled and no command is sent", async () => {
    const t = await render({ e1: two.e1 }, { ids: ["e1"], readOnly: "a play session is running" })
    for (const label of ["Position x", "Rotation y", "Scale z"]) assert.equal(input(label).disabled, true, label)
    await t.user.type(input("Position x"), "5{Enter}")
    assert.equal(t.sent("setLocalTransform").length, 0)
  })

  test("an object with no transform says so", async () => {
    const fake = host({ e1: two.e1 })
    const original = fake.engine.getEntity
    fake.engine.getEntity = async (id: string) => {
      const data = await original(id)
      return { ...data, entity: { ...data.entity, transform: undefined } }
    }
    const inspector = new InspectorState(fake.engine, { listAssets: async () => [] }, { confirm: async () => true })
    await inspector.select("e1")
    renderWithApp(<InspectorPanel />, {
      store: { connected: signal(true), reportError: () => {} } as never,
      scene: { selectedId: signal<string | null>("e1") },
      hierarchy: { selection: signal<Selection>({ ids: new Set(["e1"]), anchor: "e1", primary: "e1" }), deleteSelected: async () => {} } as never,
      inspector,
      extensions: { sectionsFor: () => [] } as never,
    })
    assert.ok(screen.getByText("This object has no transform"))
  })
})

describe("the inspector with several objects selected", () => {
  test("says how many, and shows a dash where the objects differ", async () => {
    await render(two, { ids: ["e1", "e2"] })
    assert.ok(screen.getByText("2 objects"))
    // Position x differs (1 and 5), y doesn't
    assert.equal(input("Position x").value, "")
    assert.equal(input("Position x").placeholder, MixedMark)
    assert.equal(input("Position y").value, "2")
    assert.equal(input("Rotation y").value, "20")
  })

  test("a position edit is applied to both as ONE edit group, each keeping its other axes", async () => {
    const t = await render(two, { ids: ["e1", "e2"] })
    t.calls.length = 0
    await typeInto(t.user, "Position y", "8")
    await waitFor(() => assert.equal(t.sent("setLocalTransform").length, 2))
    assert.deepEqual(
      t.calls.map(([n]) => n).filter((n) => n !== "getEntity"),
      ["beginEditGroup", "setLocalTransform", "setLocalTransform", "endEditGroup"]
    )
    assert.deepEqual(t.sent("beginEditGroup")[0][1], ["Edit 2 objects"])
    const positions = t.sent("setLocalTransform").map(([, a]) => [a[0], a[1]])
    assert.deepEqual(positions, [
      ["e1", { x: 1, y: 8, z: 3 }],
      ["e2", { x: 5, y: 8, z: 3 }],
    ])
    // Read back, they agree on y
    await waitFor(() => assert.equal(input("Position y").value, "8"))
  })

  test("a shared component's field is edited on all of them, once", async () => {
    const t = await render(two, { ids: ["e1", "e2"] })
    // The two lights differ (1 and 2): a dash
    const box = input("Intensity")
    assert.equal(box.placeholder, MixedMark)
    t.calls.length = 0
    await typeInto(t.user, "Intensity", "4")
    await waitFor(() => assert.equal(t.sent("setComponentFields").length, 2))
    assert.deepEqual(t.sent("setComponentFields").map(([, a]) => [a[0], a[1]]), [
      ["e1", { intensity: 4 }],
      ["e2", { intensity: 4 }],
    ])
    assert.equal(t.sent("beginEditGroup").length, 1)
    assert.equal(t.sent("endEditGroup").length, 1)
    await waitFor(() => assert.equal(input("Intensity").value, "4"))
  })

  test("the Active box shows a dash (indeterminate) for objects that differ, and one click sets all", async () => {
    const t = await render(
      { e1: { ...two.e1, active: true }, e2: { ...two.e2, active: false } },
      { ids: ["e1", "e2"] }
    )
    const active = input("Active")
    assert.equal(active.indeterminate, true)
    t.calls.length = 0
    await t.user.click(active)
    await waitFor(() => assert.equal(t.sent("setEntityProperties").length, 1))
    // Only the one that differed gets the command
    assert.deepEqual(t.sent("setEntityProperties")[0][1], ["e2", { active: true }])
    await waitFor(() => assert.equal((screen.getByLabelText("Active") as HTMLInputElement).indeterminate, false))
  })

  test("read-only: every box is disabled and nothing is sent", async () => {
    const t = await render(two, { ids: ["e1", "e2"], readOnly: "a play session is running" })
    for (const label of ["Position x", "Rotation y", "Scale z", "Intensity", "Tag", "Layer"]) {
      assert.equal(input(label).disabled, true, label)
    }
    t.calls.length = 0
    await t.user.click(input("Active"))
    assert.deepEqual(t.calls, [])
  })

  test("a refused object is reported with how many were changed", async () => {
    const t = await render(two, { ids: ["e1", "e2"] })
    const real = t.engine.setLocalTransform
    t.engine.setLocalTransform = async (id: string, p: Vec3, r: Quat, s: Vec3) => {
      if (id === "e2") throw new Error("B is locked")
      return real(id, p, r, s)
    }
    await typeInto(t.user, "Scale x", "3")
    await waitFor(() => assert.match(document.body.textContent ?? "", /1 of 2 changes failed \(1 applied/))
    assert.match(document.body.textContent ?? "", /B is locked/)
    assert.equal(t.sent("endEditGroup").length, 1)
  })
})
