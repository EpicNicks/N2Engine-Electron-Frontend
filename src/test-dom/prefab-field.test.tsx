// A Lua script's Prefab field (protocol 1.25.0) in the inspector: a slot that takes only a .prefab (a drop, the picker),
// refuses any other asset with the field's name, shows a UUID the project doesn't have as a missing prefab and keeps it,
// clears with null, and selects the prefab in the Assets panel on a double-click. Hand-made dataTransfers stand in for
// the browser's (jsdom has none).
import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { screen, waitFor, fireEvent } from "@testing-library/preact"
import { signal } from "@preact/signals-core"
import type { ComponentSchema, EntityDetails, Quat } from "../protocol/protocol.generated"
import type { AssetEntry, JsonObject } from "../shared/api"
import { InspectorState } from "../renderer/inspector-state"
import { InspectorPanel } from "../renderer/inspector-panel"
import { AssetDragType, PrefabDragType, assetDragData } from "../renderer/drag-types"
import type { Selection } from "../renderer/hierarchy-tree"
import { checkValue, fieldPatch, getFieldValue } from "../renderer/inspector-fields"
import { parseFieldSchema } from "../protocol/component-schema"
import { renderWithApp } from "./helpers"

const Enemy: AssetEntry = { uuid: "55555555-5555-4555-8555-555555555555", path: "res://prefabs/Enemy.prefab", resourceType: "Prefab" }
const Boss: AssetEntry = { uuid: "66666666-6666-4666-8666-666666666666", path: "res://prefabs/Boss.prefab", resourceType: "Prefab" }
const Hero: AssetEntry = { uuid: "77777777-7777-4777-8777-777777777777", path: "res://hero.png", resourceType: "Texture" }
const Script = "88888888-8888-4888-8888-888888888888"
const Missing = "99999999-9999-4999-8999-999999999999"

const enemyField = {
  name: "enemy",
  displayName: "Enemy",
  kind: "PrefabRef",
  typeName: "Prefab",
  assetType: "Prefab",
  hidden: false,
  readOnly: false,
  container: "scriptData",
}

const luaSchema: ComponentSchema = {
  typeName: "LuaComponent",
  singleton: false,
  fields: [
    { name: "scriptUUID", displayName: "Script", kind: "AssetRef", typeName: "LuaScript", assetType: "LuaScript", hidden: false, readOnly: false },
    enemyField,
  ],
}

const identity: Quat = { x: 0, y: 0, z: 0, w: 1 }

/** One object "Spawner" with a LuaComponent whose enemy field holds `stored` */
async function render(stored: string | undefined) {
  const scriptData: JsonObject = stored === undefined ? {} : { enemy: stored }
  const values: JsonObject = { isActive: true, scriptUUID: Script, scriptData }
  const sent: JsonObject[] = []
  const selected: string[] = []
  const engine = {
    isConnected: () => true,
    getEntity: async (id: string) => {
      const entity: EntityDetails = {
        header: { id, parentId: "", index: 0, name: "Spawner", active: true, activeInHierarchy: true, layer: 0, tag: "" },
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: identity, scale: { x: 1, y: 1, z: 1 } },
        components: [{ type: "LuaComponent", uuid: "c1", values: structuredClone(values) }],
      }
      return { entity, worldMatrix: [] }
    },
    getComponentTypes: async () => [],
    getLuaFields: async (): Promise<ComponentSchema> => luaSchema,
    setEntityProperties: async () => {},
    setLocalTransform: async () => {},
    addComponent: async () => ({ componentId: "", values: {} }),
    removeComponent: async () => {},
    setComponentFields: async (_id: string, _componentId: string, patch: JsonObject) => {
      sent.push(structuredClone(patch))
      const data = patch.scriptData as JsonObject
      scriptData.enemy = data.enemy === null ? "" : data.enemy
      return structuredClone(values)
    },
  }
  const inspector = new InspectorState(engine, { listAssets: async () => [Enemy, Boss, Hero] }, { confirm: async () => true })
  await inspector.loadTypes()
  await inspector.loadAssets()
  await inspector.select("e1")
  const selection = signal<Selection>({ ids: new Set(["e1"]), anchor: "e1", primary: "e1" })
  renderWithApp(<InspectorPanel />, {
    store: { connected: signal(true), reportError: () => {} } as never,
    scene: { selectedId: signal<string | null>("e1") },
    hierarchy: { selection, deleteSelected: async () => {} } as never,
    inspector,
    assets: { select: async (path: string | null) => void selected.push(String(path)) } as never,
    extensions: { sectionsFor: () => [] } as never,
  })
  await screen.findByText("Enemy")
  return { sent, selected }
}

