import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { ComponentSchema, EntityDetails, FieldSchema, LocalTransform, Quat, Vec3 } from "../protocol/protocol.generated"
import { ipcError } from "../shared/api"
import type { JsonObject } from "../shared/api"
import { EditGroups } from "../renderer/edit-groups"
import { eulerToQuat, quatToEuler, quatsEquivalent } from "../renderer/euler"
import {
  MultiInspectorState,
  buildMultiView,
  fieldMixed,
  isMultiEditable,
  mixedAxes,
  multiFields,
} from "../renderer/inspector-multi"

const field = (name: string, kind: string, extra: Partial<FieldSchema> = {}): FieldSchema => ({
  name,
  displayName: name,
  kind,
  typeName: kind === "Int" ? "int" : "float",
  hidden: false,
  readOnly: false,
  ...extra,
})

const S1 = "11111111-1111-1111-1111-111111111111"
const S2 = "22222222-2222-2222-2222-222222222222"

const lightSchema: ComponentSchema = {
  typeName: "Light",
  singleton: false,
  fields: [
    field("intensity", "Float"),
    field("tint", "Vector3"),
    field("mode", "Enum", { enumOptions: ["Point", "Spot"] }),
    field("label", "String"),
    field("target", "GameObjectRef"),
    field("extra", "Json"),
    field("serial", "Int", { readOnly: true }),
  ],
}
const luaSchema: ComponentSchema = {
  typeName: "LuaComponent",
  singleton: false,
  fields: [field("scriptUUID", "AssetRef", { assetType: "LuaScript" }), field("speed", "Float", { container: "scriptData" })],
}
const types = [lightSchema, { typeName: "LuaComponent", singleton: false, fields: [field("scriptUUID", "AssetRef")] }]

const identity: Quat = { x: 0, y: 0, z: 0, w: 1 }
const transformOf = (x: number, rotation: Quat = identity, scale = 1): LocalTransform => ({
  position: { x, y: 2, z: 3 },
  rotation,
  scale: { x: scale, y: scale, z: scale },
})

interface Spec {
  name?: string
  active?: boolean
  tag?: string
  layer?: number
  transform?: LocalTransform | null
  light?: JsonObject | null
  lua?: { script: string; speed: number } | null
}

