import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { ComponentSchema, EntityDataResponse, FieldSchema } from "../protocol/protocol.generated"
import type { AssetEntry, JsonObject } from "../shared/api"
import { EntityKey, InspectorState } from "../renderer/inspector-state"
import { fieldPatch } from "../renderer/inspector-fields"

const field = (name: string, kind: string, extra: Partial<FieldSchema> = {}): FieldSchema => ({
  name,
  displayName: name,
  kind,
  typeName: kind === "Int" ? "int" : "float",
  hidden: false,
  readOnly: false,
  ...extra,
})

const types: ComponentSchema[] = [
  {
    typeName: "Light",
    singleton: false,
    fields: [field("intensity", "Float", { min: 0, max: 10 }), field("range", "Float")],
  },
  { typeName: "Canvas", singleton: true, fields: [] },
  { typeName: "LuaComponent", singleton: false, fields: [field("scriptUUID", "AssetRef", { assetType: "LuaScript" })] },
]

const S1 = "11111111-1111-1111-1111-111111111111"
const S2 = "22222222-2222-2222-2222-222222222222"

const luaSchema = (script: string): ComponentSchema => ({
  typeName: "LuaComponent",
  singleton: false,
  fields: [
    field("scriptUUID", "AssetRef", { assetType: "LuaScript" }),
    field(script === S1 ? "speed" : "jump", "Float", { container: "scriptData" }),
  ],
})

/** A promise settled from outside */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

/** One object, with a light and a Lua component */
function entityData(id: string, overrides: Partial<Record<string, JsonObject>> = {}): EntityDataResponse {
  return {
    entity: {
      header: { id, parentId: "", index: 0, name: "Lamp", active: true, activeInHierarchy: true, layer: 0, tag: "" },
      components: [
        { type: "Light", uuid: "light", values: overrides.light ?? { isActive: true, intensity: 1, range: 10 } },
        { type: "LuaComponent", uuid: "lua", values: overrides.lua ?? { scriptUUID: S1, scriptData: { speed: 1 } } },
      ],
    },
    worldMatrix: [],
  }
}

