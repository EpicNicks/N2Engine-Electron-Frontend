// A stand-in for the host's network panel (protocol 1.21.0), for the panel tests: it derives GetNetworkSettings and
// GetNetworkValidation answers from a project settings object the way the engine's NetworkPanel does (a trimmed table of
// rows: enough locked, tunable, startup-checked and build rows to draw every case), and applies SetNetworkSettings as a
// merge patch of the network block with the engine's refusals. The row table and the wording are the test's own, not the
// engine's; the shapes are the engine's (checked against NetworkPanel.cpp and the golden vectors).
import type {
  NetworkPresetInfo,
  NetworkRequirementInfo,
  NetworkSettingRange,
  NetworkSettingRow,
  NetworkSettingsInfo,
  NetworkValidationReport,
} from "../protocol/protocol.generated"
import { applyMergePatch, type Json, type JsonObject } from "../renderer/project-settings-schema"

const Ranges: NetworkSettingRange[] = [
  { key: "network.tickRate", min: 30, max: 120, default: 60, integer: true },
  { key: "network.authoritative.snapshotRate", min: 10, max: 60, default: 30, integer: true },
  { key: "network.authoritative.snapThreshold", min: 0.01, max: 100, default: 1, integer: false },
  { key: "network.deterministic.rollbackWindow", min: 0, max: 15, default: 8, integer: true },
]

const Defaults: Record<string, unknown> = {
  "network.tickRate": 60,
  "network.authoritative.snapshotRate": 30,
  "network.authoritative.snapThreshold": 1,
  "network.deterministic.rollbackWindow": 8,
  "network.deterministic.mode": "lockstep",
  "network.transport.udp": true,
  "physics.gpu": "auto",
  "math.simdTier": "auto",
}

