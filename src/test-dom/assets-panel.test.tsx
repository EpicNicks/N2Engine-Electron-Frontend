/// <reference path="../renderer/globals.d.ts" />
import "./setup"
import { test, describe, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import { screen, waitFor, within, fireEvent } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { AssetsState } from "../renderer/assets-state"
import { AssetsPanel } from "../renderer/assets-panel"
import { AssetDragType, parseAssetDrag } from "../renderer/drag-types"
import { ContextMenu, PromptDialog, showContextMenu } from "../renderer/ui"
import { HostReadOnlyReason } from "../renderer/store"
import { renderWithApp } from "./helpers"
import { FakeAssetHost, stubStore, U1, U3, U4 } from "./panel-fakes"

beforeEach(() => {
  showContextMenu(0, 0, []) // no menu left open by the test before
})

/** The panel over a real AssetsState and a fake host, with the dialogs it opens */
async function renderAssets(options: { connected?: boolean } = {}) {
  const host = new FakeAssetHost()
  const fake = stubStore(options)
  const assets = new AssetsState(host.engine, null, fake.signals.reportError, () => fake.signals.readOnlyReason.peek())
  if (fake.signals.connected.peek()) await assets.refresh()
  host.calls.length = 0
  renderWithApp(
    <>
      <AssetsPanel />
      <ContextMenu />
      <PromptDialog />
    </>,
    { store: fake.store, assets }
  )
  return { host, assets, ...fake }
}

const rowNames = (): string[] =>
  Array.from(document.querySelectorAll(".asset-list .asset-row .asset-name")).map((el) => el.textContent ?? "")

/** The row whose name is shown (the name is its own element) */
const rowOf = (name: string): HTMLElement => {
  const row = Array.from(document.querySelectorAll<HTMLElement>(".asset-list .asset-row")).find(
    (r) => r.querySelector(".asset-name")?.textContent === name
  )
  assert.ok(row, `no row named ${name}`)
  return row
}

const menuItems = (): Array<{ label: string; disabled: boolean }> =>
  within(screen.getByRole("menu"))
    .getAllByRole("menuitem")
    .map((el) => ({ label: el.textContent ?? "", disabled: el.getAttribute("aria-disabled") === "true" }))

/** The name field of the prompt (not the search box) */
const promptInput = (): HTMLInputElement =>
  within(screen.getByRole("dialog")).getByRole("textbox") as HTMLInputElement

const itemNamed = (label: string): HTMLElement => within(screen.getByRole("menu")).getByRole("menuitem", { name: label })

describe("the asset tree", () => {
  test("shows the root's folders and files; a folder's contents appear when it is opened and go when it is closed", async () => {
    await renderAssets()
    assert.deepEqual(rowNames(), ["scenes", "scripts", "hero.png"])
    assert.equal(rowOf("scripts").querySelector(".arrow")?.textContent, "\u25b8")

    const user = userEvent.setup()
    await user.click(rowOf("scripts"))
    assert.deepEqual(rowNames(), ["scenes", "scripts", "a.lua", "hero.png"])
    assert.equal(rowOf("scripts").querySelector(".arrow")?.textContent, "\u25be")
    // The file shows its type and a short UUID
    assert.equal(rowOf("a.lua").querySelector(".asset-type")?.textContent, "LuaScript")
    assert.equal(rowOf("a.lua").querySelector(".asset-uuid")?.textContent, U3.slice(0, 8))

    await user.click(rowOf("scripts"))
    assert.deepEqual(rowNames(), ["scenes", "scripts", "hero.png"])
    assert.equal(rowOf("scripts").querySelector(".arrow")?.textContent, "\u25b8")
  })

  test("clicking a row selects it, and a file's details are read from the host and shown", async () => {
    const h = await renderAssets()
    await userEvent.setup().click(rowOf("hero.png"))
    assert.ok(rowOf("hero.png").classList.contains("selected"))
    assert.equal(h.assets.selected.value, "res://hero.png")
    await waitFor(() => assert.ok(screen.getByText("res://hero.png", { selector: ".detail-value" })))
    assert.deepEqual(h.host.calls, ["getAssetInfo res://hero.png"])
    assert.ok(screen.getByText(U1, { selector: ".detail-value" }))
  })

  test("the search box narrows the tree to a flat list of matches, and says when nothing matches", async () => {
    await renderAssets()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("Search assets"), "lua")
    assert.deepEqual(rowNames(), ["scripts/a.lua"]) // a flat list: the path is the name

    await user.clear(screen.getByLabelText("Search assets"))
    await user.type(screen.getByLabelText("Search assets"), "zzz")
    assert.deepEqual(rowNames(), [])
    assert.ok(screen.getByText("No asset matches"))

    await user.clear(screen.getByLabelText("Search assets"))
    assert.deepEqual(rowNames(), ["scenes", "scripts", "hero.png"])
  })

  test("while the editor is not connected the panel says so and its Refresh is disabled", async () => {
    await renderAssets({ connected: false })
    assert.ok(screen.getByText("Not connected"))
    assert.equal((screen.getByText("Refresh") as HTMLButtonElement).disabled, true)
    assert.equal((screen.getByText("+ Folder") as HTMLButtonElement).disabled, true)
  })

  test("Refresh lists the assets again", async () => {
    const h = await renderAssets()
    h.host.assets.push({ path: "res://new.png", uuid: U4, type: "Texture", size: 1, modified: 3 })
    await userEvent.setup().click(screen.getByText("Refresh"))
    await waitFor(() => assert.deepEqual(rowNames(), ["scenes", "scripts", "hero.png", "new.png"]))
    assert.deepEqual(h.host.calls, ["listAssets  true"])
  })
})

