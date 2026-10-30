// Network panel (protocol 1.21.0: GetNetworkSettings, SetNetworkSettings, GetNetworkValidation). The host describes the
// project's network preset, the three preset bundles row by row, and checks a preset's requirements. This holds the
// capability name, the shape checks for the two answers (the generated decoders only parse the JSON), and the small
// pure helpers the UI uses: the patch of a tunable row, the check of a typed value against its range, and the words.
import type { NetworkPresetInfo, NetworkSettingRange, NetworkSettingRow, NetworkSettingsInfo, NetworkValidationReport } from "./protocol.generated"

/** The Hello capability of a host with the three network panel commands */
export const NetworkPanelCapability = "networkPanel"

/** Said wherever a preset or a tunable setting is saved: a host reads the preset once, when it starts */
export const NetworkTakesEffectNote = "Takes effect at the next play session or host start."

/** The preset ids, in the order the host lists them */
export const NetworkPresetIds = ["none", "authoritative", "deterministic"] as const

const isString = (v: unknown): v is string => typeof v === "string"
const isBool = (v: unknown): v is boolean => typeof v === "boolean"
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString)

function isRow(v: unknown): v is NetworkSettingRow {
  if (!isObject(v)) return false
  return (
    isString(v.key) &&
    isString(v.label) &&
    isBool(v.governed) &&
    isBool(v.locked) &&
    isBool(v.tunable) &&
    isBool(v.startupChecked) &&
    (v.settingKey === undefined || isString(v.settingKey)) &&
    isString(v.description) &&
    (v.lostGuarantee === undefined || isString(v.lostGuarantee)) &&
    (v.atPresetValue === undefined || isBool(v.atPresetValue)) &&
    isString(v.source)
  )
}

function isPreset(v: unknown): v is NetworkPresetInfo {
  if (!isObject(v)) return false
  return (
    isString(v.id) &&
    isString(v.label) &&
    isString(v.summary) &&
    isBool(v.selected) &&
    isBool(v.selectable) &&
    (v.unavailableReason === undefined || isString(v.unavailableReason)) &&
    Array.isArray(v.rows) &&
    v.rows.every(isRow)
  )
}

function isRange(v: unknown): v is NetworkSettingRange {
  return isObject(v) && isString(v.key) && isNumber(v.min) && isNumber(v.max) && isNumber(v.default) && isBool(v.integer)
}

/** Returns the answer when it has the documented shape; throws an Error naming the problem otherwise */
export function validateNetworkSettingsInfo(value: unknown): NetworkSettingsInfo {
  if (!isObject(value)) throw new Error("The network settings answer must be an object")
  if (!isString(value.preset)) throw new Error("The network settings answer's preset must be a string")
  if (!isBool(value.customised) || !isBool(value.storedCustomised)) {
    throw new Error("The network settings answer's customised and storedCustomised must be booleans")
  }
  if (!Array.isArray(value.presets) || !value.presets.every(isPreset)) {
    throw new Error("The network settings answer's presets must be a list of preset descriptions")
  }
  if (!Array.isArray(value.ranges) || !value.ranges.every(isRange)) {
    throw new Error("The network settings answer's ranges must be a list of ranges")
  }
  if (
    !Array.isArray(value.lostGuarantees) ||
    !value.lostGuarantees.every((g) => isObject(g) && isString(g.settingKey) && isString(g.rowKey) && isString(g.text))
  ) {
    throw new Error("The network settings answer's lostGuarantees must be a list of guarantees")
  }
  if (!isObject(value.backend) || !isString(value.backend.selected) || !isStringList(value.backend.deterministicSelectable)) {
    throw new Error("The network settings answer's backend must have a selected backend and a list of deterministic-selectable ones")
  }
  const nudge = value.nudge
  if (!isObject(nudge) || !isBool(nudge.show) || !isStringList(nudge.reasons) || !isNumber(nudge.networkObjects) || !isString(nudge.hint)) {
    throw new Error("The network settings answer's nudge must have show, reasons, networkObjects and hint")
  }
  if (!isStringList(value.problems)) throw new Error("The network settings answer's problems must be a list of strings")
  return value as unknown as NetworkSettingsInfo
}

/** Returns the report when it has the documented shape; throws an Error naming the problem otherwise */
export function validateNetworkValidationReport(value: unknown): NetworkValidationReport {
  if (!isObject(value)) throw new Error("The network validation answer must be an object")
  if (!isString(value.preset) || !isString(value.projectPreset) || !isString(value.summary)) {
    throw new Error("The network validation answer's preset, projectPreset and summary must be strings")
  }
  if (!isBool(value.refused) || !isNumber(value.unmet)) {
    throw new Error("The network validation answer's refused must be a boolean and unmet a number")
  }
  const okRequirement = (r: unknown): boolean =>
    isObject(r) &&
    isString(r.id) &&
    isString(r.text) &&
    isBool(r.met) &&
    isString(r.detail) &&
    (r.fix === undefined || (isObject(r.fix) && isString(r.fix.label) && isObject(r.fix.settings)))
  if (!Array.isArray(value.requirements) || !value.requirements.every(okRequirement)) {
    throw new Error("The network validation answer's requirements must be a list of requirements")
  }
  if (!isStringList(value.warnings)) throw new Error("The network validation answer's warnings must be a list of strings")
  return value as unknown as NetworkValidationReport
}

