import "./setup"
import { test, describe, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import type { ComponentType } from "preact"
import { useEffect } from "preact/hooks"
import { render, screen, waitFor, within, fireEvent, act } from "@testing-library/preact"
import { LayoutController } from "../renderer/layout/layout-controller"
import { DynamicTab, EditorLayout, WindowButton } from "../renderer/layout/layout-view"
import { LayoutPersistence, KeyValueStore, ProjectLayoutPref, UserLayoutPref, projectLayoutKey, UserLayoutKey } from "../renderer/layout/layout-storage"
import { prefStorageKey } from "../renderer/prefs"
import { PanelDragType } from "../renderer/layout/panel-frame"
import { defaultLayout, serializeLayout } from "../renderer/layout/layout-model"
import { ContextMenu, Panel, showContextMenu } from "../renderer/ui"
import { builtinPanels } from "../renderer/layout/builtin-panels"
import { fixtureRegistry, shape } from "../test/layout-fixture"

const Project = "11111111-1111-4111-8111-111111111111"

/** What the fake panels did: "mount hierarchy", "unmount viewport" */
let events: string[] = []
/** The fake viewports mounted so far, each with the frames it asked for while mounted (a stand-in for the renderer's requests) */
let viewports: { frames: number; running: boolean }[] = []
const framesAsked = () => viewports.reduce((sum, v) => sum + v.frames, 0)

type PanelComponent = ComponentType<Record<string, never>>

/** A panel with a Panel frame (a header of its own), like the hierarchy and the inspector */
function framed(id: string): PanelComponent {
  return function Framed() {
    useEffect(() => {
      events.push(`mount ${id}`)
      return () => void events.push(`unmount ${id}`)
    }, [])
    return (
      <Panel title={`${id} header`} class={`${id}-panel`}>
        <p>{id} content</p>
      </Panel>
    )
  }
}

/** The viewport: no header, and a loop that asks for frames for as long as it is mounted */
function viewportPanel(): PanelComponent {
  return function FakeViewport() {
    useEffect(() => {
      events.push("mount viewport")
      const me = { frames: 0, running: true }
      viewports.push(me)
      const timer = setInterval(() => me.frames++, 5)
      return () => {
        clearInterval(timer)
        me.running = false
        events.push("unmount viewport")
      }
    }, [])
    return <div class="viewport-container">viewport content</div>
  }
}

const componentOf = (id: string): PanelComponent => (id === "viewport" ? viewportPanel() : framed(id))

class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>()
  broken = false
  get(key: string): string | null {
    if (this.broken) throw new Error("storage unavailable")
    return this.data.get(key) ?? null
  }
  set(key: string, value: string): void {
    if (this.broken) throw new Error("storage unavailable")
    this.data.set(key, value)
  }
  remove(key: string): void {
    if (this.broken) throw new Error("storage unavailable")
    this.data.delete(key)
  }
}

beforeEach(() => {
  events = []
  viewports = []
  showContextMenu(0, 0, []) // no menu left open by the test before
})

function renderLayout(options: { store?: MemoryStore; dynamic?: DynamicTab[]; project?: boolean } = {}) {
  const store = options.store ?? new MemoryStore()
  const registry = fixtureRegistry<PanelComponent>(componentOf)
  const controller = new LayoutController(registry, new LayoutPersistence(store, registry))
  if (options.project !== false) controller.setProject(Project)
  const dynamic = options.dynamic ?? []
  const view = render(
    <>
      <WindowButton controller={controller} />
      <EditorLayout controller={controller} dynamic={new Map(dynamic.map((t) => [t.id, t]))} />
      <ContextMenu />
    </>
  )
  return { store, controller, view }
}

const region = (name: "left" | "right" | "bottom") => document.querySelector<HTMLElement>(`.${name}-panel`)
const tabNames = (root: HTMLElement | Document = document): string[] =>
  within(root as HTMLElement).queryAllByRole("tab").map((t) => (t.textContent ?? "").replace(/\u00d7$/, ""))
