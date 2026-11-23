// Prefab overrides (protocol 1.33.0 and 1.34.0): GetPrefabOverrides' answer as rows and targets, the field checks of the
// inspector's bold labels, and the state's Revert and Apply.
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { EntityDetails, PrefabOverridesInfo } from "../protocol/protocol.generated"
import { MultiInspectorState, buildMultiView, overriddenOn } from "../renderer/inspector-multi"
import { EditGroups } from "../renderer/edit-groups"
import {
  describeRow,
  isFieldOverridden,
  linkPathOf,
  overrideRows,
  prefabLabel,
  rowsForField,
  sharedLevels,
  targetOf,
} from "../protocol/prefab-overrides"
import { PrefabOverridesState } from "../renderer/prefab-overrides-state"
import { EngineCommandArgs } from "../shared/api"

const Nest = { level: 0, prefab: "nest-uuid", path: "res://props/Nest.prefab" }
const Crate = { level: 1, prefab: "crate-uuid", path: "res://props/Crate.prefab" }

/** A Nest instance whose inner Crate's lid is renamed, whose root has a light added, and that lost a component */
const info = (): PrefabOverridesInfo => ({
  rootId: "root",
  prefab: "nest-uuid",
  path: "res://props/Nest.prefab",
  overrides: [
    { source: "inner/lid", path: "name", value: "Open lid", objectId: "lid" },
    { source: "inner/lid", component: "inner/sprite", path: "color", value: [1, 0, 0, 1], objectId: "lid", componentId: "sprite" },
  ],
  removedObjects: [],
  removedComponents: ["inner/body"],
  addedComponents: [{ source: "nestroot", component: { type: "Light", data: { uuid: "light" } }, objectId: "root" }],
  addedChildren: [{ source: "nestroot", object: { uuid: "sticker", name: "Sticker" }, objectId: "root" }],
  linkPath: [
    { rootId: "root", prefab: "nest-uuid", path: "res://props/Nest.prefab" },
    { rootId: "inner", prefab: "crate-uuid", path: "res://props/Crate.prefab" },
  ],
  applyTo: {
    overrides: [[Nest, Crate], [Nest, Crate]],
    removedObjects: [],
    removedComponents: [[Nest, Crate]],
    addedComponents: [[Nest]],
    addedChildren: [[Nest]],
  },
})

describe("override rows", () => {
  test("every change becomes a row with the target that names it and where it can be applied", () => {
    const rows = overrideRows(info())
    assert.equal(rows.length, 5)
    assert.deepEqual(rows[0].target, { source: "inner/lid", path: "name" })
    assert.equal(rows[0].objectId, "lid")
    assert.equal(rows[0].componentId, null)
    assert.deepEqual(rows[0].levels, [Nest, Crate])
    assert.deepEqual(rows[1].target, { source: "inner/lid", path: "color", component: "inner/sprite" })
    assert.equal(rows[1].componentId, "sprite")
    assert.deepEqual(rows[2].target, { removedComponent: "inner/body" })
    assert.deepEqual(rows[3].target, { addedComponent: "light" })
    assert.equal(rows[3].componentId, "light")
    assert.deepEqual(rows[4].target, { addedChild: "sticker" })
  })

  test("a 1.33.0 host's answer has no levels: the rows can be reverted, not applied", () => {
    const old = info()
    delete old.applyTo
    delete old.linkPath
    const rows = overrideRows(old)
    assert.equal(rows.length, 5)
    assert.ok(rows.every((row) => row.levels.length === 0))
    assert.deepEqual(linkPathOf(old), [])
  })

  test("an entry that names nothing is left out", () => {
    assert.equal(targetOf("overrides", { path: "name" }), null)
    assert.equal(targetOf("removedObjects", 5), null)
    assert.equal(targetOf("addedChildren", { object: {} }), null)
  })

  test("a row says what it changes, with the scene's names", () => {
    const rows = overrideRows(info())
    const names = { object: (id: string) => ({ lid: "Lid", root: "Nest 1", sticker: "Sticker" })[id] ?? null, component: (id: string) => (id === "sprite" ? "Sprite2D" : null) }
    assert.equal(describeRow(rows[0], names), "Lid: name")
    assert.equal(describeRow(rows[1], names), "Lid: Sprite2D color")
    assert.equal(describeRow(rows[3], names), "Nest 1: added a component")
    assert.equal(describeRow(rows[4], names), "Added Sticker under Nest 1")
  })
})

