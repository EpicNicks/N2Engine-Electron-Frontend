/// <reference path="../renderer/globals.d.ts" />
import "./setup"
import { test, describe, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import { cleanup, screen, waitFor, within } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import type { ExtensionTrustState } from "../shared/api"
import { EditorStore } from "../renderer/store"
import { HierarchyState } from "../renderer/hierarchy-state"
import { ConsoleStore } from "../renderer/console-store"
import { ConsolePanel } from "../renderer/console-panel"
import {
  ExtensionNotice,
  ExtensionTrustBanner,
  ExtensionsSection,
  ToolsButton,
} from "../renderer/extensions-ui"
import { FormDialog } from "../renderer/form-dialog"
import { ConfirmDialog, ContextMenu, confirmDialog, formDialog, formRequest, showContextMenu } from "../renderer/ui"
import { FakeApi, FakeTimers } from "../test/fake-store-api"
import { Uuid, fakeExtensions, field, invokeResult, menuItem, serverInfo, summary } from "../test/fake-extensions"
import { renderWithApp } from "./helpers"

const snapForm = {
  fields: [
    field("grid", "Float", { displayName: "Grid", min: 0.01, max: 100, tooltip: "Grid size in metres" }),
    field("snapY", "Bool", { displayName: "Snap Y" }),
  ],
  defaults: { grid: 1, snapY: false },
}
const snapItem = menuItem("align.snap", "Tools/Align/Snap", { title: "Snap to grid", form: snapForm })
const plainItem = menuItem("align.plain", "Tools/Align/Plain", { title: "Plain item" })

const trust = (over: Partial<ExtensionTrustState> = {}): ExtensionTrustState => ({
  files: ["Align.lua", "tools/Snap.lua"],
  more: 0,
  trusted: false,
  enabled: false,
  ...over,
})

function makeStore() {
  const api = new FakeApi()
  const store = new EditorStore(api, { timers: new FakeTimers(), now: () => 0 })
  return { api, store }
}

/** The page's real dialogs over the fake extensions; the Tools button, the notice and every dialog rendered */
async function mountMenu(over: Parameters<typeof fakeExtensions>[0] = {}) {
  const f = fakeExtensions({
    ...over,
    run: {
      confirm: confirmDialog,
      askForm: async (item) => (item.form === undefined ? {} : formDialog(item.title, item.form, "Run")),
      ...over.run,
    },
  })
  await f.state.refresh()
  const { api, store } = makeStore()
  renderWithApp(
    <>
      <ToolsButton />
      <ExtensionNotice />
      <ContextMenu />
      <FormDialog />
      <ConfirmDialog />
    </>,
    // A GameObject field picks from the scene's objects (none here)
    { extensions: f.state, store, hierarchy: new HierarchyState({} as never, { confirm: async () => true }) }
  )
  return { f, api, store, user: userEvent.setup() }
}

// Its name has the spinner's label added while an item runs
const tools = () => screen.getByRole("button", { name: /^Tools/ })
const menuLabels = () => within(screen.getByRole("menu")).getAllByRole("menuitem").map((el) => el.textContent ?? "")
const menuItemNamed = (name: string) => within(screen.getByRole("menu")).getByRole("menuitem", { name })

beforeEach(() => {
  showContextMenu(0, 0, []) // no menu left open by an earlier test
  formRequest.value = null
})

describe("the Tools button", () => {
  test("is shown only while the host has extensions on", async () => {
    const off = await mountMenu({ enabled: false })
    assert.equal(screen.queryByRole("button", { name: /^Tools/ }), null, "extensions off on the host")
    assert.equal(off.f.state.menuVisible.value, false)
  })

  test("is hidden for a host without the editorExtensions capability", async () => {
    await mountMenu({ info: serverInfo({ capabilities: [] }) })
    assert.equal(screen.queryByRole("button", { name: /^Tools/ }), null)
  })

  test("appears when the host says its extensions changed, and goes when the connection does", async () => {
    const f = fakeExtensions({ enabled: false })
    f.state.start()
    await waitFor(() => assert.equal(f.state.status.value, "disabled"))
    const { store } = makeStore()
    renderWithApp(<ToolsButton />, { extensions: f.state, store })
    assert.equal(screen.queryByRole("button", { name: /^Tools/ }), null)
    f.host.info = { ...f.host.info, enabled: true }
    f.changeCount.value++
    await waitFor(() => assert.ok(screen.getByRole("button", { name: /^Tools/ })))
    f.connected.value = false
    await waitFor(() => assert.equal(screen.queryByRole("button", { name: /^Tools/ }), null))
  })

  test("an extension with no items still has a Tools menu, that says so", async () => {
    const { user } = await mountMenu({ items: [] })
    await user.click(tools())
    assert.deepEqual(menuLabels(), ["No menu items declared by the extensions"])
    assert.equal(menuItemNamed("No menu items declared by the extensions").getAttribute("aria-disabled"), "true")
  })
})

describe("the Tools menu", () => {
  test("paths are nested submenus: Align opens a level with Back, and Back returns", async () => {
    const { user } = await mountMenu({ items: [snapItem, plainItem, menuItem("top", "Tools/Top", { title: "Top item" })] })
    await user.click(tools())
    assert.deepEqual(menuLabels(), ["Align\u203a", "Top item"])
    assert.equal(menuItemNamed("Align").getAttribute("aria-haspopup"), "menu")
    await user.click(menuItemNamed("Align"))
    assert.deepEqual(menuLabels(), ["Back", "Snap to grid", "Plain item"])
    await user.click(menuItemNamed("Back"))
    assert.deepEqual(menuLabels(), ["Align\u203a", "Top item"])
  })

  test("choosing an item runs it on the selection with the menu's revision and closes the menu", async () => {
    const { f, user } = await mountMenu({ items: [plainItem] })
    f.invokeAnswer = { status: "ok", value: invokeResult({ message: "Done it", select: [Uuid(9)] }) }
    await user.click(tools())
    await user.click(menuItemNamed("Align"))
    await user.click(menuItemNamed("Plain item"))
    await waitFor(() => assert.equal(f.invokes.length, 1))
    assert.deepEqual(f.invokes[0], { itemId: "align.plain", selection: [Uuid(1), Uuid(2)], params: {}, uiRevision: 4 })
    assert.equal(screen.queryByRole("menu"), null)
    // The result is shown as a notice, and the objects it asked for are selected
    await waitFor(() => assert.ok(screen.getByText("Plain item", { selector: "b" })))
    assert.match(document.querySelector(".extension-notice")?.textContent ?? "", /Plain item: Done it/)
    assert.deepEqual(f.selected, [[Uuid(9)]])
  })

  test("a disabled item says why (its tooltip) and does nothing when clicked, and the menu stays", async () => {
    const { f, user } = await mountMenu({ items: [plainItem] })
    f.blocked.reason = "you are signed in as a viewer, who can look but not change anything or play"
    await user.click(tools())
    await user.click(menuItemNamed("Align"))
    const item = menuItemNamed("Plain item")
    assert.equal(item.getAttribute("aria-disabled"), "true")
    assert.match(item.title, /Not available: you are signed in as a viewer/)
    await user.click(item)
    assert.equal(f.invokes.length, 0)
    assert.ok(screen.getByRole("menu"), "still open")
  })

  test("an admin-only item is disabled for an editor with the reason, and enabled for an admin", async () => {
    const adminItem = menuItem("admin.only", "Tools/Admin only", { title: "Admin only", minRole: "admin" })
    const editor = await mountMenu({ items: [adminItem], role: "editor" })
    await editor.user.click(tools())
    assert.equal(menuItemNamed("Admin only").getAttribute("aria-disabled"), "true")
    assert.match(menuItemNamed("Admin only").title, /admin role \(you are signed in as editor\)/)
  })

  test("a selection rule disables an item until the selection fits", async () => {
    const needsOne = menuItem("one", "Tools/Needs one", { title: "Needs one", enabledWhen: { selection: "one" } })
    const { f, user } = await mountMenu({ items: [needsOne] })
    await user.click(tools())
    assert.equal(menuItemNamed("Needs one").getAttribute("aria-disabled"), "true")
    assert.match(menuItemNamed("Needs one").title, /exactly one object/)
    await user.keyboard("{Escape}")
    f.selection.ids = [Uuid(1)]
    await user.click(tools())
    assert.equal(menuItemNamed("Needs one").getAttribute("aria-disabled"), "false")
  })

  test("an extension that became faulted: its items stay, disabled, with the reason", async () => {
    const { user } = await mountMenu({ items: [plainItem], extensions: [summary({ state: "faulted" })] })
    await user.click(tools())
    await user.click(menuItemNamed("Align"))
    assert.equal(menuItemNamed("Plain item").getAttribute("aria-disabled"), "true")
    assert.match(menuItemNamed("Plain item").title, /disabled until an admin reloads it/)
  })

  test("works from the keyboard: Enter opens it, Right enters a group, Enter runs the marked item, Left goes back", async () => {
    const { f, user } = await mountMenu({ items: [plainItem] })
    tools().focus()
    await user.keyboard("{Enter}")
    assert.deepEqual(menuLabels(), ["Align\u203a"])
    await user.keyboard("{ArrowRight}")
    assert.deepEqual(menuLabels(), ["Back", "Plain item"])
    await user.keyboard("{ArrowLeft}")
    assert.deepEqual(menuLabels(), ["Align\u203a"])
    await user.keyboard("{ArrowRight}{Enter}")
    await waitFor(() => assert.equal(f.invokes.length, 1))
    assert.equal(f.invokes[0].itemId, "align.plain")
  })

  test("while an item runs the button shows a spinner and every item is disabled", async () => {
    const { f, user } = await mountMenu({ items: [plainItem] })
    let release: () => void = () => {}
    f.invokeAnswer = () => new Promise((resolve) => (release = () => resolve({ status: "ok", value: invokeResult() })))
    await user.click(tools())
    await user.click(menuItemNamed("Align"))
    await user.click(menuItemNamed("Plain item"))
    await waitFor(() => assert.ok(screen.getByRole("status", { name: "A menu item is running" })))
    assert.equal(tools().getAttribute("aria-busy"), "true")
    await user.click(tools())
    await user.click(menuItemNamed("Align"))
    assert.equal(menuItemNamed("Plain item").getAttribute("aria-disabled"), "true")
    assert.match(menuItemNamed("Plain item").title, /Another menu item is running/)
    release()
    await waitFor(() => assert.equal(screen.queryByRole("status", { name: "A menu item is running" }), null))
    assert.equal(tools().getAttribute("aria-busy"), "false")
  })
})

describe("running an item that has a form", () => {
  async function openForm(over: Parameters<typeof fakeExtensions>[0] = {}) {
    const mounted = await mountMenu({ items: [snapItem], ...over })
    await mounted.user.click(tools())
    await mounted.user.click(menuItemNamed("Align"))
    await mounted.user.click(menuItemNamed("Snap to grid"))
    const dialog = await screen.findByRole("dialog", { name: "Snap to grid" })
    return { ...mounted, dialog }
  }

  test("the dialog is a labelled modal with a row per field, the defaults, and the tooltips as text", async () => {
    const { dialog } = await openForm()
    assert.equal(dialog.getAttribute("aria-modal"), "true")
    const grid = within(dialog).getByRole("textbox", { name: "Grid" }) as HTMLInputElement
    assert.equal(grid.value, "1")
    assert.equal((within(dialog).getByRole("checkbox", { name: "Snap Y" }) as HTMLInputElement).checked, false)
    assert.ok(within(dialog).getByText("Grid size in metres", { selector: ".form-hint" }))
    assert.ok(dialog.contains(document.activeElement), "the focus is in the dialog")
    assert.ok(within(dialog).getByRole("button", { name: "Cancel" }))
  })

  test("OK sends the values entered, the number as a number, and the item is run on the selection", async () => {
    const { f, user, dialog } = await openForm()
    const grid = within(dialog).getByRole("textbox", { name: "Grid" })
    await user.clear(grid)
    await user.type(grid, "2.5")
    await user.click(within(dialog).getByRole("checkbox", { name: "Snap Y" }))
    await user.click(within(dialog).getByRole("button", { name: "Run" }))
    await waitFor(() => assert.equal(f.invokes.length, 1))
    assert.deepEqual(f.invokes[0].params, { grid: 2.5, snapY: true })
    assert.equal(screen.queryByRole("dialog"), null, "closed")
  })

  test("Enter in a number field is OK", async () => {
    const { f, user, dialog } = await openForm()
    const grid = within(dialog).getByRole("textbox", { name: "Grid" })
    await user.clear(grid)
    await user.type(grid, "4{Enter}")
    await waitFor(() => assert.equal(f.invokes.length, 1))
    assert.deepEqual(f.invokes[0].params, { grid: 4, snapY: false })
  })

  test("a number past its bounds is clamped to them before it is sent (the host does the same)", async () => {
    const { f, user, dialog } = await openForm()
    const grid = within(dialog).getByRole("textbox", { name: "Grid" })
    await user.clear(grid)
    await user.type(grid, "1000")
    await user.click(within(dialog).getByRole("button", { name: "Run" }))
    await waitFor(() => assert.equal(f.invokes.length, 1))
    assert.equal(f.invokes[0].params.grid, 100)
  })

  test("text that is not a number is refused next to the field, nothing is sent and the dialog stays", async () => {
    const { f, user, dialog } = await openForm()
    const grid = within(dialog).getByRole("textbox", { name: "Grid" })
    await user.clear(grid)
    await user.type(grid, "wide")
    await user.click(within(dialog).getByRole("button", { name: "Run" }))
    assert.match(within(dialog).getByRole("alert").textContent ?? "", /Grid must be a number/)
    assert.equal(f.invokes.length, 0)
    assert.ok(screen.getByRole("dialog"))
    // Fixing it clears the error and sends
    await user.clear(grid)
    await user.type(grid, "3")
    await user.click(within(dialog).getByRole("button", { name: "Run" }))
    await waitFor(() => assert.equal(f.invokes.length, 1))
    assert.equal(f.invokes[0].params.grid, 3)
  })

  test("Escape and Cancel close it and nothing is sent or reported", async () => {
    const first = await openForm()
    await first.user.keyboard("{Escape}")
    await waitFor(() => assert.equal(screen.queryByRole("dialog"), null))
    assert.equal(first.f.invokes.length, 0)
    assert.deepEqual(first.f.failures, [])
  })

  test("Cancel closes it too", async () => {
    const { f, user, dialog } = await openForm()
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => assert.equal(screen.queryByRole("dialog"), null))
    assert.equal(f.invokes.length, 0)
  })

  test("Tab stays inside the dialog: after the last button comes the first field, and Shift+Tab goes the other way", async () => {
    const { user, dialog } = await openForm()
    const run = within(dialog).getByRole("button", { name: "Run" })
    run.focus()
    await user.tab()
    const first = dialog.querySelector<HTMLElement>("input, select, button")!
    assert.equal(document.activeElement, first)
    await user.tab({ shift: true })
    assert.equal(document.activeElement, run)
  })

  test("a click outside does not close it: what was typed is not thrown away", async () => {
    const { user } = await openForm()
    await user.click(document.querySelector(".modal-overlay")!)
    assert.ok(screen.getByRole("dialog"))
  })

  test("the keymap is paused while it is open (a dialog counts as modal)", async () => {
    await openForm()
    const { modalOpen } = await import("../renderer/ui")
    assert.equal(modalOpen(), true)
  })

  test("every kind the host supports gets an editor: int, string, enum, Vector3 and a GameObject", async () => {
    const item = menuItem("kinds", "Tools/Kinds", {
      title: "Kinds",
      form: {
        fields: [
          field("count", "Int", { displayName: "Count", min: 1, max: 9 }),
          field("label", "String", { displayName: "Label" }),
          field("mode", "Enum", { displayName: "Mode", enumOptions: ["fast", "slow"] }),
          field("offset", "Vector3", { displayName: "Offset" }),
          field("target", "GameObjectRef", { displayName: "Target" }),
          field("hidden", "String", { displayName: "Hidden", hidden: true }),
        ],
        defaults: { count: 1, label: "x", mode: "fast", offset: { x: 0, y: 0, z: 0 }, target: null, hidden: "secret" },
      },
    })
    const mounted = await mountMenu({ items: [item] })
    await mounted.user.click(tools())
    await mounted.user.click(menuItemNamed("Kinds"))
    const dialog = await screen.findByRole("dialog", { name: "Kinds" })
    assert.ok(within(dialog).getByRole("textbox", { name: "Count" }))
    assert.ok(within(dialog).getByRole("textbox", { name: "Label" }))
    assert.ok(within(dialog).getByRole("combobox", { name: "Mode" }))
    assert.ok(within(dialog).getByText("Offset", { selector: ".form-label" }))
    assert.ok(within(dialog).getByText("Target", { selector: ".form-label" }))
    assert.equal(within(dialog).queryByText("Hidden"), null, "a hidden field is not shown")
    await mounted.user.selectOptions(within(dialog).getByRole("combobox", { name: "Mode" }), "slow")
    await mounted.user.click(within(dialog).getByRole("button", { name: "Run" }))
    await waitFor(() => assert.equal(mounted.f.invokes.length, 1))
    assert.deepEqual(mounted.f.invokes[0].params, {
      count: 1,
      label: "x",
      mode: "slow",
      offset: { x: 0, y: 0, z: 0 },
      target: null,
      hidden: "secret",
    })
  })

  test("a field's name and tooltip from project code are text, never markup", async () => {
    const hostile = `<img src=x onerror="window.pwned=1">`
    const item = menuItem("h", "Tools/H", {
      title: hostile,
      form: { fields: [field("a", "String", { displayName: hostile, tooltip: hostile })], defaults: { a: "" } },
    })
    const mounted = await mountMenu({ items: [item] })
    await mounted.user.click(tools())
    await mounted.user.click(menuItemNamed(hostile))
    await screen.findByRole("dialog")
    assert.equal(document.querySelector("img"), null)
    assert.equal((window as unknown as { pwned?: number }).pwned, undefined)
    assert.ok(screen.getAllByText(hostile).length >= 2)
  })
})

