import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import {
  MaxGroupDepth,
  MaxLabelLength,
  availabilityOf,
  buildToolsMenu,
  countItems,
  placeOf,
  selectionAllows,
  type MenuContext,
  type ToolsNode,
} from "../renderer/extension-menu"
import { Uuid, menuItem, summary } from "./fake-extensions"

function context(over: Partial<MenuContext> = {}): MenuContext {
  return {
    role: "editor",
    canInvoke: true,
    blockedReason: null,
    openGroups: 0,
    running: false,
    selection: [Uuid(1)],
    componentsOf: () => undefined,
    extensionOf: () => undefined,
    ...over,
  }
}

/** The menu as nested [label, children | enabled] lists, for short assertions */
function shape(nodes: ToolsNode[]): unknown[] {
  return nodes.map((node) => (node.kind === "group" ? [node.label, shape(node.children)] : node.enabled ? node.label : `${node.label} (off)`))
}

describe("placeOf", () => {
  test("the path's folders are the groups, a leading Tools is dropped, and the title is the label", () => {
    assert.deepEqual(placeOf(menuItem("a", "Tools/Align/Snap...", { title: "Snap selection" })), { groups: ["Align"], label: "Snap selection" })
    assert.deepEqual(placeOf(menuItem("a", "Tools/Align/Snap", { title: "" })), { groups: ["Align"], label: "Snap" })
    assert.deepEqual(placeOf(menuItem("a", "tools/Top", { title: "Top" })), { groups: [], label: "Top" })
  })

  test("a path that does not start with Tools keeps all its folders", () => {
    assert.deepEqual(placeOf(menuItem("a", "Align/Snap", { title: "Snap" })), { groups: ["Align"], label: "Snap" })
    assert.deepEqual(placeOf(menuItem("a", "Toolsy/Snap", { title: "Snap" })), { groups: ["Toolsy"], label: "Snap" })
  })

  test("odd paths: empty segments and spaces are skipped, an empty path puts the item at the top", () => {
    assert.deepEqual(placeOf(menuItem("a", "Tools//Align/ /Snap/", { title: "S" })), { groups: ["Align"], label: "S" })
    assert.deepEqual(placeOf(menuItem("id1", "", { title: "" })), { groups: [], label: "id1" })
    assert.deepEqual(placeOf(menuItem("id1", "///", { title: "Named" })), { groups: [], label: "Named" })
    assert.deepEqual(placeOf(menuItem("id1", "Tools", { title: "" })), { groups: [], label: "Tools" })
  })

  test("control characters become ? and long names are cut; nesting stops at the host's depth", () => {
    assert.equal(placeOf(menuItem("a", "Tools/G\nrp/x", { title: "A\u0007B" })).groups[0], "G?rp")
    assert.equal(placeOf(menuItem("a", "x", { title: "A\u0007B" })).label, "A?B")
    const long = "n".repeat(MaxLabelLength + 20)
    assert.equal(placeOf(menuItem("a", `Tools/${long}/x`, { title: long })).label.length, MaxLabelLength + 3)
    const deep = placeOf(menuItem("a", Array.from({ length: 12 }, (_, i) => `g${i}`).join("/"), { title: "t" }))
    assert.equal(deep.groups.length, MaxGroupDepth)
  })
})

describe("buildToolsMenu", () => {
  test("paths become nested groups in first-seen order, items in the host's order", () => {
    const items = [
      menuItem("a", "Tools/Align/Snap", { title: "Snap" }),
      menuItem("b", "Tools/Align/Distribute", { title: "Distribute" }),
      menuItem("c", "Tools/Create/Prefabs/Door", { title: "Door" }),
      menuItem("d", "Tools/Top", { title: "Top level" }),
      menuItem("e", "Tools/Align/Deep/One", { title: "One" }),
      menuItem("f", "Tools/Create/Window", { title: "Window" }),
    ]
    assert.deepEqual(shape(buildToolsMenu(items, context())), [
      ["Align", ["Snap", "Distribute", ["Deep", ["One"]]]],
      ["Create", [["Prefabs", ["Door"]], "Window"]],
      "Top level",
    ])
  })

  test("duplicate labels stay two entries, and a group and an item with one name are two entries", () => {
    const items = [
      menuItem("a", "Tools/Same", { title: "Same" }),
      menuItem("b", "Tools/Same", { title: "Same" }),
      menuItem("c", "Tools/Same/Inner", { title: "Inner" }),
    ]
    const menu = buildToolsMenu(items, context())
    assert.deepEqual(shape(menu), ["Same", "Same", ["Same", ["Inner"]]])
    assert.equal(countItems(menu), 3)
  })

  test("no items is an empty menu", () => {
    assert.deepEqual(buildToolsMenu([], context()), [])
  })

  test("an item keeps its own record (its id is what names it)", () => {
    const item = menuItem("only", "Tools/X", { title: "X" })
    const [leaf] = buildToolsMenu([item], context())
    assert.equal(leaf.kind === "item" && leaf.item, item)
  })
})