function setup(options: { confirm?: boolean } = {}) {
  const calls: Array<[string, unknown[]]> = []
  const sets: Array<{ entityId: string; componentId: string; values: JsonObject; reply: ReturnType<typeof deferred<unknown>> }> = []
  const errors: Array<[string, unknown]> = []
  const timers: Array<{ id: number; callback: () => void; ms: number }> = []
  let nextTimer = 1
  const state: { connected: boolean; stored: Record<string, JsonObject>; autoReply: boolean; failSet: string | null } = {
    connected: true,
    stored: {},
    autoReply: true,
    failSet: null,
  }
  const engine = {
    isConnected: () => state.connected,
    getEntity: async (id: string) => {
      calls.push(["getEntity", [id]])
      if (id === "gone") throw new Error("Entity not found: gone")
      const data = entityData(id, state.stored)
      return data
    },
    getComponentTypes: async () => {
      calls.push(["getComponentTypes", []])
      return types
    },
    addComponent: async (entityId: string, typeName: string) => {
      calls.push(["addComponent", [entityId, typeName]])
      if (typeName === "Boom") throw new Error("Unknown component type 'Boom'")
      return { componentId: "new-" + typeName, values: { isActive: true } }
    },
    removeComponent: async (entityId: string, componentId: string) => {
      calls.push(["removeComponent", [entityId, componentId]])
    },
    setComponentFields: (entityId: string, componentId: string, values: JsonObject) => {
      calls.push(["setComponentFields", [entityId, componentId, values]])
      const reply = deferred<unknown>()
      sets.push({ entityId, componentId, values, reply })
      if (state.failSet) reply.reject(new Error(state.failSet))
      else if (state.autoReply) reply.resolve(storedAfter(componentId, values))
      return reply.promise
    },
    getLuaFields: async (entityId: string, componentId: string) => {
      calls.push(["getLuaFields", [entityId, componentId]])
      const script = (state.stored.lua?.scriptUUID as string | undefined) ?? S1
      return luaSchema(script)
    },
    setEntityProperties: async (entityId: string, properties: JsonObject) => {
      calls.push(["setEntityProperties", [entityId, properties]])
      if (state.failSet) throw new Error(state.failSet)
    },
  }
  /** What the fake host stores: the request merged over the component's values, a light's intensity clamped to 0..10 */
  const storedAfter = (componentId: string, request: JsonObject): JsonObject => {
    const base: JsonObject =
      componentId === "light"
        ? { isActive: true, intensity: 1, range: 10 }
        : { scriptUUID: S1, scriptData: { speed: 1 } }
    const stored = { ...base, ...state.stored[componentId], ...request }
    if (typeof stored.intensity === "number") stored.intensity = Math.min(10, Math.max(0, stored.intensity))
    state.stored[componentId] = stored
    return stored
  }
  const project = {
    listAssets: async (): Promise<AssetEntry[]> => [{ uuid: S1, path: "res://scripts/a.lua", resourceType: "LuaScript" }],
  }
  const inspector = new InspectorState(engine, project, {
    confirm: async (message) => {
      calls.push(["confirm", [message]])
      return options.confirm ?? true
    },
    onError: (what, error) => errors.push([what, error]),
    debounceMs: 250,
    timers: {
      set: (callback, ms) => {
        const timer = { id: nextTimer++, callback, ms }
        timers.push(timer)
        return timer.id
      },
      clear: (handle) => {
        const i = timers.findIndex((timer) => timer.id === handle)
        if (i >= 0) timers.splice(i, 1)
      },
    },
  })
  /** Runs the timers that are waiting, as the debounce delay passing */
  const fire = () => {
    const due = timers.splice(0)
    due.forEach((timer) => timer.callback())
  }
  const sentValues = () => calls.filter(([name]) => name === "setComponentFields").map(([, args]) => args[2])
  const light = () => inspector.components.value.find((c) => c.id === "light")!
  return { inspector, engine, calls, sets, errors, timers, state, fire, sentValues, light }
}