/** A dataTransfer as the Assets panel fills it for a row (a prefab's also carries PrefabDragType) */
function transferOf(asset: AssetEntry) {
  const data = new Map<string, string>([[AssetDragType, assetDragData(asset)]])
  if (asset.resourceType === "Prefab") data.set(PrefabDragType, assetDragData(asset))
  return { dropEffect: "", effectAllowed: "copy", types: [...data.keys()], getData: (type: string) => data.get(type) ?? "" }
}

const slot = () => {
  const found = document.querySelector(".prefab-slot .slot")
  assert.ok(found, "the prefab slot")
  return found as HTMLElement
}

describe("the Prefab field's value", () => {
  test("is a plain UUID string inside scriptData, and empty or null is none", () => {
    const field = parseFieldSchema({ ...enemyField, assetPath: Enemy.path }, "field")
    assert.equal(field.kind, "PrefabRef")
    assert.equal(field.assetPath, Enemy.path)
    assert.deepEqual(fieldPatch(field, Enemy.uuid), { scriptData: { enemy: Enemy.uuid } }, "never {$ref}")
    assert.equal(getFieldValue(field, { scriptData: { enemy: Enemy.uuid } }), Enemy.uuid)
    assert.deepEqual(checkValue(field, ""), { ok: true, value: null })
    assert.deepEqual(checkValue(field, null), { ok: true, value: null })
    assert.equal(checkValue(field, "res://prefabs/Enemy.prefab").ok, false)
  })
})

describe("the Prefab field in the inspector", () => {
  test("an empty field shows None; a dropped prefab is sent as its UUID", async () => {
    const { sent } = await render(undefined)
    assert.match(slot().textContent ?? "", /None/)
    const transfer = transferOf(Enemy)
    const over = fireEvent.dragOver(slot(), { dataTransfer: transfer })
    assert.equal(over, false, "a prefab's drag is allowed (the default is prevented)")
    fireEvent.drop(slot(), { dataTransfer: transfer })
    await waitFor(() => assert.equal(sent.length, 1))
    assert.deepEqual(sent[0], { scriptData: { enemy: Enemy.uuid } })
  })

  test("any other asset is refused while it is over the slot and on a drop, and nothing is sent", async () => {
    const { sent } = await render(undefined)
    const transfer = transferOf(Hero)
    const over = fireEvent.dragOver(slot(), { dataTransfer: transfer })
    assert.equal(over, true, "not a prefab: the drop is not allowed (the cursor shows it)")
    fireEvent.drop(slot(), { dataTransfer: transfer })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(sent.length, 0)
  })

  test("a chosen prefab is shown by its file name", async () => {
    await render(Boss.uuid)
    assert.match(slot().textContent ?? "", /Boss\.prefab/)
  })

  test("a missing prefab is shown red with its short UUID; Clear sends null", async () => {
    const { sent } = await render(Missing)
    assert.match(slot().textContent ?? "", /Missing prefab 99999999/)
    assert.ok(slot().querySelector(".slot-label.missing"), "shown as missing")
    fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    await waitFor(() => assert.equal(sent.length, 1))
    assert.deepEqual(sent[0], { scriptData: { enemy: null } })
  })

  test("a double-click selects the prefab in the Assets panel", async () => {
    const { selected } = await render(Enemy.uuid)
    fireEvent.dblClick(slot())
    assert.deepEqual(selected, [Enemy.path])
  })
})
