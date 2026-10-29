import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { MenuItemConstructorOptions } from "electron"
import { buildAppMenuTemplate } from "../main/app-menu"

describe("the macOS application menu", () => {
  const sent: string[] = []
  const template = buildAppMenuTemplate("N2 Editor", (command) => sent.push(command))
  const edit = template.find((item) => item.label === "Edit")!
  const items = edit.submenu as MenuItemConstructorOptions[]

  test("Edit has Undo and Redo, on Cmd+Z and Cmd+Shift+Z, that send the command to the page", () => {
    const undo = items.find((item) => item.label === "Undo")!
    const redo = items.find((item) => item.label === "Redo")!
    assert.equal(undo.accelerator, "CmdOrCtrl+Z")
    assert.equal(redo.accelerator, "Shift+CmdOrCtrl+Z")
    assert.equal(undo.role, undefined, "not the web contents' own undo")
    assert.equal(redo.role, undefined)
    ;(undo.click as () => void)()
    ;(redo.click as () => void)()
    assert.deepEqual(sent, ["undo", "redo"])
  })

  test("the text editing items stay, and the app menu carries the app's name", () => {
    const roles = items.map((item) => item.role)
    for (const role of ["cut", "copy", "paste", "selectAll"]) assert.ok(roles.includes(role as never), role)
    assert.equal(template[0].label, "N2 Editor")
  })
})

describe("the macOS application menu names the steps (so an AI agent's steps show in the Edit menu)", () => {
  const itemsFor = (labels: { undo: string; redo: string }) => {
    const template = buildAppMenuTemplate("N2 Editor", () => undefined, labels)
    return (template.find((item) => item.label === "Edit")!.submenu as MenuItemConstructorOptions[]).map((item) => item.label)
  }

  test("Undo and Redo carry the history's labels", () => {
    const labels = itemsFor({ undo: "AI: n2_set_transform #3", redo: "AI: n2_create_entity #4" })
    assert.ok(labels.includes("Undo AI: n2_set_transform #3"))
    assert.ok(labels.includes("Redo AI: n2_create_entity #4"))
  })

  test("with no step they are plain Undo and Redo, and a label is one short line", () => {
    const plain = itemsFor({ undo: "", redo: "" })
    assert.ok(plain.includes("Undo") && plain.includes("Redo"))
    const odd = itemsFor({ undo: "a\nb" + "x".repeat(200), redo: "" }).find((l) => l?.startsWith("Undo "))!
    assert.ok(!odd.includes("\n"))
    assert.ok(odd.length < 80)
  })
})