describe("InspectorState: reading the object", () => {
  test("selecting reads the object: header, components, the Lua component's fields", async () => {
    const { inspector, calls } = setup()
    await inspector.loadTypes()
    await inspector.select("e1")
    assert.equal(inspector.entityId.value, "e1")
    assert.equal(inspector.header.value?.name, "Lamp")
    assert.deepEqual(
      inspector.components.value.map((c) => [c.id, c.type]),
      [
        ["light", "Light"],
        ["lua", "LuaComponent"],
      ]
    )
    assert.equal(inspector.loading.value, false)
    assert.deepEqual(inspector.presentTypes.value, new Set(["Light", "LuaComponent"]))
    assert.deepEqual(inspector.schemaFor(inspector.components.value[0])?.typeName, "Light")
    // The Lua component's fields are the script's, not the type's one field
    assert.deepEqual(
      inspector.schemaFor(inspector.components.value[1])?.fields.map((f) => f.name),
      ["scriptUUID", "speed"]
    )
    assert.deepEqual(
      calls.filter(([name]) => name === "getLuaFields"),
      [["getLuaFields", ["e1", "lua"]]]
    )
  })

  test("a type that isn't registered has no schema", async () => {
    const { inspector, engine } = setup()
    await inspector.loadTypes()
    engine.getEntity = async (id) => ({
      ...entityData(id),
      entity: { ...entityData(id).entity, components: [{ type: "Mystery", uuid: "m", values: { a: 1 } }] },
    })
    await inspector.select("e1")
    assert.equal(inspector.schemaFor(inspector.components.value[0]), null)
  })

  test("the types are read once, and again after a reset", async () => {
    const { inspector, calls } = setup()
    await Promise.all([inspector.loadTypes(), inspector.loadTypes()])
    await inspector.loadTypes()
    assert.equal(calls.filter(([name]) => name === "getComponentTypes").length, 1)
    assert.equal(inspector.types.value?.length, 3)
    inspector.reset()
    assert.equal(inspector.types.value, null)
    await inspector.loadTypes()
    assert.equal(calls.filter(([name]) => name === "getComponentTypes").length, 2)
  })

  test("types that can't be read leave a reason, and are tried again", async () => {
    const { inspector, engine } = setup()
    engine.getComponentTypes = async () => {
      throw new Error("Unknown command 0x60")
    }
    const quiet = console.error
    console.error = () => {}
    try {
      await inspector.loadTypes()
    } finally {
      console.error = quiet
    }
    assert.equal(inspector.types.value, null)
    assert.match(inspector.typesProblem.value ?? "", /Unknown command/)
    engine.getComponentTypes = async () => types
    await inspector.loadTypes()
    assert.equal(inspector.typesProblem.value, null)
    assert.equal((inspector.types.value as readonly unknown[] | null)?.length, 3)
  })

  test("an object that can't be read leaves a reason and nothing to show", async () => {
    const { inspector } = setup()
    await inspector.select("gone")
    assert.match(inspector.loadProblem.value ?? "", /not found/)
    assert.deepEqual(inspector.components.value, [])
    assert.equal(inspector.header.value, null)
    assert.equal(inspector.loading.value, false)
  })

  test("a scene change that touched the object reads it again; another's doesn't", async () => {
    const { inspector, calls, state } = setup()
    await inspector.select("e1")
    const reads = () => calls.filter(([name]) => name === "getEntity").length
    await inspector.applyChange({ full: false, entityIds: ["other"] })
    assert.equal(reads(), 1)
    state.stored.light = { isActive: true, intensity: 4, range: 10 }
    await inspector.applyChange({ full: false, entityIds: ["e1"] })
    assert.equal(reads(), 2)
    assert.equal(inspector.components.value[0].values.intensity, 4)
    await inspector.applyChange({ full: true, entityIds: [] })
    assert.equal(reads(), 3)
  })

  test("selecting nothing clears; selecting the same object again reads nothing", async () => {
    const { inspector, calls } = setup()
    await inspector.select("e1")
    await inspector.select("e1")
    assert.equal(calls.filter(([name]) => name === "getEntity").length, 1)
    await inspector.select(null)
    assert.equal(inspector.entityId.value, null)
    assert.deepEqual(inspector.components.value, [])
  })

  test("a slow read of an object that was left doesn't replace the new one", async () => {
    const { inspector, engine } = setup()
    const slow = deferred<EntityDataResponse>()
    engine.getEntity = (id: string) => (id === "slow" ? slow.promise : Promise.resolve(entityData(id)))
    const first = inspector.select("slow")
    await inspector.select("fast")
    slow.resolve({ ...entityData("slow"), entity: { ...entityData("slow").entity, components: [] } })
    await first
    assert.equal(inspector.entityId.value, "fast")
    assert.equal(inspector.components.value.length, 2)
  })

  test("not connected: nothing is read, and nothing is left loading", async () => {
    const { inspector, calls, state } = setup()
    state.connected = false
    await inspector.select("e1")
    assert.equal(inspector.loading.value, false)
    assert.equal(
      calls.some(([name]) => name === "getEntity"),
      false
    )
  })
})

