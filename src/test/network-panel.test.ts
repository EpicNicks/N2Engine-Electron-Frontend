// The Network panel's rules without a DOM (protocol 1.21.0): the answers' shape checks, the patch of a tunable row, the
// range check, and the state's guards (capability, read-only, unavailable preset, fixes through SetProjectSettings).
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { signal } from "@preact/signals-core"
import {
  checkNumber,
  formatValue,
  mergePatches,
  networkPatchOf,
  validateNetworkSettingsInfo,
  validateNetworkValidationReport,
} from "../protocol/network-panel"
import { NetworkPanelModel, NetworkUnsupportedReason } from "../renderer/network-panel-state"
import { applyMergePatch, type Json, type JsonObject } from "../renderer/project-settings-schema"
import { ipcError } from "../shared/api"
import { fakeNetworkAnswers, fakeSetNetwork, type FakeNetworkOptions } from "./fake-network"

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function modelOf(options: { settings?: JsonObject; supported?: boolean; readOnly?: string | null; network?: FakeNetworkOptions; refuse?: string } = {}) {
  let settings: unknown = options.settings ?? {}
  const connected = signal(true)
  const supported = signal(options.supported !== false)
  const readOnlyReason = signal<string | null>(options.readOnly ?? null)
  const sets: Array<{ preset: string; settings: JsonObject }> = []
  const projectPatches: JsonObject[] = []
  const model = new NetworkPanelModel({
    getNetworkSettings: async () => fakeNetworkAnswers(settings, options.network).info,
    getNetworkValidation: async (preset) => fakeNetworkAnswers(settings, options.network).report(preset),
    setNetworkSettings: async (preset, patch) => {
      sets.push({ preset, settings: patch })
      if (options.refuse) throw ipcError({ error: options.refuse })
      const result = fakeSetNetwork(settings, preset, patch, options.network)
      if ("error" in result) throw ipcError({ error: result.error })
      settings = result.settings
      return fakeNetworkAnswers(settings, options.network).info
    },
    setProjectSettings: async (patch) => {
      projectPatches.push(patch)
      settings = applyMergePatch(settings as Json, patch as Json)
      return {} as never
    },
    connected,
    supported,
    readOnlyReason,
  })
  return { model, connected, supported, readOnlyReason, sets, projectPatches, settings: () => settings }
}

describe("the shape checks", () => {
  const { info, report } = fakeNetworkAnswers({ network: { preset: "authoritative" } })
  test("accept the documented shape", () => {
    assert.deepEqual(validateNetworkSettingsInfo(info), info)
    assert.deepEqual(validateNetworkValidationReport(report("")), report(""))
  })
  test("reject a missing or mistyped field", () => {
    assert.throws(() => validateNetworkSettingsInfo(null), /object/)
    assert.throws(() => validateNetworkSettingsInfo({ ...info, preset: 1 }), /preset must be a string/)
    assert.throws(() => validateNetworkSettingsInfo({ ...info, customised: "no" }), /booleans/)
    assert.throws(() => validateNetworkSettingsInfo({ ...info, ranges: [{ key: "x" }] }), /ranges/)
    assert.throws(() => validateNetworkSettingsInfo({ ...info, nudge: { show: true } }), /nudge/)
    assert.throws(() => validateNetworkSettingsInfo({ ...info, backend: { selected: "physx" } }), /backend/)
    assert.throws(() => validateNetworkValidationReport({ ...report(""), requirements: [{ id: "x" }] }), /requirements/)
    assert.throws(() => validateNetworkValidationReport({ ...report(""), warnings: [1] }), /warnings/)
  })
})

