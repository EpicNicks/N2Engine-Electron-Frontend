/// <reference path="../renderer/globals.d.ts" />
import "./setup"
import { afterEach, test } from "node:test"
import * as assert from "node:assert/strict"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/preact"
import type { HostPreferencesState, PreferencesApi } from "../shared/api"
import { PreferencesDialog } from "../renderer/preferences-dialog"
import { showPreferences, closePreferences } from "../renderer/preferences-request"
import { modalOpen } from "../renderer/ui"
import { PrefsStore } from "../renderer/prefs"
import { ViewportToolPref } from "../renderer/viewport-tool-prefs"

afterEach(() => closePreferences())
function setup() {
  const data = new Map<string, string>(), writes: unknown[] = [], applied: unknown[] = []
  const prefs = new PrefsStore({ get: key => data.get(key) ?? null, set: (key, value) => { data.set(key, value) }, remove: key => { data.delete(key) } })
  const initial: HostPreferencesState = { settings: { hostPath: "", renderer: "", readyTimeoutMs: 30000 }, location: { path: "C:/engine/N2EditorHost.exe", source: "env", problem: null } }
  const api: PreferencesApi = { getHost: async () => initial, chooseHostPath: async () => "C:/chosen/N2EditorHost.exe",
    saveHost: async settings => { writes.push(settings); return { ...initial, settings } } }
  act(() => showPreferences())
  render(<PreferencesDialog api={api} prefs={prefs} onSaved={tool => applied.push(tool)} />)
  return { api, prefs, writes, applied }
}
const ready = async () => waitFor(() => assert.equal((screen.getByRole("button", { name: "Browse..." }) as HTMLButtonElement).disabled, false))

test("accessible local preferences load, browse stages, and Save round-trips host and user values without a project provider", async () => {
  const r = setup(); await ready()
  assert.ok(screen.getByRole("dialog", { name: "Preferences" })); assert.equal(modalOpen(), true)
  assert.match(screen.getByText(/Changes apply to the next/).textContent!, /does not restart/)
  fireEvent.click(screen.getByRole("button", { name: "Browse..." }))
  await waitFor(() => assert.equal((screen.getByLabelText("N2EditorHost executable") as HTMLInputElement).value, "C:/chosen/N2EditorHost.exe"))
  assert.equal(r.writes.length, 0)
  fireEvent.change(screen.getByLabelText("Renderer"), { target: { value: "software" } })
  fireEvent.input(screen.getByLabelText("Startup timeout (seconds)"), { target: { value: "45" } })
  fireEvent.change(screen.getByLabelText("Tool"), { target: { value: "rotate" } })
  fireEvent.click(screen.getByRole("button", { name: "Save preferences" }))
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null))
  assert.deepEqual(r.writes, [{ hostPath: "C:/chosen/N2EditorHost.exe", renderer: "software", readyTimeoutMs: 45000 }])
  assert.equal(r.prefs.user.get(ViewportToolPref).mode, "rotate"); assert.equal(r.applied.length, 1); assert.equal(modalOpen(), false)
})

test("Cancel and Escape ask before discarding dirty drafts and do not write anything", async () => {
  const r = setup(); await ready()
  fireEvent.input(screen.getByLabelText("N2EditorHost executable"), { target: { value: "unsaved.exe" } })
  fireEvent.keyDown(screen.getByLabelText("N2EditorHost executable"), { key: "Escape" })
  assert.ok(screen.getByRole("group", { name: "Discard unsaved preferences" }))
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))
  assert.equal((screen.getByLabelText("N2EditorHost executable") as HTMLInputElement).value, "unsaved.exe")
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }))
  assert.equal(screen.queryByRole("dialog"), null); assert.equal(r.writes.length, 0); assert.equal(r.applied.length, 0)
})

test("main-process save errors stay in the dialog with the user's values, and retry saves", async () => {
  const r = setup(); await ready()
  const original = r.api.saveHost
  r.api.saveHost = async () => { throw new Error("Permission denied writing settings.json") }
  fireEvent.change(screen.getByLabelText("Renderer"), { target: { value: "opengl" } })
  fireEvent.click(screen.getByRole("button", { name: "Save preferences" }))
  await waitFor(() => assert.match(screen.getByRole("alert").textContent!, /Permission denied/))
  assert.equal((screen.getByLabelText("Renderer") as HTMLSelectElement).value, "opengl")
  r.api.saveHost = original; fireEvent.click(screen.getByRole("button", { name: "Save preferences" }))
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null))
})

test("focus cycles inside the dialog and returns to its opener on cancel", async () => {
  const opener = document.createElement("button"); opener.textContent = "Open preferences"; document.body.append(opener); opener.focus()
  setup(); await ready()
  assert.equal(document.activeElement, screen.getByRole("heading", { name: "Preferences" }), "opening focuses the title without scrolling a narrow dialog to its footer")
  const first = screen.getByLabelText("N2EditorHost executable"), cancel = screen.getByRole("button", { name: "Cancel" })
  first.focus(); fireEvent.keyDown(first, { key: "Tab", shiftKey: true })
  assert.equal(document.activeElement, cancel, "disabled Save is excluded from the focus cycle")
  fireEvent.keyDown(cancel, { key: "Tab" }); assert.equal(document.activeElement, first)
  fireEvent.click(cancel); await waitFor(() => assert.equal(document.activeElement, opener)); opener.remove()
})
