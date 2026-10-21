import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { runBlockedReason } from "../renderer/extensions-state"
import { fakeExtensions, menuItem, serverInfo, summary } from "./fake-extensions"

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe("ExtensionsState status and the Tools menu's visibility", () => {
  test("a host with extensions on is ready: the menu shows, with the items the host listed", async () => {
    const f = fakeExtensions()
    assert.equal(f.state.status.value, "loading")
    await f.state.refresh()
    assert.equal(f.state.status.value, "ready")
    assert.equal(f.state.menuVisible.value, true)
    assert.equal(f.state.ui.value?.menuItems.length, 1)
    assert.equal(f.state.uiRevision, 4)
  })

  test("a host without the editorExtensions capability: nothing is asked, the menu is hidden", async () => {
    const f = fakeExtensions({ info: serverInfo({ capabilities: [] }) })
    await f.state.refresh()
    assert.equal(f.state.status.value, "unsupported")
    assert.equal(f.state.menuVisible.value, false)
    assert.deepEqual(f.log, [], "no command was sent")
  })

  test("enabled false (the host was started without --editor-extensions): hidden, with the list but no menu fetched", async () => {
    const f = fakeExtensions({ enabled: false })
    await f.state.refresh()
    assert.equal(f.state.status.value, "disabled")
    assert.equal(f.state.menuVisible.value, false)
    assert.equal(f.state.ui.value, null)
    assert.deepEqual(f.log, ["list"], "no GetEditorUi for a host with extensions off")
  })

  test("not connected: nothing held and nothing shown", async () => {
    const f = fakeExtensions()
    await f.state.refresh()
    f.connected.value = false
    await f.state.refresh()
    assert.equal(f.state.status.value, "disconnected")
    assert.equal(f.state.menuVisible.value, false)
    assert.equal(f.state.info.value, null)
    assert.equal(f.state.ui.value, null)
  })

  test("a host that cannot be asked is an error with its message, and the menu is hidden", async () => {
    const f = fakeExtensions()
    f.host.listError = "Host is shutting down"
    await f.state.refresh()
    assert.equal(f.state.status.value, "error")
    assert.equal(f.state.loadError.value, "Host is shutting down")
    assert.equal(f.state.menuVisible.value, false)
    f.host.listError = null
    await f.state.refresh()
    assert.equal(f.state.status.value, "ready")
    assert.equal(f.state.loadError.value, null)
  })

  test("a 1.14 host lists extensions (menu visible) but cannot run items: canInvoke is false", async () => {
    const f = fakeExtensions({ info: serverInfo({ protocolVersion: "1.14.0" }) })
    await f.state.refresh()
    assert.equal(f.state.menuVisible.value, true)
    assert.equal(f.state.canInvoke.value, false)
    assert.equal(f.state.menu().every((n) => n.kind === "group" || !n.enabled), true)
  })

  test("a 1.15 host can run items; the role decides who may reload", async () => {
    const f = fakeExtensions({ role: "editor" })
    assert.equal(f.state.canInvoke.value, true)
    assert.equal(f.state.isAdmin.value, false)
    f.role.value = "admin"
    assert.equal(f.state.isAdmin.value, true)
  })
})

describe("ExtensionsState following the host", () => {
  test("start() fetches at once, again when the host says its extensions changed, and again on another connection", async () => {
    const f = fakeExtensions()
    const stop = f.state.start()
    await tick()
    assert.deepEqual(f.log.filter((s) => s === "list"), ["list"])
    f.host.ui = { uiRevision: 5, menuItems: [menuItem("x", "Tools/X")], inspectorSections: [] }
    f.changeCount.value++
    await tick()
    assert.equal(f.state.uiRevision, 5, "the new revision is the one runs are built from")
    assert.equal(f.state.ui.value?.menuItems[0].id, "x")
    f.connected.value = false
    await tick()
    assert.equal(f.state.status.value, "disconnected")
    f.connected.value = true
    await tick()
    assert.equal(f.state.status.value, "ready")
    stop()
    const before = f.log.length
    f.changeCount.value++
    await tick()
    assert.equal(f.log.length, before, "stopped")
  })

  test("a slow older answer cannot replace a newer one", async () => {
    const f = fakeExtensions()
    const first = f.state.refresh()
    f.host.ui = { uiRevision: 9, menuItems: [], inspectorSections: [] }
    const second = f.state.refresh()
    await Promise.all([first, second])
    assert.equal(f.state.uiRevision, 9)
  })

  test("reset forgets the list, the menu and the notice", async () => {
    const f = fakeExtensions()
    await f.state.refresh()
    f.state.notice.value = { title: "t", message: "m", warnings: [] }
    f.state.reset()
    assert.equal(f.state.info.value, null)
    assert.equal(f.state.ui.value, null)
    assert.equal(f.state.notice.value, null)
  })
})

