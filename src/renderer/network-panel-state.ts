// The Network panel's state, without a DOM (protocol 1.21.0): the host's GetNetworkSettings answer, the validation
// report, the preset choice and the tunable edits (SetNetworkSettings), and the fix buttons. Given its pieces (or
// fakes), so it is unit tested in Node; the Network section of Project Settings (project-settings-sections.tsx) draws it.
//
// The rules it keeps:
//  - nothing is read or offered without the networkPanel capability (an older host has none of the three commands);
//  - choosing a preset and saving settings is off while a game runs, on a read-only host and for a viewer (readOnlyReason);
//    reading is not (GetNetworkSettings and GetNetworkValidation are Read commands);
//  - a preset the host marks not selectable (Deterministic without a backend that can carry it) can't be chosen, and the
//    host's reason is shown;
//  - only the project's own preset has editable rows, and only its tunable rows; values are checked against the host's
//    ranges before they are sent, and the host's answer replaces what is shown;
//  - a fix button applies the requirement's patch through SetProjectSettings, not SetNetworkSettings: the host's fix is
//    "a merge patch for SetProjectSettings" (it sets physics.gpu, math.simdTier, physics.backend and so on, which
//    SetNetworkSettings refuses by design);
//  - the newest read wins.
import { signal, type ReadonlySignal } from "@preact/signals-core"
import {
  NetworkPresetIds,
  checkNumber,
  mergePatches,
  networkPatchOf,
  rangeOf,
  tunableKind,
} from "../protocol/network-panel"
import type {
  NetworkPresetInfo,
  NetworkRequirementInfo,
  NetworkSettingRow,
  NetworkSettingsInfo,
  NetworkValidationReport,
  ProjectInfoResponse,
} from "../protocol/protocol.generated"
import { errorTextOf } from "../shared/api"
import type { JsonObject } from "./project-settings-schema"

export interface NetworkPanelDeps {
  /** GetNetworkSettings */
  getNetworkSettings(): Promise<NetworkSettingsInfo>
  /** SetNetworkSettings: the preset (empty keeps it) and a merge patch of the network block */
  setNetworkSettings(preset: string, settings: JsonObject): Promise<NetworkSettingsInfo>
  /** GetNetworkValidation: a preset id, or empty for the project's own */
  getNetworkValidation(preset: string): Promise<NetworkValidationReport>
  /** SetProjectSettings: where a requirement's fix patch goes */
  setProjectSettings(settings: JsonObject): Promise<ProjectInfoResponse>
  connected: ReadonlySignal<boolean>
  /** Whether Hello lists the networkPanel capability */
  supported: ReadonlySignal<boolean>
  /** EditorStore.readOnlyReason: a play session, a read-only host, a viewer; null when writes work */
  readOnlyReason: ReadonlySignal<string | null>
}

export const NetworkUnsupportedReason =
  "This host does not have the networkPanel capability (it is older than protocol 1.21.0), so the network settings can't be read or changed here."

/** A draft is the text of a tunable row's input; null is "back to the default" */
export type NetworkDrafts = Record<string, string | null>

export class NetworkPanelModel {
  /** The host's last answer; null until read, when not connected and when unsupported */
  readonly info = signal<NetworkSettingsInfo | null>(null)
  readonly loadError = signal<string | null>(null)
  /** The last report; null until read */
  readonly report = signal<NetworkValidationReport | null>(null)
  readonly reportError = signal<string | null>(null)
  /** The preset whose bundle and requirements are shown: the project's own until the user picks another */
  readonly viewed = signal<string | null>(null)
  /** The host's refusal of the last write, until the next try */
  readonly error = signal<string | null>(null)
  /** The unsent edits of tunable rows, by setting key */
  readonly drafts = signal<NetworkDrafts>({})
  /** What the last accepted write was ("preset deterministic", "settings", "fix: ..."), until the next try; drives the next-start note */
  readonly lastSaved = signal<string | null>(null)
  /** The preset id being chosen, "settings" while tunables are sent, or the id of the requirement being fixed */
  readonly busy = signal<string | null>(null)

  private reads = 0
  private reportReads = 0

  constructor(private readonly deps: NetworkPanelDeps) {}

  get supported(): boolean {
    return this.deps.supported.value
  }

  /** Why nothing can be read now (not connected, unsupported), or null */
  get readBlockedReason(): string | null {
    if (!this.deps.connected.value) return "Not connected"
    if (!this.deps.supported.value) return NetworkUnsupportedReason
    return null
  }