describe("availabilityOf", () => {
  const item = menuItem("a", "Tools/A")

  test("enabled when nothing is in the way", () => {
    assert.deepEqual(availabilityOf(item, context()), { enabled: true, reason: null })
  })

  test("a host that cannot run items (protocol before 1.15) disables everything, with the reason", () => {
    const result = availabilityOf(item, context({ canInvoke: false }))
    assert.equal(result.enabled, false)
    assert.match(result.reason ?? "", /protocol 1\.15\.0/)
  })

  test("a faulted extension's items are disabled until a reload; a failed one the same", () => {
    for (const state of ["faulted", "failed"] as const) {
      const result = availabilityOf(item, context({ extensionOf: () => summary({ name: "Align Tools", state }) }))
      assert.equal(result.enabled, false)
      assert.match(result.reason ?? "", /Align Tools is disabled until an admin reloads it/)
    }
    assert.equal(availabilityOf(item, context({ extensionOf: () => summary({ state: "loaded" }) })).enabled, true)
  })

  test("an item above the user's role is disabled with a tooltip, and an admin item is fine for an admin", () => {
    const adminItem = menuItem("b", "Tools/B", { minRole: "admin" })
    const editor = availabilityOf(adminItem, context({ role: "editor" }))
    assert.equal(editor.enabled, false)
    assert.match(editor.reason ?? "", /admin role \(you are signed in as editor\)/)
    assert.equal(availabilityOf(adminItem, context({ role: "admin" })).enabled, true)
    assert.equal(availabilityOf(adminItem, context({ role: null })).enabled, false)
    assert.equal(availabilityOf(item, context({ role: "editor" })).enabled, true, "an ordinary item is for editors")
  })

  test("read-only, viewer, play and no-scene reasons come from the editor's own guard", () => {
    const result = availabilityOf(item, context({ blockedReason: "you are signed in as a viewer" }))
    assert.deepEqual(result, { enabled: false, reason: "Not available: you are signed in as a viewer" })
  })

  test("an edit group still open, and another item running, disable it", () => {
    assert.match(availabilityOf(item, context({ openGroups: 1 })).reason ?? "", /edit is in progress/)
    assert.match(availabilityOf(item, context({ running: true })).reason ?? "", /Another menu item is running/)
  })

  test("the selection rules", () => {
    const rule = (selection: "any" | "nonEmpty" | "one" | "none", ids: string[]) =>
      availabilityOf(menuItem("r", "Tools/R", { enabledWhen: { selection } }), context({ selection: ids })).enabled
    for (const [selection, counts] of [
      ["any", [true, true, true]],
      ["nonEmpty", [false, true, true]],
      ["one", [false, true, false]],
      ["none", [true, false, false]],
    ] as const) {
      assert.deepEqual([rule(selection, []), rule(selection, [Uuid(1)]), rule(selection, [Uuid(1), Uuid(2)])], counts, selection)
    }
    assert.equal(selectionAllows("one", 1), true)
    assert.equal(selectionAllows("none", 2), false)
  })

  test("each rule says what to do", () => {
    const why = (selection: "nonEmpty" | "one" | "none", ids: string[]) =>
      availabilityOf(menuItem("r", "Tools/R", { enabledWhen: { selection } }), context({ selection: ids })).reason
    assert.match(why("nonEmpty", []) ?? "", /at least one object/)
    assert.match(why("one", []) ?? "", /exactly one object/)
    assert.match(why("none", [Uuid(1)]) ?? "", /Deselect everything/)
  })

  test("componentType: every selected object needs it, and something must be selected", () => {
    const camera = menuItem("c", "Tools/C", { enabledWhen: { selection: "any", componentType: "Camera" } })
    const components = new Map<string, string[]>([
      [Uuid(1), ["Camera", "Transform"]],
      [Uuid(2), ["Transform"]],
    ])
    const ctx = (selection: string[]) => context({ selection, componentsOf: (id) => components.get(id) })
    assert.equal(availabilityOf(camera, ctx([Uuid(1)])).enabled, true)
    assert.equal(availabilityOf(camera, ctx([Uuid(1), Uuid(2)])).enabled, false)
    assert.match(availabilityOf(camera, ctx([Uuid(1), Uuid(2)])).reason ?? "", /Every selected object needs a Camera component/)
    assert.match(availabilityOf(camera, ctx([])).reason ?? "", /Select an object with a Camera component/)
    assert.equal(availabilityOf(camera, ctx([Uuid(99)])).enabled, false, "an object the editor does not know has none")
  })

  test("the first reason wins: an old host before a role before the editor's guard", () => {
    const adminItem = menuItem("b", "Tools/B", { minRole: "admin" })
    const all = context({ canInvoke: false, role: "editor", blockedReason: "busy", openGroups: 2 })
    assert.match(availabilityOf(adminItem, all).reason ?? "", /too old/)
    assert.match(availabilityOf(adminItem, { ...all, canInvoke: true }).reason ?? "", /admin role/)
    assert.match(availabilityOf(adminItem, { ...all, canInvoke: true, role: "admin" }).reason ?? "", /Not available: busy/)
  })
})