/** The words for a preset id the host sends ("none", "authoritative", "deterministic"; anything else as sent) */
export function presetLabel(id: string): string {
  switch (id.toLowerCase()) {
    case "none":
      return "None"
    case "authoritative":
      return "Server authoritative"
    case "deterministic":
      return "Deterministic"
    default:
      return id
  }
}

/** The words for a row's source: where the project's value comes from */
export function sourceLabel(source: string): string {
  switch (source) {
    case "project":
      return "Project file"
    case "override":
      return "Stored override"
    case "default":
      return "Default"
    case "build":
      return "Build"
    default:
      return source
  }
}

/** A setting's value as text: null and absent as an en dash, booleans on/off, everything else as written */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "–"
  if (typeof value === "boolean") return value ? "on" : "off"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

/**
 * The merge patch of a tunable row for SetNetworkSettings' settings field: a setting key "network.authoritative.snapRate"
 * is the path authoritative.snapRate inside the network block ("network.tickRate" is tickRate). Null returns the setting
 * to its default. Null when the key is not under network.
 */
export function networkPatchOf(settingKey: string, value: unknown): Record<string, unknown> | null {
  const prefix = "network."
  if (!settingKey.startsWith(prefix) || settingKey.length === prefix.length) return null
  const path = settingKey.slice(prefix.length).split(".")
  let patch: unknown = value
  for (let i = path.length - 1; i >= 0; i--) patch = { [path[i]]: patch }
  return patch as Record<string, unknown>
}

/** Merges two patches built by networkPatchOf (objects merge, a later leaf wins) */
export function mergePatches(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [key, value] of Object.entries(b)) {
    const existing = out[key]
    out[key] = isObject(existing) && isObject(value) ? mergePatches(existing, value) : value
  }
  return out
}

/** The kinds of tunable value the editor knows how to write */
export type TunableKind = "number" | "boolean" | "text"

/** How a tunable row is edited: a number when the host gave it a range, a toggle for a boolean, else text */
export function tunableKind(row: NetworkSettingRow, range: NetworkSettingRange | undefined): TunableKind {
  if (range) return "number"
  if (typeof row.current === "boolean" || typeof row.value === "boolean") return "boolean"
  return "text"
}

/** The range the host gave a row's setting, if any */
export function rangeOf(info: NetworkSettingsInfo, row: NetworkSettingRow): NetworkSettingRange | undefined {
  return row.settingKey === undefined ? undefined : info.ranges.find((r) => r.key === row.settingKey)
}

/**
 * Time dilation (protocol 1.23.0): network.authoritative.timeDilation, the opt-in client clock dilation of Server
 * authoritative. GetNetworkSettings reports it as values.authoritative.timeDilation; it is not a row of the preset table
 * and has no entry in ranges, so its ranges are the engine's read (NetworkSettings: minScale 0.5 to 1, maxScale 1 to 2).
 */
export const TimeDilationKey = "network.authoritative.timeDilation"

/** The three fields SetNetworkSettings accepts under authoritative.timeDilation (any other is refused) */
export const TimeDilationFields = ["enabled", "minScale", "maxScale"] as const
export type TimeDilationField = (typeof TimeDilationFields)[number]

export interface TimeDilationValues {
  enabled: boolean
  minScale: number
  maxScale: number
}

/** The engine's defaults: off, 0.9 and 1.1 */
export const TimeDilationDefaults: TimeDilationValues = { enabled: false, minScale: 0.9, maxScale: 1.1 }

/** The engine's ranges of the two scales, in the shape checkNumber takes */
export const TimeDilationRanges: Record<"minScale" | "maxScale", NetworkSettingRange> = {
  minScale: { key: `${TimeDilationKey}.minScale`, min: 0.5, max: 1, default: TimeDilationDefaults.minScale, integer: false },
  maxScale: { key: `${TimeDilationKey}.maxScale`, min: 1, max: 2, default: TimeDilationDefaults.maxScale, integer: false },
}

/** The time dilation the host reports (values.authoritative.timeDilation), or null for a host before 1.23.0 or a malformed answer */
export function timeDilationOf(info: NetworkSettingsInfo): TimeDilationValues | null {
  const values = info.values
  if (!isObject(values) || !isObject(values.authoritative)) return null
  const dilation = values.authoritative.timeDilation
  if (!isObject(dilation) || !isBool(dilation.enabled) || !isNumber(dilation.minScale) || !isNumber(dilation.maxScale)) return null
  return { enabled: dilation.enabled, minScale: dilation.minScale, maxScale: dilation.maxScale }
}

/** The checked value of a typed number, or the problem in words (the host refuses an out-of-range value too) */
export function checkNumber(text: string, range: NetworkSettingRange): { value: number } | { error: string } {
  const trimmed = text.trim()
  if (trimmed === "") return { error: "Enter a number" }
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return { error: `${trimmed} is not a number` }
  if (range.integer && !Number.isInteger(value)) return { error: "Must be a whole number" }
  if (value < range.min || value > range.max) return { error: `Must be between ${range.min} and ${range.max}` }
  return { value }
}
