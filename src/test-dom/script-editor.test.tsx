/// <reference path="../renderer/globals.d.ts" />
import "./setup"
import { test } from "node:test"
import * as assert from "node:assert/strict"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/preact"
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