describe("InspectorState: editing a component", () => {
  test("an edit is shown at once and sent after the debounce delay, as one request", async () => {
    const { inspector, sentValues, fire, timers } = setup()
    await inspector.select("e1")
    inspector.edit("light", { intensity: 2 })
    inspector.edit("light", { range: 5 })
    assert.equal(inspector.valuesOf(inspector.components.value[0]).intensity, 2)
    assert.equal(inspector.components.value[0].values.intensity, 1) // the stored value is unchanged until the host answers
    assert.equal(timers.length, 1) // the second edit restarted the one timer
    assert.equal(timers[0].ms, 250)
    assert.deepEqual(sentValues(), [])
    fire()
    await inspector.flush()
    assert.deepEqual(sentValues(), [{ intensity: 2, range: 5 }])
    assert.equal(inspector.components.value[0].values.intensity, 2)
    assert.equal(inspector.overlays.value.size, 0)
  })

  test("the host's answer replaces what was shown: a clamped value", async () => {
    const { inspector } = setup()
    await inspector.select("e1")
    inspector.edit("light", { intensity: 99 }, { immediate: true })
    assert.equal(inspector.valuesOf(inspector.components.value[0]).intensity, 99)
    await inspector.flush()
    assert.equal(inspector.valuesOf(inspector.components.value[0]).intensity, 10)
  })

  test("a refusal puts every field of the request back, and shows the message", async () => {
    const { inspector, state } = setup()
    await inspector.select("e1")
    state.failSet = "Field 'range': a float for an integer"
    inspector.edit("light", { intensity: 2, range: 5 }, { immediate: true })
    assert.equal(inspector.valuesOf(inspector.components.value[0]).range, 5)
    await inspector.flush()
    const values = inspector.valuesOf(inspector.components.value[0])
    assert.equal(values.intensity, 1)
    assert.equal(values.range, 10)
    assert.match(inspector.errors.value.get("light") ?? "", /Field 'range'/)
    // The next edit clears it
    state.failSet = null
    inspector.edit("light", { intensity: 3 }, { immediate: true })
    assert.equal(inspector.errors.value.has("light"), false)
    await inspector.flush()
    assert.equal(inspector.components.value[0].values.intensity, 3)
  })

  test("edits made while a request is on its way wait, and go as the next one, one request at a time", async () => {
    const { inspector, sets, state, sentValues } = setup()
    await inspector.select("e1")
    state.autoReply = false
    inspector.edit("light", { intensity: 2 }, { immediate: true })
    inspector.edit("light", { range: 7 }, { immediate: true })
    inspector.edit("light", { range: 8 }, { immediate: true })
    assert.deepEqual(sentValues(), [{ intensity: 2 }]) // the others wait
    const view = () => inspector.valuesOf(inspector.components.value[0])
    assert.equal(view().intensity, 2)
    assert.equal(view().range, 8)
    sets[0].reply.resolve({ isActive: true, intensity: 2, range: 10 })
    await tick()
    await tick()
    assert.deepEqual(sentValues(), [{ intensity: 2 }, { range: 8 }])
    // While the second is on its way the answer to the first doesn't undo it
    assert.equal(view().range, 8)
    sets[1].reply.resolve({ isActive: true, intensity: 2, range: 8 })
    await inspector.flush()
    assert.equal(inspector.components.value[0].values.range, 8)
    assert.equal(inspector.overlays.value.size, 0)
  })

  test("a refusal of the first request leaves the edits that came after it to be sent", async () => {
    const { inspector, sets, state, sentValues } = setup()
    await inspector.select("e1")
    state.autoReply = false
    inspector.edit("light", { intensity: 2 }, { immediate: true })
    inspector.edit("light", { range: 7 }, { immediate: true })
    sets[0].reply.reject(new Error("refused"))
    await tick()
    await tick()
    assert.deepEqual(sentValues(), [{ intensity: 2 }, { range: 7 }])
    sets[1].reply.resolve({ isActive: true, intensity: 1, range: 7 })
    await inspector.flush()
    const values = inspector.valuesOf(inspector.components.value[0])
    assert.equal(values.intensity, 1)
    assert.equal(values.range, 7)
  })

  test("setting a field to what it already is sends nothing", async () => {
    const { inspector, sentValues } = setup()
    await inspector.select("e1")
    inspector.edit("light", { intensity: 1 }, { immediate: true })
    await inspector.flush()
    inspector.edit("light", { intensity: 5 })
    inspector.edit("light", { intensity: 1 }) // back to the stored value before it was sent
    await inspector.flush()
    assert.deepEqual(sentValues(), [])
    assert.equal(inspector.overlays.value.size, 0)
  })

  test("the echo keys are never sent", async () => {
    const { inspector, sentValues } = setup()
    await inspector.select("e1")
    inspector.edit("light", { uuid: "light", intensity: 3 }, { immediate: true })
    await inspector.flush()
    assert.deepEqual(sentValues(), [{ intensity: 3 }])
  })

  test("a Lua field is edited inside scriptData, and the rest of the data isn't touched", async () => {
    const { inspector, sentValues } = setup()
    await inspector.select("e1")
    const speed = inspector.schemaFor(inspector.components.value[1])!.fields.find((f) => f.name === "speed")!
    inspector.edit("lua", fieldPatch(speed, 9), { immediate: true })
    await inspector.flush()
    assert.deepEqual(sentValues(), [{ scriptData: { speed: 9 } }])
  })

  test("a new script goes after the data edit that was pending, and the script's fields are read again", async () => {
    const { inspector, sentValues, calls, state } = setup()
    await inspector.select("e1")
    inspector.edit("lua", { scriptData: { speed: 4 } })
    inspector.edit("lua", { scriptUUID: S2 }, { immediate: true })
    await inspector.flush()
    assert.deepEqual(sentValues(), [{ scriptData: { speed: 4 } }, { scriptUUID: S2 }])
    assert.equal(state.stored.lua?.scriptUUID, S2)
    assert.equal(calls.filter(([name]) => name === "getLuaFields").length, 2)
    assert.deepEqual(
      inspector.schemaFor(inspector.components.value[1])?.fields.map((f) => f.name),
      ["scriptUUID", "jump"]
    )
  })

  test("overlapping reads of a script's fields share one read, and a late answer for another script is dropped", async () => {
    const { inspector, engine, state } = setup()
    const first = deferred<ComponentSchema>()
    let asked = 0
    engine.getLuaFields = (_e: string, _c: string) => {
      asked++
      return asked === 1 ? first.promise : Promise.resolve(luaSchema(S2))
    }
    const selecting = inspector.select("e1")
    await tick()
    // The same script again while the read is on its way: no second read
    const again = [inspector.refresh(), inspector.refresh()]
    await tick()
    assert.equal(asked, 1)
    // The script changes, and its fields are read; then the first (old) answer arrives
    state.stored.lua = { scriptUUID: S2, scriptData: {} }
    const changed = inspector.refresh()
    await tick()
    await tick()
    assert.equal(asked, 2)
    first.resolve(luaSchema(S1))
    await Promise.all([selecting, changed, ...again])
    assert.deepEqual(
      inspector.schemaFor(inspector.components.value[1])?.fields.map((f) => f.name),
      ["scriptUUID", "jump"]
    )
  })

  test("a failed read of the fields leaves a reason and is asked again on the next read", async () => {
    const { inspector, engine } = setup()
    let fail = true
    engine.getLuaFields = async () => {
      if (fail) throw new Error("script failed")
      return luaSchema(S1)
    }
    await inspector.select("e1")
    assert.match(inspector.luaProblems.value.get("lua") ?? "", /script failed/)
    fail = false
    await inspector.refresh()
    assert.equal(inspector.luaProblems.value.has("lua"), false)
    assert.equal(inspector.luaSchemas.value.has("lua"), true)
  })

  test("the Lua fields are asked again only when the script changed (or on request)", async () => {
    const { inspector, calls } = setup()
    await inspector.select("e1")
    await inspector.refresh()
    const asked = () => calls.filter(([name]) => name === "getLuaFields").length
    assert.equal(asked(), 1)
    await inspector.refreshLuaFields()
    assert.equal(asked(), 2)
  })

  test("a Lua component without a script has no script fields, and a failing script says why", async () => {
    const { inspector, engine, state } = setup()
    state.stored.lua = { scriptUUID: null as never }
    await inspector.select("e1")
    assert.equal(inspector.luaSchemas.value.size, 0)
    assert.equal(inspector.luaProblems.value.size, 0)
    state.stored.lua = { scriptUUID: S1 }
    engine.getLuaFields = async () => {
      throw new Error("The script failed to load")
    }
    await inspector.refresh()
    assert.match(inspector.luaProblems.value.get("lua") ?? "", /failed to load/)
    assert.equal(inspector.luaSchemas.value.size, 0)
  })

  test("a read that began before an edit was answered doesn't undo it", async () => {
    const { inspector, engine, sets, state } = setup()
    await inspector.select("e1")
    const slowRead = deferred<EntityDataResponse>()
    const reads = engine.getEntity
    engine.getEntity = () => slowRead.promise
    const refresh = inspector.refresh()
    engine.getEntity = reads
    state.autoReply = false
    inspector.edit("light", { intensity: 6 }, { immediate: true })
    sets[0].reply.resolve({ isActive: true, intensity: 6, range: 10 })
    await inspector.flush()
    slowRead.resolve(entityData("e1")) // the old values
    await refresh
    assert.equal(inspector.components.value[0].values.intensity, 6)
  })

  test("changing the selection sends what was edited to the object it was edited on", async () => {
    const { inspector, calls } = setup()
    await inspector.select("e1")
    inspector.edit("light", { intensity: 3 })
    await inspector.select("e2")
    const sent = calls.filter(([name]) => name === "setComponentFields")
    assert.deepEqual(sent, [["setComponentFields", ["e1", "light", { intensity: 3 }]]])
    assert.equal(inspector.entityId.value, "e2")
    assert.equal(inspector.components.value[0].values.intensity, 3) // the fake host keeps one set of values for every object
    assert.equal(inspector.overlays.value.size, 0)
  })

  test("a refusal that arrives after the selection moved is reported, not shown on the new object", async () => {
    const { inspector, sets, state, errors } = setup()
    await inspector.select("e1")
    state.autoReply = false
    inspector.edit("light", { intensity: 3 }, { immediate: true })
    await inspector.select("e2")
    sets[0].reply.reject(new Error("refused"))
    await tick()
    await tick()
    assert.equal(errors.length, 1)
    assert.match(String(errors[0][1]), /refused/)
    assert.equal(inspector.errors.value.size, 0)
  })

  test("an edit of a component that isn't there is ignored", async () => {
    const { inspector, sentValues } = setup()
    await inspector.select("e1")
    inspector.edit("nope", { a: 1 }, { immediate: true })
    await inspector.flush()
    assert.deepEqual(sentValues(), [])
  })

  test("a component that is gone after a read takes its edits and errors with it", async () => {
    const { inspector, engine, state } = setup()
    await inspector.select("e1")
    state.failSet = "refused"
    inspector.edit("lua", { isActive: false }, { immediate: true })
    await inspector.flush()
    assert.equal(inspector.errors.value.has("lua"), true)
    engine.getEntity = async (id) => ({
      ...entityData(id),
      entity: { ...entityData(id).entity, components: entityData(id).entity.components.slice(0, 1) },
    })
    await inspector.refresh()
    assert.equal(inspector.errors.value.has("lua"), false)
    assert.deepEqual(
      inspector.components.value.map((c) => c.id),
      ["light"]
    )
  })

  test("collapsing is per component, and forgotten for one that is gone", async () => {
    const { inspector, engine } = setup()
    await inspector.select("e1")
    inspector.toggleCollapsed("light")
    assert.equal(inspector.collapsed.value.has("light"), true)
    inspector.toggleCollapsed("light")
    assert.equal(inspector.collapsed.value.has("light"), false)
    inspector.toggleCollapsed("lua")
    engine.getEntity = async (id) => ({
      ...entityData(id),
      entity: { ...entityData(id).entity, components: [] },
    })
    await inspector.refresh()
    assert.equal(inspector.collapsed.value.size, 0)
  })
})

