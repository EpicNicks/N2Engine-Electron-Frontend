import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { HistoryView } from "../renderer/history-panel"
import { entries, fakeHistoryHost, settleTasks } from "../test/fake-history-host"

const three = { cursor: 2, entries: entries("Create Cube", "Move Cube", "Delete Cube") }

async function shown(initial = three) {
  const h = fakeHistoryHost(initial)
  const view = render(<HistoryView model={h.model} />)
  await act(async () => {
    await settleTasks()
  })
  return { h, view }
}

const rowLabels = () => screen.getAllByRole("option").map((o) => o.querySelector(".history-label")?.textContent)

describe("the history panel", () => {
  test("lists the initial state and the steps, marks the current one and dims the undone ones", async () => {
    await shown()
    assert.deepEqual(rowLabels(), ["Initial state", "Create Cube", "Move Cube", "Delete Cube"])
    const options = screen.getAllByRole("option")
    assert.equal(options[2].getAttribute("aria-current"), "step")
    assert.ok(options[3].classList.contains("undone"))
    assert.ok(!options[1].classList.contains("undone"))
    assert.match(screen.getByText(/3 steps/).textContent ?? "", /3 steps, 300 B/)
    assert.match(screen.getByText(/revision 1, saved at 1/).textContent ?? "", /revision 1/)
  })

  test("an empty history shows the initial state alone", async () => {
    await shown({ cursor: 0, entries: [] })
    assert.deepEqual(rowLabels(), ["Initial state"])
    assert.ok(screen.getByText(/No steps yet/))
  })

  test("not connected: nothing to list", async () => {
    const h = fakeHistoryHost(three)
    h.connected.value = false
    render(<HistoryView model={h.model} />)
    await act(async () => {
      await settleTasks()
    })
    assert.equal(screen.queryAllByRole("option").length, 0)
    assert.ok(screen.getByText("Not connected"))
  })

  test("clicking an earlier row undoes to it, one step at a time, and the rows follow", async () => {
    const { h } = await shown()
    await userEvent.click(screen.getAllByRole("option")[0])
    await waitFor(() => assert.equal(h.host().cursor, 0))
    assert.equal(h.log.filter((l) => l === "undo").length, 2)
    await waitFor(() => assert.equal(screen.getAllByRole("option")[0].getAttribute("aria-current"), "step"))
  })

  test("clicking a later row redoes to it", async () => {
    const { h } = await shown()
    await userEvent.click(screen.getAllByRole("option")[3])
    await waitFor(() => assert.equal(h.host().cursor, 3))
    assert.equal(h.log.filter((l) => l === "redo").length, 1)
  })

  test("clicking the current row does nothing", async () => {
    const { h } = await shown()
    h.log.length = 0
    await userEvent.click(screen.getAllByRole("option")[2])
    assert.deepEqual(h.log, [])
  })

  test("a failure mid-jump shows the error, stops, and shows the host's history", async () => {
    const { h } = await shown()
    h.failures.set(2, "step cannot be undone")
    await userEvent.click(screen.getAllByRole("option")[0])
    const alert = await screen.findByRole("alert")
    assert.match(alert.textContent ?? "", /step cannot be undone/)
    assert.equal(h.host().cursor, 1)
    await waitFor(() => assert.equal(screen.getAllByRole("option")[1].getAttribute("aria-current"), "step"))
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    assert.equal(screen.queryByRole("alert"), null)
  })

  test("read-only: the rows are disabled with the reason and a click sends nothing", async () => {
    const { h } = await shown()
    h.readOnlyReason.value = "you are signed in as a viewer"
    await act(async () => {
      await settleTasks()
    })
    assert.equal(screen.getByRole("listbox").getAttribute("aria-disabled"), "true")
    assert.match(screen.getByText(/Read-only: you are signed in as a viewer/).textContent ?? "", /viewer/)
    h.log.length = 0
    await userEvent.click(screen.getAllByRole("option")[0])
    assert.deepEqual(h.log, [])
  })

  test("a client edit group open disables the rows", async () => {
    const { h } = await shown()
    await act(async () => {
      await h.groups.begin("Move Cube")
    })
    assert.ok(screen.getByText(/edit group is open/))
    h.log.length = 0
    await userEvent.click(screen.getAllByRole("option")[0])
    assert.deepEqual(h.log, [])
    await act(async () => {
      await h.groups.closeAll()
    })
    assert.equal(screen.getByRole("listbox").getAttribute("aria-disabled"), "false")
  })

  test("the host changing the history (another client's edit) updates the rows", async () => {
    const { h } = await shown()
    act(() => h.hostChanges({ cursor: 3, entries: entries("Create Cube", "Move Cube", "Delete Cube", "Rename") }))
    await act(async () => {
      await h.timers.fire()
      await settleTasks()
    })
    assert.deepEqual(rowLabels(), ["Initial state", "Create Cube", "Move Cube", "Delete Cube", "Rename"])
    assert.equal(screen.getAllByRole("option")[3].getAttribute("aria-current"), "step")
  })

  test("a jump shows its progress, and Cancel stops it between steps", async () => {
    const big = { cursor: 4, entries: entries("A", "B", "C", "D") }
    const { h } = await shown(big)
    // Cancel is requested from the UI as the first step is answered: the second step is never sent
    const unsubscribe = h.model.progress.subscribe((p) => {
      if (p && p.done === 1 && !p.cancelling) h.model.cancel()
    })
    await userEvent.click(screen.getAllByRole("option")[0])
    await waitFor(() => assert.equal(h.model.progress.value, null))
    unsubscribe()
    assert.equal(h.host().cursor, 3)
    assert.equal(screen.queryByRole("alert"), null)
  })

  test("Escape in the list cancels a running jump", async () => {
    const { h } = await shown({ cursor: 4, entries: entries("A", "B", "C", "D") })
    const unsubscribe = h.model.progress.subscribe((p) => {
      if (p && p.done === 1 && !p.cancelling) fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" })
    })
    await userEvent.click(screen.getAllByRole("option")[0])
    await waitFor(() => assert.equal(h.model.progress.value, null))
    unsubscribe()
    assert.equal(h.host().cursor, 3)
  })

  test("keyboard: arrows move, Enter jumps, Home and End go to the ends", async () => {
    const { h } = await shown()
    const options = () => screen.getAllByRole("option")
    options()[2].focus()
    await userEvent.keyboard("{ArrowUp}")
    await waitFor(() => assert.equal(document.activeElement, options()[1]))
    await userEvent.keyboard("{Home}")
    await waitFor(() => assert.equal(document.activeElement, options()[0]))
    await userEvent.keyboard("{End}")
    await waitFor(() => assert.equal(document.activeElement, options()[3]))
    await userEvent.keyboard("{ArrowDown}")
    assert.equal(document.activeElement, options()[3], "stays on the last row")
    await userEvent.keyboard("{Home}{Enter}")
    await waitFor(() => assert.equal(h.host().cursor, 0))
  })

  test("only the active row is in the tab order", async () => {
    await shown()
    const tabbable = screen.getAllByRole("option").filter((o) => o.tabIndex === 0)
    assert.equal(tabbable.length, 1)
    assert.equal(tabbable[0].getAttribute("aria-current"), "step")
  })

  test("closing the panel stops its listeners", async () => {
    const { h, view } = await shown()
    await act(async () => {
      view.unmount()
    })
    h.log.length = 0
    h.hostChanges({ cursor: 1, entries: entries("A") })
    await h.timers.fire()
    await settleTasks()
    assert.deepEqual(h.log, [])
    assert.equal(h.timers.pending.size, 0)
  })
})