describe("the asset context menu", () => {
  test("right-clicking a scene selects it and offers Open Scene, Copy Path and Copy UUID, all enabled", async () => {
    await renderAssets()
    await userEvent.setup().click(rowOf("scenes")) // opens the folder
    fireEvent.contextMenu(rowOf("main.scene"))
    assert.deepEqual(menuItems(), [
      { label: "Open Scene", disabled: false },
      { label: "Copy Path", disabled: false },
      { label: "Copy UUID", disabled: false },
    ])
    assert.ok(rowOf("main.scene").classList.contains("selected"))
  })

  test("a folder offers the three New items, and right-clicking selects it", async () => {
    await renderAssets()
    fireEvent.contextMenu(rowOf("scenes"))
    assert.deepEqual(menuItems(), [
      { label: "New Folder...", disabled: false },
      { label: "New Script...", disabled: false },
      { label: "New Scene...", disabled: false },
    ])
    assert.ok(rowOf("scenes").classList.contains("selected"))
  })

  test("a text file offers Open; a texture offers only the two copies", async () => {
    await renderAssets()
    const user = userEvent.setup()
    await user.click(rowOf("scripts"))
    fireEvent.contextMenu(rowOf("a.lua"))
    assert.deepEqual(menuItems(), [
      { label: "Open", disabled: false },
      { label: "Copy Path", disabled: false },
      { label: "Copy UUID", disabled: false },
    ])
    fireEvent.contextMenu(rowOf("hero.png"))
    assert.deepEqual(menuItems(), [
      { label: "Copy Path", disabled: false },
      { label: "Copy UUID", disabled: false },
    ])
  })

  test("Open on a text file reads it through the host and opens it in the editor", async () => {
    const h = await renderAssets()
    const user = userEvent.setup()
    await user.click(rowOf("scripts"))
    fireEvent.contextMenu(rowOf("a.lua"))
    await user.click(itemNamed("Open"))
    await waitFor(() => assert.deepEqual(h.assets.tabs.value.map((t) => [t.path, t.text]), [["res://scripts/a.lua", "print(1)"]]))
    assert.ok(h.host.calls.includes("readTextAsset res://scripts/a.lua"))
    assert.equal(screen.queryByRole("menu"), null) // the menu closed
    assert.deepEqual(h.errors, [])
  })

  test("on a read-only host Open Scene is disabled, not hidden, and does nothing; a text file still opens", async () => {
    const h = await renderAssets()
    h.signals.hostReadOnly.value = true
    const user = userEvent.setup()
    await user.click(rowOf("scenes"))
    fireEvent.contextMenu(rowOf("main.scene"))
    assert.deepEqual(menuItems()[0], { label: "Open Scene", disabled: true })
    await user.click(itemNamed("Open Scene"))
    assert.ok(screen.getByRole("menu")) // a disabled item leaves the menu up
    assert.deepEqual(h.calls, [])

    await user.click(rowOf("scripts"))
    fireEvent.contextMenu(rowOf("a.lua"))
    assert.deepEqual(menuItems()[0], { label: "Open", disabled: false })
  })

  test("Open Scene asks the store to open that scene; double-clicking the row does the same", async () => {
    const h = await renderAssets()
    const user = userEvent.setup()
    await user.click(rowOf("scenes"))
    fireEvent.contextMenu(rowOf("main.scene"))
    await user.click(itemNamed("Open Scene"))
    assert.deepEqual(h.calls, ["openScene res://scenes/main.scene"])

    fireEvent.dblClick(rowOf("main.scene"))
    assert.deepEqual(h.calls, ["openScene res://scenes/main.scene", "openScene res://scenes/main.scene"])
  })

  test("a double click on a scene of a read-only host does nothing", async () => {
    const h = await renderAssets()
    h.signals.hostReadOnly.value = true
    await userEvent.setup().click(rowOf("scenes"))
    fireEvent.dblClick(rowOf("main.scene"))
    assert.deepEqual(h.calls, [])
  })

  test("a folder's menu has the three New items, disabled while a game is running (not hidden)", async () => {
    const h = await renderAssets()
    h.signals.playMode.value = "a game is running"
    fireEvent.contextMenu(rowOf("scripts"))
    assert.deepEqual(menuItems(), [
      { label: "New Folder...", disabled: true },
      { label: "New Script...", disabled: true },
      { label: "New Scene...", disabled: true },
    ])
    // A disabled item does not ask for a name
    await userEvent.setup().click(itemNamed("New Folder..."))
    assert.equal(screen.queryByRole("dialog"), null)
    assert.deepEqual(h.host.calls, [])
  })

  test("a folder's New Scene makes Untitled.scene in that folder and lists the assets again", async () => {
    const h = await renderAssets()
    fireEvent.contextMenu(rowOf("scripts"))
    await userEvent.setup().click(itemNamed("New Scene..."))
    await waitFor(() => assert.deepEqual(h.host.calls, ["listAssets  true"]))
    assert.deepEqual(h.calls, ["newScene res://scripts/Untitled.scene"])
  })
})