describe("ExtensionsState.extensionOf", () => {
  test("an item belongs to the extension with its id, else the only one with its name", async () => {
    const f = fakeExtensions({
      extensions: [summary({ id: "a.lua", name: "Align" }), summary({ id: "b.lua", name: "Twin" }), summary({ id: "c.lua", name: "Twin" })],
    })
    await f.state.refresh()
    const of = (extension: string) => f.state.extensionOf(menuItem("i", "Tools/I", { extension }))?.id
    assert.equal(of("a.lua"), "a.lua", "by id")
    assert.equal(of("Align"), "a.lua", "by a unique name")
    assert.equal(of("Twin"), undefined, "two extensions share the name: not guessed")
    assert.equal(of("Nobody"), undefined)
  })

  test("a faulted extension's items stay in the menu, disabled with the reason", async () => {
    const f = fakeExtensions({ extensions: [summary({ state: "faulted" })] })
    await f.state.refresh()
    const [leaf] = f.state.menu()
    assert.equal(leaf.kind === "group" ? leaf.children[0].kind : leaf.kind, "item")
    const item = leaf.kind === "group" ? leaf.children[0] : leaf
    assert.equal(item.kind === "item" && item.enabled, false)
    assert.match((item.kind === "item" && item.reason) || "", /disabled until an admin reloads/)
  })
})

describe("ExtensionsState.menu", () => {
  test("is built from the host's items and the selection as it is now", async () => {
    const f = fakeExtensions({
      items: [menuItem("one", "Tools/One", { enabledWhen: { selection: "one" } }), menuItem("many", "Tools/Many", { enabledWhen: { selection: "nonEmpty" } })],
    })
    await f.state.refresh()
    const states = () => f.state.menu().map((n) => (n.kind === "item" ? n.enabled : null))
    f.selection.ids = ["00000000-0000-0000-0000-000000000001"]
    assert.deepEqual(states(), [true, true])
    f.selection.ids = ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"]
    assert.deepEqual(states(), [false, true])
    f.selection.ids = []
    assert.deepEqual(states(), [false, false])
  })

  test("an edit group open, or an item running, disables every item", async () => {
    const f = fakeExtensions()
    await f.state.refresh()
    const enabled = () => {
      const [node] = f.state.menu()
      const leaf = node.kind === "group" ? node.children[0] : node
      return leaf.kind === "item" && leaf.enabled
    }
    assert.equal(enabled(), true)
    f.openGroups.value = 1
    assert.equal(enabled(), false)
    f.openGroups.value = 0
    f.state.running.value = "something"
    assert.equal(enabled(), false)
  })
})

describe("ExtensionsState.reload", () => {
  test("reloads, then reads the list and the menu again", async () => {
    const f = fakeExtensions()
    await f.state.refresh()
    f.log.length = 0
    f.host.info = { ...f.host.info, uiRevision: 5 }
    const result = await f.state.reload()
    assert.equal(result.status, "ok")
    assert.deepEqual(f.log, ["reload", "list", "ui"])
    assert.equal(f.state.reloading.value, false)
    assert.equal(f.state.reloadError.value, null)
  })

  test("a refusal (an editor, a read-only host) is kept as the reason, and nothing is thrown", async () => {
    const f = fakeExtensions()
    f.host.reloadAnswer = { status: "error", kind: "forbidden", message: "Forbidden: needs the admin role", code: "forbidden" }
    const result = await f.state.reload()
    assert.equal(result.status, "error")
    assert.equal(f.state.reloadError.value, "Forbidden: needs the admin role")
    assert.equal(f.state.reloading.value, false)
    f.host.reloadAnswer = null
    await f.state.reload()
    assert.equal(f.state.reloadError.value, null, "cleared by the next one")
  })
})

describe("runBlockedReason", () => {
  const ok = { connected: true, hasScene: true, busy: null, readOnlyReason: null }
  test("null when nothing is in the way", () => {
    assert.equal(runBlockedReason(ok), null)
  })
  test("the first of: not connected, a refusal of writes, no scene, busy", () => {
    assert.match(runBlockedReason({ ...ok, connected: false, readOnlyReason: "r" }) ?? "", /not connected/)
    assert.equal(runBlockedReason({ ...ok, readOnlyReason: "you are a viewer", hasScene: false }), "you are a viewer")
    assert.equal(runBlockedReason({ ...ok, hasScene: false, busy: "Opening" }), "no scene is open")
    assert.equal(runBlockedReason({ ...ok, busy: "Saving..." }), "the editor is busy (Saving...)")
  })
})
