/// <reference path="../renderer/globals.d.ts" />
import "./setup"
import { test } from "node:test"
import * as assert from "node:assert/strict"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact"
import { forEachDiagnostic } from "@codemirror/lint"
import { signal } from "@preact/signals-core"
import { EditorView } from "@codemirror/view"
import { startCompletion, currentCompletions } from "@codemirror/autocomplete"
import { EditorState } from "@codemirror/state"
import { TextEditor } from "../renderer/assets-panel"
import { ScriptEditor } from "../renderer/script-editor"
import { AssetsState } from "../renderer/assets-state"
import { renderWithApp } from "./helpers"
import { FakeAssetHost, stubStore } from "./panel-fakes"
import type { ConsoleStore } from "../renderer/console-store"

const viewOf = () => {
  const content = screen.getByRole("textbox") as HTMLElement
  const view = EditorView.findFromDOM(content)
  assert.ok(view)
  return view
}

test("CodeMirror mounts with line numbers and reflects external text/read-only changes without treating them as edits", async () => {
  const edited: string[] = []
  const result = render(<ScriptEditor path="res://scripts/a.lua" text="print(1)" readOnly={false} onChange={text => edited.push(text)} />)
  const view = viewOf()
  assert.equal(view.state.doc.toString(), "print(1)")
  assert.ok(document.querySelector(".cm-lineNumbers"))
  act(() => view.dispatch({ changes: { from: 6, to: 7, insert: "2" } }))
  assert.deepEqual(edited, ["print(2)"])
  result.rerender(<ScriptEditor path="res://scripts/a.lua" text={"reloaded\ntext"} readOnly={true} onChange={text => edited.push(text)} />)
  await waitFor(() => assert.equal(view.state.doc.toString(), "reloaded\ntext"))
  assert.equal(view.state.facet(EditorState.readOnly), true)
  assert.equal(view.contentDOM.getAttribute("contenteditable"), "false")
  assert.deepEqual(edited, ["print(2)"])
})

test("the asset tab owns unsaved text and Ctrl+S saves it through the fake host, retaining CRLF endings", async () => {
  const host = new FakeAssetHost(), fake = stubStore()
  host.files.set("res://scripts/a.lua", "print(1)\r\n")
  const writes: string[] = []
  const engine = { ...host.engine, writeTextAsset: async (path: string, text: string) => { writes.push(text); host.files.set(path, text) } }
  const assets = new AssetsState(engine, null, fake.signals.reportError, () => fake.signals.readOnlyReason.peek())
  await assets.openText("res://scripts/a.lua")
  const console = { entries: signal([]) } as unknown as ConsoleStore
  renderWithApp(<TextEditor path="res://scripts/a.lua" />, { assets, store: { ...fake.store, console } })
  const view = viewOf()
  act(() => view.dispatch({ changes: { from: 6, to: 7, insert: "3" } }))
  await waitFor(() => assert.equal(assets.tabs.value[0].text, "print(3)\n"))
  assert.ok(screen.getByText("Unsaved changes"))
  fireEvent.keyDown(view.contentDOM, { key: "s", code: "KeyS", ctrlKey: true })
  await waitFor(() => assert.equal(writes.length, 1))
  assert.equal(writes[0], "print(3)\r\n")
  assert.ok(screen.getByText("Saved"))
  act(() => { fake.signals.playMode.value = "playing" })
  await waitFor(() => assert.equal(view.state.facet(EditorState.readOnly), true))
  assert.equal((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, true)
})

test("Lua member completion and the find/replace panel run inside the mounted editor", async () => {
  render(<ScriptEditor path="res://scripts/test.lua" text="Vector3." readOnly={false} onChange={() => {}} />)
  const view = viewOf()
  act(() => { view.dispatch({ selection: { anchor: view.state.doc.length } }); startCompletion(view) })
  await waitFor(() => assert.ok(currentCompletions(view.state).some(item => item.label === "Dot")))
  fireEvent.keyDown(view.contentDOM, { key: "f", code: "KeyF", ctrlKey: true })
  await waitFor(() => assert.ok(view.dom.querySelector('.cm-search input[name="search"]')))
  assert.ok(view.dom.querySelector('.cm-search input[name="replace"]'))
})

test("a syntax error from the host becomes a squiggle at its line and column, after the debounce, and goes when the text is fixed", async () => {
  const asked: string[] = []
  const checkSyntax = async (text: string, name: string) => {
    asked.push(`${name}|${text}`)
    return text.includes("=\n") ? { ok: false, line: 1, column: 3, message: "unexpected symbol near '='" } : { ok: true, line: 0, message: "" }
  }
  const result = render(<ScriptEditor path="res://scripts/a.lua" text="x = 1" readOnly={false} onChange={() => {}} checkSyntax={checkSyntax} />)
  const view = viewOf()
  assert.equal(asked.length, 0, "nothing is asked before the debounce")
  result.rerender(<ScriptEditor path="res://scripts/a.lua" text={"x ==\n"} readOnly={false} onChange={() => {}} checkSyntax={checkSyntax} />)
  await waitFor(() => assert.ok(view.dom.querySelector(".cm-lintRange-error")), { timeout: 3000 })
  assert.deepEqual(asked, ["res://scripts/a.lua|x ==\n"], "only the newest text was checked")
  assert.ok(screen.getByRole("status").textContent?.includes("1 syntax error"))
  const marks: string[] = []
  forEachDiagnostic(view.state, (d, from, to) => marks.push(`${from}-${to}:${d.message}`))
  assert.deepEqual(marks, ["2-3:unexpected symbol near '='"])
  result.rerender(<ScriptEditor path="res://scripts/a.lua" text={"x = 2\n"} readOnly={false} onChange={() => {}} checkSyntax={checkSyntax} />)
  await waitFor(() => assert.equal(view.dom.querySelector(".cm-lintRange-error"), null), { timeout: 3000 })
  assert.equal(screen.queryByRole("status"), null)
})

test("a read-only editor still lints, a non-Lua file never does and a host that cannot check shows no squiggles", async () => {
  const bad = async () => ({ ok: false, line: 1, message: "bad" })
  let asked = 0
  const counting = async () => { asked++; return bad() }
  render(<ScriptEditor path="res://scripts/a.lua" text="oops" readOnly={true} onChange={() => {}} checkSyntax={counting} />)
  await waitFor(() => assert.ok(viewOf().dom.querySelector(".cm-lintRange-error")), { timeout: 3000 })
  cleanup()
  asked = 0
  render(<ScriptEditor path="res://data/a.json" text="{" readOnly={false} onChange={() => {}} checkSyntax={counting} />)
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.equal(asked, 0)
  assert.equal(viewOf().dom.querySelector(".cm-lintRange-error"), null)
  cleanup()
  render(<ScriptEditor path="res://scripts/a.lua" text="oops" readOnly={false} onChange={() => {}} />)
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.equal(viewOf().dom.querySelector(".cm-lintRange-error"), null)
})

test("a failing check says it is unavailable instead of marking the code", async () => {
  render(<ScriptEditor path="res://scripts/a.lua" text="x = 1" readOnly={false} onChange={() => {}} checkSyntax={async () => { throw new Error("connection lost") }} />)
  await waitFor(() => assert.match(screen.getByRole("status").textContent ?? "", /Syntax check unavailable: connection lost/), { timeout: 3000 })
  assert.equal(viewOf().dom.querySelector(".cm-lintRange-error"), null)
})
