/// <reference path="../renderer/globals.d.ts" />
import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { screen, waitFor, fireEvent } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import type { HierarchyNode } from "../protocol/protocol.generated"
import { HierarchyState } from "../renderer/hierarchy-state"
import { HierarchyPanel } from "../renderer/hierarchy-panel"
import { ConfirmDialog, ContextMenu, confirmDialog } from "../renderer/ui"
import { renderWithApp } from "./helpers"
import { FakeSceneHost, stubStore } from "./panel-fakes"

/** The panel over a scene given as text, whose Hand and Rock hold a Collider and whose Rock is tagged Prop */
async function renderSearchable(spec = "Player(Arm(Hand),Leg),World(Tree,Rock),Sun") {
  const host = new FakeSceneHost(spec)
  const fake = stubStore()
  const plain = host.engine.getHierarchy
  host.engine.getHierarchy = async () => {
    const response = await plain()
    const nodes: HierarchyNode[] = response.nodes.map((n) => ({
      ...n,
      components: n.name === "Hand" || n.name === "Rock" ? ["Collider"] : [],
      tag: n.name === "Rock" || n.name === "Tree" ? "Prop" : "",
    }))
    return { ...response, nodes }
  }
  const hierarchy = new HierarchyState(host.engine, { confirm: confirmDialog })
  await hierarchy.refresh()
  renderWithApp(
    <>
      <HierarchyPanel />
      <ContextMenu />
      <ConfirmDialog />
    </>,
    { store: fake.store, hierarchy }
  )
  return { host, hierarchy }
}

const names = (): string[] =>
  Array.from(document.querySelectorAll(".hierarchy-item")).map((el) => el.querySelector(".hierarchy-name")?.textContent ?? "")
const rowOf = (name: string): HTMLElement => {
  const row = Array.from(document.querySelectorAll<HTMLElement>(".hierarchy-item")).find(
    (r) => r.querySelector(".hierarchy-name")?.textContent === name
  )
  assert.ok(row, `no row named ${name}`)
  return row
}
const box = () => screen.getByRole("searchbox", { name: "Search the hierarchy" }) as HTMLInputElement
const list = (): HTMLElement => screen.getByRole("tree")

describe("the hierarchy search box", () => {
  test("typing filters to the matches and their ancestors, with a count; clearing restores the tree", async () => {
    await renderSearchable()
    const user = userEvent.setup()
    assert.deepEqual(names(), ["Player", "World", "Sun"])
    assert.equal(document.querySelector(".hierarchy-count"), null)

    await user.type(box(), "hand")
    assert.deepEqual(names(), ["Player", "Arm", "Hand"])
    assert.equal(rowOf("Player").getAttribute("aria-expanded"), "true", "ancestors are open")
    assert.equal(document.querySelector(".hierarchy-count")?.textContent, "1 match")

    await user.clear(box())
    assert.deepEqual(names(), ["Player", "World", "Sun"], "the tree as the user left it (collapsed)")
    assert.equal(document.querySelector(".hierarchy-count"), null)
  })

  test("t:, tag: and layer: tokens narrow the same way", async () => {
    await renderSearchable()
    const user = userEvent.setup()
    await user.type(box(), "t:collider")
    assert.deepEqual(names(), ["Player", "Arm", "Hand", "World", "Rock"])
    assert.equal(document.querySelector(".hierarchy-count")?.textContent, "2 matches")
    await user.type(box(), " tag:prop")
    assert.deepEqual(names(), ["World", "Rock"])
    await user.type(box(), " layer:5")
    assert.ok(screen.getByText("No objects match the search"))
  })

  test("the clear button and Escape clear the search; Escape on an empty box goes back to the list", async () => {
    await renderSearchable()
    const user = userEvent.setup()
    await user.type(box(), "sun")
    assert.deepEqual(names(), ["Sun"])
    await user.click(screen.getByLabelText("Clear the search"))
    assert.equal(box().value, "")
    assert.deepEqual(names(), ["Player", "World", "Sun"])

    await user.type(box(), "arm")
    await user.keyboard("{Escape}")
    assert.equal(box().value, "")
    box().focus()
    await user.keyboard("{Escape}")
    assert.equal(document.activeElement, list())
  })

  test("the List button shows the matches flat with their paths", async () => {
    await renderSearchable()
    const user = userEvent.setup()
    await user.type(box(), "hand")
    await user.click(screen.getByRole("button", { name: "List" }))
    assert.deepEqual(names(), ["Hand"])
    assert.equal(rowOf("Hand").querySelector(".hierarchy-path")?.textContent, "Player / Arm / Hand")
    assert.equal(rowOf("Hand").style.paddingLeft, "4px")
    assert.equal(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed"), "true")
    await user.click(screen.getByRole("button", { name: "List" }))
    assert.deepEqual(names(), ["Player", "Arm", "Hand"])
  })

  test("Ctrl+F in the list focuses the box", async () => {
    await renderSearchable()
    list().focus()
    fireEvent.keyDown(list(), { key: "f", ctrlKey: true })
    assert.equal(document.activeElement, box())
  })

  test("clicking and the arrow keys work on the filtered rows", async () => {
    const h = await renderSearchable()
    const user = userEvent.setup()
    await user.type(box(), "t:collider")
    await user.click(rowOf("Hand"))
    assert.equal(h.hierarchy.selection.value.primary, "id-Hand")
    fireEvent.keyDown(list(), { key: "ArrowDown" })
    assert.equal(rowOf("World").getAttribute("aria-selected"), "true", "the next shown row, not Leg")
    fireEvent.keyDown(list(), { key: "ArrowDown" })
    assert.equal(rowOf("Rock").getAttribute("aria-selected"), "true")
    assert.deepEqual(h.host.calls, [])
  })

  test("the rows can't be dragged while a search is on, and a drop does nothing; they can again after", async () => {
    const h = await renderSearchable("A,B,C")
    const user = userEvent.setup()
    const transfer = { data: new Map<string, string>(), effectAllowed: "", dropEffect: "", types: [] as string[], setData() {} }
    assert.equal(rowOf("B").getAttribute("draggable"), "true")
    await user.type(box(), "b")
    await waitFor(() => assert.deepEqual(names(), ["B"]))
    assert.equal(rowOf("B").getAttribute("draggable"), "false")
    fireEvent.dragStart(rowOf("B"), { dataTransfer: transfer })
    fireEvent.dragOver(rowOf("B"), { dataTransfer: transfer })
    assert.equal(document.querySelector(".drop-inside"), null)
    fireEvent.drop(rowOf("B"), { dataTransfer: transfer })
    fireEvent.dragEnd(rowOf("B"))
    assert.deepEqual(h.host.calls, [])
    await user.clear(box())
    assert.equal(rowOf("B").getAttribute("draggable"), "true")
  })

  test("Delete acts on the shown selection only", async () => {
    const h = await renderSearchable("A,B,C")
    fireEvent.click(rowOf("A"))
    fireEvent.click(rowOf("C"), { ctrlKey: true })
    await userEvent.setup().type(box(), "c")
    list().focus()
    fireEvent.keyDown(list(), { key: "Delete" })
    await waitFor(() => assert.deepEqual(h.host.calls, ["destroyEntity id-C"]))
  })

  test("the search is a signal of the state: a restored one shows in the box", async () => {
    const h = await renderSearchable()
    h.hierarchy.setQuery("rock")
    await waitFor(() => assert.equal(box().value, "rock"))
    assert.deepEqual(names(), ["World", "Rock"])
  })
})