describe("InspectorState: the object's own properties", () => {
  test("a property is shown at once and sent", async () => {
    const { inspector, calls } = setup()
    await inspector.select("e1")
    const pending = inspector.setEntityProperties({ active: false })
    assert.equal(inspector.header.value?.active, false)
    await pending
    assert.deepEqual(calls.filter(([name]) => name === "setEntityProperties"), [["setEntityProperties", ["e1", { active: false }]]])
  })

  test("a refusal puts it back and shows the message under the object", async () => {
    const { inspector, state } = setup()
    await inspector.select("e1")
    state.failSet = "layer must be 0 to 31"
    await inspector.setEntityProperties({ layer: 40 })
    assert.equal(inspector.header.value?.layer, 0)
    assert.match(inspector.errors.value.get(EntityKey) ?? "", /layer/)
  })
})

describe("InspectorState: adding and removing components", () => {
  test("adding appends the component with the host's default values", async () => {
    const { inspector, calls } = setup()
    await inspector.loadTypes()
    await inspector.select("e1")
    await inspector.addComponent("Light")
    assert.deepEqual(calls.filter(([name]) => name === "addComponent"), [["addComponent", ["e1", "Light"]]])
    assert.deepEqual(
      inspector.components.value.map((c) => c.id),
      ["light", "lua", "new-Light"]
    )
  })

  test("a singleton the object has is refused without asking the host", async () => {
    const { inspector, calls } = setup()
    await inspector.loadTypes()
    await inspector.select("e1")
    await inspector.addComponent("Canvas")
    await assert.rejects(inspector.addComponent("Canvas"), /only one Canvas/)
    assert.equal(calls.filter(([name]) => name === "addComponent").length, 1)
  })

  test("the host's refusal is thrown, and nothing is added", async () => {
    const { inspector } = setup()
    await inspector.select("e1")
    await assert.rejects(inspector.addComponent("Boom"), /Unknown component type/)
    assert.equal(inspector.components.value.length, 2)
  })

  test("removing asks first; no leaves everything", async () => {
    const { inspector, calls } = setup({ confirm: false })
    await inspector.select("e1")
    assert.equal(await inspector.removeComponent("light"), false)
    assert.equal(calls.some(([name]) => name === "removeComponent"), false)
  })

  test("removing sends the command, drops what was edited, and reads the object again", async () => {
    const { inspector, calls, engine, timers } = setup()
    await inspector.select("e1")
    inspector.edit("light", { intensity: 3 })
    engine.getEntity = async (id) => ({
      ...entityData(id),
      entity: { ...entityData(id).entity, components: entityData(id).entity.components.slice(1) },
    })
    assert.equal(await inspector.removeComponent("light"), true)
    assert.deepEqual(calls.filter(([name]) => name === "removeComponent"), [["removeComponent", ["e1", "light"]]])
    assert.equal(calls.some(([name]) => name === "setComponentFields"), false)
    assert.equal(timers.length, 0)
    assert.deepEqual(
      inspector.components.value.map((c) => c.id),
      ["lua"]
    )
    assert.match(String(calls.find(([name]) => name === "confirm")?.[1][0]), /Remove Light/)
  })

  test("a request of a component that is being removed may be refused, and that isn't shown", async () => {
    const { inspector, engine, sets, state, errors } = setup()
    await inspector.select("e1")
    state.autoReply = false
    inspector.edit("light", { intensity: 3 }, { immediate: true })
    const removing = inspector.removeComponent("light")
    await tick()
    sets[0].reply.reject(new Error("Component not found: light"))
    engine.getEntity = async (id) => ({
      ...entityData(id),
      entity: { ...entityData(id).entity, components: entityData(id).entity.components.slice(1) },
    })
    assert.equal(await removing, true)
    assert.equal(inspector.errors.value.size, 0)
    assert.equal(errors.length, 0)
  })

  test("a refused removal is thrown, and the object is read again", async () => {
    const { inspector, engine, calls } = setup()
    await inspector.select("e1")
    engine.removeComponent = async () => {
      throw new Error("Component not found: light")
    }
    await assert.rejects(inspector.removeComponent("light"), /not found/)
    assert.equal(calls.filter(([name]) => name === "getEntity").length, 2)
  })
})

