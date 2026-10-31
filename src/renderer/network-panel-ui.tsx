// The Network section of Project Settings (protocol 1.21.0): the three preset cards, the shown preset's bundle row by row
// (locked and tunable settings), the validation report with its fix buttons, the nudge and the "takes effect at next
// start" notice, and (protocol 1.23.0) the time dilation group under the Server authoritative bundle. The logic is in network-panel-state.ts (tested in Node). Every string from the host (labels,
// descriptions, reasons, messages) is untrusted and is only ever a text node here.
import type { NetworkPresetInfo, NetworkRequirementInfo, NetworkSettingRow } from "../protocol/protocol.generated"
import {
  NetworkTakesEffectNote,
  TimeDilationDefaults,
  TimeDilationKey,
  TimeDilationRanges,
  formatValue,
  presetLabel,
  rangeOf,
  sourceLabel,
  tunableKind,
  type TimeDilationField,
} from "../protocol/network-panel"
import type { NetworkPanelModel } from "./network-panel-state"
import type { SectionProps } from "./project-settings-sections"

/** The modes the host accepts for deterministic.mode */
const DeterministicModes = ["lockstep", "rollback"]

function PresetCard(props: { panel: NetworkPanelModel; preset: NetworkPresetInfo }) {
  const { panel, preset } = props
  const block = panel.presetBlockReason(preset)
  const busy = panel.busy.value !== null
  const chosen = preset.selected
  return (
    <div class={`ps-backend ps-preset${chosen ? " current" : ""}${preset.selectable ? "" : " missing"}`} data-preset={preset.id} role="group" aria-label={preset.label}>
      <div class="ps-backend-head">
        <b>{preset.label}</b> <code>{preset.id}</code>
        {chosen && <span class="ps-badge">project preset</span>}
        {!preset.selectable && <span class="ps-badge restart">unavailable</span>}
      </div>
      <p class="ps-help">{preset.summary}</p>
      {!preset.selectable && preset.unavailableReason && (
        <p class="ps-warning" role="note">
          {preset.unavailableReason}
        </p>
      )}
      <div class="ps-buttons">
        <button type="button" disabled={chosen || block !== null || busy} title={block ?? undefined} onClick={() => void panel.choosePreset(preset.id)}>
          {panel.busy.value === preset.id ? "Choosing..." : chosen ? "Chosen" : "Use this preset"}
        </button>
        <button type="button" aria-pressed={panel.viewedId === preset.id} onClick={() => void panel.view(preset.id)}>
          View bundle
        </button>
      </div>
    </div>
  )
}