describe("overridden fields", () => {
  test("a value's key, a script field and a path inside one count; another field does not", () => {
    assert.equal(isFieldOverridden(["color"], "color"), true)
    assert.equal(isFieldOverridden(["scriptData.speed"], "speed"), true)
    assert.equal(isFieldOverridden(["positionable.localScale"], "positionable.localScale"), true)
    assert.equal(isFieldOverridden(["size.x"], "size"), true)
    assert.equal(isFieldOverridden(["colorMode"], "color"), false, "a prefix of a name is not the field")
    assert.equal(isFieldOverridden(undefined, "color"), false)
  })

  test("the rows of one field are the object's or the component's own", () => {
    const rows = overrideRows(info())
    assert.deepEqual(rowsForField(rows, "lid", null, "name"), [rows[0]])
    assert.deepEqual(rowsForField(rows, "lid", "sprite", "color"), [rows[1]])
    assert.deepEqual(rowsForField(rows, "root", null, "name"), [])
    assert.deepEqual(sharedLevels([rows[0], rows[3]]), [Nest], "only the levels every row has")
  })

  test("a prefab's label is its file name", () => {
    assert.equal(prefabLabel(Crate), "Crate.prefab")
    assert.equal(prefabLabel({ prefab: "u", path: "" }), "u")
  })
})

describe("the overrides state", () => {
  const fake = () => {
    const calls: string[] = []
    let answer = info()
    const engine = {
      getPrefabOverrides: async (id: string) => {
        calls.push(`get ${id}`)
        return answer
      },
      revertPrefabOverrides: async (id: string, targets: unknown[]) => void calls.push(`revert ${id} ${JSON.stringify(targets)}`),
      applyPrefabOverrides: async (id: string, targets: unknown[], level: number) =>
        void calls.push(`apply ${id} ${JSON.stringify(targets)} ${level}`),
    }
    const asked: string[] = []
    let agree = true
    const state = new PrefabOverridesState(engine, {
      confirm: async (message) => {
        asked.push(message)
        return agree
      },
      changed: () => void calls.push("changed"),
    })
    return {
      state,
      calls,
      asked,
      setAgree: (v: boolean) => (agree = v),
      setAnswer: (v: PrefabOverridesInfo) => (answer = v),
    }
  }

  test("reads the object's instance, and clears for none", async () => {
    const f = fake()
    await f.state.load("lid")
    assert.equal(f.state.rows.value.length, 5)
    assert.equal(f.state.linkPath.value.length, 2)
    assert.equal(f.state.canApply, true)
    await f.state.load(null)
    assert.equal(f.state.info.value, null)
    assert.deepEqual(f.calls, ["get lid"])
  })

  test("Revert sends the rows' targets, or all, then reads again", async () => {
    const f = fake()
    await f.state.load("lid")
    await f.state.revert([f.state.rows.value[0]])
    await f.state.revert("all")
    assert.deepEqual(f.calls, [
      "get lid",
      'revert lid [{"source":"inner/lid","path":"name"}]',
      "changed",
      "get lid",
      'revert lid [{"all":true}]',
      "changed",
      "get lid",
    ])
  })

  test("Apply asks first, names the prefab, and sends the level", async () => {
    const f = fake()
    await f.state.load("lid")
    f.setAgree(false)
    assert.equal(await f.state.apply([f.state.rows.value[0]], 1), false)
    assert.equal(f.calls.filter((c) => c.startsWith("apply")).length, 0, "nothing is sent when the user says no")
    assert.match(f.asked[0], /Apply this override to Crate\.prefab\?/)
    f.setAgree(true)
    assert.equal(await f.state.apply("all", -1), true)
    assert.ok(f.calls.includes('apply lid [{"all":true}] -1'))
    assert.match(f.asked[1], /every override of this instance to the innermost prefab/)
  })

  test("a host before 1.34.0 can't apply: no levels in its answer", async () => {
    const f = fake()
    const old = info()
    delete old.applyTo
    f.setAnswer(old)
    await f.state.load("lid")
    assert.equal(f.state.canApply, false)
    assert.equal(await f.state.apply("all", 0), false)
  })

  test("the page may call the three commands with checked arguments", () => {
    assert.deepEqual(EngineCommandArgs.getPrefabOverrides, ["string"])
    assert.deepEqual(EngineCommandArgs.revertPrefabOverrides, ["string", "jsonArray"])
    assert.deepEqual(EngineCommandArgs.applyPrefabOverrides, ["string", "jsonArray", "int32"])
    assert.deepEqual(EngineCommandArgs.unpackPrefab, ["string", "bool"])
  })
})