describe("the helpers", () => {
  test("a setting key is a path inside the network block", () => {
    assert.deepEqual(networkPatchOf("network.tickRate", 30), { tickRate: 30 })
    assert.deepEqual(networkPatchOf("network.authoritative.snapshotRate", null), { authoritative: { snapshotRate: null } })
    assert.equal(networkPatchOf("physics.gpu", "off"), null)
    assert.equal(networkPatchOf("network.", 1), null)
  })
  test("patches merge by object", () => {
    assert.deepEqual(mergePatches({ authoritative: { a: 1 }, tickRate: 30 }, { authoritative: { b: 2 } }), { authoritative: { a: 1, b: 2 }, tickRate: 30 })
  })
  test("a typed number is checked against the host's range", () => {
    const range = { key: "network.tickRate", min: 30, max: 120, default: 60, integer: true }
    assert.deepEqual(checkNumber("45", range), { value: 45 })
    assert.deepEqual(checkNumber("29", range), { error: "Must be between 30 and 120" })
    assert.deepEqual(checkNumber("45.5", range), { error: "Must be a whole number" })
    assert.deepEqual(checkNumber("", range), { error: "Enter a number" })
    assert.deepEqual(checkNumber("abc", range), { error: "abc is not a number" })
    assert.deepEqual(checkNumber("0.5", { ...range, integer: false, min: 0.01, max: 100 }), { value: 0.5 })
  })
  test("values are shown as text", () => {
    assert.equal(formatValue(null), "–")
    assert.equal(formatValue(true), "on")
    assert.equal(formatValue(0.5), "0.5")
    assert.equal(formatValue("off"), "off")
  })
})

