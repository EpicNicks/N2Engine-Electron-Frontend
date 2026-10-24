import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { IpcMain } from "electron"
import { HostSettings } from "../main/host-settings"
import { registerPreferencesIpc } from "../main/preferences-ipc"
import { Channels, type HostPreferencesState, type PreferencesApi } from "../shared/api"
import { parseHostLaunchPreferences } from "../shared/host-preferences"
import { PrefsStore, type KeyValueStore } from "../renderer/prefs"
import { PreferencesState } from "../renderer/preferences-state"
import { ViewportToolPref, ViewportSnapPref } from "../renderer/viewport-tool-prefs"

const initial = (): HostPreferencesState => ({ settings: { hostPath: "", renderer: "", readyTimeoutMs: 30000 }, location: { path: null, source: null, problem: null } })
class Memory implements KeyValueStore {
  values = new Map<string, string>(); broken = false
  get(key: string) { return this.values.get(key) ?? null }
  set(key: string, value: string) { if (this.broken) throw new Error("Storage blocked"); this.values.set(key, value) }
  remove(key: string) { this.values.delete(key) }
}
function rig() {
  const storage = new Memory(), prefs = new PrefsStore(storage), saved: unknown[] = [], applied: unknown[] = []
  const api: PreferencesApi = { getHost: async () => initial(), chooseHostPath: async () => "C:/chosen/host.exe",
    saveHost: async settings => { saved.push(settings); return { ...initial(), settings } } }
  const model = new PreferencesState(api, prefs, tool => applied.push(tool))
  return { storage, prefs, saved, applied, api, model }
}

test("host settings round-trip, preserve unknown keys, filter secrets from renderer, and clear to environment/default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2-prefs-"))
  try {
    const file = path.join(dir, "settings.json"), host = path.join(dir, "host.exe")
    fs.writeFileSync(host, "")
    fs.writeFileSync(file, JSON.stringify({ other: { keep: true }, token: "main-only" }))
    const settings = new HostSettings(file, { N2ENGINE_HOST: host })
    const result = settings.savePreferences({ hostPath: host, renderer: "software", readyTimeoutMs: 45000, secret: "ignored" })
    assert.equal(result.settings.hostPath, host); assert.equal(result.settings.renderer, "software")
    assert.equal(settings.readyTimeoutMs(), 45000); assert.equal(settings.require(), host)
    assert.ok(!JSON.stringify(result).includes("main-only"))
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { other: { keep: true }, token: "main-only", hostPath: host, renderer: "software", readyTimeoutMs: 45000 })
    const cleared = settings.savePreferences({ hostPath: "  ", renderer: "", readyTimeoutMs: 30000 })
    assert.equal(cleared.location.source, "env"); assert.equal(cleared.settings.hostPath, ""); assert.equal(settings.renderer(), undefined)
    assert.deepEqual(new HostSettings(file, {}).preferences().settings, cleared.settings)
    const before = fs.readFileSync(file, "utf8")
    assert.throws(() => settings.savePreferences({ hostPath: path.join(dir, "missing"), renderer: "opengl", readyTimeoutMs: 30000 }), /Not found/)
    assert.equal(fs.readFileSync(file, "utf8"), before)
    fs.writeFileSync(file, "{broken")
    assert.throws(() => settings.preferences(), /Couldn.t read editor settings/)
    assert.throws(() => settings.savePreferences(initial().settings))
    assert.equal(fs.readFileSync(file, "utf8"), "{broken", "a broken file is not silently replaced")
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test("Preferences reads default only for a missing file and surface malformed or unreadable settings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2-prefs-read-"))
  try {
    const file = path.join(dir, "settings.json"), settings = new HostSettings(file, {})
    assert.deepEqual(settings.preferences(), initial())
    for (const raw of ["null", "[]", "{broken"]) {
      fs.writeFileSync(file, raw); assert.throws(() => settings.preferences(), /Couldn.t read editor settings/)
    }
    fs.rmSync(file); fs.mkdirSync(file)
    assert.throws(() => settings.preferences(), /Couldn.t read editor settings/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test("launch preferences reject malformed inputs before anything can be persisted", () => {
  for (const invalid of [null, [], true, { ...initial().settings, renderer: "vulkan" }, { ...initial().settings, hostPath: "a\0b" },
    ...[0, -1, 999, 300001, 1000.5, Infinity, NaN, "30000"].map(readyTimeoutMs => ({ ...initial().settings, readyTimeoutMs }))])
    assert.throws(() => parseHostLaunchPreferences(invalid))
  assert.equal(parseHostLaunchPreferences({ ...initial().settings, readyTimeoutMs: 1000 }).readyTimeoutMs, 1000)
  assert.equal(parseHostLaunchPreferences({ ...initial().settings, readyTimeoutMs: 300000 }).readyTimeoutMs, 300000)
})

test("preferences IPC is editor-frame-only, stages the picker, validates writes and never controls a host session", async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const frame = { url: "file:///editor/index.html" }, editor = { mainFrame: frame }
  let picks = 0, saves = 0
  registerPreferencesIpc({ handle: (channel: string, fn: typeof handlers extends Map<string, infer T> ? T : never) => handlers.set(channel, fn) } as unknown as IpcMain,
    { page: { getEditor: () => editor as never, url: frame.url }, settings: { preferences: initial, savePreferences: (raw: unknown) => { saves++; return { ...initial(), settings: parseHostLaunchPreferences(raw) } } } as HostSettings,
      chooseHostPath: async () => { picks++; return "chosen.exe" } })
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: editor, senderFrame: frame }, ...args)
  assert.deepEqual(await invoke(Channels.preferencesChooseHost), { ok: true, value: "chosen.exe" }); assert.equal(picks, 1); assert.equal(saves, 0)
  assert.deepEqual(await invoke(Channels.preferencesGetHost), { ok: true, value: initial() })
  assert.equal((await invoke(Channels.preferencesSaveHost, { ...initial().settings, renderer: "bad" }) as { ok: boolean }).ok, false)
  const denied = await handlers.get(Channels.preferencesGetHost)!({ sender: editor, senderFrame: { url: frame.url } }) as { ok: boolean }
  assert.equal(denied.ok, false)
})

