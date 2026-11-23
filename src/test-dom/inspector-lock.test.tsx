import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { act, screen, waitFor } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { signal } from "@preact/signals-core"
import type { JsonObject } from "../shared/api"
import { InspectorState } from "../renderer/inspector-state"
import { InspectorPanel } from "../renderer/inspector-panel"
import type { Selection } from "../renderer/hierarchy-tree"
import { renderWithApp } from "./helpers"

const names: Record<string, string> = { e1: "Alpha", e2: "Beta", e3: "Gamma" }

async function render() {
  const gone = new Set<string>()
  const engine = {
    isConnected: () => true,
    getEntity: async (id: string) => {
      if (gone.has(id)) throw new Error(`Entity not found: ${id}`)
      return {
        entity: {
          header: { id, parentId: "", index: 0, name: names[id], active: true, activeInHierarchy: true, layer: 0, tag: "" },
          transform: undefined,
          components: [],
        },
        worldMatrix: [],
      }
    },
    getComponentTypes: async () => [],
    getLuaFields: async () => ({ typeName: "LuaComponent", singleton: false, fields: [] }),
    addComponent: async () => ({ componentId: "x", values: {} }),
    removeComponent: async () => {},
    setEntityProperties: async (_id: string, _p: JsonObject) => {},
    setComponentFields: async () => ({}),
    setLocalTransform: async () => {},
  }
  const inspector = new InspectorState(engine, { listAssets: async () => [] }, { confirm: async () => true })
  const selectedId = signal<string | null>(null)
  const selection = signal<Selection>({ ids: new Set(), anchor: null, primary: null })
  const deleted: Array<readonly string[] | undefined> = []
  const select = async (ids: string[]) => {
    const primary = ids.at(-1) ?? null
    await act(async () => {
      selectedId.value = primary
      selection.value = { ids: new Set(ids), anchor: primary, primary }
      await inspector.follow(primary, ids)
    })
  }
  renderWithApp(<InspectorPanel />, {
    store: { connected: signal(true), reportError: () => {} } as never,
    scene: { selectedId },
    hierarchy: {
      selection,
      deleteSelected: async (ids?: readonly string[]) => void deleted.push(ids),
    } as never,
    inspector,
    extensions: { sectionsFor: () => [] } as never,
  })
  return { inspector, select, gone, deleted, user: userEvent.setup() }
}

const shown = (): string => (screen.getByLabelText("Name") as HTMLInputElement).value
const lockButton = (): HTMLButtonElement =>
  (screen.queryByRole("button", { name: "Lock the inspector" }) ?? screen.getByRole("button", { name: "Unlock the inspector" })) as HTMLButtonElement

describe("the inspector's lock button", () => {
  test("is off and disabled with nothing to show, then locks the object shown", async () => {
    const t = await render()
    assert.equal(lockButton().disabled, true)
    await t.select(["e1"])
    await waitFor(() => assert.equal(shown(), "Alpha"))
    assert.equal(lockButton().disabled, false)
    assert.equal(lockButton().getAttribute("aria-pressed"), "false")
    await t.user.click(lockButton())
    assert.equal(lockButton().getAttribute("aria-pressed"), "true")
    assert.equal(lockButton().getAttribute("aria-label"), "Unlock the inspector")
  })

  test("locked, selecting another object (or several, or none) leaves the inspector on the locked one", async () => {
    const t = await render()
    await t.select(["e1"])
    await waitFor(() => assert.equal(shown(), "Alpha"))
    await t.user.click(lockButton())
    await t.select(["e2"])
    assert.equal(shown(), "Alpha")
    await t.select(["e2", "e3"])
    assert.equal(shown(), "Alpha")
    assert.equal(document.querySelector(".multi-inspector"), null)
    await t.select([])
    assert.equal(shown(), "Alpha")
  })

  test("Delete while locked deletes the locked object, not the selection", async () => {
    const t = await render()
    await t.select(["e1"])
    await waitFor(() => assert.equal(shown(), "Alpha"))
    await t.user.click(lockButton())
    await t.select(["e2"])
    await t.user.click(screen.getByRole("button", { name: "Delete Entity" }))
    assert.deepEqual(t.deleted, [["e1"]])
  })

  test("unlocked, it stays on the object until the selection changes, then follows it", async () => {
    const t = await render()
    await t.select(["e1"])
    await waitFor(() => assert.equal(shown(), "Alpha"))
    await t.user.click(lockButton())
    await t.select(["e2"])
    await t.user.click(lockButton())
    assert.equal(lockButton().getAttribute("aria-pressed"), "false")
    assert.equal(shown(), "Alpha")
    await t.select(["e3"])
    await waitFor(() => assert.equal(shown(), "Gamma"))
    assert.deepEqual(t.deleted, [])
  })

  test("the locked object is deleted: it unlocks and shows the selection", async () => {
    const t = await render()
    await t.select(["e1"])
    await waitFor(() => assert.equal(shown(), "Alpha"))
    await t.user.click(lockButton())
    await t.select(["e2"])
    t.gone.add("e1")
    await act(async () => {
      await t.inspector.applyChange({ full: false, entityIds: ["e1"] })
    })
    await waitFor(() => assert.equal(shown(), "Beta"))
    assert.equal(lockButton().getAttribute("aria-pressed"), "false")
  })
})