describe("the network panel state", () => {
  test("reads nothing without the capability and says why", async () => {
    const h = modelOf({ supported: false })
    await h.model.refresh()
    assert.equal(h.model.info.value, null)
    assert.equal(h.model.readBlockedReason, NetworkUnsupportedReason)
    assert.equal(await h.model.choosePreset("authoritative"), false)
  })

  test("reads the settings and the project's own validation", async () => {
    const h = modelOf({ settings: { network: { preset: "authoritative" } } })
    await h.model.refresh()
    assert.equal(h.model.info.value?.preset, "authoritative")
    assert.equal(h.model.viewedId, "authoritative")
    assert.equal(h.model.report.value?.preset, "authoritative")
  })

  test("Deterministic is not selectable when no backend can carry it, with the host's reason", async () => {
    const h = modelOf({ network: { deterministicBackends: [] } })
    await h.model.refresh()
    const det = h.model.info.value!.presets.find((p) => p.id === "deterministic")!
    assert.equal(det.selectable, false)
    assert.match(h.model.presetBlockReason(det)!, /does not declare CrossPlatform determinism/)
    assert.equal(await h.model.choosePreset("deterministic"), false)
    assert.deepEqual(h.sets, [])
  })

  test("choosing a preset sends it with no settings, shows the host's answer and the new report", async () => {
    const h = modelOf()
    await h.model.refresh()
    assert.equal(await h.model.choosePreset("authoritative"), true)
    assert.deepEqual(h.sets, [{ preset: "authoritative", settings: {} }])
    assert.equal(h.model.info.value?.preset, "authoritative")
    assert.equal(h.model.lastSaved.value, "preset authoritative")
    assert.equal(h.model.report.value?.preset, "authoritative")
  })

  test("the host's refusal is kept as it said it, and nothing changes", async () => {
    const h = modelOf({ refuse: "Not available in a play host" })
    await h.model.refresh()
    assert.equal(await h.model.choosePreset("authoritative"), false)
    assert.equal(h.model.error.value, "Not available in a play host")
    assert.equal(h.model.info.value?.preset, "none")
  })

  test("writes are off when read-only, but reading and viewing another bundle still work", async () => {
    const h = modelOf({ readOnly: "viewer" })
    await h.model.refresh()
    assert.match(h.model.disabledReason!, /Read-only/)
    assert.equal(await h.model.choosePreset("authoritative"), false)
    await h.model.view("deterministic")
    assert.equal(h.model.report.value?.preset, "deterministic")
    assert.equal(h.model.viewingProjectPreset, false)
  })

  test("only the project's preset has editable rows, and only tunable rows with a network setting", async () => {
    const h = modelOf({ settings: { network: { preset: "authoritative" } } })
    await h.model.refresh()
    const rows = h.model.viewedPreset!.rows
    const byKey = (key: string) => rows.find((r) => r.key === key)!
    assert.equal(h.model.rowEditable(byKey("network.tickRate")), true)
    // tunable but under physics.*: SetNetworkSettings can't write it
    assert.equal(h.model.rowEditable(byKey("physics.gpu")), false)
    assert.equal(h.model.rowEditable(byKey("build.strictFp")), false)
    await h.model.view("deterministic")
    assert.equal(h.model.rowEditable(h.model.viewedPreset!.rows.find((r) => r.key === "network.tickRate")!), false)
  })

  test("edits become a minimal merge patch, checked against the ranges, and are sent with an empty preset", async () => {
    const h = modelOf({ settings: { network: { preset: "authoritative" } } })
    await h.model.refresh()
    const rows = h.model.viewedPreset!.rows
    const tick = rows.find((r) => r.key === "network.tickRate")!
    const snap = rows.find((r) => r.key === "state.sync")!
    h.model.setDraft(tick, "200")
    assert.match(h.model.draftError(tick)!, /between 30 and 120/)
    assert.equal(h.model.canApply, false)
    assert.equal(await h.model.apply(), false)
    h.model.setDraft(tick, "120")
    h.model.setDraft(snap, "20")
    assert.deepEqual(h.model.build(), { patch: { tickRate: 120, authoritative: { snapshotRate: 20 } }, errors: [] })
    assert.equal(await h.model.apply(), true)
    assert.deepEqual(h.sets, [{ preset: "", settings: { tickRate: 120, authoritative: { snapshotRate: 20 } } }])
    assert.deepEqual(h.model.drafts.value, {})
    assert.equal(h.model.lastSaved.value, "settings")
    assert.equal(h.model.viewedPreset!.rows.find((r) => r.key === "network.tickRate")!.current, 120)
  })

  test("a reset row sends null, which returns the setting to its default", async () => {
    const h = modelOf({ settings: { network: { preset: "authoritative", tickRate: 30 } } })
    await h.model.refresh()
    const tick = h.model.viewedPreset!.rows.find((r) => r.key === "network.tickRate")!
    h.model.resetDraft(tick)
    assert.equal(h.model.textOf(tick), "60")
    assert.deepEqual(h.model.build().patch, { tickRate: null })
  })

  test("a fix applies its patch through SetProjectSettings (not SetNetworkSettings) and the report is read again", async () => {
    const h = modelOf({ settings: { network: { preset: "deterministic" }, physics: { backend: "jolt" } }, network: { deterministicBackends: ["jolt"] } })
    await h.model.refresh()
    const unmet = h.model.report.value!.requirements.filter((r) => !r.met).map((r) => r.id)
    assert.deepEqual(unmet, ["simd-scalar", "gpu-physics-off"])
    assert.equal(h.model.report.value!.refused, true)
    assert.equal(await h.model.applyFix("simd-scalar"), true)
    assert.deepEqual(h.projectPatches, [{ math: { simdTier: "scalar" } }])
    assert.deepEqual(h.sets, [])
    assert.deepEqual(
      h.model.report.value!.requirements.filter((r) => !r.met).map((r) => r.id),
      ["gpu-physics-off"]
    )
    assert.equal(h.model.lastSaved.value, "fix: Set math.simdTier to scalar")
    await h.model.applyFix("gpu-physics-off")
    assert.equal(h.model.report.value!.refused, false)
  })

  test("a requirement with no fix, or a fix while read-only, is not applied", async () => {
    const h = modelOf({ settings: { network: { preset: "deterministic" }, physics: { backend: "jolt" } } })
    await h.model.refresh()
    assert.equal(await h.model.applyFix("strict-fp"), false)
    h.readOnlyReason.value = "a game is running"
    assert.equal(await h.model.applyFix("simd-scalar"), false)
    assert.deepEqual(h.projectPatches, [])
  })

  test("the newest read wins", async () => {
    const h = modelOf()
    const first = h.model.refresh()
    const second = h.model.refresh()
    await Promise.all([first, second, settle()])
    assert.equal(h.model.info.value?.preset, "none")
  })
})
