/// <reference path="../renderer/globals.d.ts" />
import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { screen, act } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import type { ServerInfo } from "../shared/api"
import { ipcError } from "../shared/api"
import { EditorStore, HostReadOnlyReason, StoreApi } from "../renderer/store"
import { HierarchyState } from "../renderer/hierarchy-state"
import { HierarchyPanel } from "../renderer/hierarchy-panel"
import { ReadOnlyBadge, SceneButtons } from "../renderer/editor"
import { ErrorBanner } from "../renderer/ui"
import { assetMenu } from "../renderer/assets-panel"
import { followWriteGuard } from "../renderer/write-guard"
import { renderWithApp, stubApp } from "./helpers"

const scene = { path: "res://scenes/a.scene", name: "a", uuid: "u1", revision: 1, savedRevision: 1 }

/** An EditorStore over a fake page API: connected to a host whose ServerInfo says readOnly (or, for a 1.10 host, false) */
async function connectedStore(readOnly: boolean) {
  const info: ServerInfo = {
    protocolVersion: "1.11.0",
    engineVersion: "1.0.0",
    capabilities: [],
    projectLoaded: true,
    readOnly,
  }
  let connected = false
  const listeners: Array<(connected: boolean) => void> = []
  const api = {
    engine: {
      isConnected: () => connected,
      serverInfo: () => (connected ? info : null),
      onConnectionChange: (listener: (connected: boolean) => void) => listeners.push(listener),
      pollEvents: async () => ({ epoch: 1, nextSeq: 1, dropped: 0, events: [] }),
      getOpenScene: async () => ({ ...scene }),
      getHistory: async () => ({ cursor: 0, entries: [] }),
      getAutosave: async () => ({ exists: false }),
    },
    host: {
      state: () => ({ status: "running", mode: "local", launch: 1, projectPath: "C:\\P", message: null }),
      onStateChange: () => {},
    },
    remote: {},
    project: {},
    dialogs: { dismissAutosave: () => {} },
  } as unknown as StoreApi
  // The console's poll timer never fires here
  const store = new EditorStore(api, { timers: { setTimeout: () => 0, clearTimeout: () => {} } })
  connected = true
  await act(async () => {
    listeners.forEach((listener) => listener(true))
    await new Promise((resolve) => setImmediate(resolve))
  })
  return store
}

const hierarchyOf = () =>
  new HierarchyState({} as never, { confirm: async () => true })

describe("the read-only badge", () => {
  test("a read-only host is badged", async () => {
    const store = await connectedStore(true)
    renderWithApp(<ReadOnlyBadge />, { store })
    const badge = screen.getByRole("status")
    assert.equal(badge.textContent, "Read-only")
    assert.match(badge.title, /--read-only/)
  })

  test("a host that can be edited (any 1.10 host) shows no badge", async () => {
    const store = await connectedStore(false)
    renderWithApp(<ReadOnlyBadge />, { store })
    assert.equal(screen.queryByRole("status"), null)
  })
})

describe("the scene buttons", () => {
  const names = ["New scene", "Open scene", "Save scene", "Save as..."]

  test("on a read-only host all four are disabled, not hidden, and say why", async () => {
    const store = await connectedStore(true)
    renderWithApp(<SceneButtons />, { store, assets: {} })
    for (const name of names) {
      const button = screen.getByText(name) as HTMLButtonElement
      assert.equal(button.disabled, true, name)
      assert.ok(button.title.includes(HostReadOnlyReason), name)
    }
  })

  test("on a host that can be edited they are enabled", async () => {
    const store = await connectedStore(false)
    renderWithApp(<SceneButtons />, { store, assets: {} })
    for (const name of names) assert.equal((screen.getByText(name) as HTMLButtonElement).disabled, false, name)
  })
})

describe("the hierarchy on a read-only host", () => {
  test("the Add button is disabled once the write guard has reached the panel, and enabled on an editable host", async () => {
    const editable = await connectedStore(false)
    const editableHierarchy = hierarchyOf()
    const stopEditable = followWriteGuard(editable, { inspector: { setReadOnly: () => {} }, hierarchy: editableHierarchy })
    renderWithApp(<HierarchyPanel />, { store: editable, hierarchy: editableHierarchy })
    assert.equal((screen.getByText("+ Add") as HTMLButtonElement).disabled, false)
    stopEditable()
  })

  test("read-only: Add is disabled", async () => {
    const store = await connectedStore(true)
    const hierarchy = hierarchyOf()
    const stop = followWriteGuard(store, { inspector: { setReadOnly: () => {} }, hierarchy })
    renderWithApp(<HierarchyPanel />, { store, hierarchy })
    assert.equal((screen.getByText("+ Add") as HTMLButtonElement).disabled, true)
    assert.equal(hierarchy.readOnlyReason.value, HostReadOnlyReason)
    stop()
  })
})

describe("a denial the host sends", () => {
  test("is shown as an alert with the host's own message, and can be dismissed", async () => {
    const store = await connectedStore(false)
    renderWithApp(<ErrorBanner />, { store })
    assert.equal(screen.queryByRole("alert"), null)

    const message = "read-only host: SetComponentFields is not allowed"
    act(() => store.reportError("Failed to set the component's fields", ipcError({ error: message, code: "readOnly" })))
    assert.match(screen.getByRole("alert").textContent ?? "", new RegExp(message))

    await userEvent.setup().click(screen.getByLabelText("Dismiss"))
    assert.equal(screen.queryByRole("alert"), null)
  })

  test("a readOnly denial turns the badge on and the scene buttons off, though ServerInfo said otherwise", async () => {
    const store = await connectedStore(false)
    renderWithApp(
      <>
        <ReadOnlyBadge />
        <SceneButtons />
      </>,
      { store, assets: {} }
    )
    assert.equal(screen.queryByRole("status"), null)
    assert.equal((screen.getByText("Save scene") as HTMLButtonElement).disabled, false)
    act(() => store.reportError("Failed to save", ipcError({ error: "read-only host: SaveSceneToFile is not allowed", code: "readOnly" })))
    assert.equal(screen.getByRole("status").textContent, "Read-only")
    assert.equal((screen.getByText("Save scene") as HTMLButtonElement).disabled, true)
  })
})

const itemOf = (items: ReturnType<typeof assetMenu>, label: string) =>
  items.find((item): item is Extract<(typeof items)[number], { label: string }> => "label" in item && item.label === label)

describe("the asset context menu", () => {
  const sceneRow = {
    kind: "asset",
    depth: 0,
    path: "res://scenes/a.scene",
    asset: { uuid: "u2", path: "res://scenes/a.scene", type: "Scene" },
  } as never
  const scriptRow = {
    kind: "asset",
    depth: 0,
    path: "res://scripts/a.lua",
    asset: { uuid: "u3", path: "res://scripts/a.lua", type: "LuaScript" },
  } as never

  test("Open Scene is disabled on a read-only host, not hidden; a text file can still be opened", async () => {
    const store = await connectedStore(true)
    const app = stubApp({ store })
    const scene = itemOf(assetMenu(app, sceneRow, () => {}), "Open Scene")
    assert.ok(scene)
    assert.equal(scene.disabled, true)
    const script = itemOf(assetMenu(app, scriptRow, () => {}), "Open")
    assert.ok(script)
    assert.ok(!script.disabled)
  })

  test("Open Scene is enabled on a host that can be edited", async () => {
    const store = await connectedStore(false)
    const scene = itemOf(assetMenu(stubApp({ store }), sceneRow, () => {}), "Open Scene")
    assert.ok(scene)
    assert.ok(!scene.disabled)
  })
})
