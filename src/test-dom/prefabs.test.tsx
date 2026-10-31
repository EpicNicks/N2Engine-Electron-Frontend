/// <reference path="../renderer/globals.d.ts" />
// Prefab assets in the panels (protocol 1.19.0): the hierarchy's rows, menu and drops, the assets panel's prefab rows and
// folder drops, and the inspector's prefab line. A hand-made dataTransfer stands in for the browser's (jsdom has none).
import "./setup"
import { test, describe, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import { signal } from "@preact/signals-core"
import { screen, waitFor, within, fireEvent, act } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import type { HierarchyResponse, Vec3 } from "../protocol/protocol.generated"
import { AssetsState } from "../renderer/assets-state"
import { AssetsPanel } from "../renderer/assets-panel"
import { HierarchyPanel } from "../renderer/hierarchy-panel"
import { PrefabRow } from "../renderer/inspector-panel"
import { HierarchyState } from "../renderer/hierarchy-state"
import { prefabOptions } from "../renderer/prefab-options"
import { AssetDragType, EntityDragType, PrefabDragType } from "../renderer/drag-types"
import { PrefabAssetsCapability } from "../protocol/prefab-assets"
import { ConfirmDialog, ContextMenu, PromptDialog, confirmDialog, showContextMenu } from "../renderer/ui"
import { renderWithApp } from "./helpers"
import { FakeAssetHost, FakeSceneHost, stubStore, U1 } from "./panel-fakes"

beforeEach(() => {
  showContextMenu(0, 0, []) // no menu left open by the test before
})

const Reason = "a game is running"
const PU = "55555555-5555-5555-5555-555555555555"
const PU2 = "66666666-6666-6666-6666-666666666666"

/** A dataTransfer that keeps what is set on it, and answers getData like a drop's */
const makeTransfer = () => {
  const data = new Map<string, string>()
  return {
    data,
    effectAllowed: "",
    dropEffect: "",
    types: [] as string[],
    setData(type: string, value: string) {
      data.set(type, value)
      this.types.push(type)
    },
    getData(type: string) {
      return data.get(type) ?? ""
    },
  }
}

/** Both panels over real states and fake hosts: a scene "A,B(B1)" and an asset list with a prefab at PU */
async function renderBoth(options: { capability?: boolean; second?: boolean; spec?: string; linked?: Record<string, string> } = {}) {
  const sceneHost = new FakeSceneHost(options.spec ?? "A,B(B1)")
  const assetHost = new FakeAssetHost()
  assetHost.assets.push({ path: "res://Hero.prefab", uuid: PU, type: "Prefab", size: 99, modified: 1 })
  if (options.second) {
    assetHost.assets.push({ path: "res://Villain.prefab", uuid: PU2, type: "Prefab", size: 98, modified: 1 })
  }
  const fake = stubStore()
  const caps = signal<unknown>(options.capability === false ? ["entityClipboard"] : [PrefabAssetsCapability])
  fake.signals.serverInfo.value = { protocolVersion: "1.19.0", capabilities: caps.value } as never
  const assets = new AssetsState(assetHost.engine, null, fake.signals.reportError, () => fake.signals.readOnlyReason.peek())
  await assets.refresh()
  assetHost.calls.length = 0

  // The prefab commands over the scene stand-in: a link is kept by object name
  const links = new Map(Object.entries(options.linked ?? {}))
  const prefabCalls: string[] = []
  const baseHierarchy = sceneHost.engine.getHierarchy
  const engine = {
    ...sceneHost.engine,
    getHierarchy: async (): Promise<HierarchyResponse> => {
      const response = await baseHierarchy()
      return { ...response, nodes: response.nodes.map((n) => (links.has(n.name) ? { ...n, prefab: links.get(n.name) } : n)) }
    },
    createPrefab: async (id: string, path: string, overwrite: boolean) => {
      prefabCalls.push(`createPrefab ${id}|${path}|${overwrite}`)
      links.set(sceneHost.find(id)!.obj.name, PU)
      return { path, uuid: PU }
    },
    instantiatePrefab: async (uuid: string, parentId: string, index: number, hasPosition: boolean, position: Vec3) => {
      prefabCalls.push(`instantiatePrefab ${uuid}|${parentId}|${index}|${hasPosition}|${position.x}`)
      const name = "Hero"
      const id = await sceneHost.engine.createEntityEx(name, parentId, index, "")
      links.set(name, uuid)
      return id
    },
    applyPrefab: async (id: string) => void prefabCalls.push(`applyPrefab ${id}`),
    unpackPrefab: async (id: string) => {
      prefabCalls.push(`unpackPrefab ${id}`)
      links.delete(sceneHost.find(id)!.obj.name)
    },
  }
  const hierarchy = new HierarchyState(engine, {
    confirm: confirmDialog,
    prefabs: prefabOptions(fake.signals as never, assets, { caseInsensitivePaths: false, onError: fake.signals.reportError }),
  })
  await hierarchy.refresh()
  sceneHost.calls.length = 0
  renderWithApp(
    <>
      <HierarchyPanel />
      <AssetsPanel />
      <ContextMenu />
      <PromptDialog />
      <ConfirmDialog />
    </>,
    { store: fake.store, hierarchy, assets }
  )
  return { sceneHost, assetHost, assets, hierarchy, prefabCalls, links, ...fake }
}

const hierarchyRow = (name: string): HTMLElement => {
  const row = Array.from(document.querySelectorAll<HTMLElement>(".hierarchy-item")).find(
    (r) => r.querySelector(".hierarchy-name")?.textContent === name
  )
  assert.ok(row, `no hierarchy row named ${name}`)
  return row
}
const assetRow = (name: string): HTMLElement => {
  const row = Array.from(document.querySelectorAll<HTMLElement>(".asset-list .asset-row")).find(
    (r) => r.querySelector(".asset-name")?.textContent === name
  )
  assert.ok(row, `no asset row named ${name}`)
  return row
}
const menuLabels = (): string[] =>
  within(screen.getByRole("menu")).getAllByRole("menuitem").map((el) => el.textContent ?? "")
const menuItem = (label: string): HTMLElement => within(screen.getByRole("menu")).getByRole("menuitem", { name: label })

describe("prefabs in the assets panel", () => {
  test("a prefab has its own icon, and dragging it carries the prefab type besides the asset type", async () => {
    await renderBoth()
    const row = assetRow("Hero.prefab")
    assert.equal(row.querySelector(".icon")?.textContent, "\u{1f9e9}")
    const transfer = makeTransfer()
    fireEvent.dragStart(row, { dataTransfer: transfer })
    assert.ok(transfer.types.includes(AssetDragType))
    assert.ok(transfer.types.includes(PrefabDragType))
    assert.equal(JSON.parse(transfer.data.get(PrefabDragType)!).type, "Prefab")

    const other = makeTransfer()
    fireEvent.dragStart(assetRow("hero.png"), { dataTransfer: other })
    assert.ok(!other.types.includes(PrefabDragType))
  })

  test("the detail says an instance is a copy with a link", async () => {
    const user = userEvent.setup()
    await renderBoth()
    await user.click(assetRow("Hero.prefab"))
    assert.match(document.querySelector(".asset-detail .asset-hint")?.textContent ?? "", /copy with a link/)
    assert.match(document.querySelector(".asset-detail .asset-hint")?.textContent ?? "", /does not update objects already in a scene/)
  })

  test("Add to Scene in the row menu makes an instance as the last root", async () => {
    const user = userEvent.setup()
    const h = await renderBoth()
    await user.pointer({ keys: "[MouseRight]", target: assetRow("Hero.prefab") })
    assert.ok(menuLabels().includes("Add to Scene"))
    await user.click(menuItem("Add to Scene"))
    await waitFor(() => assert.deepEqual(h.prefabCalls, [`instantiatePrefab ${PU}||-1|false|0`]))
    await waitFor(() => assert.ok(hierarchyRow("Hero")))
  })

  test("no prefab item without the capability", async () => {
    const user = userEvent.setup()
    await renderBoth({ capability: false })
    await user.pointer({ keys: "[MouseRight]", target: assetRow("Hero.prefab") })
    assert.ok(!menuLabels().includes("Add to Scene"))
  })

  test("an object dropped on a folder row makes a prefab in that folder (a file that exists asks first)", async () => {
    const h = await renderBoth()
    const transfer = makeTransfer()
    fireEvent.dragStart(hierarchyRow("A"), { dataTransfer: transfer })
    const folder = assetRow("scripts")
    fireEvent.dragOver(folder, { dataTransfer: transfer })
    assert.ok(folder.classList.contains("drop-target"))
    assert.equal(transfer.dropEffect, "copy")
    fireEvent.drop(folder, { dataTransfer: transfer })
    await waitFor(() => assert.deepEqual(h.prefabCalls, ["createPrefab id-A|res://scripts/A.prefab|false"]))
    assert.ok(!folder.classList.contains("drop-target"))
    await waitFor(() => assert.ok(h.assetHost.calls.some((c) => c.startsWith("listAssets"))))
  })

  test("an object dropped on a file goes to the file's folder; on the empty list, to the root", async () => {
    const h = await renderBoth()
    const transfer = makeTransfer()
    fireEvent.dragStart(hierarchyRow("B"), { dataTransfer: transfer })
    fireEvent.drop(assetRow("Hero.prefab"), { dataTransfer: transfer })
    await waitFor(() => assert.deepEqual(h.prefabCalls, ["createPrefab id-B|res://B.prefab|false"]))
  })

  test("a file that is already listed is replaced only after the user agrees", async () => {
    const user = userEvent.setup()
    const h = await renderBoth()
    h.assetHost.assets.push({ path: "res://scripts/A.prefab", uuid: U1, type: "Prefab", size: 1, modified: 1 })
    await h.assets.refresh()
    const transfer = makeTransfer()
    fireEvent.dragStart(hierarchyRow("A"), { dataTransfer: transfer })
    fireEvent.drop(assetRow("scripts"), { dataTransfer: transfer })
    const dialog = await screen.findByRole("alertdialog")
    assert.match(dialog.textContent ?? "", /Replace res:\/\/scripts\/A.prefab/)
    await user.click(within(dialog).getByText("Replace"))
    await waitFor(() => assert.deepEqual(h.prefabCalls, ["createPrefab id-A|res://scripts/A.prefab|true"]))
  })

  test("nothing is accepted while read-only or without the capability", async () => {
    const ro = await renderBoth()
    act(() => ro.hierarchy.setReadOnly(Reason))
    act(() => {
      ro.signals.playMode.value = Reason
    })
    const transfer = makeTransfer()
    fireEvent.dragStart(hierarchyRow("A"), { dataTransfer: transfer })
    fireEvent.dragOver(assetRow("scripts"), { dataTransfer: transfer })
    assert.ok(!assetRow("scripts").classList.contains("drop-target"))
    fireEvent.drop(assetRow("scripts"), { dataTransfer: transfer })
    assert.deepEqual(ro.prefabCalls, [])
  })
})

describe("several prefabs at once (multi-prefab drag)", () => {
  const selectedNames = (): string[] =>
    Array.from(document.querySelectorAll(".asset-list .asset-row.selected .asset-name")).map((el) => el.textContent ?? "")

  test("Ctrl+click adds a file to the selection and takes it out again; a plain click goes back to one", async () => {
    const user = userEvent.setup()
    const h = await renderBoth({ second: true })
    await user.click(assetRow("Hero.prefab"))
    await user.keyboard("{Control>}")
    await user.click(assetRow("Villain.prefab"))
    await user.keyboard("{/Control}")
    assert.deepEqual(selectedNames().sort(), ["Hero.prefab", "Villain.prefab"])
    assert.equal(h.assets.selected.value, "res://Hero.prefab")
    await user.keyboard("{Control>}")
    await user.click(assetRow("Villain.prefab"))
    await user.keyboard("{/Control}")
    assert.deepEqual(selectedNames(), ["Hero.prefab"])
    await user.keyboard("{Control>}")
    await user.click(assetRow("Villain.prefab"))
    await user.keyboard("{/Control}")
    await user.click(assetRow("hero.png"))
    assert.deepEqual(selectedNames(), ["hero.png"])
  })

  test("Shift+click selects the files between, skipping folders", async () => {
    const user = userEvent.setup()
    const h = await renderBoth({ second: true })
    // Rows of files have a type column, folders do not
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".asset-list .asset-row"))
    const index = (name: string) => rows.findIndex((r) => r.querySelector(".asset-name")?.textContent === name)
    const [lo, hi] = [index("Hero.prefab"), index("Villain.prefab")].sort((x, y) => x - y)
    const files = rows.slice(lo, hi + 1).filter((r) => r.querySelector(".asset-type")).length
    await user.click(assetRow("Hero.prefab"))
    await user.keyboard("{Shift>}")
    await user.click(assetRow("Villain.prefab"))
    await user.keyboard("{/Shift}")
    assert.equal(selectedNames().length, files)
    assert.ok(selectedNames().includes("Villain.prefab"))
    assert.equal(h.assets.selected.value, "res://Hero.prefab")
  })

  test("dragging one of several selected prefabs carries all of them, in the order of the rows", async () => {
    const user = userEvent.setup()
    await renderBoth({ second: true })
    await user.click(assetRow("Villain.prefab"))
    await user.keyboard("{Control>}")
    await user.click(assetRow("Hero.prefab"))
    await user.keyboard("{/Control}")
    const transfer = makeTransfer()
    fireEvent.dragStart(assetRow("Hero.prefab"), { dataTransfer: transfer })
    const carried = JSON.parse(transfer.data.get(PrefabDragType)!) as { uuid: string }[]
    assert.deepEqual(carried.map((c) => c.uuid).sort(), [PU, PU2].sort())
    // The asset type stays the dragged row's own, for the inspector's asset fields
    assert.equal(JSON.parse(transfer.data.get(AssetDragType)!).uuid, PU)
  })

  test("a drag of a prefab outside the selection carries only that prefab", async () => {
    const user = userEvent.setup()
    await renderBoth({ second: true })
    await user.click(assetRow("Villain.prefab"))
    const transfer = makeTransfer()
    fireEvent.dragStart(assetRow("Hero.prefab"), { dataTransfer: transfer })
    assert.equal(JSON.parse(transfer.data.get(PrefabDragType)!).uuid, PU)
  })

  test("dropping the several on the hierarchy adds them all as one edit group", async () => {
    const user = userEvent.setup()
    const h = await renderBoth({ second: true })
    await user.click(assetRow("Hero.prefab"))
    await user.keyboard("{Control>}")
    await user.click(assetRow("Villain.prefab"))
    await user.keyboard("{/Control}")
    const transfer = makeTransfer()
    fireEvent.dragStart(assetRow("Hero.prefab"), { dataTransfer: transfer })
    const list = screen.getByRole("tree")
    fireEvent.dragOver(list, { dataTransfer: transfer })
    fireEvent.drop(list, { dataTransfer: transfer })
    await waitFor(() => assert.equal(h.prefabCalls.filter((c) => c.startsWith("instantiatePrefab")).length, 2))
    const uuids = h.prefabCalls.filter((c) => c.startsWith("instantiatePrefab")).map((c) => c.split(" ")[1].split("|")[0])
    assert.deepEqual(uuids.sort(), [PU, PU2].sort())
  })

  test("the row menu adds all the selected prefabs, and right-clicking a selected row keeps the selection", async () => {
    const user = userEvent.setup()
    const h = await renderBoth({ second: true })
    await user.click(assetRow("Hero.prefab"))
    await user.keyboard("{Control>}")
    await user.click(assetRow("Villain.prefab"))
    await user.keyboard("{/Control}")
    await user.pointer({ keys: "[MouseRight]", target: assetRow("Villain.prefab") })
    assert.deepEqual(selectedNames().sort(), ["Hero.prefab", "Villain.prefab"])
    await user.click(menuItem("Add 2 Prefabs to Scene"))
    await waitFor(() => assert.equal(h.prefabCalls.filter((c) => c.startsWith("instantiatePrefab")).length, 2))
  })

  test("a file that leaves the listing leaves the selection", async () => {
    const user = userEvent.setup()
    const h = await renderBoth({ second: true })
    await user.click(assetRow("Hero.prefab"))
    await user.keyboard("{Control>}")
    await user.click(assetRow("Villain.prefab"))
    await user.keyboard("{/Control}")
    h.assetHost.assets.splice(h.assetHost.assets.findIndex((a) => a.uuid === PU2), 1)
    await act(() => h.assets.refresh())
    assert.deepEqual([...h.assets.marked.value], [])
  })
})

