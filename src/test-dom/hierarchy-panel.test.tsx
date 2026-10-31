/// <reference path="../renderer/globals.d.ts" />
import "./setup"
import { test, describe, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import { screen, waitFor, within, fireEvent, act } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { HierarchyState } from "../renderer/hierarchy-state"
import { HierarchyPanel } from "../renderer/hierarchy-panel"
import { ConfirmDialog, ContextMenu, confirmDialog, showContextMenu } from "../renderer/ui"
import { renderWithApp } from "./helpers"
import { FakeSceneHost, stubStore } from "./panel-fakes"

const Reason = "a game is running"

beforeEach(() => {
  showContextMenu(0, 0, []) // no menu left open by the test before
})

/** The panel over a real HierarchyState and a fake host whose scene is given as text */
async function renderHierarchy(spec: string, options: { connected?: boolean; scene?: null } = {}) {
  const host = new FakeSceneHost(spec)
  const fake = stubStore(options)
  const hierarchy = new HierarchyState(host.engine, { confirm: confirmDialog })
  if (fake.signals.connected.peek() && fake.signals.scene.peek() !== null) await hierarchy.refresh()
  renderWithApp(
    <>
      <HierarchyPanel />
      <ContextMenu />
      <ConfirmDialog />
    </>,
    { store: fake.store, hierarchy }
  )
  return { host, hierarchy, ...fake }
}

/** The names of the rows shown (a row being renamed shows its field's text) */
const names = (): string[] =>
  Array.from(document.querySelectorAll(".hierarchy-item")).map(
    (el) => el.querySelector(".hierarchy-name")?.textContent ?? (el.querySelector(".hierarchy-rename") as HTMLInputElement).value
  )

/** The row of an object by its name */
const rowOf = (name: string): HTMLElement => {
  const row = Array.from(document.querySelectorAll<HTMLElement>(".hierarchy-item")).find(
    (r) => r.querySelector(".hierarchy-name")?.textContent === name
  )
  assert.ok(row, `no row named ${name}`)
  return row
}

const arrowOf = (name: string): HTMLElement => rowOf(name).querySelector(".arrow") as HTMLElement
const list = (): HTMLElement => screen.getByRole("tree")
const isSelected = (name: string): boolean => rowOf(name).getAttribute("aria-selected") === "true"

const menuLabels = (): string[] =>
  within(screen.getByRole("menu")).getAllByRole("menuitem").map((el) => el.textContent ?? "")
const itemNamed = (label: string): HTMLElement => within(screen.getByRole("menu")).getByRole("menuitem", { name: label })

describe("the hierarchy tree", () => {
  test("shows the scene's roots with their arrows; children appear when expanded and go when collapsed", async () => {
    const h = await renderHierarchy("A(A1,A2(A2a)),B")
    assert.deepEqual(names(), ["A", "B"])
    assert.equal(rowOf("A").getAttribute("aria-expanded"), "false")
    assert.equal(arrowOf("A").textContent, "\u25b8")
    // A leaf has no arrow and no aria-expanded
    assert.equal(rowOf("B").getAttribute("aria-expanded"), null)
    assert.ok(arrowOf("B").classList.contains("empty"))

    const user = userEvent.setup()
    await user.click(arrowOf("A"))
    assert.deepEqual(names(), ["A", "A1", "A2", "B"])
    assert.equal(rowOf("A").getAttribute("aria-expanded"), "true")
    assert.equal(arrowOf("A").textContent, "\u25be")
    assert.equal(rowOf("A1").style.paddingLeft, "18px") // one level in

    await user.click(arrowOf("A2"))
    assert.deepEqual(names(), ["A", "A1", "A2", "A2a", "B"])
    assert.equal(rowOf("A2a").style.paddingLeft, "32px")

    await user.click(arrowOf("A"))
    assert.deepEqual(names(), ["A", "B"])
    // Expanding only changes what is shown: the host is not asked to change anything
    assert.deepEqual(h.host.calls, [])
  })

  test("the header names the scene", async () => {
    await renderHierarchy("A")
    assert.ok(screen.getByText("Hierarchy: a"))
  })

  test("not connected says so, and + Add is disabled", async () => {
    await renderHierarchy("A", { connected: false })
    assert.ok(screen.getByText("Not connected"))
    assert.equal((screen.getByText("+ Add") as HTMLButtonElement).disabled, true)
  })

  test("no scene loaded", async () => {
    await renderHierarchy("A", { scene: null })
    assert.ok(screen.getByText("No scene loaded"))
    assert.equal((screen.getByText("+ Add") as HTMLButtonElement).disabled, true)
  })

  test("a scene with no objects says so, and + Add is enabled", async () => {
    await renderHierarchy("")
    assert.ok(screen.getByText(/No objects in a\./))
    assert.equal((screen.getByText("+ Add") as HTMLButtonElement).disabled, false)
  })
})

describe("selecting", () => {
  test("a click selects one object and a click on another moves the selection; the host is not asked anything", async () => {
    const h = await renderHierarchy("A,B,C")
    const user = userEvent.setup()
    await user.click(rowOf("A"))
    assert.deepEqual([isSelected("A"), isSelected("B"), isSelected("C")], [true, false, false])
    assert.ok(rowOf("A").classList.contains("selected"))
    await user.click(rowOf("B"))
    assert.deepEqual([isSelected("A"), isSelected("B"), isSelected("C")], [false, true, false])
    assert.equal(h.hierarchy.selection.value.primary, "id-B")
    assert.deepEqual(h.host.calls, [])
  })

  test("Ctrl-click adds and removes an object, Shift-click selects the range", async () => {
    await renderHierarchy("A,B,C,D")
    fireEvent.click(rowOf("A"))
    fireEvent.click(rowOf("C"), { ctrlKey: true })
    assert.deepEqual([isSelected("A"), isSelected("B"), isSelected("C"), isSelected("D")], [true, false, true, false])
    fireEvent.click(rowOf("A"), { ctrlKey: true })
    assert.deepEqual([isSelected("A"), isSelected("C")], [false, true])

    fireEvent.click(rowOf("B"))
    fireEvent.click(rowOf("D"), { shiftKey: true })
    assert.deepEqual([isSelected("A"), isSelected("B"), isSelected("C"), isSelected("D")], [false, true, true, true])
  })

  test("the arrow keys move the selection and open and close the selected object", async () => {
    await renderHierarchy("A(A1),B")
    fireEvent.click(rowOf("A"))
    fireEvent.keyDown(list(), { key: "ArrowRight" })
    assert.deepEqual(names(), ["A", "A1", "B"])
    fireEvent.keyDown(list(), { key: "ArrowDown" })
    assert.equal(isSelected("A1"), true)
    assert.equal(isSelected("A"), false)
    fireEvent.keyDown(list(), { key: "ArrowDown" })
    assert.equal(isSelected("B"), true)
    fireEvent.keyDown(list(), { key: "ArrowUp" })
    fireEvent.keyDown(list(), { key: "ArrowUp" })
    assert.equal(isSelected("A"), true)
    fireEvent.keyDown(list(), { key: "ArrowLeft" })
    assert.deepEqual(names(), ["A", "B"])
  })

  test("selecting is still possible while the hierarchy is read-only", async () => {
    const h = await renderHierarchy("A,B")
    act(() => h.hierarchy.setReadOnly(Reason))
    await userEvent.setup().click(rowOf("B"))
    assert.equal(isSelected("B"), true)
  })
})

describe("renaming", () => {
  test("F2 turns the selected object's name into a field; Enter sends the new name and the row shows it", async () => {
    const h = await renderHierarchy("A,B")
    const user = userEvent.setup()
    await user.click(rowOf("B"))
    fireEvent.keyDown(list(), { key: "F2" })
    const input = (await screen.findByLabelText("Name")) as HTMLInputElement
    assert.equal(input.value, "B")
    await waitFor(() => assert.equal(document.activeElement, input))

    await user.clear(input)
    await user.type(input, "Boss{Enter}")

    await waitFor(() => assert.deepEqual(names(), ["A", "Boss"]))
    assert.deepEqual(h.host.calls, ['setEntityProperties id-B {"name":"Boss"}'])
    assert.equal(screen.queryByLabelText("Name"), null)
    assert.deepEqual(h.errors, [])
  })

  test("double-clicking the name starts renaming it", async () => {
    await renderHierarchy("A,B")
    fireEvent.dblClick(rowOf("A").querySelector(".hierarchy-name")!)
    assert.equal(((await screen.findByLabelText("Name")) as HTMLInputElement).value, "A")
  })

  test("Escape cancels: the name stays and nothing is sent", async () => {
    const h = await renderHierarchy("A,B")
    const user = userEvent.setup()
    await user.click(rowOf("A"))
    fireEvent.keyDown(list(), { key: "F2" })
    const input = (await screen.findByLabelText("Name")) as HTMLInputElement
    await user.clear(input)
    await user.type(input, "Zed{Escape}")
    assert.equal(screen.queryByLabelText("Name"), null)
    assert.deepEqual(names(), ["A", "B"])
    assert.deepEqual(h.host.calls, [])
  })

  test("an empty name, the same name, or only spaces send nothing", async () => {
    const h = await renderHierarchy("A,B")
    const user = userEvent.setup()
    for (const typed of ["{Enter}", "A{Enter}", "   {Enter}"]) {
      await user.click(rowOf("A"))
      fireEvent.keyDown(list(), { key: "F2" })
      const input = (await screen.findByLabelText("Name")) as HTMLInputElement
      await user.clear(input)
      await user.type(input, typed)
      await waitFor(() => assert.equal(screen.queryByLabelText("Name"), null))
    }
    assert.deepEqual(names(), ["A", "B"])
    assert.deepEqual(h.host.calls, [])
  })

  test("leaving the field (blur) commits the name, trimmed", async () => {
    const h = await renderHierarchy("A,B")
    const user = userEvent.setup()
    await user.click(rowOf("A"))
    fireEvent.keyDown(list(), { key: "F2" })
    const input = (await screen.findByLabelText("Name")) as HTMLInputElement
    await user.clear(input)
    await user.type(input, "  Alpha  ")
    await user.tab()
    await waitFor(() => assert.deepEqual(names(), ["Alpha", "B"]))
    assert.deepEqual(h.host.calls, ['setEntityProperties id-A {"name":"Alpha"}'])
  })

  test("a host that refuses the rename shows its message", async () => {
    const h = await renderHierarchy("A,B")
    h.host.engine.setEntityProperties = async () => {
      throw new Error("read-only host: SetEntityProperties is not allowed")
    }
    const user = userEvent.setup()
    await user.click(rowOf("A"))
    fireEvent.keyDown(list(), { key: "F2" })
    const input = (await screen.findByLabelText("Name")) as HTMLInputElement
    await user.clear(input)
    await user.type(input, "Zed{Enter}")
    await waitFor(() =>
      assert.deepEqual(h.errors, ["Failed to rename the object: read-only host: SetEntityProperties is not allowed"])
    )
    assert.deepEqual(names(), ["A", "B"])
  })

  test("the active checkbox sends the flag and the row shows it", async () => {
    const h = await renderHierarchy("A,B")
    const box = screen.getByLabelText("A active") as HTMLInputElement
    assert.equal(box.checked, true)
    await userEvent.setup().click(box)
    await waitFor(() => assert.ok(rowOf("A").classList.contains("inactive")))
    assert.deepEqual(h.host.calls, ['setEntityProperties id-A {"active":false}'])
    assert.equal((screen.getByLabelText("A active") as HTMLInputElement).checked, false)
  })
})

describe("creating objects", () => {
  test("+ Add lists the presets; Create Cube makes a root object, selects it and starts renaming it", async () => {
    const h = await renderHierarchy("A")
    const user = userEvent.setup()
    await user.click(screen.getByText("+ Add"))
    assert.deepEqual(menuLabels().slice(0, 3), ["Create Empty", "Create Cube", "Create Sphere"])

    await user.click(itemNamed("Create Cube"))
    await waitFor(() => assert.deepEqual(h.host.calls, ["createEntityEx ||-1|Cube"]))
    await waitFor(() => assert.ok(screen.getByLabelText("Name")))
    assert.equal((screen.getByLabelText("Name") as HTMLInputElement).value, "Cube")
    assert.equal(h.hierarchy.selection.value.primary, "new-1")
    assert.equal(screen.queryByRole("menu"), null)

    await userEvent.setup().type(screen.getByLabelText("Name"), "{Enter}") // keeps the name: no rename sent
    assert.deepEqual(names(), ["A", "Cube"])
    assert.equal(h.host.calls.length, 1)
  })

  test("a row's context menu creates a child of that object, which opens to show it", async () => {
    const h = await renderHierarchy("A,B")
    fireEvent.contextMenu(rowOf("A"))
    assert.ok(isSelected("A"))
    assert.deepEqual(menuLabels().slice(0, 4), ["Rename (F2)", "Duplicate (Ctrl+D)", "Delete (Del)", "Create Empty Child"])
    await userEvent.setup().click(itemNamed("Create Sphere Child"))
    await waitFor(() => assert.deepEqual(h.host.calls, ["createEntityEx |id-A|-1|Sphere"]))
    await waitFor(() => assert.deepEqual(names(), ["A", "Sphere", "B"]))
    assert.equal(rowOf("A").getAttribute("aria-expanded"), "true")
  })

  test("right-clicking the empty space of the list offers the root's Create items", async () => {
    const h = await renderHierarchy("A")
    fireEvent.contextMenu(list())
    assert.equal(menuLabels()[0], "Create Empty")
    await userEvent.setup().click(itemNamed("Create Point Light"))
    await waitFor(() => assert.deepEqual(h.host.calls, ["createEntityEx ||-1|PointLight"]))
  })
})

describe("deleting and duplicating", () => {
  test("Delete removes a single selected object at once, with no question", async () => {
    const h = await renderHierarchy("A,B,C")
    await userEvent.setup().click(rowOf("B"))
    fireEvent.keyDown(list(), { key: "Delete" })
    await waitFor(() => assert.deepEqual(names(), ["A", "C"]))
    assert.deepEqual(h.host.calls, ["destroyEntity id-B"])
    assert.equal(screen.queryByRole("alertdialog"), null)
  })

  test("deleting an object with children asks first; Cancel leaves everything, Delete removes the object and what is under it", async () => {
    const h = await renderHierarchy("A(A1,A2),B")
    const user = userEvent.setup()
    await user.click(rowOf("A"))
    fireEvent.keyDown(list(), { key: "Delete" })
    const dialog = await screen.findByRole("alertdialog")
    assert.equal(within(dialog).getByText(/Delete 'A' and everything under it \(3 objects\)\?/).tagName, "P")

    await user.click(within(dialog).getByText("Cancel"))
    await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null))
    assert.deepEqual(names(), ["A", "B"])
    assert.deepEqual(h.host.calls, [])

    fireEvent.keyDown(list(), { key: "Delete" })
    await user.click(within(await screen.findByRole("alertdialog")).getByText("Delete"))
    await waitFor(() => assert.deepEqual(names(), ["B"]))
    assert.deepEqual(h.host.calls, ["destroyEntity id-A"])
  })

  test("the row menu's Delete does the same, and Duplicate copies the object and selects the copy", async () => {
    const h = await renderHierarchy("A,B")
    const user = userEvent.setup()
    fireEvent.contextMenu(rowOf("B"))
    await user.click(itemNamed("Duplicate (Ctrl+D)"))
    await waitFor(() => assert.deepEqual(names(), ["A", "B", "B (1)"]))
    assert.deepEqual(h.host.calls, ["duplicateEntity id-B"])
    assert.equal(isSelected("B (1)"), true)
    assert.equal(isSelected("B"), false)

    h.host.calls.length = 0
    fireEvent.contextMenu(rowOf("A"))
    await user.click(itemNamed("Delete (Del)"))
    await waitFor(() => assert.deepEqual(names(), ["B", "B (1)"]))
    assert.deepEqual(h.host.calls, ["destroyEntity id-A"])
  })

  test("Ctrl+D duplicates", async () => {
    const h = await renderHierarchy("A,B")
    await userEvent.setup().click(rowOf("A"))
    fireEvent.keyDown(list(), { key: "d", ctrlKey: true })
    await waitFor(() => assert.deepEqual(names(), ["A", "A (1)", "B"]))
    assert.deepEqual(h.host.calls, ["duplicateEntity id-A"])
  })

  test("a failed delete is shown and the tree is read again", async () => {
    const h = await renderHierarchy("A,B")
    h.host.engine.destroyEntity = async () => {
      throw new Error("The entity is gone")
    }
    await userEvent.setup().click(rowOf("A"))
    fireEvent.keyDown(list(), { key: "Delete" })
    await waitFor(() => assert.deepEqual(h.errors, ["Failed to delete: The entity is gone"]))
    assert.deepEqual(names(), ["A", "B"])
  })
})

