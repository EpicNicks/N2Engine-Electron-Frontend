/// <reference path="../renderer/globals.d.ts" />
import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { screen, within } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { ConsoleStore, ConsoleEntry, LogLevel } from "../renderer/console-store"
import { ConsoleSourceRegistry } from "../renderer/console-filter"
import { ConsolePanel } from "../renderer/console-panel"
import { renderWithApp } from "./helpers"

const never = async () => ({ epoch: 1, nextSeq: 1, dropped: 0, events: [] }) as never
const line = (level: LogLevel, message: string, source = "host"): Omit<ConsoleEntry, "id"> => ({ level, message, source, time: 0 })

function renderConsole(lines: Array<Omit<ConsoleEntry, "id">>, registry?: ConsoleSourceRegistry) {
  const log = new ConsoleStore(never, { now: () => 0, sources: registry })
  log.addEntries(lines)
  renderWithApp(<ConsolePanel />, { store: { console: log } })
  return log
}

const messages = (): string[] =>
  Array.from(document.querySelectorAll(".console-entry .console-message")).map((el) => el.textContent ?? "")
const filter = () => screen.getByRole("searchbox", { name: "Filter" }) as HTMLInputElement

describe("the console filters", () => {
  test("typing filters the lines and highlights the match; clearing the text restores them", async () => {
    renderConsole([line("info", "Loaded the scene"), line("info", "Saved"), line("warn", "scene is large")])
    const user = userEvent.setup()
    assert.deepEqual(messages(), ["Loaded the scene", "Saved", "scene is large"])
    await user.type(filter(), "SCENE")
    assert.deepEqual(messages(), ["Loaded the scene", "scene is large"])
    const marks = Array.from(document.querySelectorAll(".console-message mark")).map((m) => m.textContent)
    assert.deepEqual(marks, ["scene", "scene"], "the text as written in the line")
    await user.clear(filter())
    assert.deepEqual(messages(), ["Loaded the scene", "Saved", "scene is large"])
    assert.equal(document.querySelector("mark"), null)
  })

  test("the level boxes show their counts and hide their lines", async () => {
    renderConsole([line("info", "a"), line("warn", "b"), line("error", "c"), line("error", "d")])
    const user = userEvent.setup()
    assert.ok(screen.getByLabelText("Errors (2)"))
    await user.click(screen.getByLabelText("Errors (2)"))
    assert.deepEqual(messages(), ["a", "b"])
    assert.ok(screen.getByLabelText("Errors (2)"), "the count stays: it is how many there are")
  })

  test("a source box hides that source's lines, with its count", async () => {
    renderConsole([line("info", "from host"), line("info", "from game", "game"), line("info", "editor note", "editor")])
    const user = userEvent.setup()
    const sources = within(screen.getByRole("group", { name: "Sources" }))
    assert.ok(sources.getByLabelText("Game (1)"))
    await user.click(sources.getByLabelText("Game (1)"))
    assert.deepEqual(messages(), ["from host", "editor note"])
    await user.click(sources.getByLabelText("Host (1)"))
    assert.deepEqual(messages(), ["editor note"])
  })

  test("a source an extension registers gets a box", () => {
    const registry = new ConsoleSourceRegistry([
      { id: "host", label: "Host" },
      { id: "extension", label: "Extension" },
    ])
    renderConsole([line("info", "ext says hi", "extension")], registry)
    assert.ok(screen.getByLabelText("Extension (1)"))
  })

  test("regex is off until switched on; an invalid pattern shows a message and filters nothing", async () => {
    renderConsole([line("info", "ab"), line("info", "a.b")])
    const user = userEvent.setup()
    const regex = screen.getByRole("button", { name: ".*" })
    assert.equal(regex.getAttribute("aria-pressed"), "false")
    await user.type(filter(), "a.b")
    assert.deepEqual(messages(), ["a.b"])
    await user.click(regex)
    assert.equal(regex.getAttribute("aria-pressed"), "true")
    assert.deepEqual(messages(), ["a.b"], "a.b as a pattern matches a.b, not ab")
    await user.clear(filter())
    await user.type(filter(), "a[[") // "[[" types a literal [
    assert.deepEqual(messages(), ["ab", "a.b"])
    assert.match(screen.getByRole("alert").textContent ?? "", /Not a valid pattern/)
    assert.equal(filter().getAttribute("aria-invalid"), "true")
    await user.type(filter(), "b]")
    assert.equal(screen.queryByRole("alert"), null)
  })

  test("match case is a toggle", async () => {
    renderConsole([line("info", "Error here"), line("info", "error there")])
    const user = userEvent.setup()
    await user.type(filter(), "Error")
    assert.equal(messages().length, 2)
    await user.click(screen.getByRole("button", { name: "Aa" }))
    assert.deepEqual(messages(), ["Error here"])
  })

  test("Collapse merges identical lines in a row into one with a count badge", async () => {
    renderConsole([line("info", "tick"), line("info", "tick"), line("info", "tick"), line("warn", "tick"), line("info", "tock")])
    const user = userEvent.setup()
    assert.equal(document.querySelectorAll(".console-entry").length, 5)
    assert.equal(document.querySelector(".console-count"), null)
    await user.click(screen.getByRole("button", { name: "Collapse" }))
    assert.deepEqual(messages(), ["tick", "tick", "tock"])
    const badges = Array.from(document.querySelectorAll(".console-count")).map((b) => b.textContent)
    assert.deepEqual(badges, ["3"])
    await user.click(screen.getByRole("button", { name: "Collapse" }))
    assert.equal(document.querySelectorAll(".console-entry").length, 5)
  })

  test("Clear empties the list; nothing matching says so", async () => {
    const log = renderConsole([line("info", "x")])
    const user = userEvent.setup()
    await user.type(filter(), "zzz")
    assert.ok(screen.getByText("No lines match the filter"))
    await user.click(screen.getByRole("button", { name: "Clear" }))
    assert.equal(log.entries.value.length, 0)
    await user.clear(filter())
    assert.ok(screen.getByText("No log lines yet"))
  })
})