  /** Why nothing can be written now (not connected, unsupported, read-only), or null */
  get disabledReason(): string | null {
    const read = this.readBlockedReason
    if (read !== null) return read
    const readOnly = this.deps.readOnlyReason.value
    return readOnly === null ? null : `Read-only: ${readOnly}`
  }

  /** The preset whose bundle is shown: the user's pick, else the project's own */
  get viewedId(): string {
    return this.viewed.value ?? this.info.value?.preset ?? "none"
  }

  get viewedPreset(): NetworkPresetInfo | null {
    const info = this.info.value
    return info?.presets.find((p) => p.id === this.viewedId) ?? null
  }

  /** Whether the shown bundle is the project's own: only then its rows are editable */
  get viewingProjectPreset(): boolean {
    const info = this.info.value
    return info !== null && this.viewedId === info.preset
  }

  /** Why this preset can't be chosen now (the global reason, else the preset's own), or null */
  presetBlockReason(preset: NetworkPresetInfo): string | null {
    const global = this.disabledReason
    if (global !== null) return global
    if (this.info.value === null) return "The network settings are not read yet"
    if (!preset.selectable) return preset.unavailableReason ?? "The host does not allow this preset"
    return null
  }

  /** Whether a row of the shown bundle can be edited now: the project's preset, a tunable row with a setting, writes working */
  rowEditable(row: NetworkSettingRow): boolean {
    return this.viewingProjectPreset && row.tunable && row.settingKey !== undefined && patchKeyOk(row.settingKey) && this.disabledReason === null
  }

  /** GetNetworkSettings and the report of the shown preset; the newest read wins. Clears the answers when not connected or unsupported. */
  async refresh(): Promise<void> {
    const read = ++this.reads
    if (this.readBlockedReason !== null) {
      this.info.value = null
      this.report.value = null
      this.loadError.value = null
      this.reportError.value = null
      return
    }
    try {
      const info = await this.deps.getNetworkSettings()
      if (read !== this.reads) return
      this.info.value = info
      this.loadError.value = null
      if (this.viewed.value !== null && !info.presets.some((p) => p.id === this.viewed.value)) this.viewed.value = null
    } catch (e) {
      if (read !== this.reads) return
      console.error("Failed to get the network settings:", e)
      this.loadError.value = errorTextOf(e)
    }
    await this.refreshReport()
  }

  /** GetNetworkValidation for the shown preset; the newest read wins */
  async refreshReport(): Promise<void> {
    const read = ++this.reportReads
    if (this.readBlockedReason !== null) return
    try {
      const report = await this.deps.getNetworkValidation(this.viewedId)
      if (read !== this.reportReads) return
      this.report.value = report
      this.reportError.value = null
    } catch (e) {
      if (read !== this.reportReads) return
      console.error("Failed to get the network validation:", e)
      this.reportError.value = errorTextOf(e)
    }
  }

  /** Shows another preset's bundle and requirements (reading only; nothing is chosen) */
  async view(id: string): Promise<void> {
    if (!(NetworkPresetIds as readonly string[]).includes(id)) return
    this.viewed.value = id
    this.drafts.value = {}
    await this.refreshReport()
  }

  /** SetNetworkSettings with a preset; true when the host took it. The answer replaces what is shown. */
  async choosePreset(id: string): Promise<boolean> {
    const preset = this.info.value?.presets.find((p) => p.id === id)
    if (!preset || this.busy.value !== null || this.presetBlockReason(preset) !== null) return false
    this.error.value = null
    this.lastSaved.value = null
    this.busy.value = id
    try {
      const answer = await this.deps.setNetworkSettings(id, {})
      this.reads++ // an older read must not overwrite this answer
      this.info.value = answer
      this.loadError.value = null
      this.viewed.value = null
      this.drafts.value = {}
      this.lastSaved.value = `preset ${id}`
      await this.refreshReport()
      return true
    } catch (e) {
      console.error("Failed to set the network preset:", e)
      this.error.value = errorTextOf(e)
      return false
    } finally {
      this.busy.value = null
    }
  }

  /** The text a row's input holds: the draft, else the project's current value (the preset's value when there is none) */
  textOf(row: NetworkSettingRow): string {
    const key = row.settingKey
    if (key !== undefined && key in this.drafts.value) {
      const draft = this.drafts.value[key]
      if (draft !== null) return draft
      const range = this.info.value ? rangeOf(this.info.value, row) : undefined
      return range ? String(range.default) : ""
    }
    const shown = row.current ?? row.value
    return shown === null || shown === undefined ? "" : String(shown)
  }