describe("drag and drop (a hand-made dataTransfer: jsdom has none)", () => {
  /** A dataTransfer that keeps what is set on it */
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
    }
  }

  test("dropping an object on another (no layout: the middle of the row) makes it a child, and the host is asked to keep it in place", async () => {
    const h = await renderHierarchy("A,B")
    const transfer = makeTransfer()
    fireEvent.dragStart(rowOf("B"), { dataTransfer: transfer })
    assert.equal(transfer.data.get("application/x-n2-entity"), "id-B")
    assert.ok(rowOf("B").classList.contains("dragging"))

    fireEvent.dragOver(rowOf("A"), { dataTransfer: transfer })
    assert.ok(rowOf("A").classList.contains("drop-inside"))
    fireEvent.drop(rowOf("A"), { dataTransfer: transfer })

    await waitFor(() => assert.equal(h.host.calls.length, 1))
    assert.match(h.host.calls[0], /^setEntityParent id-B\|id-A\|-?\d+\|true$/)
    await waitFor(() => assert.deepEqual(names(), ["A", "B"])) // A is now open, showing B under it
    assert.equal(h.host.text(), "A(B)")
    assert.equal(document.querySelector(".dragging"), null)
    assert.equal(document.querySelector(".drop-inside"), null)
  })

  test("starting a drag does not change the selection; a click does, with Ctrl and Shift as before", async () => {
    const h = await renderHierarchy("A,B,C")
    const user = userEvent.setup()
    await user.click(rowOf("A"))
    assert.ok(isSelected("A"))
    const transfer = makeTransfer()
    fireEvent.mouseDown(rowOf("B"))
    assert.ok(isSelected("A") && !isSelected("B"), "a press selects nothing")
    fireEvent.dragStart(rowOf("B"), { dataTransfer: transfer })
    assert.equal(transfer.data.get("application/x-n2-entity"), "id-B")
    assert.ok(isSelected("A") && !isSelected("B"), "a drag from an unselected row leaves the selection alone")
    assert.equal(h.hierarchy.selection.value.primary, "id-A")
    fireEvent.dragEnd(rowOf("B"), { dataTransfer: transfer })
    await user.click(rowOf("B"))
    assert.ok(isSelected("B") && !isSelected("A"))
    await user.keyboard("{Control>}")
    await user.click(rowOf("C"))
    await user.keyboard("{/Control}")
    assert.ok(isSelected("B") && isSelected("C"))
  })

  test("an object dropped on itself or on something under it changes nothing", async () => {
    const h = await renderHierarchy("A(A1)")
    const user = userEvent.setup()
    await user.click(arrowOf("A"))
    const transfer = makeTransfer()
    fireEvent.dragStart(rowOf("A"), { dataTransfer: transfer })
    fireEvent.dragOver(rowOf("A1"), { dataTransfer: transfer })
    assert.equal(document.querySelector(".drop-inside"), null)
    fireEvent.drop(rowOf("A1"), { dataTransfer: transfer })
    fireEvent.dragStart(rowOf("A"), { dataTransfer: transfer })
    fireEvent.drop(rowOf("A"), { dataTransfer: transfer })
    assert.deepEqual(h.host.calls, [])
  })

  test("a row of a read-only hierarchy is not draggable, and a drop moves nothing", async () => {
    const h = await renderHierarchy("A,B")
    assert.equal(rowOf("B").getAttribute("draggable"), "true")
    act(() => h.hierarchy.setReadOnly(Reason))
    assert.equal(rowOf("B").getAttribute("draggable"), "false")
    const transfer = makeTransfer()
    fireEvent.dragStart(rowOf("B"), { dataTransfer: transfer })
    fireEvent.drop(rowOf("A"), { dataTransfer: transfer })
    assert.deepEqual(h.host.calls, [])
  })
})