describe("the multi-object inspector's overrides", () => {
  const object = (id: string, overrides: string[] | undefined, componentOverrides: string[] | undefined): EntityDetails => ({
    header: { id, parentId: "", index: 0, name: id, active: true, activeInHierarchy: true, layer: 0, tag: "", linkDepth: 1, ...(overrides ? { overrides } : {}) },
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
    components: [{ type: "Light", uuid: `${id}-light`, values: { intensity: 1 }, ...(componentOverrides ? { overrides: componentOverrides } : {}) }],
  })

  test("overriddenOn names the objects where an own field or a shared component's field differs", () => {
    const objects = [object("a", ["tag"], ["intensity"]), object("b", undefined, undefined), object("c", ["tag"], undefined)]
    const view = buildMultiView(objects)
    assert.deepEqual(overriddenOn(objects, null, "tag").map((o) => o.entityId), ["a", "c"])
    assert.deepEqual(overriddenOn(objects, view.components[0], "intensity"), [{ entityId: "a", componentId: "a-light" }])
    assert.deepEqual(overriddenOn(objects, null, "layer"), [])
  })

  test("Revert reads each object's overrides and reverts that field there only, as one edit group", async () => {
    const objects = new Map([
      ["a", object("a", ["tag"], undefined)],
      ["b", object("b", undefined, undefined)],
    ])
    const calls: string[] = []
    const engine = {
      isConnected: () => true,
      getEntity: async (id: string) => ({ entity: structuredClone(objects.get(id)!), worldMatrix: [] }),
      getLuaFields: async () => ({ typeName: "LuaComponent", singleton: false, fields: [] }),
      setEntityProperties: async () => {},
      setComponentFields: async () => ({}),
      setLocalTransform: async () => {},
      addComponent: async () => ({ componentId: "", values: {} }),
      removeComponent: async () => {},
      getPrefabOverrides: async (id: string): Promise<PrefabOverridesInfo> => ({
        ...info(),
        overrides: [{ source: `${id}-src`, path: "tag", value: "X", objectId: id }],
        removedComponents: [],
        addedComponents: [],
        addedChildren: [],
      }),
      revertPrefabOverrides: async (id: string, targets: unknown[]) => void calls.push(`revert ${id} ${JSON.stringify(targets)}`),
    }
    const groups = new EditGroups({
      isConnected: () => true,
      beginEditGroup: async (label: string) => void calls.push(`begin ${label}`),
      endEditGroup: async () => void calls.push("end"),
    })
    const host = { types: { value: [] }, readOnlyReason: { value: null } }
    const multi = new MultiInspectorState(host, engine, { groups })
    await multi.select(["a", "b"])
    assert.equal(multi.canRevertOverrides, true)
    await multi.revertOverride(null, "tag")
    assert.deepEqual(
      calls.filter((c) => c.startsWith("revert")),
      ['revert a [{"source":"a-src","path":"tag"}]'],
      "b has no override of the tag: nothing is sent for it"
    )
  })
})