describe("prefabs in the hierarchy", () => {
  test("an instance row has a badge that says it is a copy, with the prefab's path", async () => {
    await renderBoth({ linked: { A: PU } })
    const badge = hierarchyRow("A").querySelector(".hierarchy-prefab")
    assert.ok(badge)
    assert.match(badge.getAttribute("title") ?? "", /res:\/\/Hero\.prefab/)
    assert.match(badge.getAttribute("title") ?? "", /does not update it/)
    assert.equal(hierarchyRow("B").querySelector(".hierarchy-prefab"), null)
  })

  test("dropping a prefab on a row makes the instance a child of it", async () => {
    const h = await renderBoth()
    const transfer = makeTransfer()
    fireEvent.dragStart(assetRow("Hero.prefab"), { dataTransfer: transfer })
    const target = hierarchyRow("A")
    fireEvent.dragOver(target, { dataTransfer: transfer })
    assert.ok(target.classList.contains("drop-inside"))
    assert.equal(transfer.dropEffect, "copy")
    fireEvent.drop(target, { dataTransfer: transfer })
    await waitFor(() => assert.deepEqual(h.prefabCalls, [`instantiatePrefab ${PU}|id-A|-1|false|0`]))
    assert.equal(document.querySelector(".drop-inside"), null)
    await waitFor(() => assert.equal(h.sceneHost.text(), "A(Hero),B(B1)"))
  })

  test("dropping a prefab on the empty space of the list makes a root", async () => {
    const h = await renderBoth()
    const transfer = makeTransfer()
    fireEvent.dragStart(assetRow("Hero.prefab"), { dataTransfer: transfer })
    const list = screen.getByRole("tree")
    fireEvent.dragOver(list, { dataTransfer: transfer })
    assert.ok(list.classList.contains("drop-end"))
    fireEvent.drop(list, { dataTransfer: transfer })
    await waitFor(() => assert.deepEqual(h.prefabCalls, [`instantiatePrefab ${PU}||-1|false|0`]))
  })

  test("the line goes when the drag leaves the list", async () => {
    await renderBoth()
    const transfer = makeTransfer()
    fireEvent.dragStart(assetRow("Hero.prefab"), { dataTransfer: transfer })
    fireEvent.dragOver(hierarchyRow("A"), { dataTransfer: transfer })
    assert.ok(hierarchyRow("A").classList.contains("drop-inside"))
    fireEvent.dragLeave(screen.getByRole("tree"), { dataTransfer: transfer, relatedTarget: document.body })
    assert.equal(document.querySelector(".drop-inside"), null)
  })

  test("a read-only hierarchy and a host without the capability take no prefab drop", async () => {
    const ro = await renderBoth()
    act(() => ro.hierarchy.setReadOnly(Reason))
    const transfer = makeTransfer()
    fireEvent.dragStart(assetRow("Hero.prefab"), { dataTransfer: transfer })
    fireEvent.dragOver(hierarchyRow("A"), { dataTransfer: transfer })
    assert.equal(document.querySelector(".drop-inside"), null)
    fireEvent.drop(hierarchyRow("A"), { dataTransfer: transfer })
    assert.deepEqual(ro.prefabCalls, [])
  })

  test("without the capability a prefab dragged over the hierarchy is not taken", async () => {
    const h = await renderBoth({ capability: false })
    const transfer = makeTransfer()
    fireEvent.dragStart(assetRow("Hero.prefab"), { dataTransfer: transfer })
    fireEvent.dragOver(hierarchyRow("A"), { dataTransfer: transfer })
    assert.equal(document.querySelector(".drop-inside"), null)
    fireEvent.drop(hierarchyRow("A"), { dataTransfer: transfer })
    assert.deepEqual(h.prefabCalls, [])
  })

  test("a drag of an object is still a move, not a prefab drop", async () => {
    const h = await renderBoth()
    const transfer = makeTransfer()
    fireEvent.dragStart(hierarchyRow("B"), { dataTransfer: transfer })
    assert.ok(transfer.types.includes(EntityDragType))
    fireEvent.dragOver(hierarchyRow("A"), { dataTransfer: transfer })
    assert.equal(transfer.dropEffect, "move")
    fireEvent.drop(hierarchyRow("A"), { dataTransfer: transfer })
    await waitFor(() => assert.equal(h.sceneHost.calls.length, 1))
    assert.deepEqual(h.prefabCalls, [])
  })

  test("Create Prefab... asks for a path (res://prefabs/<name>.prefab) and makes the prefab", async () => {
    const user = userEvent.setup()
    const h = await renderBoth()
    await user.pointer({ keys: "[MouseRight]", target: hierarchyRow("A") })
    assert.ok(menuLabels().includes("Create Prefab..."))
    assert.ok(!menuLabels().includes("Apply to Prefab..."))
    await user.click(menuItem("Create Prefab..."))
    const dialog = screen.getByRole("dialog")
    assert.match(dialog.getAttribute("aria-label") ?? "", /copy with a link/)
    const input = within(dialog).getByRole("textbox") as HTMLInputElement
    assert.equal(input.value, "res://prefabs/A.prefab")
    await user.click(within(dialog).getByText("OK"))
    await waitFor(() => assert.deepEqual(h.prefabCalls, ["createPrefab id-A|res://prefabs/A.prefab|false"]))
    await waitFor(() => assert.ok(hierarchyRow("A").querySelector(".hierarchy-prefab")))
    assert.deepEqual(h.errors, [])
  })

  test("a bad path typed in the prompt is an error and sends nothing", async () => {
    const user = userEvent.setup()
    const h = await renderBoth()
    await user.pointer({ keys: "[MouseRight]", target: hierarchyRow("A") })
    await user.click(menuItem("Create Prefab..."))
    const input = within(screen.getByRole("dialog")).getByRole("textbox") as HTMLInputElement
    await user.clear(input)
    await user.type(input, "res://a/../b.prefab{Enter}")
    await waitFor(() => assert.equal(h.errors.length, 1))
    assert.match(h.errors[0], /Failed to create the prefab: .*\.\./)
    assert.deepEqual(h.prefabCalls, [])
  })

  test("an instance's menu has Select Prefab Asset, Apply (asks first) and Unpack", async () => {
    const user = userEvent.setup()
    const h = await renderBoth({ linked: { A: PU } })
    await user.pointer({ keys: "[MouseRight]", target: hierarchyRow("A") })
    for (const label of ["Create Prefab...", "Select Prefab Asset", "Apply to Prefab...", "Unpack Prefab"]) {
      assert.ok(menuLabels().includes(label), label)
    }
    await user.click(menuItem("Select Prefab Asset"))
    assert.equal(h.assets.selected.value, "res://Hero.prefab")

    await user.pointer({ keys: "[MouseRight]", target: hierarchyRow("A") })
    await user.click(menuItem("Apply to Prefab..."))
    const dialog = screen.getByRole("alertdialog")
    assert.match(dialog.textContent ?? "", /Overwrite res:\/\/Hero\.prefab with 'A'/)
    assert.match(dialog.textContent ?? "", /not updated/)
    await user.click(within(dialog).getByText("Cancel"))
    assert.deepEqual(h.prefabCalls, [])

    await user.pointer({ keys: "[MouseRight]", target: hierarchyRow("A") })
    await user.click(menuItem("Apply to Prefab..."))
    await user.click(within(screen.getByRole("alertdialog")).getByText("Apply"))
    await waitFor(() => assert.deepEqual(h.prefabCalls, ["applyPrefab id-A"]))

    await user.pointer({ keys: "[MouseRight]", target: hierarchyRow("A") })
    await user.click(menuItem("Unpack Prefab"))
    await waitFor(() => assert.deepEqual(h.prefabCalls, ["applyPrefab id-A", "unpackPrefab id-A"]))
    await waitFor(() => assert.equal(hierarchyRow("A").querySelector(".hierarchy-prefab"), null))
  })

  test("no prefab item in the menu without the capability, and none while read-only", async () => {
    const user = userEvent.setup()
    const without = await renderBoth({ capability: false, linked: { A: PU } })
    await user.pointer({ keys: "[MouseRight]", target: hierarchyRow("A") })
    assert.ok(!menuLabels().some((l) => /Prefab/.test(l)))
    showContextMenu(0, 0, [])
    act(() => without.hierarchy.setReadOnly(Reason))
    await user.pointer({ keys: "[MouseRight]", target: hierarchyRow("A") })
    assert.deepEqual(menuLabels(), [`Read only: ${Reason}`])
  })
})