const menuLabels = (): string[] =>
  Array.from(document.querySelectorAll(".context-menu-item")).map((el) => (el.textContent ?? "").replace(/^[\u2713\u2003]\s*/, "").trim())
const menuItem = (label: string): HTMLElement => {
  const item = Array.from(document.querySelectorAll<HTMLElement>(".context-menu-item")).find((el) =>
    (el.textContent ?? "").replace(/^[\u2713\u2003]\s*/, "").trim() === label
  )
  assert.ok(item, `no menu item ${label}; there are ${menuLabels().join(", ")}`)
  return item
}
const chooseFromWindow = (label: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Window" }))
  fireEvent.click(menuItem(label))
}
/** A stand-in for a DataTransfer (jsdom has none) that remembers what the drag put in it */
const dataTransfer = () => {
  const data = new Map<string, string>()
  return {
    data,
    types: [] as string[],
    effectAllowed: "uninitialized",
    dropEffect: "none",
    setData(type: string, value: string) {
      data.set(type, value)
      this.types = [...data.keys()]
    },
    getData: (type: string) => data.get(type) ?? "",
  }
}

describe("the default arrangement", () => {
  test("has the four regions with the panels where they always were, and no tab bars but the console's", () => {
    renderLayout()
    assert.ok(region("left")!.querySelector(".assets-panel"))
    assert.ok(document.querySelector(".center-region .viewport-container"))
    assert.ok(document.querySelector(".center-panel .bottom-panel"))
    // The right region stacks hierarchy, inspector and engine, each with its own header and none a tab bar
    const right = region("right")!
    assert.deepEqual(
      Array.from(right.querySelectorAll(".panel-header")).map((h) => h.textContent),
      ["hierarchy header", "inspector header", "engine header"]
    )
    assert.equal(right.querySelectorAll(".tab-bar").length, 0)
    assert.equal(region("left")!.querySelectorAll(".tab-bar").length, 0)
    assert.equal(document.querySelectorAll(".center-region .tab-bar").length, 0)
    assert.deepEqual(tabNames(region("bottom")!), ["Console"])
  })

  test("the right region's stacks keep their shares (hierarchy 30%, inspector the rest, engine by content)", () => {
    renderLayout()
    const groups = Array.from(region("right")!.querySelectorAll<HTMLElement>(".panel-group"))
    assert.deepEqual(
      groups.map((g) => [g.style.flex, g.style.maxHeight]),
      [
        ["0 0 30%", ""],
        ["1 1 0%", ""],
        ["0 0 auto", "30%"],
      ]
    )
  })

  test("the regions have the sizes the splitters always started with, and a splitter between each", () => {
    renderLayout()
    assert.equal(region("left")!.style.width, "300px")
    assert.equal(region("right")!.style.width, "300px")
    assert.equal(region("bottom")!.style.height, "220px")
    assert.equal(document.querySelectorAll(".splitter").length, 3)
  })
})

