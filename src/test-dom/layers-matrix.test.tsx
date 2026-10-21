import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { act, render, screen, waitFor, within } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { ProjectSettingsView } from "../renderer/project-settings-panel"
import { AllLayersMask, LayerCount, isRowMask, rowsCollide, type JsonObject } from "../renderer/project-settings-schema"
import { fakeProjectHost, settleTasks } from "./fake-project-host"

const Names = ["Default", "TransparentFX", "Ignore Raycast", "", "Water", "UI", "Enemies"]

async function shownLayers(options: Parameters<typeof fakeProjectHost>[0] = {}) {
  const h = fakeProjectHost({ settings: { layers: { layers: Names } }, ...options })
  render(<ProjectSettingsView model={h.model} />)
  await act(async () => {
    await settleTasks()
  })
  await userEvent.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByText("Layers"))
  return h
}

const cell = (a: number, b: number) => screen.getByLabelText(`Layers ${a} and ${b} collide`) as HTMLInputElement
const apply = () => screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement
const sentRows = (patch: JsonObject): number[] => (patch.layers as { collisionMatrix: number[] }).collisionMatrix
const allRows = (): number[] => new Array<number>(LayerCount).fill(AllLayersMask)

describe("the layer collision matrix", () => {
  test("only the named layers are shown until the unnamed ones are asked for", async () => {
    await shownLayers()
    const grid = screen.getByRole("table", { name: "Layer collision matrix" })
    // Default, TransparentFX, Ignore Raycast, Water, UI, Enemies
    assert.equal(within(grid).getAllByRole("row").length, 1 + 6)
    assert.equal(screen.queryByLabelText("Layers 3 and 3 collide"), null)
    assert.equal(screen.queryByLabelText("Layers 0 and 31 collide"), null)
    await userEvent.click(screen.getByLabelText("Show the unnamed layers (26)"))
    assert.equal(within(grid).getAllByRole("row").length, 1 + LayerCount)
    assert.ok(cell(3, 3))
    assert.ok(cell(31, 0))
    assert.equal(within(grid).getAllByLabelText(/^Layers \d+ and \d+ collide$/).length, LayerCount * LayerCount)
  })

  test("ticking (a, b) ticks (b, a); Apply sends the 32 row masks with the pair cleared in both rows", async () => {
    const h = await shownLayers()
    assert.equal(cell(0, 6).checked, true)
    assert.equal(apply().disabled, true)
    await userEvent.click(cell(0, 6))
    await waitFor(() => assert.equal(cell(6, 0).checked, false))
    assert.equal(cell(0, 6).checked, false)
    assert.equal(cell(6, 6).checked, true)
    assert.ok(screen.getByTitle("Unsaved changes"))
    assert.equal(apply().disabled, false)
    await userEvent.click(apply())
    await waitFor(() => assert.equal(h.patches.length, 1))
    // Only the matrix: the names are not sent when none changed
    assert.deepEqual(Object.keys(h.patches[0].layers as JsonObject), ["collisionMatrix"])
    const expected = allRows()
    expected[0] = 0xffffffbf // bit 6 of row 0
    expected[6] = 0xfffffffe // bit 0 of row 6
    assert.deepEqual(sentRows(h.patches[0]), expected)
    // The host keeps the names, and the grid follows what it saved
    assert.deepEqual((h.settings().layers as JsonObject).layers, Names)
    await waitFor(() => assert.equal(apply().disabled, true))
    assert.equal(cell(6, 0).checked, false)
  })

  test("toggling a pair back is no change", async () => {
    const h = await shownLayers()
    await userEvent.click(cell(4, 5))
    await waitFor(() => assert.equal(apply().disabled, false))
    await userEvent.click(cell(5, 4))
    await waitFor(() => assert.equal(apply().disabled, true))
    assert.equal(cell(4, 5).checked, true)
    assert.deepEqual(h.patches, [])
  })

  test("Revert puts the host's matrix back", async () => {
    const h = await shownLayers()
    await userEvent.click(cell(1, 2))
    await waitFor(() => assert.equal(cell(2, 1).checked, false))
    await userEvent.click(screen.getByRole("button", { name: "Revert" }))
    await waitFor(() => assert.equal(cell(2, 1).checked, true))
    assert.equal(cell(1, 2).checked, true)
    assert.equal(apply().disabled, true)
    assert.deepEqual(h.patches, [])
  })

  test("a row's checkbox sets every shown pair of the layer; the hidden layers are left as they were", async () => {
    const h = await shownLayers()
    const row = screen.getByLabelText("All of row 4") as HTMLInputElement
    assert.equal(row.checked, true)
    await userEvent.click(row)
    await waitFor(() => assert.equal(cell(4, 0).checked, false))
    for (const b of [0, 1, 2, 4, 5, 6]) {
      assert.equal(cell(4, b).checked, false)
      assert.equal(cell(b, 4).checked, false)
    }
    assert.equal((screen.getByLabelText("All of row 4") as HTMLInputElement).checked, false)
    // The column of the same layer is the same set
    assert.equal((screen.getByLabelText("All of column 4") as HTMLInputElement).checked, false)
    assert.equal((screen.getByLabelText("All of column 0") as HTMLInputElement).indeterminate, true)
    await userEvent.click(apply())
    await waitFor(() => assert.equal(h.patches.length, 1))
    const rows = sentRows(h.patches[0])
    for (const b of [0, 1, 2, 4, 5, 6]) assert.equal(rowsCollide(rows, 4, b), false)
    // Layer 3 and 7..31 are unnamed, so not shown: still colliding with 4
    for (const b of [3, 7, 31]) assert.equal(rowsCollide(rows, 4, b), true)
  })

  test("a column's checkbox ticks the pairs back on", async () => {
    await shownLayers({ settings: { layers: { layers: Names, collisionMatrix: new Array<number>(LayerCount).fill(0) } } })
    const column = screen.getByLabelText("All of column 6") as HTMLInputElement
    assert.equal(column.checked, false)
    await userEvent.click(column)
    await waitFor(() => assert.equal(cell(6, 0).checked, true))
    assert.equal(cell(0, 6).checked, true)
    assert.equal(cell(6, 6).checked, true)
    assert.equal(cell(0, 1).checked, false)
  })

  test("the 32nd layer: bit 31 is sent unsigned and every row is a 32-bit mask", async () => {
    const h = await shownLayers({ settings: { layers: { layers: Names, collisionMatrix: new Array<number>(LayerCount).fill(0) } } })
    await userEvent.click(screen.getByLabelText("Show the unnamed layers (26)"))
    await userEvent.click(cell(31, 0))
    await userEvent.click(cell(31, 31))
    await userEvent.click(apply())
    await waitFor(() => assert.equal(h.patches.length, 1))
    const rows = sentRows(h.patches[0])
    assert.equal(rows.length, LayerCount)
    assert.ok(rows.every(isRowMask))
    assert.equal(rows[0], 0x80000000)
    assert.equal(rows[31], 0x80000001)
    assert.equal(rows.filter((r) => r !== 0).length, 2)
  })

  test("Restore previous values brings a pair back after an Apply", async () => {
    const h = await shownLayers()
    await userEvent.click(cell(2, 5))
    await userEvent.click(apply())
    await waitFor(() => assert.equal(h.patches.length, 1))
    await userEvent.click(screen.getByRole("button", { name: "Restore previous values" }))
    await waitFor(() => assert.equal(cell(5, 2).checked, true))
    await userEvent.click(apply())
    await waitFor(() => assert.equal(h.patches.length, 2))
    assert.deepEqual(sentRows(h.patches[1]), allRows())
  })

  test("an editor (not an admin) can change the matrix, as the other layer settings", async () => {
    const h = await shownLayers({ role: "editor" })
    assert.equal(cell(0, 1).disabled, false)
    await userEvent.click(cell(0, 1))
    await userEvent.click(apply())
    await waitFor(() => assert.equal(h.patches.length, 1))
  })

  test("read-only (a viewer, a read-only host): the cells and the row and column boxes are disabled", async () => {
    const h = await shownLayers()
    await userEvent.click(cell(0, 1))
    await act(async () => {
      h.readOnlyReason.value = "you are signed in as a viewer, who can look but not change anything or play"
    })
    await waitFor(() => assert.equal(cell(0, 1).disabled, true))
    assert.equal(cell(4, 4).disabled, true)
    assert.equal((screen.getByLabelText("All of row 0") as HTMLInputElement).disabled, true)
    assert.equal((screen.getByLabelText("All of column 0") as HTMLInputElement).disabled, true)
    assert.equal(apply().disabled, true)
    // Showing the unnamed layers only changes the view
    assert.equal((screen.getByLabelText("Show the unnamed layers (26)") as HTMLInputElement).disabled, false)
    assert.deepEqual(h.patches, [])
  })

  test("an invalid matrix in the project is flagged and shown as every layer colliding", async () => {
    await shownLayers({ settings: { layers: { layers: Names, collisionMatrix: [1, 2, 3] } } })
    assert.match(screen.getByRole("note").textContent ?? "", /not 32 masks/)
    assert.equal(cell(0, 1).checked, true)
  })
})