describe("InspectorState: read-only", () => {
  test("nothing can be changed while it is read-only", async () => {
    const { inspector, calls } = setup()
    await inspector.loadTypes()
    await inspector.select("e1")
    inspector.setReadOnly("a play session is running")
    assert.equal(inspector.readOnly.value, true)
    assert.throws(() => inspector.edit("light", { intensity: 2 }), /read-only: a play session is running/)
    await assert.rejects(inspector.addComponent("Light"), /read-only/)
    await assert.rejects(inspector.removeComponent("light"), /read-only/)
    await assert.rejects(inspector.setEntityProperties({ name: "x" }), /read-only/)
    const writes = ["setComponentFields", "addComponent", "removeComponent", "setEntityProperties"]
    assert.equal(calls.some(([name]) => writes.includes(name)), false)
    // Reading still works
    await inspector.refresh()
    assert.equal(inspector.components.value.length, 2)
    inspector.setReadOnly(null)
    inspector.edit("light", { intensity: 2 }, { immediate: true })
    await inspector.flush()
    assert.equal(calls.filter(([name]) => name === "setComponentFields").length, 1)
  })

  test("what was edited just before it became read-only is still sent", async () => {
    const { inspector, sentValues } = setup()
    await inspector.select("e1")
    inspector.edit("light", { intensity: 2 })
    inspector.setReadOnly("playing")
    await inspector.flush()
    assert.deepEqual(sentValues(), [{ intensity: 2 }])
  })
})