function RowValueEditor(props: { panel: NetworkPanelModel; row: NetworkSettingRow }) {
  const { panel, row } = props
  const info = panel.info.value
  if (!info) return null
  const range = rangeOf(info, row)
  const kind = tunableKind(row, range)
  const text = panel.textOf(row)
  const error = panel.draftError(row)
  const key = row.settingKey ?? row.key
  const isMode = key === "network.deterministic.mode"
  const dirty = row.settingKey !== undefined && row.settingKey in panel.drafts.value
  return (
    <div class="ps-control">
      {isMode ? (
        <select aria-label={row.label} value={text} onChange={(e) => panel.setDraft(row, (e.currentTarget as HTMLSelectElement).value)}>
          {(DeterministicModes.includes(text) ? DeterministicModes : [text, ...DeterministicModes]).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      ) : kind === "boolean" ? (
        <input type="checkbox" aria-label={row.label} checked={text === "true"} onChange={(e) => panel.setDraft(row, (e.currentTarget as HTMLInputElement).checked ? "true" : "false")} />
      ) : kind === "number" && range ? (
        <input
          type="number"
          aria-label={row.label}
          value={text}
          min={range.min}
          max={range.max}
          step={range.integer ? 1 : "any"}
          aria-invalid={error !== null}
          onInput={(e) => panel.setDraft(row, (e.currentTarget as HTMLInputElement).value)}
        />
      ) : (
        <input type="text" aria-label={row.label} value={text} onInput={(e) => panel.setDraft(row, (e.currentTarget as HTMLInputElement).value)} />
      )}
      {range && (
        <span class="ps-unit">
          {range.min}-{range.max}
        </span>
      )}
      {dirty && (
        <button type="button" onClick={() => panel.resetDraft(row)} title={`Back to the default${range ? ` (${range.default})` : ""}`}>
          Default
        </button>
      )}
      {error && (
        <span class="ps-field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

function BundleRow(props: { panel: NetworkPanelModel; row: NetworkSettingRow }) {
  const { panel, row } = props
  const editable = panel.rowEditable(row)
  const off = row.locked && row.atPresetValue === false
  return (
    <tr class={`ps-net-row${off ? " off" : ""}`} data-row={row.key}>
      <th scope="row">
        <div>{row.label}</div>
        {row.settingKey && <code class="ps-help">{row.settingKey}</code>}
        <div class="ps-help">{row.description}</div>
        {off && row.lostGuarantee && <div class="ps-field-error">Loses: {row.lostGuarantee}</div>}
      </th>
      <td>
        {row.locked && <span class="ps-badge restart">locked</span>}
        {row.tunable && <span class="ps-badge">tunable</span>}
        {row.startupChecked && <span class="ps-badge restart">checked at start</span>}
        {!row.governed && <span class="ps-help">any value</span>}
      </td>
      <td>{formatValue(row.value)}</td>
      <td>{editable ? <RowValueEditor panel={panel} row={row} /> : row.settingKey === undefined ? formatValue(undefined) : formatValue(row.current)}</td>
      <td>{sourceLabel(row.source)}</td>
    </tr>
  )
}

const TimeDilationRows: Array<{ field: TimeDilationField; label: string; help: string }> = [
  { field: "enabled", label: "Time dilation enabled", help: "A joined client speeds up or slows down its fixed-step clock to keep its input stamps at the tick the server needs." },
  { field: "minScale", label: "Minimum scale", help: "The slowest the client's clock runs (0.5 to 1)." },
  { field: "maxScale", label: "Maximum scale", help: "The fastest the client's clock runs (1 to 2)." },
]

function TimeDilationEditor(props: { panel: NetworkPanelModel; field: TimeDilationField; label: string }) {
  const { panel, field, label } = props
  const text = panel.timeDilationText(field)
  const error = panel.timeDilationDraftError(field)
  const range = field === "enabled" ? null : TimeDilationRanges[field]
  return (
    <div class="ps-control">
      {range === null ? (
        <input type="checkbox" aria-label={label} checked={text === "true"} onChange={(e) => panel.setTimeDilationDraft(field, (e.currentTarget as HTMLInputElement).checked ? "true" : "false")} />
      ) : (
        <>
          <input
            type="number"
            aria-label={label}
            value={text}
            min={range.min}
            max={range.max}
            step="any"
            aria-invalid={error !== null}
            onInput={(e) => panel.setTimeDilationDraft(field, (e.currentTarget as HTMLInputElement).value)}
          />
          <span class="ps-unit">
            {range.min}-{range.max}
          </span>
        </>
      )}
      {panel.timeDilationDirty(field) && (
        <button type="button" onClick={() => panel.resetTimeDilationDraft(field)} title={`Back to the default (${formatValue(TimeDilationDefaults[field])})`}>
          Default
        </button>
      )}
      {error && (
        <span class="ps-field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

/** network.authoritative.timeDilation (protocol 1.23.0): not a row of the preset table, so a group of its own */
function TimeDilationGroup(props: { panel: NetworkPanelModel }) {
  const { panel } = props
  const current = panel.timeDilation
  if (!panel.timeDilationShown || current === null) return null
  const editable = panel.timeDilationEditable
  return (
    <div class="ps-net-dilation" data-dilation="">
      <h4>Time dilation (opt-in)</h4>
      <p class="ps-help">
        <code>{TimeDilationKey}</code>: client clock dilation for Server authoritative. Off by default; the scales default to {TimeDilationDefaults.minScale} and{" "}
        {TimeDilationDefaults.maxScale}. The server is not affected.
      </p>
      <div class="ps-matrix-scroll">
        <table class="ps-net-table" aria-label="Time dilation">
          <thead>
            <tr>
              <th scope="col">Setting</th>
              <th scope="col">Default</th>
              <th scope="col">Current</th>
            </tr>
          </thead>
          <tbody>
            {TimeDilationRows.map(({ field, label, help }) => (
              <tr key={field} class="ps-net-row" data-dilation-field={field}>
                <th scope="row">
                  <div>{label}</div>
                  <code class="ps-help">{`${TimeDilationKey}.${field}`}</code>
                  <div class="ps-help">{help}</div>
                </th>
                <td>{formatValue(TimeDilationDefaults[field])}</td>
                <td>{editable ? <TimeDilationEditor panel={panel} field={field} label={label} /> : formatValue(current[field])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && (
        <div class="ps-buttons">
          <button type="button" disabled={panel.timeDilationRemoved} onClick={() => panel.removeTimeDilation()} title="Remove network.authoritative.timeDilation from the project file: every field back to its default">
            Reset time dilation
          </button>
          {panel.timeDilationRemoved && <span class="ps-help">Apply removes it from the project file.</span>}
        </div>
      )}
    </div>
  )
}

function BundleTable(props: { panel: NetworkPanelModel }) {
  const { panel } = props
  const preset = panel.viewedPreset
  if (!preset) return null
  const { errors } = panel.build()
  return (
    <div class="ps-net-bundle">
      <h4>{preset.label} bundle</h4>
      {!panel.viewingProjectPreset && (
        <p class="ps-help">This is not the project's preset ({presetLabel(panel.info.value?.preset ?? "none")}), so its rows can't be edited here. Use this preset first.</p>
      )}
      <div class="ps-matrix-scroll">
        <table class="ps-net-table" aria-label={`${preset.label} bundle`}>
          <thead>
            <tr>
              <th scope="col">Setting</th>
              <th scope="col">Class</th>
              <th scope="col">Preset value</th>
              <th scope="col">Current</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {preset.rows.map((row) => (
              <BundleRow key={row.key} panel={panel} row={row} />
            ))}
          </tbody>
        </table>
      </div>
      <TimeDilationGroup panel={panel} />
      {errors.length > 0 && (
        <ul class="ps-field-error" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {panel.viewingProjectPreset && panel.hasDrafts && (
        <div class="ps-actions ps-buttons">
          <button type="button" disabled={!panel.canApply} onClick={() => void panel.apply()}>
            {panel.busy.value === "settings" ? "Saving..." : "Apply"}
          </button>
          <button type="button" onClick={() => panel.discardDrafts()}>
            Discard
          </button>
        </div>
      )}
    </div>
  )
}

function Requirement(props: { panel: NetworkPanelModel; requirement: NetworkRequirementInfo }) {
  const { panel, requirement } = props
  const block = panel.fixBlockReason(requirement)
  return (
    <li class={`ps-req ${requirement.met ? "met" : "unmet"}`} data-requirement={requirement.id}>
      <b>{requirement.met ? "Met" : "Unmet"}</b> {requirement.text}
      {!requirement.met && requirement.detail && <div class="ps-field-error">{requirement.detail}</div>}
      {!requirement.met && requirement.fix && (
        <div class="ps-buttons">
          <button type="button" disabled={block !== null} title={block ?? undefined} onClick={() => void panel.applyFix(requirement.id)}>
            {panel.busy.value === requirement.id ? "Applying..." : requirement.fix.label}
          </button>
        </div>
      )}
    </li>
  )
}

function ValidationReport(props: { panel: NetworkPanelModel }) {
  const { panel } = props
  const report = panel.report.value
  const error = panel.reportError.value
  return (
    <div class="ps-net-report">
      <h4>Validation ({presetLabel(panel.viewedId)})</h4>
      {error && (
        <p class="ps-field-error" role="alert">
          Failed to check the network settings: {error}
        </p>
      )}
      {report && (
        <>
          <p class={report.refused ? "ps-field-error" : "ps-help"} role="status">
            {report.summary}
          </p>
          {report.refused && report.preset === report.projectPreset && (
            <p class="ps-warning" role="note">
              The host would refuse to start this project until the unmet requirements are fixed.
            </p>
          )}
          {report.requirements.length > 0 && (
            <ul class="ps-reqs" aria-label="Requirements">
              {report.requirements.map((r) => (
                <Requirement key={r.id} panel={panel} requirement={r} />
              ))}
            </ul>
          )}
          {report.warnings.length > 0 && (
            <ul class="ps-warnings" aria-label="Warnings">
              {report.warnings.map((w) => (
                <li key={w} class="ps-note">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

/** The Network section: the project's network preset, its bundle, and what the host checks at start */
export function NetworkSection(_props: SectionProps) {
  const panel = _props.model.network
  if (!panel) return <p class="ps-intro">The network panel is not available in this panel.</p>
  const info = panel.info.value
  const reason = panel.readBlockedReason
  const loadError = panel.loadError.value
  const error = panel.error.value
  const saved = panel.lastSaved.value
  return (
    <div class="ps-form ps-network">
      <p class="ps-intro">
        The project's network model (the setting <code>network.preset</code>) and the settings it governs. {NetworkTakesEffectNote}
      </p>
      {reason && !panel.supported && (
        <div class="ps-note" role="status">
          {reason}
        </div>
      )}
      {loadError && (
        <p class="ps-field-error" role="alert">
          Failed to read the network settings: {loadError}
        </p>
      )}
      {info && (
        <>
          {info.nudge.show && (
            <div class="ps-warning" role="note" data-nudge="">
              {info.nudge.hint}
            </div>
          )}
          {info.customised && (
            <div class="ps-warning" role="note" data-customised="">
              <b>Customised.</b> This project changes locked settings of the {presetLabel(info.preset)} preset, which loses:
              <ul>
                {info.lostGuarantees.map((g) => (
                  <li key={`${g.settingKey}|${g.rowKey}`}>
                    <code>{g.settingKey}</code>: {g.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {info.problems.length > 0 && (
            <div class="ps-note" role="status">
              The host could not use some values in the project file (it used the defaults):
              <ul>
                {info.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          <div class="ps-facts">
            <div>
              <span>Preset</span> <b>{presetLabel(info.preset)}</b>
            </div>
            <div>
              <span>Physics backend</span> <b>{info.backend.selected === "" ? "none" : info.backend.selected}</b>
            </div>
            <div>
              <span>Deterministic backends</span> <b>{info.backend.deterministicSelectable.length === 0 ? "none in this build" : info.backend.deterministicSelectable.join(", ")}</b>
            </div>
          </div>
          {info.presets.map((preset) => (
            <PresetCard key={preset.id} panel={panel} preset={preset} />
          ))}
          <BundleTable panel={panel} />
          <ValidationReport panel={panel} />
        </>
      )}
      {error && (
        <div class="ps-host-error" role="alert">
          <b>The host refused it.</b> <pre>{error}</pre>
        </div>
      )}
      {saved && !error && (
        <div class="ps-restart" role="status">
          Saved ({saved}). {NetworkTakesEffectNote}
        </div>
      )}
    </div>
  )
}