function detailsOf(id: string, spec: Spec = {}): EntityDetails {
  const components = []
  if (spec.light !== null) {
    components.push({
      type: "Light",
      uuid: `${id}-light`,
      values: spec.light ?? { isActive: true, intensity: 1, tint: { x: 1, y: 1, z: 1 }, mode: "Point", label: "a" },
    })
  }
  if (spec.lua) {
    components.push({
      type: "LuaComponent",
      uuid: `${id}-lua`,
      values: { isActive: true, scriptUUID: spec.lua.script, scriptData: { speed: spec.lua.speed } },
    })
  }
  return {
    header: {
      id,
      parentId: "",
      index: 0,
      name: spec.name ?? id.toUpperCase(),
      active: spec.active ?? true,
      activeInHierarchy: true,
      layer: spec.layer ?? 0,
      tag: spec.tag ?? "",
    },
    transform: spec.transform === null ? undefined : (spec.transform ?? transformOf(0)),
    components,
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function world(specs: Record<string, Spec>, options: { groups?: boolean } = { groups: true }) {
  const objects = new Map(Object.entries(specs).map(([id, spec]) => [id, detailsOf(id, spec)]))
  const calls: Array<[string, unknown[]]> = []
  const refuse = new Map<string, { message: string; code?: string }>()
  const errors: Array<[string, unknown]> = []
  const host = { types: { value: types as readonly ComponentSchema[] | null }, readOnlyReason: { value: null as string | null } }
  const gate = (id: string) => {
    const refusal = refuse.get(id)
    if (refusal) throw ipcError({ error: refusal.message, code: refusal.code })
  }
  const failures = new Map<string, Error>()
  const failing = (command: string) => {
    const error = failures.get(command)
    if (error) throw error
  }
  const asked: string[] = []
  const state = { answer: true }
  const find = (id: string) => {
    const object = objects.get(id)
    if (!object) throw new Error(`Entity not found: ${id}`)
    return object
  }
  const engine = {
    isConnected: () => true,
    getEntity: async (id: string) => {
      calls.push(["getEntity", [id]])
      await tick()
      return { entity: structuredClone(find(id)), worldMatrix: [] }
    },
    getLuaFields: async (entityId: string, componentId: string) => {
      calls.push(["getLuaFields", [entityId, componentId]])
      return luaSchema
    },
    setEntityProperties: async (id: string, properties: JsonObject) => {
      calls.push(["setEntityProperties", [id, properties]])
      gate(id)
      Object.assign(find(id).header, properties)
    },
    setComponentFields: async (id: string, componentId: string, values: JsonObject) => {
      calls.push(["setComponentFields", [id, componentId, values]])
      gate(id)
      const component = find(id).components.find((c) => c.uuid === componentId)!
      const stored = component.values as JsonObject
      for (const [key, value] of Object.entries(values)) {
        stored[key] = key === "scriptData" ? { ...(stored.scriptData as JsonObject), ...(value as JsonObject) } : value
      }
      return stored
    },
    setLocalTransform: async (id: string, position: Vec3, rotation: Quat, scale: Vec3) => {
      calls.push(["setLocalTransform", [id, position, rotation, scale]])
      failing("setLocalTransform")
      gate(id)
      find(id).transform = { position, rotation, scale }
    },
    addComponent: async (id: string, typeName: string) => {
      calls.push(["addComponent", [id, typeName]])
      gate(id)
      const componentId = `${id}-${typeName.toLowerCase()}-${find(id).components.length}`
      find(id).components.push({ type: typeName, uuid: componentId, values: { isActive: true } })
      return { componentId, values: { isActive: true } }
    },
    removeComponent: async (id: string, componentId: string) => {
      calls.push(["removeComponent", [id, componentId]])
      gate(id)
      const object = find(id)
      object.components = object.components.filter((c) => c.uuid !== componentId)
    },
  }
  const groups = options.groups
    ? new EditGroups({
        isConnected: () => true,
        beginEditGroup: async (label: string) => void calls.push(["beginEditGroup", [label]]),
        endEditGroup: async () => void calls.push(["endEditGroup", []]),
      })
    : undefined
  const multi = new MultiInspectorState(host, engine, {
    groups,
    onError: (what, e) => errors.push([what, e]),
    confirm: async (message: string) => {
      asked.push(message)
      return state.answer
    },
  })
  const names = () => calls.map(([name]) => name).filter((name) => name !== "getEntity" && name !== "getLuaFields")
  const component = (type: string) => multi.view.value!.components.find((c) => c.type === type)!
  const engineFail = (command: string, error: Error) => void failures.set(command, error)
  return {
    multi,
    objects,
    calls,
    refuse,
    errors,
    host,
    groups,
    names,
    component,
    engineFail,
    asked,
    get answer() {
      return state.answer
    },
    set answer(value: boolean) {
      state.answer = value
    },
  }
}

describe("buildMultiView", () => {
  test("shows each shared value once, and marks the ones that differ (the first object's is the value)", () => {
    const view = buildMultiView([
      detailsOf("a", { active: true, tag: "x", layer: 1, transform: transformOf(1) }),
      detailsOf("b", { active: false, tag: "x", layer: 1, transform: transformOf(5) }),
    ])
    assert.equal(view.count, 2)
    assert.deepEqual(view.active, { value: true, mixed: true })
    assert.deepEqual(view.tag, { value: "x", mixed: false })
    assert.deepEqual(view.layer, { value: 1, mixed: false })
    const t = view.transform!
    assert.deepEqual(t.position.x, { value: 1, mixed: true })
    assert.equal(t.position.y.mixed, false)
    assert.equal(t.rotation.x.mixed || t.rotation.y.mixed || t.rotation.z.mixed, false)
    assert.equal(t.scale.z.mixed, false)
  })

  test("the rotation is compared as Euler angles (degrees), not as quaternion components", () => {
    const view = buildMultiView([
      detailsOf("a", { transform: transformOf(0, eulerToQuat({ x: 0, y: 30, z: 0 })) }),
      detailsOf("b", { transform: transformOf(0, eulerToQuat({ x: 0, y: 60, z: 0 })) }),
    ])
    const r = view.transform!.rotation
    assert.equal(r.x.mixed, false)
    assert.equal(r.y.mixed, true)
    assert.ok(Math.abs(r.y.value - 30) < 1e-6)
  })

  test("angles a whole turn apart (float noise at the +-180 wrap) are not mixed", () => {
    const view = buildMultiView([
      detailsOf("a", { transform: transformOf(0, eulerToQuat({ x: 180, y: 0, z: 0 })) }),
      detailsOf("b", { transform: transformOf(0, { x: 1, y: 0, z: 0, w: 1e-7 }) }),
    ])
    assert.equal(view.transform!.rotation.x.mixed, false)
  })

  test("an object with no transform leaves the transform out", () => {
    const view = buildMultiView([detailsOf("a"), detailsOf("b", { transform: null })])
    assert.equal(view.transform, null)
  })

  test("only the component types every object has are shared, matched by type, the first of each", () => {
    const a = detailsOf("a", { lua: { script: S1, speed: 1 } })
    const b = detailsOf("b", { lua: { script: S1, speed: 2 } })
    const c = detailsOf("c", { lua: null })
    a.components.push({ type: "Light", uuid: "a-light-2", values: { intensity: 99 } }) // the second Light is not the one
    assert.deepEqual(
      buildMultiView([a, b]).components.map((x) => x.type),
      ["Light", "LuaComponent"]
    )
    const shared = buildMultiView([a, b, c])
    assert.deepEqual(shared.components.map((x) => x.type), ["Light"])
    assert.deepEqual(shared.components[0].entries.map((e) => e.componentId), ["a-light", "b-light", "c-light"])
  })

  test("a LuaComponent is shared only when they all run the same script", () => {
    const same = buildMultiView([detailsOf("a", { lua: { script: S1, speed: 1 } }), detailsOf("b", { lua: { script: S1, speed: 1 } })])
    assert.ok(same.components.some((c) => c.type === "LuaComponent"))
    const different = buildMultiView([detailsOf("a", { lua: { script: S1, speed: 1 } }), detailsOf("b", { lua: { script: S2, speed: 1 } })])
    assert.ok(!different.components.some((c) => c.type === "LuaComponent"))
    const none = buildMultiView([detailsOf("a", { lua: { script: "", speed: 1 } }), detailsOf("b", { lua: { script: "", speed: 1 } })])
    assert.ok(!none.components.some((c) => c.type === "LuaComponent"))
  })

  test("field values: mixed where they differ, per axis for a vector", () => {
    const a = detailsOf("a", { light: { intensity: 1, tint: { x: 1, y: 0, z: 0 }, mode: "Point" } })
    const b = detailsOf("b", { light: { intensity: 1, tint: { x: 1, y: 5, z: 0 }, mode: "Spot" } })
    const light = buildMultiView([a, b]).components[0]
    const f = (name: string) => lightSchema.fields.find((x) => x.name === name)!
    assert.deepEqual(fieldMixed(f("intensity"), light.entries), { value: 1, mixed: false })
    assert.equal(fieldMixed(f("mode"), light.entries).mixed, true)
    assert.equal(fieldMixed(f("tint"), light.entries).mixed, true)
    assert.deepEqual(mixedAxes(f("tint"), light.entries), ["y"])
    // A field a component has no value for shows the kind's neutral value, the same for all
    assert.deepEqual(fieldMixed(f("label"), light.entries), { value: "", mixed: false })
  })

  test("references, lists, JSON and read-only fields are not multi-edited", () => {
    assert.equal(isMultiEditable(field("a", "Float")), true)
    assert.equal(isMultiEditable(field("a", "Color")), true)
    for (const kind of ["GameObjectRef", "AssetRef", "ComponentRef", "AssetRefList", "Json"]) {
      assert.equal(isMultiEditable(field("a", kind)), false, kind)
    }
    assert.equal(isMultiEditable(field("a", "Float", { readOnly: true })), false)
    const shown = multiFields(lightSchema)
    assert.deepEqual(shown.fields.map((x) => x.name), ["intensity", "tint", "mode", "label"])
    assert.equal(shown.skipped, 2) // target and extra; the read-only one is not "left out"
  })
})

describe("MultiInspectorState: reading", () => {
  test("fewer than two objects shows nothing; two or more read every object", async () => {
    const w = world({ a: {}, b: {}, c: {} })
    await w.multi.select(["a"])
    assert.equal(w.multi.view.value, null)
    assert.equal(w.calls.length, 0)
    await w.multi.select(["a", "b", "c"])
    assert.equal(w.multi.objects.value?.length, 3)
    assert.deepEqual(w.calls.filter(([n]) => n === "getEntity").map(([, a]) => a[0]), ["a", "b", "c"])
    await w.multi.select(["a"])
    assert.equal(w.multi.view.value, null)
  })

  test("the same selection is not read again; a change to a selected object is, one to another object isn't", async () => {
    const w = world({ a: {}, b: {}, c: {} })
    await w.multi.select(["a", "b"])
    const reads = () => w.calls.filter(([n]) => n === "getEntity").length
    await w.multi.select(["a", "b"])
    assert.equal(reads(), 2)
    await w.multi.applyChange({ full: false, entityIds: ["c"] })
    assert.equal(reads(), 2)
    await w.multi.applyChange({ full: false, entityIds: ["b"] })
    assert.equal(reads(), 4)
    await w.multi.applyChange({ full: true, entityIds: [] })
    assert.equal(reads(), 6)
  })

  test("an object that can't be read is a problem, not a half-shown list", async () => {
    const w = world({ a: {} })
    await w.multi.select(["a", "gone"])
    assert.equal(w.multi.view.value, null)
    assert.match(w.multi.loadProblem.value ?? "", /gone/)
  })

  test("a slow answer for an earlier selection can't replace a newer one", async () => {
    const w = world({ a: { name: "A" }, b: { name: "B" }, c: { name: "C" } })
    const first = w.multi.select(["a", "b"])
    await w.multi.select(["b", "c"])
    await first
    assert.deepEqual(w.multi.objects.value?.map((o) => o.header.id), ["b", "c"])
  })

  test("a shared LuaComponent's script fields are read once for its script", async () => {
    const w = world({ a: { lua: { script: S1, speed: 1 } }, b: { lua: { script: S1, speed: 2 } } })
    await w.multi.select(["a", "b"])
    assert.equal(w.calls.filter(([n]) => n === "getLuaFields").length, 1)
    assert.equal(w.multi.schemaFor(w.component("LuaComponent"))?.fields[1].name, "speed")
    assert.equal(w.multi.schemaFor(w.component("Light"))?.typeName, "Light")
  })

  test("reset forgets everything", async () => {
    const w = world({ a: {}, b: {} })
    await w.multi.select(["a", "b"])
    w.multi.reset()
    assert.equal(w.multi.view.value, null)
    assert.deepEqual(w.multi.ids.value, [])
  })
})

describe("MultiInspectorState: editing", () => {
  test("a field edit goes to every object that differs, inside ONE group named for the count", async () => {
    const w = world({
      a: { light: { intensity: 1, tint: { x: 1, y: 1, z: 1 } } },
      b: { light: { intensity: 2, tint: { x: 1, y: 1, z: 1 } } },
      c: { light: { intensity: 5, tint: { x: 1, y: 1, z: 1 } } },
    })
    await w.multi.select(["a", "b", "c"])
    const intensity = lightSchema.fields[0]
    await w.multi.setField(w.component("Light"), intensity, 5)
    // c already has 5: nothing for it
    assert.deepEqual(w.names(), ["beginEditGroup", "setComponentFields", "setComponentFields", "endEditGroup"])
    assert.deepEqual(w.calls.find(([n]) => n === "beginEditGroup")![1], ["Edit 3 objects"])
    assert.deepEqual(
      w.calls.filter(([n]) => n === "setComponentFields").map(([, a]) => [a[0], a[1], a[2]]),
      [
        ["a", "a-light", { intensity: 5 }],
        ["b", "b-light", { intensity: 5 }],
      ]
    )
    // Read again: they agree now
    assert.equal(fieldMixed(intensity, w.component("Light").entries).mixed, false)
    assert.equal(w.groups?.depth, 0)
  })

  test("an edit that changes nothing sends nothing and opens no group", async () => {
    const w = world({ a: {}, b: {} })
    await w.multi.select(["a", "b"])
    await w.multi.setField(w.component("Light"), lightSchema.fields[0], 1)
    await w.multi.setProperties({ active: true })
    await w.multi.setTransformAxis("position", "y", 2)
    assert.deepEqual(w.names(), [])
  })

  test("a vector axis edit keeps each object's other axes", async () => {
    const w = world({
      a: { light: { tint: { x: 1, y: 2, z: 3 } } },
      b: { light: { tint: { x: 4, y: 5, z: 6 } } },
    })
    await w.multi.select(["a", "b"])
    await w.multi.setField(w.component("Light"), lightSchema.fields[1], { x: 9, y: 2, z: 3 }, "x")
    const sent = w.calls.filter(([n]) => n === "setComponentFields").map(([, a]) => a[2])
    assert.deepEqual(sent, [{ tint: { x: 9, y: 2, z: 3 } }, { tint: { x: 9, y: 5, z: 6 } }])
  })

  test("the active flag, tag and layer fan out as one group", async () => {
    const w = world({ a: { active: true, layer: 1 }, b: { active: false, layer: 1 } })
    await w.multi.select(["a", "b"])
    await w.multi.setProperties({ active: true })
    assert.deepEqual(w.names(), ["beginEditGroup", "setEntityProperties", "endEditGroup"])
    assert.deepEqual(w.calls.find(([n]) => n === "setEntityProperties")![1], ["b", { active: true }])
    assert.equal(w.multi.view.value?.active.mixed, false)
    w.calls.length = 0
    await w.multi.setProperties({ tag: "enemy" })
    assert.deepEqual(w.names(), ["beginEditGroup", "setEntityProperties", "setEntityProperties", "endEditGroup"])
    assert.equal(w.multi.view.value?.tag.value, "enemy")
  })

  test("a position axis keeps each object's other axes, rotation and scale", async () => {
    const q = eulerToQuat({ x: 10, y: 20, z: 30 })
    const w = world({
      a: { transform: { position: { x: 1, y: 2, z: 3 }, rotation: q, scale: { x: 2, y: 2, z: 2 } } },
      b: { transform: { position: { x: 4, y: 5, z: 6 }, rotation: identity, scale: { x: 1, y: 1, z: 1 } } },
    })
    await w.multi.select(["a", "b"])
    await w.multi.setTransformAxis("position", "x", 7)
    assert.deepEqual(w.names(), ["beginEditGroup", "setLocalTransform", "setLocalTransform", "endEditGroup"])
    const sent = w.calls.filter(([n]) => n === "setLocalTransform").map(([, a]) => a)
    assert.deepEqual(sent[0], ["a", { x: 7, y: 2, z: 3 }, q, { x: 2, y: 2, z: 2 }])
    assert.deepEqual(sent[1], ["b", { x: 7, y: 5, z: 6 }, identity, { x: 1, y: 1, z: 1 }])
  })

  test("a field edit with several axes keeps each object's other axes", async () => {
    const w = world({
      a: { light: { isActive: true, intensity: 1, tint: { x: 1, y: 1, z: 0.2 }, mode: "Point", label: "a" } },
      b: { light: { isActive: true, intensity: 1, tint: { x: 0, y: 0, z: 0.9 }, mode: "Point", label: "a" } },
    })
    await w.multi.select(["a", "b"])
    const tint = lightSchema.fields.find((f) => f.name === "tint")!
    await w.multi.setField(w.component("Light"), tint, { x: 0.5, y: 0.5, z: 0.2 }, ["x", "y"])
    const sent = w.calls.filter(([n]) => n === "setComponentFields").map(([, a]) => (a[2] as JsonObject).tint)
    assert.deepEqual(sent, [{ x: 0.5, y: 0.5, z: 0.2 }, { x: 0.5, y: 0.5, z: 0.9 }])
  })

  test("sendPending sends what the panel's pause is holding, and Undo/Save's settled then waits for it", async () => {
    const w = world({ a: {}, b: {} })
    await w.multi.select(["a", "b"])
    let sent = false
    const off = w.multi.onPending(() => {
      sent = true
      void w.multi.setProperties({ tag: "t" })
    })
    w.multi.sendPending()
    assert.equal(sent, true)
    await w.multi.settled
    assert.equal(w.multi.view.value?.tag.value, "t")
    off()
    sent = false
    w.multi.sendPending()
    assert.equal(sent, false)
  })

  test("a rotation axis changes only that Euler angle of each object", async () => {
    const w = world({
      a: { transform: transformOf(0, eulerToQuat({ x: 10, y: 20, z: 30 })) },
      b: { transform: transformOf(0, eulerToQuat({ x: -40, y: 5, z: 60 })) },
    })
    await w.multi.select(["a", "b"])
    await w.multi.setTransformAxis("rotation", "y", 45)
    const sent = w.calls.filter(([n]) => n === "setLocalTransform").map(([, a]) => a)
    const angles = sent.map((s) => quatToEuler(s[2] as Quat))
    assert.ok(Math.abs(angles[0].x - 10) < 1e-6 && Math.abs(angles[0].y - 45) < 1e-6 && Math.abs(angles[0].z - 30) < 1e-6)
    assert.ok(Math.abs(angles[1].x + 40) < 1e-6 && Math.abs(angles[1].y - 45) < 1e-6 && Math.abs(angles[1].z - 60) < 1e-6)
    assert.equal(w.multi.view.value?.transform?.rotation.y.mixed, false)
  })

  test("a rotation that means what is stored (360 for 0) is not sent", async () => {
    const w = world({ a: {}, b: {} })
    await w.multi.select(["a", "b"])
    await w.multi.setTransformAxis("rotation", "z", 360)
    assert.deepEqual(w.names(), [])
  })

  test("a scale axis", async () => {
    const w = world({ a: { transform: transformOf(0, identity, 1) }, b: { transform: transformOf(0, identity, 3) } })
    await w.multi.select(["a", "b"])
    await w.multi.setTransformAxis("scale", "z", 2)
    const sent = w.calls.filter(([n]) => n === "setLocalTransform").map(([, a]) => a[3])
    assert.deepEqual(sent, [{ x: 1, y: 1, z: 2 }, { x: 3, y: 3, z: 2 }])
  })

  test("a shared LuaComponent's script field is edited through its container", async () => {
    const w = world({ a: { lua: { script: S1, speed: 1 } }, b: { lua: { script: S1, speed: 2 } } })
    await w.multi.select(["a", "b"])
    await w.multi.setField(w.component("LuaComponent"), luaSchema.fields[1], 9)
    const sent = w.calls.filter(([n]) => n === "setComponentFields").map(([, a]) => a[2])
    assert.deepEqual(sent, [{ scriptData: { speed: 9 } }, { scriptData: { speed: 9 } }])
  })

  test("without edit groups the edits still go out, ungrouped", async () => {
    const w = world({ a: { layer: 0 }, b: { layer: 1 } }, { groups: false })
    await w.multi.select(["a", "b"])
    await w.multi.setProperties({ layer: 3 })
    assert.deepEqual(w.names(), ["setEntityProperties", "setEntityProperties"])
  })

  test("edits are made one at a time, in order, even when asked for together", async () => {
    const w = world({ a: { layer: 0 }, b: { layer: 1 } })
    await w.multi.select(["a", "b"])
    const first = w.multi.setProperties({ layer: 3 })
    const second = w.multi.setProperties({ tag: "t" })
    await Promise.all([first, second])
    assert.deepEqual(w.names(), [
      "beginEditGroup",
      "setEntityProperties",
      "setEntityProperties",
      "endEditGroup",
      "beginEditGroup",
      "setEntityProperties",
      "setEntityProperties",
      "endEditGroup",
    ])
  })

  test("settled resolves when the edits are sent and read back", async () => {
    const w = world({ a: { layer: 0 }, b: { layer: 1 } })
    await w.multi.select(["a", "b"])
    const edit = w.multi.setProperties({ layer: 3 })
    let settled = false
    void w.multi.settled.then(() => (settled = true))
    await tick()
    assert.equal(settled, false)
    await edit
    await w.multi.settled
    assert.equal(w.multi.view.value?.layer.mixed, false)
  })
})

describe("MultiInspectorState: partial failure and read-only", () => {
  test("a refusal aborts the edit: nothing more is sent, the group still ends, what is shown is the host's", async () => {
    const w = world({ a: { layer: 0 }, b: { name: "Bravo", layer: 0 }, c: { layer: 0 } })
    await w.multi.select(["a", "b", "c"])
    w.refuse.set("b", { message: "Entity is locked" })
    await w.multi.setProperties({ layer: 4 })
    // c is not sent: the edit stopped at b
    assert.deepEqual(w.names(), ["beginEditGroup", "setEntityProperties", "setEntityProperties", "endEditGroup"])
    const problem = w.multi.editProblem.value ?? ""
    assert.match(problem, /1 of 3 changes applied \(Undo takes back what was applied\), 1 not sent/)
    assert.match(problem, /Bravo: Entity is locked/)
    // Read back: a took it, b and c did not, so the layer is mixed and the first object's value is shown
    assert.deepEqual(w.multi.view.value?.layer, { value: 4, mixed: true })
    assert.equal(w.groups?.depth, 0)
    // The next edit starts clean
    w.refuse.clear()
    await w.multi.setProperties({ layer: 4 })
    assert.equal(w.multi.editProblem.value, null)
    assert.equal(w.multi.view.value?.layer.mixed, false)
  })

  test("a denial is told to onError once, not once per object", async () => {
    const w = world({ a: { layer: 0 }, b: { layer: 0 } })
    await w.multi.select(["a", "b"])
    w.refuse.set("a", { message: "read-only host: SetEntityProperties is not allowed", code: "readOnly" })
    w.refuse.set("b", { message: "read-only host: SetEntityProperties is not allowed", code: "readOnly" })
    await w.multi.setProperties({ layer: 2 })
    assert.equal(w.errors.length, 1)
    assert.match(w.multi.editProblem.value ?? "", /0 of 2 changes applied, 1 not sent/)
    assert.equal(w.groups?.depth, 0)
  })

  test("a refusal of the last object: everything before it applied, none left unsent", async () => {
    const w = world({ a: {}, b: {}, c: { name: "Charlie" } })
    await w.multi.select(["a", "b", "c"])
    w.refuse.set("c", { message: "nope" })
    await w.multi.setTransformAxis("position", "x", 9)
    assert.equal(w.calls.filter(([n]) => n === "setLocalTransform").length, 3)
    assert.match(w.multi.editProblem.value ?? "", /2 of 3 changes applied .*, 0 not sent\. Charlie: nope/)
    assert.equal(w.groups?.depth, 0)
  })

  test("an edit that fails after the selection moved on reports nothing on the new selection; its group still ends", async () => {
    const w = world({ a: {}, b: { name: "Bravo" }, c: {}, d: {} })
    await w.multi.select(["a", "b"])
    w.refuse.set("b", { message: "locked" })
    const edit = w.multi.setProperties({ tag: "Enemy" })
    // The selection changes while the edit is on its way
    const moved = w.multi.select(["c", "d"])
    await Promise.all([edit, moved])
    await w.multi.settled
    assert.equal(w.multi.editProblem.value, null)
    assert.deepEqual(w.multi.ids.value, ["c", "d"])
    // The edit went to the objects it was made on, and no further than the refusal
    const sent = w.calls.filter(([n]) => n === "setEntityProperties").map(([, a]) => a[0])
    assert.deepEqual(sent, ["a", "b"])
    assert.equal(w.groups?.depth, 0)
    // What is shown is the new selection, read from the host
    assert.deepEqual(
      w.multi.objects.value?.map((o) => o.header.id),
      ["c", "d"]
    )
  })

  test("the group ends even when the host's answer is a thrown non-host error (a dropped connection)", async () => {
    const w = world({ a: {}, b: {} })
    await w.multi.select(["a", "b"])
    w.engineFail("setLocalTransform", new Error("connection lost"))
    await w.multi.setTransformAxis("scale", "y", 2)
    assert.deepEqual(w.names(), ["beginEditGroup", "setLocalTransform", "endEditGroup"])
    assert.equal(w.groups?.depth, 0)
    assert.match(w.multi.editProblem.value ?? "", /connection lost/)
  })

  test("read-only: no command is sent and the edit is refused", async () => {
    const w = world({ a: {}, b: {} })
    await w.multi.select(["a", "b"])
    w.host.readOnlyReason.value = "a play session is running"
    assert.throws(() => w.multi.setProperties({ layer: 9 }), /read-only/)
    assert.throws(() => w.multi.setTransformAxis("position", "x", 9), /read-only/)
    assert.throws(() => w.multi.setField(w.component("Light"), lightSchema.fields[0], 9), /read-only/)
    assert.throws(() => w.multi.addComponent("Light"), /read-only/)
    await assert.rejects(w.multi.removeComponent(w.component("Light")), /read-only/)
    assert.deepEqual(w.names(), [])
  })
})

describe("MultiInspectorState: Add Component and Remove for every object", () => {
  test("Add Component adds the type to every object as ONE group", async () => {
    const w = world({ a: {}, b: {}, c: {} })
    await w.multi.select(["a", "b", "c"])
    await w.multi.addComponent("Rigidbody")
    assert.deepEqual(w.names(), ["beginEditGroup", "addComponent", "addComponent", "addComponent", "endEditGroup"])
    assert.deepEqual(w.calls.find(([n]) => n === "beginEditGroup")?.[1], ["Edit 3 objects"])
    assert.deepEqual(
      w.calls.filter(([n]) => n === "addComponent").map(([, a]) => a),
      [
        ["a", "Rigidbody"],
        ["b", "Rigidbody"],
        ["c", "Rigidbody"],
      ]
    )
    // Read back: every object has it now, so it is shared
    assert.ok(w.multi.view.value?.components.some((c) => c.type === "Rigidbody"))
  })

  test("a singleton type that any selected object has can't be added to all", async () => {
    const w = world({ a: {}, b: { light: null } })
    w.host.types.value = [{ ...lightSchema, singleton: true }, types[1]]
    await w.multi.select(["a", "b"])
    assert.ok(w.multi.presentTypes.value.has("Light"))
    assert.throws(() => w.multi.addComponent("Light"), /only one Light/)
    assert.deepEqual(w.names(), [])
  })

  test("Remove asks once, then removes the shared component from every object as ONE group", async () => {
    const w = world({ a: {}, b: {} })
    await w.multi.select(["a", "b"])
    assert.equal(await w.multi.removeComponent(w.component("Light")), true)
    assert.deepEqual(w.asked, ["Remove Light from 2 objects?"])
    assert.deepEqual(w.names(), ["beginEditGroup", "removeComponent", "removeComponent", "endEditGroup"])
    assert.deepEqual(
      w.calls.filter(([n]) => n === "removeComponent").map(([, a]) => a),
      [
        ["a", "a-light"],
        ["b", "b-light"],
      ]
    )
    assert.equal(w.multi.view.value?.components.length, 0)
  })

  test("Remove declined sends nothing", async () => {
    const w = world({ a: {}, b: {} })
    w.answer = false
    await w.multi.select(["a", "b"])
    assert.equal(await w.multi.removeComponent(w.component("Light")), false)
    assert.deepEqual(w.names(), [])
  })

  test("Remove that is refused on one object stops there and the group ends", async () => {
    const w = world({ a: { name: "Alpha" }, b: {} })
    await w.multi.select(["a", "b"])
    w.refuse.set("a", { message: "in use" })
    await w.multi.removeComponent(w.component("Light"))
    assert.deepEqual(w.names(), ["beginEditGroup", "removeComponent", "endEditGroup"])
    assert.match(w.multi.editProblem.value ?? "", /0 of 2 changes applied, 1 not sent\. Alpha: in use/)
    assert.equal(w.groups?.depth, 0)
    // Nothing was removed: the light is still shared
    assert.ok(w.multi.view.value?.components.some((c) => c.type === "Light"))
  })
})

describe("quaternions in the fan-out", () => {
  test("what is sent for a rotation is a unit quaternion of the new angles", async () => {
    const w = world({ a: {}, b: {} })
    await w.multi.select(["a", "b"])
    await w.multi.setTransformAxis("rotation", "x", 90)
    const sent = w.calls.filter(([n]) => n === "setLocalTransform").map(([, a]) => a[2] as Quat)
    assert.equal(sent.length, 2)
    for (const q of sent) assert.ok(quatsEquivalent(q, eulerToQuat({ x: 90, y: 0, z: 0 })))
  })
})