describe("InspectorState: assets and references", () => {
  test("the asset index is read, with the built-in meshes", async () => {
    const { inspector } = setup()
    await inspector.loadAssets()
    assert.equal(inspector.assets.value.byUuid(S1)?.path, "res://scripts/a.lua")
    assert.equal(inspector.assets.value.byPath("res://SCRIPTS/a.lua"), undefined) // exact by default
    assert.equal(inspector.assets.value.ofType("Mesh").length, 3)
  })

  test("a failing asset index leaves the one held", async () => {
    const { inspector } = setup()
    await inspector.loadAssets()
    const quiet = console.error
    console.error = () => {}
    try {
      const failing = new InspectorState({} as never, { listAssets: async () => Promise.reject(new Error("no")) }, { confirm: async () => true })
      await failing.loadAssets()
      assert.equal(failing.assets.value.entries.length, 3) // the built-ins only
    } finally {
      console.error = quiet
    }
  })

  test("which object a component belongs to is found by reading the candidates, each once, up to a limit", async () => {
    const { inspector, engine, calls } = setup()
    await inspector.select("e1")
    engine.getEntity = async (id) => {
      calls.push(["getEntity", [id]])
      return {
        ...entityData(id),
        entity: {
          ...entityData(id).entity,
          components: [{ type: "Body", uuid: "body-of-" + id, values: {} }],
        },
      }
    }
    assert.equal(inspector.componentInfo("body-of-e5"), undefined)
    assert.equal(await inspector.resolveComponent("body-of-e5", ["e1", "e3", "e4", "e5", "e6"]), true)
    // e1 is the inspected object (not read again), and the search stopped when it was found
    const reads = () => calls.filter(([name, args]) => name === "getEntity" && args[0] !== "e1").map(([, args]) => args[0])
    assert.deepEqual(reads(), ["e3", "e4", "e5"])
    assert.deepEqual(inspector.componentInfo("body-of-e5"), { type: "Body", entityId: "e5" })
    // Objects read once aren't read again, and an unknown component isn't found
    assert.equal(await inspector.resolveComponent("nope", ["e3", "e4", "e5", "e7"]), false)
    assert.deepEqual(reads(), ["e3", "e4", "e5", "e7"])
    // The search is capped
    const many = Array.from({ length: 200 }, (_, i) => "x" + i)
    await inspector.resolveComponent("nope", many)
    assert.equal(reads().length, 4 + InspectorState.MaxResolveReads)
  })

  test("the components of another object are listed, and remembered by UUID", async () => {
    const { inspector } = setup()
    await inspector.select("e1")
    assert.deepEqual(await inspector.componentsOf("e1"), [
      { id: "light", type: "Light" },
      { id: "lua", type: "LuaComponent" },
    ])
    assert.equal(inspector.componentInfo("light")?.entityId, "e1")
    await inspector.componentsOf("e9")
    assert.deepEqual(inspector.componentInfo("lua"), { type: "LuaComponent", entityId: "e1" })
    inspector.reset()
    assert.equal(inspector.componentInfo("light"), undefined)
  })
})
