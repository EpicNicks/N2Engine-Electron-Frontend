import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { fireEvent, screen, waitFor } from "@testing-library/preact"
import { signal } from "@preact/signals-core"
import type { ComponentSchema, FieldSchema } from "../protocol/protocol.generated"
import type { AssetEntry, JsonObject } from "../shared/api"
import { EditGroups } from "../renderer/edit-groups"
import { InspectorState } from "../renderer/inspector-state"
import { InspectorPanel } from "../renderer/inspector-panel"
import type { Selection } from "../renderer/hierarchy-tree"
import { AssetDragType, EntityDragType, PrefabDragType, ScriptDragType, assetDragData } from "../renderer/drag-types"
import { renderWithApp } from "./helpers"

const S1 = "11111111-1111-1111-1111-111111111111"
const S2 = "22222222-2222-2222-2222-222222222222"
const OBJ = "44444444-4444-4444-4444-444444444444"
const PREFAB = "33333333-3333-3333-3333-333333333333"

const field = (name: string, kind: string, extra: Partial<FieldSchema> = {}): FieldSchema => ({
  name,
  displayName: name === "scriptUUID" ? "Script" : name[0].toUpperCase() + name.slice(1),
  kind,
  typeName: kind === "GameObjectRef" ? "GameObject" : kind === "Float" ? "float" : kind,
  hidden: false,
  readOnly: false,
  ...extra,
})

/** A LuaComponent whose script has an exposed GameObject field (target) and a number (speed) */
const luaSchema: ComponentSchema = {
  typeName: "LuaComponent",
  singleton: false,
  fields: [
    field("scriptUUID", "AssetRef", { assetType: "LuaScript" }),
    field("target", "GameObjectRef", { container: "scriptData" }),
    field("speed", "Float", { container: "scriptData" }),
  ],
}

const assets: AssetEntry[] = [
  { uuid: S1, path: "res://scripts/a.lua", resourceType: "LuaScript" },
  { uuid: S2, path: "res://scripts/b.lua", resourceType: "LuaScript" },
  { uuid: PREFAB, path: "res://prefabs/Pink Light.prefab", resourceType: "Prefab" },
]

function setup() {
  const calls: Array<[string, unknown[]]> = []
  const components = [{ type: "LuaComponent", uuid: "lua", values: { scriptUUID: S1, scriptData: {} } as JsonObject }]
  let added = 0
  const engine = {
    isConnected: () => true,
    getEntity: async (id: string) => ({
      entity: {
        header: { id, parentId: "", index: 0, name: "Lamp", active: true, activeInHierarchy: true, layer: 0, tag: "" },
        transform: undefined,
        components: structuredClone(components),
      },
      worldMatrix: [],
    }),
    getComponentTypes: async () => [luaSchema],
    getLuaFields: async () => luaSchema,
    addComponent: async (id: string, type: string) => {
      calls.push(["addComponent", [id, type]])
      const uuid = `new-${++added}`
      components.push({ type, uuid, values: { scriptUUID: "" } })
      return { componentId: uuid, values: { scriptUUID: "" } }
    },
    removeComponent: async () => {},
    setEntityProperties: async () => {},
    setLocalTransform: async () => {},
    setComponentFields: async (id: string, componentId: string, values: JsonObject) => {
      calls.push(["setComponentFields", [id, componentId, values]])
      const component = components.find((c) => c.uuid === componentId)!
      component.values = { ...component.values, ...values }
      return component.values
    },
    beginEditGroup: async (label: string) => void calls.push(["beginEditGroup", [label]]),
    endEditGroup: async () => void calls.push(["endEditGroup", []]),
  }
  return { engine, calls }
}

async function render(options: { selected?: string[] } = {}) {
  const { engine, calls } = setup()
  const inspector = new InspectorState(
    engine,
    { listAssets: async () => assets },
    { confirm: async () => true, groups: new EditGroups(engine) }
  )
  await inspector.loadTypes()
  await inspector.loadAssets()
  const ids = options.selected ?? ["e1"]
  await inspector.select(ids[0])
  const reported: string[] = []
  const tree = {
    nodes: new Map([[OBJ, { name: "Obj" }]]),
    parents: new Map<string, string>(),
    order: [OBJ],
  }
  const selection = signal<Selection>({ ids: new Set(ids), anchor: ids[0], primary: ids[0] })
  const view = renderWithApp(<InspectorPanel />, {
    store: { connected: signal(true), reportError: (what: string, e: unknown) => void reported.push(`${what}: ${e}`) } as never,
    scene: { selectedId: signal<string | null>(ids[0]) },
    hierarchy: { selection, tree: signal(tree), deleteSelected: async () => {} } as never,
    inspector,
    extensions: { sectionsFor: () => [] } as never,
  })
  if (ids.length === 1) await waitFor(() => assert.ok(screen.getByText("Target")))
  return { inspector, calls, reported, view }
}

/** A hand-made dataTransfer (jsdom has none) carrying what the panels put in a drag */
function transferOf(data: Record<string, string>) {
  return { types: Object.keys(data), getData: (type: string) => data[type] ?? "", dropEffect: "", effectAllowed: "" }
}

const asset = (a: AssetEntry) => ({ [AssetDragType]: assetDragData(a) })
const prefabDrag = { ...asset(assets[2]), [PrefabDragType]: assetDragData(assets[2]) }
const scriptDrag = (list: AssetEntry[]) => ({
  ...asset(list[0]),
  [ScriptDragType]: list.length > 1 ? JSON.stringify(list.map((s) => JSON.parse(assetDragData(s)))) : assetDragData(list[0]),
})