  setDraft(row: NetworkSettingRow, text: string): void {
    if (row.settingKey === undefined) return
    this.drafts.value = { ...this.drafts.value, [row.settingKey]: text }
  }

  /** Marks a row to go back to its default: the patch carries null for it */
  resetDraft(row: NetworkSettingRow): void {
    if (row.settingKey === undefined) return
    this.drafts.value = { ...this.drafts.value, [row.settingKey]: null }
  }

  discardDrafts(): void {
    this.drafts.value = {}
  }

  /** The problem with a row's draft (a number out of its range), or null */
  draftError(row: NetworkSettingRow): string | null {
    const key = row.settingKey
    const info = this.info.value
    if (key === undefined || info === null || !(key in this.drafts.value) || this.drafts.value[key] === null) return null
    const range = rangeOf(info, row)
    if (tunableKind(row, range) !== "number" || !range) return null
    const checked = checkNumber(this.drafts.value[key] as string, range)
    return "error" in checked ? checked.error : null
  }

  /** The merge patch of the drafts and the problems that stop it: only rows the user changed are in it */
  build(): { patch: Record<string, unknown>; errors: string[] } {
    const info = this.info.value
    const preset = this.viewedPreset
    let patch: Record<string, unknown> = {}
    const errors: string[] = []
    if (info === null || preset === null) return { patch, errors }
    for (const row of preset.rows) {
      const key = row.settingKey
      if (key === undefined || !(key in this.drafts.value)) continue
      const draft = this.drafts.value[key]
      let value: unknown
      if (draft === null) {
        value = null
      } else {
        const range = rangeOf(info, row)
        const kind = tunableKind(row, range)
        if (kind === "number" && range) {
          const checked = checkNumber(draft, range)
          if ("error" in checked) {
            errors.push(`${row.label}: ${checked.error}`)
            continue
          }
          value = checked.value
        } else if (kind === "boolean") {
          value = draft === "true"
        } else {
          value = draft.trim()
        }
      }
      const piece = networkPatchOf(key, value)
      if (piece === null) {
        errors.push(`${row.label}: ${key} is not a network setting`)
        continue
      }
      patch = mergePatches(patch, piece)
    }
    return { patch, errors }
  }

  get canApply(): boolean {
    const { patch, errors } = this.build()
    return this.disabledReason === null && this.busy.value === null && errors.length === 0 && Object.keys(patch).length > 0
  }

  /** Sends the drafts through SetNetworkSettings; true when the host took them */
  async apply(): Promise<boolean> {
    if (!this.canApply) return false
    const { patch } = this.build()
    this.error.value = null
    this.lastSaved.value = null
    this.busy.value = "settings"
    try {
      const answer = await this.deps.setNetworkSettings("", patch as JsonObject)
      this.reads++
      this.info.value = answer
      this.loadError.value = null
      this.drafts.value = {}
      this.lastSaved.value = "settings"
      await this.refreshReport()
      return true
    } catch (e) {
      console.error("Failed to set the network settings:", e)
      this.error.value = errorTextOf(e)
      return false
    } finally {
      this.busy.value = null
    }
  }

  /** Why this requirement's fix can't be applied now, or null */
  fixBlockReason(requirement: NetworkRequirementInfo): string | null {
    if (requirement.fix === undefined) return "This requirement has no fix"
    if (this.busy.value !== null) return "Another change is on its way"
    return this.disabledReason
  }

  /** Applies a requirement's fix patch through SetProjectSettings; true when the host took it. The panel is read again. */
  async applyFix(requirementId: string): Promise<boolean> {
    const requirement = this.report.value?.requirements.find((r) => r.id === requirementId)
    if (!requirement || !requirement.fix || this.fixBlockReason(requirement) !== null) return false
    this.error.value = null
    this.lastSaved.value = null
    this.busy.value = requirementId
    try {
      await this.deps.setProjectSettings(requirement.fix.settings as JsonObject)
      this.lastSaved.value = `fix: ${requirement.fix.label}`
      // The fix can change the backend, the SIMD tier or the timestep: every row's current value and the report change
      await this.refresh()
      return true
    } catch (e) {
      console.error("Failed to apply the network fix:", e)
      this.error.value = errorTextOf(e)
      return false
    } finally {
      this.busy.value = null
    }
  }
}

/** Whether a setting key can be written by SetNetworkSettings (it is under the network block) */
function patchKeyOk(settingKey: string): boolean {
  return networkPatchOf(settingKey, null) !== null
}