describe("the hierarchy while it is read-only", () => {
  test("+ Add is disabled, the checkboxes are disabled and say why, and the row menu has one disabled item", async () => {
    const h = await renderHierarchy("A,B")
    act(() => h.hierarchy.setReadOnly(Reason))
    assert.equal((screen.getByText("+ Add") as HTMLButtonElement).disabled, true)
    const box = screen.getByLabelText("A active") as HTMLInputElement
    assert.equal(box.disabled, true)
    assert.equal(box.title, `Read only: ${Reason}`)

    fireEvent.contextMenu(rowOf("A"))
    assert.deepEqual(menuLabels(), [`Read only: ${Reason}`])
    assert.equal(itemNamed(`Read only: ${Reason}`).getAttribute("aria-disabled"), "true")
    await userEvent.setup().click(itemNamed(`Read only: ${Reason}`))
    assert.deepEqual(h.host.calls, [])
  })

  test("F2, Delete and Ctrl+D do nothing, and no call reaches the host", async () => {
    const h = await renderHierarchy("A,B")
    act(() => h.hierarchy.setReadOnly(Reason))
    fireEvent.click(rowOf("A"))
    fireEvent.keyDown(list(), { key: "F2" })
    fireEvent.keyDown(list(), { key: "Delete" })
    fireEvent.keyDown(list(), { key: "d", ctrlKey: true })
    assert.equal(screen.queryByLabelText("Name"), null)
    assert.equal(screen.queryByRole("alertdialog"), null)
    assert.deepEqual(names(), ["A", "B"])
    assert.deepEqual(h.host.calls, [])
    assert.deepEqual(h.errors, [])
  })

  test("the empty space's context menu offers nothing to create", async () => {
    const h = await renderHierarchy("A")
    act(() => h.hierarchy.setReadOnly(Reason))
    fireEvent.contextMenu(list())
    assert.equal(screen.queryByRole("menu"), null)
  })

  test("a rename in progress ends when the hierarchy becomes read-only, and the typed name is not sent", async () => {
    const h = await renderHierarchy("A,B")
    await userEvent.setup().click(rowOf("A"))
    fireEvent.keyDown(list(), { key: "F2" })
    const input = (await screen.findByLabelText("Name")) as HTMLInputElement
    await userEvent.setup().type(input, "x")
    act(() => h.hierarchy.setReadOnly(Reason))
    await waitFor(() => assert.equal(screen.queryByLabelText("Name"), null))
    assert.deepEqual(names(), ["A", "B"])
    assert.deepEqual(h.host.calls, [])
  })

  test("everything is enabled again once it can be edited", async () => {
    const h = await renderHierarchy("A")
    act(() => h.hierarchy.setReadOnly(Reason))
    assert.equal((screen.getByText("+ Add") as HTMLButtonElement).disabled, true)
    act(() => h.hierarchy.setReadOnly(null))
    assert.equal((screen.getByText("+ Add") as HTMLButtonElement).disabled, false)
    assert.equal((screen.getByLabelText("A active") as HTMLInputElement).disabled, false)
  })
})