describe("tabs", () => {
  test("a panel moved onto another's stack becomes a tab, and clicking a tab switches", () => {
    renderLayout()
    fireEvent.contextMenu(region("left")!.querySelector(".panel-header")!)
    fireEvent.click(menuItem("Move to Right"))
    // The left region is empty now: no column, no splitter for it
    assert.equal(region("left"), null)
    assert.equal(document.querySelectorAll(".splitter").length, 2)
    const first = document.querySelector<HTMLElement>(".right-panel .panel-group")!
    assert.deepEqual(tabNames(first), ["Hierarchy", "Assets"])
    const tabs = within(first).getAllByRole("tab")
    assert.equal(tabs[1].getAttribute("aria-selected"), "true")
    assert.equal(within(first).getByRole("tabpanel").textContent, "assets headerassets content")

    fireEvent.click(tabs[0])
    assert.equal(tabs[0].getAttribute("aria-selected"), "true")
    assert.equal(within(first).getByRole("tabpanel").textContent, "hierarchy headerhierarchy content")
  })

  test("a hidden tab's panel stays mounted (it keeps its state), hidden", async () => {
    const { controller } = renderLayout()
    act(() => controller.move("assets", { region: "right", group: 0 }))
    await waitFor(() => assert.ok(events.includes("mount assets")))
    events = []
    act(() => controller.activate("hierarchy"))
    act(() => controller.activate("assets"))
    act(() => controller.activate("hierarchy"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(events, [], "switching tabs mounts and unmounts nothing")
    const hidden = document.querySelector<HTMLElement>(".assets-panel")!.closest<HTMLElement>(".tab-panel")!
    assert.equal(hidden.hidden, true)
  })

  test("moving a stack's first tab out keeps the stack's other panels mounted", async () => {
    const { controller } = renderLayout()
    act(() => controller.move("hierarchy", { region: "left", group: 0 }))
    await waitFor(() => assert.ok(events.includes("mount hierarchy")))
    events = []
    act(() => controller.move("assets", { region: "right", group: 0 }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(!events.includes("unmount hierarchy"), "hierarchy was not remounted: " + events.join(", "))
  })

  test("a tab whose panel is not mounted has no aria-controls, and the others name an existing tabpanel", () => {
    const { controller } = renderLayout()
    act(() => controller.move("viewport", { region: "bottom", group: 0 }))
    const tabs = within(region("bottom")!).getAllByRole("tab")
    for (const tab of tabs) {
      const controls = tab.getAttribute("aria-controls")
      if (tab.getAttribute("aria-selected") === "true") assert.ok(document.getElementById(controls!), "the shown tab names its panel")
      else if (controls !== null) assert.ok(document.getElementById(controls), "aria-controls never names a missing element")
    }
  })

  test("a layout change waiting to be saved is saved when the window is hidden or closed", () => {
    const { controller, store } = renderLayout()
    const detach = controller.flushOnUnload(window)
    act(() => controller.setSize("left", 333))
    assert.equal(store.get(prefStorageKey(ProjectLayoutPref, Project)), null, "still waiting")
    window.dispatchEvent(new Event("pagehide"))
    assert.ok(store.get(prefStorageKey(ProjectLayoutPref, Project)), "saved")
    detach()
  })

  test("a tab bar shows a closable tab's close button, and it closes the panel", () => {
    renderLayout()
    const consoleTab = within(region("bottom")!).getByRole("tab")
    fireEvent.click(within(consoleTab).getByRole("button", { name: "Close Console" }))
    assert.equal(document.querySelector(".bottom-panel"), null)
  })
})

describe("moving panels", () => {
  test("every region but the current one is offered, and the move is applied", () => {
    renderLayout()
    fireEvent.contextMenu(region("right")!.querySelector(".panel-header")!)
    assert.deepEqual(menuLabels(), ["Move to Left", "Move to Centre", "Move to Bottom", "Close"])
    fireEvent.click(menuItem("Move to Bottom"))
    assert.deepEqual(tabNames(region("bottom")!), ["Console", "Hierarchy"])
  })

  test("a tab dragged onto another stack's tab bar moves there", () => {
    const { controller } = renderLayout()
    // Hierarchy and inspector as tabs of one stack so there are tab bars
    act(() => controller.move("inspector", { region: "right", group: 0 }))
    const bottomTab = within(region("bottom")!).getByRole("tab")
    const drag = dataTransfer()
    const hierarchyTab = within(region("right")!).getAllByRole("tab")[0]
    fireEvent.dragStart(hierarchyTab, { dataTransfer: drag })
    assert.equal(drag.data.get(PanelDragType), "hierarchy")
    assert.equal(controller.dragging.value, "hierarchy")
    fireEvent.dragOver(bottomTab, { dataTransfer: drag })
    fireEvent.drop(bottomTab, { dataTransfer: drag })
    assert.deepEqual(tabNames(region("bottom")!), ["Hierarchy", "Console"], "dropped onto a tab: before it")
    assert.equal(controller.dragging.value, null)
  })

  test("a panel's header can be dragged onto a stack's body", () => {
    const { controller } = renderLayout()
    const drag = dataTransfer()
    fireEvent.dragStart(region("left")!.querySelector(".panel-header")!, { dataTransfer: drag })
    fireEvent.drop(region("bottom")!.querySelector(".panel-group")!, { dataTransfer: drag })
    assert.deepEqual(tabNames(region("bottom")!), ["Console", "Assets"])
    assert.equal(controller.dragging.value, null)
  })

  test("an empty region shows a drop zone while a tab is dragged, and a drop there fills it", () => {
    const { controller } = renderLayout()
    act(() => controller.move("assets", { region: "right" }))
    assert.equal(document.querySelector(".drop-zone"), null)
    const drag = dataTransfer()
    fireEvent.dragStart(within(region("right")!).getAllByRole("tab")[1], { dataTransfer: drag })
    const zone = document.querySelector<HTMLElement>(".drop-zone.left")!
    assert.ok(zone)
    fireEvent.drop(zone, { dataTransfer: drag })
    assert.ok(region("left")!.querySelector(".assets-panel"))
    assert.equal(document.querySelector(".drop-zone"), null)
  })

  test("a drag that is not a panel is ignored, and one that names an unknown panel changes nothing", () => {
    const { controller } = renderLayout()
    const before = JSON.stringify(controller.layout.value)
    const foreign = { ...dataTransfer(), types: ["text/plain"], getData: () => "assets" }
    fireEvent.drop(region("bottom")!.querySelector(".panel-group")!, { dataTransfer: foreign })
    const bogus = dataTransfer()
    bogus.setData(PanelDragType, "ghost")
    fireEvent.drop(region("bottom")!.querySelector(".panel-group")!, { dataTransfer: bogus })
    assert.equal(JSON.stringify(controller.layout.value), before)
  })

  test("an empty centre says so, and the viewport can only move when it is a tab", () => {
    const { controller } = renderLayout()
    // Alone in its stack it has no tab bar, so no menu: there is nothing to grab
    assert.equal(document.querySelectorAll(".center-region .tab-bar").length, 0)
    act(() => controller.move("assets", { region: "center" }))
    const tabs = within(document.querySelector<HTMLElement>(".center-region")!).getAllByRole("tab")
    assert.deepEqual(tabs.map((t) => t.textContent), ["Viewport", "Assets\u00d7"])
    assert.equal(within(tabs[0]).queryByRole("button"), null, "the viewport has no close button")
    act(() => controller.move("viewport", { region: "left" }))
    act(() => controller.move("assets", { region: "right" }))
    assert.equal(document.querySelector(".center-region .viewport-container"), null)
    assert.ok(within(document.querySelector<HTMLElement>(".center-region")!).getByText(/No panel here/))
  })
})

describe("keyboard", () => {
  const stacked = () => {
    const h = renderLayout()
    act(() => h.controller.move("inspector", { region: "right", group: 0 }))
    act(() => h.controller.move("engine", { region: "right", group: 0 }))
    return h
  }

  test("tabs are a tablist with one tab in the tab order", () => {
    stacked()
    const list = within(region("right")!).getByRole("tablist")
    assert.equal(list.getAttribute("aria-label"), "Right panels")
    const tabs = within(list).getAllByRole("tab")
    assert.deepEqual(tabs.map((t) => t.getAttribute("tabindex")), ["-1", "-1", "0"], "the shown one only")
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute("aria-controls")!)
      assert.ok(panel, "aria-controls names a tabpanel")
      assert.equal(panel.getAttribute("role"), "tabpanel")
      assert.equal(panel.getAttribute("aria-labelledby"), tab.id)
    }
  })

  test("arrow keys, Home and End switch tabs and move the focus, wrapping round", async () => {
    stacked()
    const tabs = () => within(region("right")!).getAllByRole("tab")
    tabs()[2].focus()
    fireEvent.keyDown(tabs()[2], { key: "ArrowRight" })
    await waitFor(() => assert.equal(document.activeElement, tabs()[0]))
    assert.equal(tabs()[0].getAttribute("aria-selected"), "true")
    fireEvent.keyDown(tabs()[0], { key: "ArrowLeft" })
    await waitFor(() => assert.equal(document.activeElement, tabs()[2]))
    fireEvent.keyDown(tabs()[2], { key: "Home" })
    await waitFor(() => assert.equal(document.activeElement, tabs()[0]))
    fireEvent.keyDown(tabs()[0], { key: "ArrowRight" })
    await waitFor(() => assert.equal(document.activeElement, tabs()[1]))
    fireEvent.keyDown(tabs()[1], { key: "End" })
    await waitFor(() => assert.equal(document.activeElement, tabs()[2]))
    assert.equal(within(region("right")!).getByRole("tabpanel").textContent, "engine headerengine content")
  })

  test("the context menu key opens the tab's menu with the focus in it; arrows and Enter move the panel", async () => {
    stacked()
    const tab = within(region("right")!).getAllByRole("tab")[1]
    tab.focus()
    fireEvent.keyDown(tab, { key: "ContextMenu" })
    const menu = await screen.findByRole("menu")
    await waitFor(() => assert.equal(document.activeElement, menu))
    assert.equal(menu.querySelector(".marked")?.textContent, "Move to Left", "the first item is marked")
    fireEvent.keyDown(menu, { key: "ArrowDown" })
    fireEvent.keyDown(menu, { key: "ArrowDown" })
    assert.equal(menu.querySelector(".marked")?.textContent, "Move to Bottom")
    fireEvent.keyDown(menu, { key: "ArrowUp" })
    fireEvent.keyDown(menu, { key: "Enter" })
    assert.equal(screen.queryByRole("menu"), null)
    assert.deepEqual(tabNames(region("right")!), ["Hierarchy", "Engine"])
    assert.deepEqual(tabNames(document.querySelector<HTMLElement>(".center-region")!), ["Viewport", "Inspector"])
    // The moved tab keeps the focus
    await waitFor(() => assert.equal((document.activeElement as HTMLElement).dataset.tabId, "inspector"))
  })

  test("Shift+F10 opens the same menu, and Escape closes it and gives the focus back", async () => {
    stacked()
    const tab = within(region("right")!).getAllByRole("tab")[1]
    tab.focus()
    fireEvent.keyDown(tab, { key: "F10", shiftKey: true })
    await screen.findByRole("menu")
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    assert.equal(screen.queryByRole("menu"), null)
    assert.equal(document.activeElement, tab)
  })

  test("Delete closes a closable tab", () => {
    stacked()
    const tab = within(region("right")!).getAllByRole("tab")[1]
    fireEvent.keyDown(tab, { key: "Delete" })
    assert.deepEqual(tabNames(region("right")!), ["Hierarchy", "Engine"])
  })

  test("Delete does nothing on the viewport's tab, which cannot be closed", () => {
    const { controller } = renderLayout()
    act(() => controller.move("assets", { region: "center" }))
    const viewport = within(document.querySelector<HTMLElement>(".center-region")!).getAllByRole("tab")[0]
    fireEvent.keyDown(viewport, { key: "Delete" })
    assert.deepEqual(tabNames(document.querySelector<HTMLElement>(".center-region")!), ["Viewport", "Assets"])
    assert.deepEqual(controller.layout.value.closed, [])
  })

  test("the Window menu opens from the keyboard with the focus in it", async () => {
    renderLayout()
    const button = screen.getByRole("button", { name: "Window" })
    button.focus()
    // A click made by Enter or Space has no detail
    fireEvent.click(button, { detail: 0 })
    const menu = await screen.findByRole("menu")
    await waitFor(() => assert.equal(document.activeElement, menu))
    fireEvent.keyDown(menu, { key: "Escape" })
    assert.equal(document.activeElement, button)
  })
})

describe("the Window menu", () => {
  test("lists every panel (shown ones checked), then the layout's items", () => {
    renderLayout()
    fireEvent.click(screen.getByRole("button", { name: "Window" }))
    assert.deepEqual(menuLabels(), [
      "Assets",
      "Viewport",
      "Console",
      "Hierarchy",
      "Inspector",
      "Engine",
      "Reset layout",
      "Save layout as the default for new projects",
      "Keyboard shortcuts",
    ])
    assert.ok((menuItem("Inspector").textContent ?? "").startsWith("\u2713"))
  })

  test("choosing a shown panel closes it, and choosing it again opens it where it started", () => {
    renderLayout()
    chooseFromWindow("Inspector")
    assert.deepEqual(
      Array.from(region("right")!.querySelectorAll(".panel-header")).map((h) => h.textContent),
      ["hierarchy header", "engine header"]
    )
    fireEvent.click(screen.getByRole("button", { name: "Window" }))
    assert.ok(!(menuItem("Inspector").textContent ?? "").startsWith("\u2713"), "unchecked once closed")
    fireEvent.click(menuItem("Inspector"))
    assert.deepEqual(
      Array.from(region("right")!.querySelectorAll(".panel-header")).map((h) => h.textContent),
      ["hierarchy header", "inspector header", "engine header"]
    )
  })

  test("closing every panel of a region removes the region; opening one brings it back", () => {
    renderLayout()
    chooseFromWindow("Assets")
    assert.equal(region("left"), null)
    chooseFromWindow("Assets")
    assert.ok(region("left")!.querySelector(".assets-panel"))
  })

  test("the viewport is always shown: choosing it only switches to it", () => {
    const { controller } = renderLayout()
    chooseFromWindow("Viewport")
    assert.ok(document.querySelector(".viewport-container"))
    assert.deepEqual(controller.layout.value.closed, [])
  })

  test("choosing a panel that cannot be closed, hidden behind another tab, shows it", () => {
    const { controller } = renderLayout()
    act(() => controller.move("assets", { region: "center" }))
    assert.equal(document.querySelector(".viewport-container"), null)
    chooseFromWindow("Viewport")
    assert.ok(document.querySelector(".viewport-container"))
    assert.deepEqual(controller.layout.value.closed, [])
  })

  test("Reset layout puts everything back, the sizes too, and forgets the project's layout", () => {
    const { store, controller } = renderLayout()
    chooseFromWindow("Inspector")
    act(() => controller.move("assets", { region: "right" }))
    act(() => controller.setSize("right", 480))
    controller.flush()
    assert.ok(store.data.has(prefStorageKey(ProjectLayoutPref, Project)))
    chooseFromWindow("Reset layout")
    assert.equal(store.data.has(prefStorageKey(ProjectLayoutPref, Project)), false)
    assert.ok(region("left")!.querySelector(".assets-panel"))
    assert.equal(region("right")!.style.width, "300px")
    assert.equal(region("right")!.querySelectorAll(".panel-header").length, 3)
  })

  test("Save as default stores a user layout, and the menu then offers to forget it", () => {
    const { store } = renderLayout()
    chooseFromWindow("Inspector")
    chooseFromWindow("Save layout as the default for new projects")
    assert.ok(store.data.has(prefStorageKey(UserLayoutPref)))
    fireEvent.click(screen.getByRole("button", { name: "Window" }))
    fireEvent.click(menuItem("Forget the saved default layout"))
    assert.equal(store.data.has(prefStorageKey(UserLayoutPref)), false)
  })
})

describe("saved layouts", () => {
  test("a layout stored for the project is shown when the editor opens", () => {
    const store = new MemoryStore()
    const registry = fixtureRegistry()
    let layout = defaultLayout(registry)
    layout = { ...layout, closed: ["engine"], regions: { ...layout.regions, right: { size: 410, groups: [{ id: "s7", tabs: ["inspector", "assets"], active: "assets" }, { id: "s8", tabs: ["hierarchy"], active: "hierarchy" }] }, left: { size: 200, groups: [] } } }
    store.data.set(projectLayoutKey(Project), JSON.stringify(serializeLayout(layout)))
    renderLayout({ store })
    assert.equal(region("left"), null)
    assert.equal(region("right")!.style.width, "410px")
    const stacks = Array.from(region("right")!.querySelectorAll<HTMLElement>(".panel-group"))
    assert.deepEqual(stacks.map((s) => tabNames(s)), [["Inspector", "Assets"], []])
    assert.equal(within(stacks[0]).getByRole("tabpanel").textContent, "assets headerassets content")
  })

  test("a stored layout naming an unknown panel is shown without it, and the viewport is there", () => {
    const store = new MemoryStore()
    store.data.set(
      projectLayoutKey(Project),
      JSON.stringify({
        version: 1,
        closed: [],
        regions: {
          left: { size: 300, groups: [{ tabs: ["ghost", "assets"], active: "ghost" }] },
          center: { groups: [] },
          bottom: { size: 220, groups: [{ tabs: ["console"], active: "console" }] },
          right: { size: 300, groups: [] },
        },
      })
    )
    renderLayout({ store })
    assert.ok(region("left")!.querySelector(".assets-panel"))
    assert.ok(document.querySelector(".center-region .viewport-container"))
    assert.equal(region("right")!.querySelectorAll(".panel-header").length, 3)
  })

  test("corrupt or unreadable storage gives the default arrangement", () => {
    const store = new MemoryStore()
    store.data.set(projectLayoutKey(Project), "{not json")
    store.data.set(UserLayoutKey, '{"version":99}')
    renderLayout({ store })
    assert.ok(region("left")!.querySelector(".assets-panel"))
    assert.equal(region("right")!.querySelectorAll(".panel-header").length, 3)
  })

  test("with storage unavailable the editor still works and arranges for the session", () => {
    const store = new MemoryStore()
    store.broken = true
    const { controller } = renderLayout({ store })
    chooseFromWindow("Inspector")
    act(() => controller.move("assets", { region: "bottom" }))
    act(() => controller.setSize("left", 400))
    controller.flush()
    chooseFromWindow("Save layout as the default for new projects")
    chooseFromWindow("Reset layout")
    // Nothing reaches the storage, but the preferences keep the saved default for the session: Reset shows it
    assert.ok(region("bottom")!.querySelector(".assets-panel"))
    assert.equal(store.data.size, 0)
  })

  test("a splitter size shows in the region and is saved", () => {
    const { store, controller } = renderLayout()
    act(() => {
      controller.setSize("left", 420)
      controller.setSize("bottom", 150)
    })
    assert.equal(region("left")!.style.width, "420px")
    assert.equal(region("bottom")!.style.height, "150px")
    controller.flush()
    const saved = JSON.parse(store.data.get(prefStorageKey(ProjectLayoutPref, Project))!).value
    assert.equal(saved.regions.left.size, 420)
    assert.equal(saved.regions.bottom.size, 150)
  })
})

describe("the viewport's frame requests", () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  test("stop while it is hidden behind another tab, and start again when it is shown", async () => {
    const { controller } = renderLayout()
    await waitFor(() => assert.equal(viewports.length, 1))
    await waitFor(() => assert.ok(framesAsked() > 0), { timeout: 500 })
    act(() => controller.move("assets", { region: "center" })) // the new tab is shown
    assert.equal(document.querySelector(".viewport-container"), null, "not mounted while hidden")
    assert.equal(viewports[0].running, false, "its loop was stopped, not left running behind the other tab")
    const atHide = framesAsked()
    await pause(40)
    assert.equal(framesAsked(), atHide, "no frame request while hidden")
    act(() => controller.activate("viewport"))
    assert.ok(document.querySelector(".viewport-container"))
    await waitFor(() => assert.equal(viewports.length, 2))
    await waitFor(() => assert.ok(framesAsked() > atHide), { timeout: 500 })
    assert.equal(viewports[1].running, true)
  })

  test("a panel that is not marked to unmount keeps running behind another tab, hidden", async () => {
    const { controller } = renderLayout()
    act(() => controller.move("assets", { region: "right", group: 0 }))
    await waitFor(() => assert.ok(events.includes("mount hierarchy")))
    await pause(20)
    const before = events.length
    act(() => controller.activate("assets"))
    await pause(20)
    assert.deepEqual(events.slice(before), [])
  })

  test("stop when the layout goes away", async () => {
    const { view } = renderLayout()
    await waitFor(() => assert.ok(framesAsked() > 0), { timeout: 500 })
    act(() => {
      view.unmount()
    })
    assert.equal(viewports[0].running, false)
    const atUnmount = framesAsked()
    await pause(40)
    assert.equal(framesAsked(), atUnmount)
  })
})

describe("text files at the bottom", () => {
  const file = (name: string, closes: string[]): DynamicTab => ({
    id: `text:res://${name}`,
    label: name,
    title: `res://${name}`,
    dirty: name === "b.lua",
    render: () => <textarea aria-label={name} />,
    close: () => void closes.push(name),
    activate: () => void closes.push(`activate ${name}`),
  })

  test("are tabs after the console, with a dirty mark and a close button; one is shown at a time", () => {
    const calls: string[] = []
    const { controller } = renderLayout({ dynamic: [file("a.lua", calls), file("b.lua", calls)] })
    act(() => controller.setDynamicTabs(["text:res://a.lua", "text:res://b.lua"]))
    assert.deepEqual(tabNames(region("bottom")!), ["Console", "a.lua", "b.lua \u2022"])
    // The last opened is shown, and only its editor is mounted
    assert.ok(screen.getByLabelText("b.lua"))
    assert.equal(screen.queryByLabelText("a.lua"), null)
    assert.equal(document.querySelector(".console-panel, .console-panel"), null)
    const tabs = within(region("bottom")!).getAllByRole("tab")
    fireEvent.click(tabs[1])
    assert.ok(screen.getByLabelText("a.lua"))
    assert.deepEqual(calls, ["activate a.lua"], "the page is told which file is shown")
    fireEvent.click(within(tabs[2]).getByRole("button", { name: "Close b.lua" }))
    assert.deepEqual(calls, ["activate a.lua", "b.lua"], "closing goes through the page, which may ask first")
  })

  test("a text file's tab has no way to be dragged to another region", () => {
    const { controller } = renderLayout({ dynamic: [file("a.lua", [])] })
    act(() => controller.setDynamicTabs(["text:res://a.lua"]))
    const tab = within(region("bottom")!).getAllByRole("tab")[1]
    assert.equal(tab.getAttribute("draggable"), "false")
    fireEvent.contextMenu(tab)
    assert.deepEqual(menuLabels(), ["Close"])
  })

  test("are not in the saved layout", () => {
    const { controller, store } = renderLayout({ dynamic: [file("a.lua", [])] })
    act(() => controller.setDynamicTabs(["text:res://a.lua"]))
    act(() => controller.move("assets", { region: "right" }))
    controller.flush()
    assert.equal((store.data.get(prefStorageKey(ProjectLayoutPref, Project)) ?? "").includes("a.lua"), false)
  })
})

describe("the editor's registered panels", () => {
  test("are the six the editor always had, in their old places and stacks", () => {
    const registry = builtinPanels()
    assert.deepEqual(
      registry.list().map((d) => [d.id, d.defaultRegion, d.defaultGroup ?? 0]),
      [
        ["assets", "left", 0],
        ["viewport", "center", 0],
        ["console", "bottom", 0],
        ["hierarchy", "right", 0],
        ["inspector", "right", 1],
        ["engine", "right", 2],
      ]
    )
    assert.deepEqual(shape(defaultLayout(registry)), {
      left: [["assets"]],
      center: [["viewport"]],
      bottom: [["console"]],
      right: [["hierarchy"], ["inspector"], ["engine"]],
    })
  })

  test("the viewport cannot be closed and is unmounted while hidden; the right stacks keep their old shares", () => {
    const registry = builtinPanels()
    assert.equal(registry.get("viewport")!.closable, false)
    assert.equal(registry.get("viewport")!.unmountWhenHidden, true)
    for (const id of ["assets", "console", "hierarchy", "inspector", "engine"]) assert.equal(registry.get(id)!.closable, true, id)
    assert.deepEqual(registry.get("hierarchy")!.sizing, { flex: "0 0 30%" })
    assert.equal(registry.get("inspector")!.sizing, undefined, "flex 1: the rest")
    assert.deepEqual(registry.get("engine")!.sizing, { flex: "0 0 auto", maxHeight: "30%" })
    assert.equal(registry.get("console")!.tabBar, "always")
  })
})