test("draft edits and browsing are isolated until Save; user viewport scope round-trips without touching project preferences", async () => {
  const r = rig(); await r.model.load()
  r.prefs.project("project1").set(ViewportSnapPref, ViewportSnapPref.default, { immediate: true })
  const projectBefore = r.storage.values.get("n2.prefs.project.project1.viewport.snap")
  await r.model.browse(); assert.equal(r.saved.length, 0); assert.equal(r.model.dirty.value, true)
  r.model.viewport.value = { mode: "rotate", space: "local", pivot: "center" }
  assert.equal(r.prefs.user.get(ViewportToolPref).mode, "translate")
  assert.equal(await r.model.save(), true)
  assert.equal(r.saved.length, 1); assert.equal(r.applied.length, 1); assert.equal(r.model.dirty.value, false)
  assert.deepEqual(new PrefsStore(r.storage).user.get(ViewportToolPref), r.model.viewport.value)
  assert.equal(r.storage.values.get("n2.prefs.project.project1.viewport.snap"), projectBefore)
})

test("validation and main-process write failures retain the draft and never apply viewport changes", async () => {
  const r = rig(); await r.model.load(); r.model.host.value = { ...r.model.host.value, readyTimeoutMs: NaN }
  assert.equal(await r.model.save(), false); assert.equal(r.saved.length, 0); assert.match(r.model.error.value!, /timeout/)
  r.model.host.value = { ...initial().settings, renderer: "software" }
  r.api.saveHost = async () => { throw new Error("Disk full") }
  assert.equal(await r.model.save(), false); assert.match(r.model.error.value!, /Disk full/)
  assert.equal(r.model.dirty.value, true); assert.equal(r.applied.length, 0)
})

test("local user settings work independently of a read-only, playing, remote, or unavailable host", async () => {
  const r = rig()
  r.api.getHost = async () => ({ ...initial(), settings: { ...initial().settings, hostPath: "missing.exe" }, location: { path: "missing.exe", source: "setting", problem: "Not found" } })
  r.api.saveHost = async () => { throw new Error("Must not save unchanged host settings") }
  await r.model.load(); r.model.viewport.value = { mode: "scale", space: "world", pivot: "pivot" }
  assert.equal(await r.model.save(), true); assert.equal(r.applied.length, 1)
})

test("blocked local storage gives an explicit session-only warning; host-only saves do not depend on renderer storage", async () => {
  const r = rig(); await r.model.load(); r.storage.broken = true
  r.model.host.value = { ...initial().settings, renderer: "opengl" }
  assert.equal(await r.model.save(), true)
  r.model.viewport.value = { mode: "scale", space: "local", pivot: "center" }
  assert.equal(await r.model.save(), false); assert.match(r.model.warning.value!, /session.*local storage/)
  assert.equal(r.prefs.user.get(ViewportToolPref).mode, "scale")
  assert.equal(r.model.dirty.value, false)
})

test("load and picker failures are visible, and disposed dialogs ignore late results", async () => {
  const r = rig(); r.api.getHost = async () => { throw new Error("Read denied") }
  await r.model.load(); assert.match(r.model.error.value!, /Read denied/)
  r.api.getHost = async () => initial(); await r.model.load()
  r.api.chooseHostPath = async () => { throw new Error("Picker failed") }; await r.model.browse(); assert.match(r.model.error.value!, /Picker failed/)
  let resolve!: (value: HostPreferencesState) => void
  r.api.getHost = () => new Promise(done => resolve = done)
  const pending = r.model.load(); r.model.dispose(); resolve({ ...initial(), settings: { ...initial().settings, hostPath: "late.exe" } }); await pending
  assert.equal(r.model.host.value.hostPath, "")
})