describe("making a folder or a script: the name prompt", () => {
  test("+ Folder asks for a name (NewFolder by default); OK makes it in the root, selects it, and shows it", async () => {
    const h = await renderAssets()
    const user = userEvent.setup()
    await user.click(screen.getByText("+ Folder"))
    const dialog = screen.getByRole("dialog", { name: "New folder" })
    const input = within(dialog).getByRole("textbox") as HTMLInputElement
    assert.equal(input.value, "NewFolder")

    await user.clear(input)
    await user.type(input, "Levels")
    await user.click(within(dialog).getByText("OK"))

    await waitFor(() => assert.ok(rowNames().includes("Levels")))
    assert.deepEqual(h.host.calls, ["createFolder res://Levels", "listAssets  true"])
    assert.equal(h.assets.selected.value, "res://Levels")
    assert.ok(rowOf("Levels").classList.contains("selected"))
    assert.equal(screen.queryByRole("dialog"), null)
    assert.deepEqual(h.errors, [])
  })

  test("Enter confirms the name, like OK", async () => {
    const h = await renderAssets()
    const user = userEvent.setup()
    await user.click(screen.getByText("+ Folder"))
    const input = promptInput()
    await user.clear(input)
    await user.type(input, "Enter{Enter}")
    await waitFor(() => assert.ok(h.host.calls.includes("createFolder res://Enter")))
  })

  test("the folder goes inside the selected folder, or beside the selected file", async () => {
    const h = await renderAssets()
    const user = userEvent.setup()
    await user.click(rowOf("scripts")) // opens and selects it
    await user.click(screen.getByText("+ Folder"))
    await user.click(within(screen.getByRole("dialog")).getByText("OK"))
    await waitFor(() => assert.ok(h.host.calls.includes("createFolder res://scripts/NewFolder")))

    h.host.calls.length = 0
    await user.click(rowOf("a.lua")) // a file in scripts: its folder
    await user.click(screen.getByText("+ Folder"))
    const input = promptInput()
    await user.clear(input)
    await user.type(input, "Second{Enter}")
    await waitFor(() => assert.ok(h.host.calls.includes("createFolder res://scripts/Second")))
  })

  test("Cancel (and Escape) make nothing and send nothing to the host", async () => {
    const h = await renderAssets()
    const user = userEvent.setup()
    await user.click(screen.getByText("+ Folder"))
    await user.click(within(screen.getByRole("dialog")).getByText("Cancel"))
    assert.equal(screen.queryByRole("dialog"), null)

    await user.click(screen.getByText("+ Folder"))
    await user.type(promptInput(), "{Escape}")
    assert.equal(screen.queryByRole("dialog"), null)

    assert.deepEqual(h.host.calls, [])
    assert.deepEqual(h.errors, [])
    assert.deepEqual(rowNames(), ["scenes", "scripts", "hero.png"])
  })

  test("an empty name is the same as cancelling", async () => {
    const h = await renderAssets()
    const user = userEvent.setup()
    await user.click(screen.getByText("+ Folder"))
    await user.clear(promptInput())
    await user.click(within(screen.getByRole("dialog")).getByText("OK"))
    assert.equal(screen.queryByRole("dialog"), null)
    assert.deepEqual(h.host.calls, [])
    assert.deepEqual(h.errors, [])
  })

  test("an invalid name is refused with the reason, before the host is asked", async () => {
    const h = await renderAssets()
    const user = userEvent.setup()
    for (const [typed, reason] of [
      ["a/b", `A name can't contain "/"`],
      ["bad?", `A name can't contain "?"`],
      ["dot.", "A name can't end with a dot or a space"],
    ]) {
      await user.click(screen.getByText("+ Folder"))
      const input = promptInput()
      await user.clear(input)
      await user.type(input, `${typed}{Enter}`)
      await waitFor(() => assert.ok(h.errors.includes(`Failed to create the folder: ${reason}`), h.errors.join("|")))
    }
    assert.deepEqual(h.host.calls, [])
    assert.deepEqual(rowNames(), ["scenes", "scripts", "hero.png"])
  })

  test("the host's refusal is shown and the tree is unchanged", async () => {
    const h = await renderAssets()
    h.host.refuse.set("createFolder", "res://Levels already exists")
    const user = userEvent.setup()
    await user.click(screen.getByText("+ Folder"))
    const input = promptInput()
    await user.clear(input)
    await user.type(input, "Levels{Enter}")
    await waitFor(() => assert.deepEqual(h.errors, ["Failed to create the folder: res://Levels already exists"]))
    assert.deepEqual(rowNames(), ["scenes", "scripts", "hero.png"])
  })

  test("+ Script adds .lua to the name, makes it from the template, and opens it in the editor", async () => {
    const h = await renderAssets()
    const user = userEvent.setup()
    await user.click(rowOf("scripts"))
    await user.click(screen.getByText("+ Script"))
    const dialog = screen.getByRole("dialog", { name: "New script" })
    const input = within(dialog).getByRole("textbox") as HTMLInputElement
    assert.equal(input.value, "NewScript")
    await user.clear(input)
    await user.type(input, "Hero{Enter}")

    await waitFor(() => assert.deepEqual(h.assets.tabs.value.map((t) => t.path), ["res://scripts/Hero.lua"]))
    assert.equal(h.host.calls[0], "createScriptAsset res://scripts/Hero.lua []")
    assert.equal(h.assets.selected.value, "res://scripts/Hero.lua")
    assert.ok(rowNames().includes("Hero.lua"))
    assert.deepEqual(h.errors, [])
  })

  test("a folder's context menu makes things inside that folder", async () => {
    const h = await renderAssets()
    const user = userEvent.setup()
    fireEvent.contextMenu(rowOf("scenes"))
    await user.click(itemNamed("New Folder..."))
    const input = promptInput()
    await user.clear(input)
    await user.type(input, "Boss{Enter}")
    await waitFor(() => assert.ok(h.host.calls.includes("createFolder res://scenes/Boss")))
  })

  test("on a read-only host + Folder and + Script are disabled, and nothing opens", async () => {
    const h = await renderAssets()
    h.signals.hostReadOnly.value = true
    const user = userEvent.setup()
    const folder = (await screen.findByText("+ Folder")) as HTMLButtonElement
    const script = screen.getByText("+ Script") as HTMLButtonElement
    await waitFor(() => assert.equal(folder.disabled, true))
    assert.equal(script.disabled, true)
    await user.click(folder)
    assert.equal(screen.queryByRole("dialog"), null)
    assert.deepEqual(h.host.calls, [])
    // The read-only reason is the store's one
    assert.equal(h.signals.readOnlyReason.value, HostReadOnlyReason)
  })

  test("a host that turns read-only while the name prompt is open still refuses the creation", async () => {
    const h = await renderAssets()
    const user = userEvent.setup()
    await user.click(screen.getByText("+ Folder"))
    h.signals.hostReadOnly.value = true
    await user.click(within(screen.getByRole("dialog")).getByText("OK"))
    await waitFor(() => assert.equal(h.errors.length, 1))
    assert.match(h.errors[0], /^Failed to create the folder: The assets can't be changed now: /)
    assert.deepEqual(h.host.calls, [])
  })
})

describe("dragging an asset", () => {
  test("a file row starts a drag that carries its UUID, path and type for an inspector asset field", async () => {
    await renderAssets()
    const stored = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: "",
      setData: (type: string, data: string) => void stored.set(type, data),
    }
    const row = rowOf("hero.png")
    assert.equal(row.getAttribute("draggable"), "true")
    fireEvent.dragStart(row, { dataTransfer })
    assert.equal(dataTransfer.effectAllowed, "copy")
    assert.equal(stored.get("text/plain"), "res://hero.png")
    const carried = parseAssetDrag(stored.get(AssetDragType) ?? "")
    assert.deepEqual(carried, { uuid: U1, path: "res://hero.png", resourceType: "Texture" })
  })
})