describe("the hierarchy's keys are keymap actions (hierarchy scope)", () => {
  test("the list is the hierarchy scope, and the panel's keys are registered with the page's keymap", async () => {
    await renderHierarchy("A,B")
    assert.equal(list().getAttribute("data-keymap-scope"), "hierarchy")
  })

  test("Shift+Down and Shift+Up extend the selection by a row", async () => {
    await renderHierarchy("A,B,C")
    fireEvent.click(rowOf("A"))
    fireEvent.keyDown(list(), { key: "ArrowDown", shiftKey: true })
    assert.deepEqual([isSelected("A"), isSelected("B"), isSelected("C")], [true, true, false])
    fireEvent.keyDown(list(), { key: "ArrowDown", shiftKey: true })
    assert.deepEqual([isSelected("A"), isSelected("B"), isSelected("C")], [true, true, true])
    fireEvent.keyDown(list(), { key: "ArrowUp", shiftKey: true })
    assert.deepEqual([isSelected("A"), isSelected("B"), isSelected("C")], [true, true, false])
  })

  test("Cmd+D duplicates too (Ctrl or Cmd, as it always did)", async () => {
    const h = await renderHierarchy("A,B")
    fireEvent.click(rowOf("A"))
    fireEvent.keyDown(list(), { key: "d", metaKey: true })
    await waitFor(() => assert.deepEqual(h.host.calls, ["duplicateEntity id-A"]))
  })

  test("a key that repeats because it is held (Delete, Ctrl+D) acts once; F2 is not held-key guarded", async () => {
    const h = await renderHierarchy("A,B,C")
    fireEvent.click(rowOf("A"))
    fireEvent.keyDown(list(), { key: "Delete" })
    await waitFor(() => assert.deepEqual(names(), ["B", "C"]))
    fireEvent.keyDown(list(), { key: "Delete", repeat: true })
    fireEvent.keyDown(list(), { key: "d", ctrlKey: true, repeat: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(h.host.calls, ["destroyEntity id-A"])
    assert.deepEqual(names(), ["B", "C"])
  })

  test("the held key's default is prevented even though nothing is done (as the old handler did)", async () => {
    await renderHierarchy("A,B")
    fireEvent.click(rowOf("A"))
    assert.equal(fireEvent.keyDown(list(), { key: "Delete", repeat: true }), false)
    assert.equal(fireEvent.keyDown(list(), { key: "ArrowDown" }), false)
    assert.equal(fireEvent.keyDown(list(), { key: "x" }), true, "a key that is not a shortcut is left alone")
  })

  test("typing in the name field never fires a shortcut (Delete, F2, Ctrl+D, the arrows)", async () => {
    const h = await renderHierarchy("A,B")
    await userEvent.setup().click(rowOf("A"))
    fireEvent.keyDown(list(), { key: "F2" })
    const input = (await screen.findByLabelText("Name")) as HTMLInputElement
    for (const init of [{ key: "Delete" }, { key: "F2" }, { key: "d", ctrlKey: true }, { key: "ArrowDown" }]) {
      fireEvent.keyDown(input, init)
    }
    assert.deepEqual(h.host.calls, [])
    assert.equal(screen.queryByRole("alertdialog"), null)
    assert.ok(screen.queryByLabelText("Name"), "still renaming")
    assert.deepEqual(names(), ["A", "B"])
  })

  test("a key pressed outside the list (the panel's Add button) is not the hierarchy's", async () => {
    const h = await renderHierarchy("A,B")
    fireEvent.click(rowOf("A"))
    fireEvent.keyDown(screen.getByRole("button", { name: "+ Add" }), { key: "Delete" })
    assert.deepEqual(h.host.calls, [])
    assert.deepEqual(names(), ["A", "B"])
  })

  test("with a dialog open the keys do nothing", async () => {
    const h = await renderHierarchy("A(A1),B")
    await userEvent.setup().click(rowOf("A"))
    fireEvent.keyDown(list(), { key: "Delete" })
    await screen.findByRole("alertdialog")
    fireEvent.keyDown(list(), { key: "ArrowDown" })
    fireEvent.keyDown(list(), { key: "d", ctrlKey: true })
    assert.equal(isSelected("A"), true, "the selection did not move")
    assert.deepEqual(h.host.calls, [])
  })

  test("the row menu shows the chords the keymap has, rebound ones too", async () => {
    const { keymap } = await import("../renderer/keymap")
    await renderHierarchy("A,B")
    assert.equal(keymap.bind("hierarchy.duplicate", ["Mod+Shift+D"]).ok, true)
    fireEvent.contextMenu(rowOf("B"))
    assert.deepEqual(menuLabels().slice(0, 3), ["Rename (F2)", "Duplicate (Ctrl+Shift+D)", "Delete (Del)"])
    keymap.reset("hierarchy.duplicate")
  })
})