const find = (settings: unknown, path: string): unknown => {
  let node: unknown = settings
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

type Cell = { locked?: boolean; tunable?: boolean; startup?: boolean; value?: unknown; settingKey?: string; lost?: string; description?: string }
const none: Cell = {}
type RowDef = { key: string; label: string; cells: [Cell, Cell, Cell] }

const Table: RowDef[] = [
  {
    key: "physics.gpu",
    label: "GPU physics",
    cells: [none, { tunable: true, value: "off", settingKey: "physics.gpu", description: "off recommended" }, { locked: true, startup: true, value: "off", settingKey: "physics.gpu", lost: "GPU dynamics is not deterministic: peers desync", description: "off" }],
  },
  {
    key: "math.simdTier",
    label: "Math SIMD tier",
    cells: [none, none, { locked: true, startup: true, value: "scalar", settingKey: "math.simdTier", lost: "SIMD tier Auto: x86 and ARM peers will desync", description: "scalar" }],
  },
  {
    key: "build.strictFp",
    label: "Floating-point build profile",
    cells: [none, none, { locked: true, startup: true, lost: "Fused multiply-add may differ between builds: peers desync", description: "the strict profile is compiled in" }],
  },
  {
    key: "network.tickRate",
    label: "Tick rate",
    cells: [none, { tunable: true, value: 60, settingKey: "network.tickRate", description: "30, 60 or 120 Hz" }, { tunable: true, value: 60, settingKey: "network.tickRate", description: "30, 60 or 120 Hz" }],
  },
  {
    key: "state.sync",
    label: "State sync / snapshot rate",
    cells: [none, { tunable: true, value: 30, settingKey: "network.authoritative.snapshotRate", description: "20-30 Hz" }, none],
  },
  {
    key: "network.authoritative.snapThreshold",
    label: "Snap threshold",
    cells: [none, { tunable: true, value: 1, settingKey: "network.authoritative.snapThreshold", description: "metres" }, none],
  },
  {
    key: "network.deterministic.mode",
    label: "Deterministic mode",
    cells: [none, none, { tunable: true, value: "lockstep", settingKey: "network.deterministic.mode", description: "lockstep or rollback" }],
  },
  {
    key: "network.transport.udp",
    label: "UDP transport",
    cells: [none, { tunable: true, value: true, settingKey: "network.transport.udp", description: "native UDP" }, { tunable: true, value: true, settingKey: "network.transport.udp", description: "native UDP" }],
  },
]

const Presets = [
  { id: "none", label: "None", summary: "Offline. No network model." },
  { id: "authoritative", label: "Server authoritative", summary: "A server simulates the game." },
  { id: "deterministic", label: "Deterministic lockstep/rollback", summary: "Every peer runs the same simulation from the same inputs." },
]

export interface FakeNetworkOptions {
  /** The backends of the build that can carry Deterministic (default ["jolt"]); empty makes Deterministic unavailable */
  deterministicBackends?: string[]
  /** The open scene's NetworkObject count, for the nudge (default 0) */
  networkObjects?: number
  /** Whether the build has strict FP (default true) */
  strictFp?: boolean
  /** Whether the host reports values.authoritative.timeDilation (protocol 1.23.0; default true, false for a 1.22 host) */
  timeDilation?: boolean
}

/** The engine's read of network.authoritative.timeDilation: defaults off, 0.9, 1.1; scales clamped 0.5-1 and 1-2 */
function readTimeDilation(settings: unknown): { values: { enabled: boolean; minScale: number; maxScale: number }; problems: string[] } {
  const problems: string[] = []
  const values = { enabled: false, minScale: 0.9, maxScale: 1.1 }
  const block = find(settings, "network.authoritative.timeDilation")
  if (block === undefined || block === null) return { values, problems }
  const enabled = find(block, "enabled")
  if (typeof enabled === "boolean") values.enabled = enabled
  else if (enabled !== undefined && enabled !== null) problems.push("network.authoritative.timeDilation.enabled must be a boolean")
  for (const [field, min, max] of [["minScale", 0.5, 1], ["maxScale", 1, 2]] as const) {
    const v = find(block, field)
    if (v === undefined || v === null) continue
    if (typeof v !== "number") {
      problems.push(`network.authoritative.timeDilation.${field} must be a number`)
      continue
    }
    if (v < min || v > max) problems.push(`network.authoritative.timeDilation.${field} must be between ${min} and ${max}`)
    values[field] = Math.min(max, Math.max(min, v))
  }
  return { values, problems }
}

/** The host's answers for a project settings object */
export function fakeNetworkAnswers(settings: unknown, options: FakeNetworkOptions = {}) {
  const selectable = options.deterministicBackends ?? ["jolt"]
  const strictFp = options.strictFp !== false
  const preset = String(find(settings, "network.preset") ?? "none").toLowerCase()
  const backend = String(find(settings, "physics.backend") ?? "physx")
  const unavailable = selectable.includes(backend)
    ? ""
    : `The physics backend ${backend} does not declare CrossPlatform determinism and every feature group; qualifying backends in this build: ${selectable.length === 0 ? "none" : selectable.join(", ")}.`
  const currentOf = (key: string): unknown => {
    const v = find(settings, key)
    return v === undefined ? (Defaults[key] ?? null) : v
  }
  const sourceOf = (key: string | undefined): string => (key === undefined ? "build" : find(settings, key) !== undefined ? "project" : "default")

  const rowsOf = (index: number): NetworkSettingRow[] =>
    Table.map((def) => {
      const cell = def.cells[index]
      const row: NetworkSettingRow = {
        key: def.key,
        label: def.label,
        governed: cell !== none,
        locked: cell.locked === true,
        tunable: cell.tunable === true,
        startupChecked: cell.startup === true,
        value: cell.value ?? null,
        description: cell.description ?? "any",
        source: sourceOf(cell.settingKey),
      }
      if (cell.settingKey !== undefined) {
        row.settingKey = cell.settingKey
        row.current = currentOf(cell.settingKey)
        row.atPresetValue = cell.value !== undefined && row.current === cell.value
      }
      if (cell.lost !== undefined) row.lostGuarantee = cell.lost
      return row
    })

  const presets: NetworkPresetInfo[] = Presets.map((p, i) => {
    const info: NetworkPresetInfo = { ...p, selected: p.id === preset, selectable: p.id !== "deterministic" || unavailable === "", rows: rowsOf(i) }
    if (!info.selectable) info.unavailableReason = unavailable
    return info
  })

  const index = Presets.findIndex((p) => p.id === preset)
  const lostGuarantees = Table.flatMap((def) => {
    const cell = def.cells[Math.max(0, index)]
    if (!cell.locked || cell.settingKey === undefined || find(settings, cell.settingKey) === undefined) return []
    return find(settings, cell.settingKey) === cell.value ? [] : [{ settingKey: cell.settingKey, rowKey: def.key, text: cell.lost ?? "" }]
  })
  const hasBlockSettings = find(settings, "network") !== undefined && Object.keys(find(settings, "network") as object).some((k) => k !== "preset")
  const reasons = [...((options.networkObjects ?? 0) > 0 ? ["scene"] : []), ...(hasBlockSettings ? ["settings"] : [])]
  const show = preset === "none" && reasons.length > 0

  const dilation = readTimeDilation(settings)
  const info: NetworkSettingsInfo = {
    preset,
    customised: lostGuarantees.length > 0,
    storedCustomised: false,
    tickRate: Number(currentOf("network.tickRate")),
    values: options.timeDilation === false ? {} : { authoritative: { timeDilation: dilation.values } },
    overrides: {},
    ranges: Ranges,
    lostGuarantees,
    presets,
    backend: { selected: backend, deterministicSelectable: selectable },
    nudge: {
      show,
      reasons,
      networkObjects: options.networkObjects ?? 0,
      hint: show ? "The project has network settings but no network model (network.preset is none). Choose Server authoritative or Deterministic." : "",
    },
    problems: options.timeDilation === false ? [] : dilation.problems,
  }

  const report = (asked: string): NetworkValidationReport => {
    const checked = (asked === "" ? preset : asked.toLowerCase()) as "none" | "authoritative" | "deterministic"
    const requirements: NetworkRequirementInfo[] = []
    const warnings: string[] = []
    if (checked === "deterministic") {
      const backendMet = selectable.includes(backend)
      requirements.push({
        id: "physics-backend",
        text: "The physics backend declares cross-platform determinism",
        met: backendMet,
        detail: backendMet ? "" : `Backend ${backend} declares SameBinary`,
        ...(backendMet || selectable.length === 0 ? {} : { fix: { label: `Use the ${selectable[0]} backend with physics.deterministic on`, settings: { physics: { backend: selectable[0], deterministic: true } } } }),
      })
      const simdMet = currentOf("math.simdTier") === "scalar"
      requirements.push({
        id: "simd-scalar",
        text: "math.simdTier is scalar",
        met: simdMet,
        detail: simdMet ? "" : `math.simdTier is ${String(currentOf("math.simdTier"))}`,
        ...(simdMet ? {} : { fix: { label: "Set math.simdTier to scalar", settings: { math: { simdTier: "scalar" } } } }),
      })
      const gpuMet = currentOf("physics.gpu") === "off"
      requirements.push({
        id: "gpu-physics-off",
        text: "GPU physics is off",
        met: gpuMet,
        detail: gpuMet ? "" : "physics.gpu is not off",
        ...(gpuMet ? {} : { fix: { label: "Set physics.gpu to off", settings: { physics: { gpu: "off" } } } }),
      })
      requirements.push({ id: "strict-fp", text: "The strict floating-point profile is compiled in", met: strictFp, detail: strictFp ? "" : "This build was not compiled with N2ENGINE_STRICT_FP" })
    } else if (checked === "authoritative" && currentOf("physics.gpu") !== "off") {
      warnings.push("physics.gpu is on: a client's GPU scene may differ from the server's")
    }
    const unmet = requirements.filter((r) => !r.met).length
    return {
      preset: checked,
      projectPreset: preset,
      refused: checked === "deterministic" && unmet > 0,
      unmet,
      summary:
        checked === "none"
          ? "Preset none: nothing is checked."
          : checked === "authoritative"
            ? `Server authoritative: ${warnings.length === 0 ? "no warnings." : `${warnings.length} warning; the engine starts anyway.`}`
            : unmet === 0
              ? `Deterministic: all ${requirements.length} requirements are met.`
              : `Deterministic: ${unmet} of ${requirements.length} requirements are unmet; the engine would refuse to start this project.`,
      requirements,
      warnings,
      environment: {},
    }
  }
  return { info, report, unavailable }
}

/** SetNetworkSettings on a settings object: the new settings, or the engine's refusal text */
export function fakeSetNetwork(settings: unknown, preset: string, patch: JsonObject, options: FakeNetworkOptions = {}): { settings: unknown } | { error: string } {
  const tunable = new Set(["tickRate", "transport", "authoritative", "deterministic"])
  const network: JsonObject = {}
  if (preset !== "") {
    if (!Presets.some((p) => p.id === preset.toLowerCase())) return { error: 'preset must be "none", "authoritative" or "deterministic" (or empty to keep the preset)' }
    if (preset.toLowerCase() === "deterministic") {
      const { unavailable } = fakeNetworkAnswers(settings, options)
      if (unavailable !== "") return { error: `The Deterministic preset can't be chosen: ${unavailable}` }
    }
    network.preset = preset.toLowerCase()
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!tunable.has(key)) return { error: `${key} is not a tunable network setting this command changes` }
    // authoritative.timeDilation (1.23.0): an object of its three keys, each of its type or null, or null for the whole
    const dilation = key === "authoritative" && typeof value === "object" && value !== null ? (value as JsonObject).timeDilation : undefined
    if (dilation !== undefined && dilation !== null) {
      if (typeof dilation !== "object" || Array.isArray(dilation)) return { error: "authoritative.timeDilation must be an object (enabled, minScale, maxScale) or null" }
      for (const [field, v] of Object.entries(dilation)) {
        const path = `authoritative.timeDilation.${field}`
        if (!["enabled", "minScale", "maxScale"].includes(field)) return { error: `${path} is not a tunable network setting this command changes` }
        if (v === null) continue
        if (field === "enabled" && typeof v !== "boolean") return { error: `${path} must be true, false or null` }
        if (field !== "enabled" && typeof v !== "number") return { error: `${path} must be a number or null` }
      }
    }
    network[key] = value
  }
  if (Object.keys(network).length === 0) return { settings }
  const next = applyMergePatch(settings as Json, { network })
  // The engine's read checks the scale ranges when the host applies the patch: a problem is an Error and nothing is saved
  const problems = readTimeDilation(next).problems
  if (problems.length > 0) return { error: problems.join("; ") }
  return { settings: next }
}