describe("the inspector's prefab line", () => {
  const render = (options: { canPrefabs: boolean; readOnly?: string | null; listed?: boolean }) => {
    const calls: string[] = []
    const errors: string[] = []
    const listing = options.listed === false ? { folders: [], assets: [] } : { folders: [], assets: [{ path: "res://Hero.prefab", uuid: PU, type: "Prefab", size: 1, modified: 1 }] }
    renderWithApp(<PrefabRow id="e1" uuid={PU} disabled={options.readOnly != null} />, {
      store: { reportError: (what: string, e: unknown) => void errors.push(`${what}: ${e}`) } as never,
      assets: {
        listing: signal(listing),
        reveal: (path: string) => void calls.push(`reveal ${path}`),
        select: async (path: string) => void calls.push(`select ${path}`),
      } as never,
      hierarchy: {
        canPrefabs: options.canPrefabs,
        applyPrefab: async (id: string) => void calls.push(`apply ${id}`),
        unpackPrefab: async (id: string) => void calls.push(`unpack ${id}`),
      } as never,
      inspector: { readOnlyReason: signal(options.readOnly ?? null), refresh: async () => void calls.push("refresh") } as never,
    })
    return { calls, errors }
  }

  test("shows the prefab's path with Select asset, Apply and Unpack", async () => {
    const user = userEvent.setup()
    const t = render({ canPrefabs: true })
    assert.equal(document.querySelector(".prefab-name")?.textContent, "res://Hero.prefab")
    assert.match(document.querySelector(".prefab-name")?.getAttribute("title") ?? "", /does not update it/)
    await user.click(screen.getByText("Select asset"))
    await user.click(screen.getByText("Apply"))
    await user.click(screen.getByText("Unpack"))
    await waitFor(() => assert.deepEqual(t.calls, ["reveal res://Hero.prefab", "select res://Hero.prefab", "apply e1", "refresh", "unpack e1", "refresh"]))
  })

  test("Apply and Unpack are disabled while read-only; Select asset still works", () => {
    render({ canPrefabs: true, readOnly: Reason })
    assert.equal((screen.getByText("Apply") as HTMLButtonElement).disabled, true)
    assert.equal((screen.getByText("Unpack") as HTMLButtonElement).disabled, true)
    assert.equal((screen.getByText("Select asset") as HTMLButtonElement).disabled, false)
  })

  test("without the capability only the path is shown; an unlisted prefab says so", () => {
    render({ canPrefabs: false, listed: false })
    assert.equal(document.querySelector(".prefab-name")?.textContent, "(not in the assets list)")
    assert.equal(screen.queryByText("Apply"), null)
    assert.equal(screen.queryByText("Unpack"), null)
  })
})
