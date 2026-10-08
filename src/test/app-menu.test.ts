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