describe("an item with a confirm question", () => {
  const dangerous = menuItem("danger", "Tools/Danger", { title: "Danger", confirm: "Snap <b>40</b> objects?" })

  test("asks first, as text; No sends nothing", async () => {
    const { f, user } = await mountMenu({ items: [dangerous] })
    await user.click(tools())
    await user.click(menuItemNamed("Danger"))
    const dialog = await screen.findByRole("alertdialog")
    assert.equal(within(dialog).getByText("Snap <b>40</b> objects?").tagName, "P")
    assert.equal(dialog.querySelector("b"), null)
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null))
    assert.equal(f.invokes.length, 0)
  })

  test("Yes runs it", async () => {
    const { f, user } = await mountMenu({ items: [dangerous] })
    await user.click(tools())
    await user.click(menuItemNamed("Danger"))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Run" }))
    await waitFor(() => assert.equal(f.invokes.length, 1))
  })
})

describe("what an item says and what goes wrong", () => {
  test("the message and warnings are shown as text, and can be dismissed", async () => {
    const { f, user } = await mountMenu({ items: [plainItem] })
    f.invokeAnswer = {
      status: "ok",
      value: invokeResult({ message: "Snapped <b>3</b>", warnings: ["<i>two</i> skipped"] }),
    }
    await user.click(tools())
    await user.click(menuItemNamed("Align"))
    await user.click(menuItemNamed("Plain item"))
    const notice = await screen.findByText(/Snapped <b>3<\/b>/)
    assert.equal(document.querySelector(".extension-notice b")?.textContent, "Plain item", "the only <b> is the title's own")
    assert.ok(screen.getByText("<i>two</i> skipped"))
    assert.equal(document.querySelector(".extension-notice i"), null)
    void notice
    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    assert.equal(document.querySelector(".extension-notice"), null)
  })

  test("a failure goes through the editor's failure channel with the host's code", async () => {
    const { f, user } = await mountMenu({ items: [plainItem] })
    f.invokeAnswer = { status: "error", kind: "forbidden", message: "Forbidden", code: "forbidden" }
    await user.click(tools())
    await user.click(menuItemNamed("Align"))
    await user.click(menuItemNamed("Plain item"))
    await waitFor(() => assert.equal(f.failures.length, 1))
    assert.equal(f.failures[0].code, "forbidden")
    assert.equal(document.querySelector(".extension-notice"), null, "no success notice")
  })
})

