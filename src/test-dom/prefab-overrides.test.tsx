/// <reference path="../renderer/globals.d.ts" />
// Prefab links and overrides in the panels (protocol 1.33.0 and 1.34.0): the hierarchy's marks and Unpack Completely, the
// inspector's bold overridden labels with Revert and Apply on a right-click, and its list of the instance's overrides.
import "./setup"
import { test, describe, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import { cleanup, screen, waitFor, fireEvent } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { signal } from "@preact/signals-core"
import type { ComponentSchema, EntityDetails, HierarchyResponse, PrefabOverridesInfo } from "../protocol/protocol.generated"
import { HierarchyPanel } from "../renderer/hierarchy-panel"
import { HierarchyState } from "../renderer/hierarchy-state"
import { InspectorState } from "../renderer/inspector-state"
import { InspectorPanel } from "../renderer/inspector-panel"
import { buildTree } from "../renderer/hierarchy-tree"
import type { Selection } from "../renderer/hierarchy-tree"
import { ConfirmDialog, ContextMenu, confirmDialog, showContextMenu } from "../renderer/ui"
import { renderWithApp } from "./helpers"
import { FakeSceneHost, stubStore } from "./panel-fakes"

beforeEach(() => {
  cleanup()
  showContextMenu(0, 0, [])
})

const PU = "55555555-5555-5555-5555-555555555555"

describe("the hierarchy's prefab marks", () => {
  async function mount(apply: boolean) {
    const sceneHost = new FakeSceneHost("Nest(Inner(Lid),Sticker),Plain")
    const fake = stubStore()
    const calls: string[] = []
    const marks: Record<string, Partial<HierarchyResponse["nodes"][number]>> = {
      Nest: { prefab: PU, linkDepth: 1, overridden: true },
      Inner: { prefab: PU, linkDepth: 2 },
      Lid: { linkDepth: 2, overridden: true },
      Sticker: { prefabAdded: true },
    }
    const base = sceneHost.engine.getHierarchy
    const engine = {
      ...sceneHost.engine,
      getHierarchy: async (): Promise<HierarchyResponse> => {
        const response = await base()
        return { ...response, nodes: response.nodes.map((n) => ({ ...n, ...(marks[n.name] ?? {}) })) }
      },
      createPrefab: async () => ({ path: "", uuid: PU }),
      instantiatePrefab: async () => "",
      applyPrefab: async () => {},
      unpackPrefab: async (id: string, completely: boolean) => void calls.push(`unpack ${sceneHost.find(id)!.obj.name} ${completely}`),
    }
    const hierarchy = new HierarchyState(engine, {
      confirm: confirmDialog,
      prefabs: {
        enabled: signal(true),
        nesting: signal(true),
        overridesApply: signal(apply),
        pathOf: () => "res://Nest.prefab",
        exists: () => false,
        changed: () => {},
      },
    })
    await hierarchy.refresh()
    for (const id of hierarchy.tree.value.nodes.keys()) hierarchy.expand(id)
    renderWithApp(
      <>
        <HierarchyPanel />
        <ContextMenu />
        <ConfirmDialog />
      </>,
      { store: fake.store, hierarchy }
    )
    return { hierarchy, calls }
  }

  const row = (name: string): HTMLElement => {
    const found = Array.from(document.querySelectorAll<HTMLElement>(".hierarchy-item")).find(
      (r) => r.querySelector(".hierarchy-name")?.textContent === name
    )
    assert.ok(found, `no row ${name}`)
    return found
  }

  test("an instance's objects, what differs from the prefab, and what the instance added are marked", async () => {
    await mount(true)
    await waitFor(() => assert.ok(document.querySelectorAll(".hierarchy-item").length >= 5))
    assert.ok(row("Nest").classList.contains("in-prefab"))
    assert.ok(row("Lid").classList.contains("in-prefab"))
    assert.ok(!row("Plain").classList.contains("in-prefab"))
    assert.ok(row("Nest").querySelector(".hierarchy-overridden"), "the root of an instance with overrides")
    assert.ok(row("Lid").querySelector(".hierarchy-overridden"))
    assert.equal(row("Inner").querySelector(".hierarchy-overridden"), null)
    assert.ok(row("Sticker").querySelector(".hierarchy-added"))
    assert.match(row("Nest").querySelector(".hierarchy-prefab")!.getAttribute("title")!, /follows the prefab/)
  })

  test("Unpack Prefab Completely is offered by a 1.34.0 host and unpacks with completely", async () => {
    const { calls } = await mount(true)
    fireEvent.contextMenu(row("Nest"))
    await userEvent.setup().click(await screen.findByText("Unpack Prefab Completely"))
    await waitFor(() => assert.deepEqual(calls, ["unpack Nest true"]))
  })

  test("a 1.33.0 host has no Unpack Completely", async () => {
    await mount(false)
    fireEvent.contextMenu(row("Nest"))
    await screen.findByText("Unpack Prefab")
    assert.equal(screen.queryByText("Unpack Prefab Completely"), null)
  })
})

describe("the inspector's prefab overrides", () => {
  const spriteType: ComponentSchema = {
    typeName: "Sprite2D",
    singleton: false,
    fields: [
      { name: "color", displayName: "Color", kind: "String", typeName: "string", hidden: false, readOnly: false },
      { name: "flipX", displayName: "Flip X", kind: "Bool", typeName: "bool", hidden: false, readOnly: false },
    ],
  }
  const info = (): PrefabOverridesInfo => ({
    rootId: "root",
    prefab: PU,
    path: "res://Nest.prefab",
    overrides: [
      { source: "inner/lid", path: "name", value: "Open lid", objectId: "lid" },
      { source: "inner/lid", component: "inner/sprite", path: "color", value: "red", objectId: "lid", componentId: "sprite" },
    ],
    removedObjects: [],
    removedComponents: [],
    addedComponents: [],
    addedChildren: [],
    linkPath: [
      { rootId: "root", prefab: PU, path: "res://Nest.prefab" },
      { rootId: "inner", prefab: "crate", path: "res://Crate.prefab" },
    ],
    applyTo: {
      overrides: [
        [
          { level: 0, prefab: PU, path: "res://Nest.prefab" },
          { level: 1, prefab: "crate", path: "res://Crate.prefab" },
        ],
        [
          { level: 0, prefab: PU, path: "res://Nest.prefab" },
          { level: 1, prefab: "crate", path: "res://Crate.prefab" },
        ],
      ],
      removedObjects: [],
      removedComponents: [],
      addedComponents: [],
      addedChildren: [],
    },
  })

  async function mount() {
    const calls: string[] = []
    const engine = {
      isConnected: () => true,
      getEntity: async (id: string) => ({
        entity: {
          header: {
            id,
            parentId: "inner",
            index: 0,
            name: "Open lid",
            active: true,
            activeInHierarchy: true,
            layer: 0,
            tag: "",
            linkDepth: 2,
            overridden: true,
            overrides: ["name"],
          },
          components: [{ type: "Sprite2D", uuid: "sprite", values: { color: "red", flipX: false }, overrides: ["color"] }],
        } as EntityDetails,
        worldMatrix: [],
      }),
      getComponentTypes: async () => [spriteType],
      addComponent: async () => ({ componentId: "x", values: {} }),
      removeComponent: async () => {},
      getLuaFields: async (): Promise<ComponentSchema> => ({ typeName: "LuaComponent", singleton: false, fields: [] }),
      setEntityProperties: async () => {},
      setComponentFields: async () => ({}),
      setLocalTransform: async () => {},
      getPrefabOverrides: async (id: string) => {
        calls.push(`get ${id}`)
        return info()
      },
      revertPrefabOverrides: async (id: string, targets: unknown[]) => void calls.push(`revert ${id} ${JSON.stringify(targets)}`),
      applyPrefabOverrides: async (id: string, targets: unknown[], level: number) =>
        void calls.push(`apply ${id} ${JSON.stringify(targets)} ${level}`),
    }
    const opened: string[] = []
    const inspector = new InspectorState(engine, { listAssets: async () => [] }, { confirm: confirmDialog, onError: () => {} })
    await inspector.loadTypes()
    await inspector.select("lid")
    await waitFor(() => assert.ok(inspector.prefabOverrides.info.value))
    const selection = signal<Selection>({ ids: new Set(["lid"]), anchor: "lid", primary: "lid" })
    const nodes = [
      { id: "root", parentId: "", index: 0, name: "Nest 1", active: true, activeInHierarchy: true, layer: 0, tag: "", components: [], prefab: PU, linkDepth: 1 },
      { id: "inner", parentId: "root", index: 0, name: "Inner", active: true, activeInHierarchy: true, layer: 0, tag: "", components: [], prefab: "crate", linkDepth: 2 },
      { id: "lid", parentId: "inner", index: 0, name: "Open lid", active: true, activeInHierarchy: true, layer: 0, tag: "", components: ["Sprite2D"], linkDepth: 2 },
    ]
    renderWithApp(
      <>
        <InspectorPanel />
        <ContextMenu />
        <ConfirmDialog />
      </>,
      {
        store: {
          connected: signal(true),
          reportError: (what: string, e: unknown) => assert.fail(`${what}: ${e}`),
          openPrefabStage: async (path: string) => void opened.push(path),
        } as never,
        scene: { selectedId: signal<string | null>("lid") },
        hierarchy: { selection, tree: signal(buildTree(nodes)), canPrefabs: false, canNesting: true, deleteSelected: async () => {} } as never,
        inspector,
      }
    )
    return { calls, opened, user: userEvent.setup() }
  }

  const label = (text: string): HTMLElement => {
    const found = Array.from(document.querySelectorAll<HTMLElement>("label")).find((l) => l.textContent === text)
    assert.ok(found, `no label ${text}`)
    return found
  }

  test("an overridden field's label is bold, another field's is not", async () => {
    await mount()
    await screen.findByText("Color")
    assert.ok(label("Name").classList.contains("overridden"))
    assert.ok(!label("Tag").classList.contains("overridden"))
    assert.ok(label("Color").classList.contains("overridden"))
    assert.ok(!label("Flip X").classList.contains("overridden"))
  })

  test("a right-click on an overridden label reverts that field, or applies it to a prefab of its link path", async () => {
    const { calls, user } = await mount()
    await screen.findByText("Color")
    fireEvent.contextMenu(label("Color"))
    await user.click(await screen.findByText("Revert"))
    await waitFor(() => assert.ok(calls.includes('revert lid [{"source":"inner/lid","path":"color","component":"inner/sprite"}]')))

    fireEvent.contextMenu(label("Name"))
    await user.click(await screen.findByText("Apply to Crate.prefab"))
    await user.click(await screen.findByRole("button", { name: "Apply" }))
    await waitFor(() => assert.ok(calls.includes('apply lid [{"source":"inner/lid","path":"name"}] 1')))
  })

  test("the instance's overrides are listed, each with Revert, and the link path's prefabs open", async () => {
    const { calls, opened, user } = await mount()
    const section = await screen.findByTestId("prefab-overrides")
    assert.match(section.textContent ?? "", /2 overrides on Nest 1/)
    await user.click(screen.getByRole("button", { name: "Show" }))
    await screen.findByText("Open lid: name")
    await screen.findByText("Open lid: Sprite2D color")
    await user.click(screen.getByRole("button", { name: "Revert All" }))
    await waitFor(() => assert.ok(calls.includes('revert lid [{"all":true}]')))
    await user.click(screen.getByRole("button", { name: "Crate.prefab" }))
    assert.deepEqual(opened, ["res://Crate.prefab"])
  })
})