/** The editor cell of a field, by its label */
const cellOf = (label: string): HTMLElement => screen.getByText(label, { selector: "label" }).parentElement as HTMLElement
const slotOf = (label: string): HTMLElement => cellOf(label).querySelector(".slot") as HTMLElement
const body = (): HTMLElement => document.querySelector(".inspector-drop") as HTMLElement

describe("a drop on a field is checked against that field (D)", () => {
  test("a prefab dropped on a GameObject field is refused in that field's words and writes nothing", async () => {
    const t = await render()
    const slot = slotOf("Target")
    const over = fireEvent.dragOver(slot, { dataTransfer: transferOf(prefabDrag) })
    assert.equal(over, false, "the field takes the drag (the drop is allowed, so it can say why not)")
    fireEvent.drop(slot, { dataTransfer: transferOf(prefabDrag) })
    const message = cellOf("Target").querySelector(".field-error")?.textContent ?? ""
    assert.match(message, /Pink Light\.prefab is a Prefab; Target expects a GameObject \(drag an object from the hierarchy\)/)
    assert.doesNotMatch(message, /Script|LuaScript/)
    assert.equal(cellOf("Script").querySelector(".field-error"), null)
    assert.deepEqual(t.calls, [])
    assert.deepEqual(t.reported, [])
  })

  test("a hierarchy object dropped on the GameObject field is taken, as before", async () => {
    const t = await render()
    fireEvent.drop(slotOf("Target"), { dataTransfer: transferOf({ [EntityDragType]: OBJ }) })
    await waitFor(() => assert.equal(t.calls.filter(([n]) => n === "setComponentFields").length, 1))
    await waitFor(() =>
      assert.deepEqual(t.calls.find(([n]) => n === "setComponentFields")?.[1], ["e1", "lua", { scriptData: { target: { $ref: OBJ } } }])
    )
    assert.equal(cellOf("Target").querySelector(".field-error"), null)
  })

  test("a prefab dropped on the Script field is still refused there, naming Script", async () => {
    const t = await render()
    fireEvent.drop(slotOf("Script"), { dataTransfer: transferOf(prefabDrag) })
    assert.match(cellOf("Script").querySelector(".field-error")?.textContent ?? "", /Script expects LuaScript/)
    assert.equal(cellOf("Target").querySelector(".field-error"), null)
    assert.deepEqual(t.calls, [])
  })

  test("a script dropped on a field that takes none (a number) adds no component: the field owns the drop", async () => {
    const t = await render()
    const cell = cellOf("Speed")
    const allowed = fireEvent.dragOver(cell, { dataTransfer: transferOf(scriptDrag([assets[1]])) })
    assert.equal(allowed, true, "not cancelled: the browser refuses the drop")
    fireEvent.drop(cell, { dataTransfer: transferOf(scriptDrag([assets[1]])) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(t.calls, [])
  })

  test("a script dropped on the Script field replaces that field's script and adds no component", async () => {
    const t = await render()
    fireEvent.drop(slotOf("Script"), { dataTransfer: transferOf(scriptDrag([assets[1]])) })
    await waitFor(() => assert.ok(t.calls.some(([n]) => n === "setComponentFields")))
    assert.equal(t.calls.some(([n]) => n === "addComponent"), false)
    assert.deepEqual(t.calls.find(([n]) => n === "setComponentFields")?.[1].slice(0, 2), ["e1", "lua"])
  })
})

describe("a script dropped on the inspector body adds a LuaComponent (A)", () => {
  test("outside any field: one component with that script, as one edit group", async () => {
    const t = await render()
    assert.equal(fireEvent.dragOver(body(), { dataTransfer: transferOf(scriptDrag([assets[1]])) }), false)
    fireEvent.drop(body(), { dataTransfer: transferOf(scriptDrag([assets[1]])) })
    await waitFor(() => assert.equal(t.calls.at(-1)?.[0], "endEditGroup"))
    assert.deepEqual(
      t.calls.map(([n]) => n),
      ["beginEditGroup", "addComponent", "setComponentFields", "endEditGroup"]
    )
    assert.deepEqual(t.calls[2][1], ["e1", "new-1", { scriptUUID: S2 }])
    // The object had a LuaComponent already: this is another
    await waitFor(() => assert.equal(t.inspector.components.value.filter((c) => c.type === "LuaComponent").length, 2))
  })

  test("several scripts: one component each, one group", async () => {
    const t = await render()
    fireEvent.drop(body(), { dataTransfer: transferOf(scriptDrag([assets[0], assets[1]])) })
    await waitFor(() => assert.equal(t.calls.at(-1)?.[0], "endEditGroup"))
    assert.deepEqual(
      t.calls.map(([n]) => n),
      ["beginEditGroup", "addComponent", "setComponentFields", "addComponent", "setComponentFields", "endEditGroup"]
    )
  })

  test("a prefab or another asset on the body does nothing", async () => {
    const t = await render()
    assert.equal(fireEvent.dragOver(body(), { dataTransfer: transferOf(prefabDrag) }), true)
    fireEvent.drop(body(), { dataTransfer: transferOf(prefabDrag) })
    assert.deepEqual(t.calls, [])
  })

  test("with several objects selected it adds nothing and says to select one", async () => {
    const t = await render({ selected: ["e1", "e2"] })
    fireEvent.drop(body(), { dataTransfer: transferOf(scriptDrag([assets[1]])) })
    assert.deepEqual(t.calls, [])
    assert.match(t.reported.join("\n"), /Select one object/)
  })
})