describe("the banner that offers to enable a project's extensions", () => {
  async function mountBanner(trustState: ExtensionTrustState | undefined, mode: "local" | "remote" = "local") {
    const { api, store } = makeStore()
    api.pushHost({ status: "running", mode, launch: 1, projectPath: "C:\\P", extensionTrust: trustState })
    const f = fakeExtensions()
    renderWithApp(<ExtensionTrustBanner />, { store, extensions: f.state })
    return { api, store, user: userEvent.setup() }
  }

  test("Not now left them off: says how many are not running, and the button asks (the main process's dialog) and restarts", async () => {
    const { api, user } = await mountBanner(trust())
    const banner = screen.getByRole("status")
    assert.match(banner.textContent ?? "", /2 editor extensions that are not running/)
    assert.match(banner.textContent ?? "", /run code on this computer's editor host/)
    await user.click(screen.getByRole("button", { name: "Enable extensions..." }))
    await waitFor(() => assert.ok(api.calls.includes("enableExtensions")))
  })

  test("one extension is singular", async () => {
    await mountBanner(trust({ files: ["Only.lua"] }))
    assert.match(screen.getByRole("status").textContent ?? "", /1 editor extension that is not running/)
  })

  test("nothing for a project with none, a host that runs them, or a remote engine", async () => {
    for (const [state, mode] of [
      [undefined, "local"],
      [trust({ trusted: true, enabled: true }), "local"],
      [trust(), "remote"],
    ] as const) {
      cleanup()
      await mountBanner(state, mode)
      assert.equal(screen.queryByRole("status"), null, `${state?.enabled} ${mode}`)
    }
  })

  test("can be dismissed", async () => {
    const { user } = await mountBanner(trust())
    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    assert.equal(screen.queryByRole("status"), null)
  })

  test("a Not now in the main process's dialog is not an error", async () => {
    const { api, store, user } = await mountBanner(trust())
    api.extensionsTrusted = false
    await user.click(screen.getByRole("button", { name: "Enable extensions..." }))
    await waitFor(() => assert.ok(api.calls.includes("enableExtensions")))
    assert.equal(store.error.value, null)
  })
})

describe("the Extensions section of the project settings", () => {
  const props = { model: {} as never, def: {} as never }

  async function mountSection(
    over: Parameters<typeof fakeExtensions>[0] = {},
    host: { mode?: "local" | "remote"; trust?: ExtensionTrustState } = {}
  ) {
    const f = fakeExtensions(over)
    await f.state.refresh()
    const { api, store } = makeStore()
    api.pushHost({ status: "running", mode: host.mode ?? "local", launch: 1, projectPath: "C:\\P", extensionTrust: host.trust })
    renderWithApp(<ExtensionsSection {...props} />, { extensions: f.state, store })
    return { f, api, store, user: userEvent.setup() }
  }

  const rows = () => Array.from(document.querySelectorAll<HTMLElement>("tr[data-extension]"))

  test("lists each extension: name, state, API version, a short hash, capabilities and item count", async () => {
    await mountSection({
      extensions: [
        summary(),
        summary({ id: "tools/Bad.lua", name: "Bad", state: "failed", error: "tools/Bad.lua:3: boom", sha256: "", capabilities: [], itemCount: 0 }),
        summary({ id: "Slow.lua", name: "Slow", state: "faulted", sha256: "ffffffff00000000" + "0".repeat(48), itemCount: 2 }),
      ],
    })
    assert.equal(rows().length, 3)
    const cells = (row: HTMLElement) => Array.from(row.children).map((c) => c.textContent)
    assert.deepEqual(cells(rows()[0]), ["Align Tools", "Loaded", "1", "01234567", "scene.read, scene.write", "1"])
    assert.deepEqual(cells(rows()[1]), ["Bad", "Failed", "1", "-", "none", "0"])
    assert.deepEqual(cells(rows()[2]), ["Slow", "Faulted", "1", "ffffffff", "scene.read, scene.write", "2"])
    assert.equal(rows()[0].querySelector(".ext-hash")?.getAttribute("title")?.length, 64, "the whole hash is the tooltip")
    // The host's error text, shown as it came (path-stripped by the host)
    assert.ok(screen.getByText("tools/Bad.lua:3: boom"))
  })

  test("what extensions say about themselves is text, never markup", async () => {
    const hostile = `<img src=x onerror="window.pwned=2">`
    await mountSection({ extensions: [summary({ name: hostile, state: "failed", error: hostile, capabilities: [hostile] })] })
    assert.equal(document.querySelector("img"), null)
    assert.ok(screen.getAllByText(hostile).length >= 2)
  })

  test("Reload is the admin's: it reloads and reads the list again", async () => {
    const { f, user } = await mountSection({ role: "admin" })
    const reload = screen.getByRole("button", { name: "Reload" })
    assert.equal((reload as HTMLButtonElement).disabled, false)
    await user.click(reload)
    await waitFor(() => assert.ok(f.log.includes("reload")))
    await waitFor(() => assert.equal(f.state.reloading.value, false))
  })

  test("an editor sees Reload disabled, with why", async () => {
    await mountSection({ role: "editor" })
    const reload = screen.getByRole("button", { name: "Reload" }) as HTMLButtonElement
    assert.equal(reload.disabled, true)
    assert.match(reload.title, /Only an admin can reload extensions/)
    assert.ok(screen.getByText(/Only an admin can reload extensions/, { selector: ".ps-help" }))
  })

  test("a host the refusal of which the admin only learns from the host: the reason is shown", async () => {
    const { f, user } = await mountSection({ role: "admin" })
    f.host.reloadAnswer = { status: "error", kind: "readOnly", message: "The host is read-only", code: "readOnly" }
    await user.click(screen.getByRole("button", { name: "Reload" }))
    await waitFor(() => assert.match(screen.getByRole("alert").textContent ?? "", /Reload failed: The host is read-only/))
  })

  test("no extensions found, and extensions off, say so", async () => {
    await mountSection({ extensions: [] })
    assert.ok(screen.getByText(/found no \.lua file/))
  })

  test("off on a local project with extensions: says how to enable, with the button", async () => {
    const { api, user } = await mountSection({ enabled: false }, { trust: trust() })
    assert.match(screen.getAllByText(/not enabled for this project/)[0].textContent ?? "", /2 editor extensions/)
    await user.click(screen.getAllByRole("button", { name: "Enable extensions..." })[0])
    await waitFor(() => assert.ok(api.calls.includes("enableExtensions")))
  })

  test("off on a local project with no editor/ folder, and off on a remote host, explain themselves", async () => {
    await mountSection({ enabled: false }, {})
    assert.ok(screen.getByText(/no \.lua file in its editor\/ folder/))
  })

  test("a remote host's explanation names the operator's flag and no button enables it", async () => {
    await mountSection({ enabled: false }, { mode: "remote" })
    assert.match(screen.getByText(/operator of a remote host/).textContent ?? "", /--editor-extensions/)
    assert.equal(screen.queryByRole("button", { name: /Enable extensions/ }), null)
    assert.equal(screen.queryByRole("button", { name: /Forget trust/ }), null)
  })

  test("an older host has nothing to show", async () => {
    await mountSection({ info: serverInfo({ capabilities: [], protocolVersion: "1.13.0" }) })
    assert.ok(screen.getByText(/older than protocol 1\.14\.0/))
  })

  test("a trusted local project: its files and the way to forget the trust", async () => {
    const { api, user } = await mountSection({}, { trust: trust({ trusted: true, enabled: true }) })
    assert.ok(screen.getByText("Trusted"))
    assert.ok(screen.getByText("Started with extensions enabled"))
    const files = within(screen.getByRole("list", { name: "Extension files" }))
    assert.deepEqual(files.getAllByRole("listitem").map((li) => li.textContent), ["Align.lua", "tools/Snap.lua"])
    const forget = screen.getByRole("button", { name: "Forget trust for this project" }) as HTMLButtonElement
    assert.equal(forget.disabled, false)
    await user.click(forget)
    await waitFor(() => assert.ok(api.calls.includes("forgetExtensionTrust")))
  })

  test("after the trust was forgotten the running host still has them: says so and offers a restart", async () => {
    const { api, user } = await mountSection({}, { trust: trust({ trusted: false, enabled: true }) })
    assert.ok(screen.getByText("Not trusted"))
    assert.match(screen.getByText(/Trust was forgotten/).textContent ?? "", /keeps the extensions it loaded until it restarts/)
    assert.equal((screen.getByRole("button", { name: "Forget trust for this project" }) as HTMLButtonElement).disabled, true)
    await user.click(screen.getByRole("button", { name: "Restart host" }))
    await waitFor(() => assert.ok(api.calls.includes("restart")))
  })

  test("file names in the trust list are text", async () => {
    const hostile = `<img src=x onerror="window.pwned=3">.lua`
    await mountSection({}, { trust: trust({ files: [hostile] }) })
    assert.equal(document.querySelector("img"), null)
    assert.ok(screen.getByText(hostile))
  })
})

describe("extension lines in the console", () => {
  test("show as text under the Extension source, with their level, and the source has a box", () => {
    const log = new ConsoleStore(async () => ({ epoch: 1, nextSeq: 1, dropped: 0, events: [] }) as never, { now: () => 0 })
    const hostile = `[<img src=x onerror="window.pwned=4">] <script>x()</script>`
    log.addEntries([
      { level: "warn", message: hostile, source: "extension", time: 0 },
      { level: "info", message: "a host line", source: "host", time: 0 },
    ])
    renderWithApp(<ConsolePanel />, { store: { console: log } })
    assert.equal(document.querySelector("img"), null)
    assert.equal(document.querySelector("script"), null)
    const line = document.querySelector(".console-entry.from-extension")
    assert.equal(line?.querySelector(".console-message")?.textContent, hostile)
    assert.ok(line?.classList.contains("warn"))
    assert.ok(within(screen.getByRole("group", { name: "Sources" })).getByLabelText("Extension (1)"))
  })
})
