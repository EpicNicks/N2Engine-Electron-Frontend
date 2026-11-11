// The Build Settings panel (build targets stage 3): the targets on the left (what n2build knows here, and any the
// project has settings for), the selected target's doctor report and settings on the right, and Build, Build and Run
// and Cancel with the build's progress and log at the bottom. The rules are in build-settings-state.ts; n2build runs in
// the main process (main/n2build-runner.ts).
import { useEffect, useMemo, useRef } from "preact/hooks"
import { computed } from "@preact/signals-core"
import { hasCapability } from "../protocol/extensions"
import {
  BuildFields,
  BuildSettingsModel,
  BuildTargetsCapability,
  Choices,
  RemoteBuildNote,
  type BuildField,
  type TargetRow,
} from "./build-settings-state"
import { Empty, Panel, useApp } from "./ui"

/** The registered panel: the model over the editor's store, window.build and the host's commands */
export function BuildSettingsPanel() {
  const { store } = useApp()
  const model = useMemo(
    () =>
      new BuildSettingsModel({
        build: window.build,
        getProjectInfo: () => window.engine.getProjectInfo(),
        setBuildTargets: (patch) => window.engine.setBuildTargets(patch),
        connected: store.connected,
        readOnlyReason: store.readOnlyReason,
        role: store.hostRole,
        projectChangeCount: store.projectChangeCount,
        remote: store.remote,
        supported: computed(() => hasCapability(store.serverInfo.value?.capabilities, BuildTargetsCapability)),
      }),
    [store]
  )
  return <BuildSettingsView model={model} />
}

const Labels: Record<BuildField, string> = {
  enabled: "Offered in this list",
  displayName: "Name on this platform",
  appId: "App id",
  version: "Version",
  buildNumber: "Build number",
  config: "Default configuration",
  pack: "Pack format",
  orientation: "Orientation",
  renderer: "Renderer",
  icon: "Icon",
  "modules.physics3d": "3D physics",
  "modules.physics2d": "2D physics",
  "modules.particles": "Particles",
  "modules.softbodies": "Soft bodies",
  "signing.profile": "Signing profile",
}

const Help: Partial<Record<BuildField, string>> = {
  displayName: "The executable and package name; empty: the project's name",
  appId: "com.example.game (Android and iOS)",
  version: "major.minor.patch, written into the package",
  buildNumber: "1 to 2100000000 (Android's versionCode)",
  config: "Used when the build below says Default",
  pack: "How the game's files are packaged: zip, stored (no compression; the web's default), 7z (needs 7-Zip) or the folder as it is",
  icon: "res://... .png",
  "modules.physics3d": "Over build.modules; empty: the project's list",
  "signing.profile": "The NAME of a profile in your own n2build.json. Keys and passwords never go in the project.",
}

export function BuildSettingsView({ model }: { model: BuildSettingsModel }) {
  useEffect(() => model.start(), [model])
  const rows = model.visibleRows.value
  const current = model.current.value
  const location = model.location.value

  return (
    <Panel
      title="Build Settings"
      icon="📦"
      class="build-settings-panel"
      actions={
        <button
          onClick={() => {
            void model.refresh()
            void model.refreshTargets()
          }}
        >
          Refresh
        </button>
      }
    >
      {model.isRemote && (
        <div class="ps-note" role="status">
          {RemoteBuildNote}
        </div>
      )}
      {!model.isRemote && location?.problem && (
        <div class="ps-warning" role="alert">
          {location.problem}
        </div>
      )}
      {model.listError.value && (
        <div class="ps-warning" role="alert">
          Couldn't list the targets: {model.listError.value}
        </div>
      )}
      <div class="ps-layout">
        <nav class="ps-list" aria-label="Build targets">
          {rows.map((row) => (
            <TargetItem key={row.name} model={model} row={row} selected={row.name === current?.name} />
          ))}
          {model.hiddenCount.value > 0 && (
            <label class="bs-show-off">
              <input
                type="checkbox"
                checked={model.showDisabled.value}
                onChange={(e) => (model.showDisabled.value = (e.target as HTMLInputElement).checked)}
              />
              Show turned-off targets ({model.hiddenCount.value})
            </label>
          )}
        </nav>
        <div class="ps-body">
          {current ? <TargetView key={current.name} model={model} row={current} /> : <Empty>No targets yet</Empty>}
        </div>
      </div>
      <BuildBar model={model} target={current} />
    </Panel>
  )
}

function TargetItem({ model, row, selected }: { model: BuildSettingsModel; row: TargetRow; selected: boolean }) {
  const report = model.doctor.value[row.name]
  const mark = !row.known ? "?" : !row.buildableHere ? "–" : report ? (report.ok ? "✓" : "✗") : ""
  return (
    <button
      type="button"
      class={`ps-item${selected ? " selected" : ""}${row.enabled ? "" : " bs-off"}`}
      aria-current={selected ? "page" : undefined}
      onClick={() => model.select(row.name)}
      title={row.known ? row.name : `${row.name}: n2build on this machine has no such target`}
    >
      <span class="ps-item-title">{row.displayName}</span>
      {model.isDirty(row.name) ? (
        <span class="ps-dirty" aria-label="Unsaved changes">
          ●
        </span>
      ) : (
        mark && <span class="bs-mark" aria-label={report ? (report.ok ? "Ready" : "Not ready") : undefined}>{mark}</span>
      )}
    </button>
  )
}

function TargetView({ model, row }: { model: BuildSettingsModel; row: TargetRow }) {
  const locked = model.settingsLockedReason.value
  const built = model.built(row.name)
  return (
    <section class="ps-section" aria-label={row.displayName}>
      <h3>
        {row.displayName} <span class="ps-unit">{row.name}</span>
      </h3>
      {!row.known && <div class="ps-note">n2build on this machine has no {row.name} target; its settings are kept in the project.</div>}
      {row.known && !row.buildableHere && (
        <div class="ps-note">Builds on {row.hostSystems.join(", ")} only.</div>
      )}
      {row.known && row.buildableHere && !model.isRemote && <DoctorView model={model} name={row.name} />}

      <h4 class="bs-heading">Settings</h4>
      {locked && (
        <div class="ps-note" role="status">
          {locked}
        </div>
      )}
      <div class="ps-control bs-enable">
        <label>
          <input
            type="checkbox"
            checked={row.enabled}
            disabled={locked !== null || model.applying.value}
            onChange={(e) => void model.setEnabled(row.name, (e.target as HTMLInputElement).checked)}
          />
          Offered in the build list
        </label>
      </div>
      {BuildFields.filter((f) => f !== "enabled").map((field) => (
        <FieldRow key={field} model={model} name={row.name} field={field} disabled={locked !== null} error={built.errors[field]} dirty={built.changed.includes(field)} />
      ))}
      {model.applyError.value && (
        <div class="ps-host-error" role="alert">
          <b>The host refused it; your edits are kept.</b> <pre>{model.applyError.value}</pre>
        </div>
      )}
      <div class="ps-buttons">
        <button
          type="button"
          onClick={() => void model.apply(row.name)}
          disabled={locked !== null || model.applying.value || built.patch === null || Object.keys(built.errors).length > 0}
        >
          {model.applying.value ? "Applying..." : "Apply"}
        </button>
        <button type="button" class="secondary" onClick={() => model.revert(row.name)} disabled={model.applying.value || built.patch === null}>
          Revert
        </button>
      </div>
    </section>
  )
}

function FieldRow(props: { model: BuildSettingsModel; name: string; field: BuildField; disabled: boolean; error?: string; dirty: boolean }) {
  const { model, name, field, disabled, error, dirty } = props
  const id = `bs-${name}-${field.replace(".", "-")}`
  const text = model.textOf(name, field)
  const choices = Choices[field]
  const set = (value: string): void => model.setEdit(name, field, value)
  return (
    <div class={`ps-row${dirty ? " dirty" : ""}`}>
      <label for={id}>{Labels[field]}</label>
      <div class="ps-control">
        {choices ? (
          <select id={id} value={text} disabled={disabled} onChange={(e) => set((e.target as HTMLSelectElement).value)}>
            <option value="">{field.startsWith("modules.") ? "(the project's list)" : "(not set)"}</option>
            {choices.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : (
          <input id={id} type="text" value={text} disabled={disabled} spellcheck={false} onInput={(e) => set((e.target as HTMLInputElement).value)} />
        )}
      </div>
      {Help[field] && <div class="ps-help">{Help[field]}</div>}
      {error && <div class="ps-field-error">{error}</div>}
    </div>
  )
}

function DoctorView({ model, name }: { model: BuildSettingsModel; name: string }) {
  const reports = model.doctor.value
  const asked = name in reports
  const report = reports[name]
  const error = model.doctorErrors.value[name]
  useEffect(() => {
    if (!(name in model.doctor.peek()) && !(name in model.doctorErrors.peek())) void model.checkTarget(name)
  }, [model, name])
  return (
    <div class="bs-doctor" aria-label="What this target needs">
      <div class="bs-doctor-head">
        <b>{report ? (report.ok ? "Ready to build" : "Not ready to build") : asked ? "Checking this machine..." : "Not checked"}</b>
        <button type="button" class="secondary" onClick={() => void model.checkTarget(name)} disabled={asked && !report}>
          Check again
        </button>
      </div>
      {error && <div class="ps-field-error">{error}</div>}
      {report && (
        <ul class="bs-checks">
          {report.checks.map((c) => (
            <li key={c.id} class={c.ok ? "ok" : c.required ? "missing" : "absent"}>
              <span class="bs-check-mark">{c.ok ? "✓" : c.required ? "✗" : "–"}</span> {c.title}
              {c.version && <span class="ps-unit"> {c.version}</span>}
              {!c.ok && c.detail && <div class="ps-help">{c.detail}</div>}
              {!c.ok && c.fix && <div class="bs-fix">Fix: {c.fix}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function BuildBar({ model, target }: { model: BuildSettingsModel; target: TargetRow | null }) {
  const state = model.buildState.value
  const running = state.status === "running"
  const blocked = target ? model.buildBlockedReason(target.name) : "Pick a target"
  const logRef = useRef<HTMLPreElement>(null)
  const lines = model.log.value
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <div class="bs-build" aria-label="Build">
      {!model.isRemote && (
        <div class="bs-build-controls">
          <select
            aria-label="Configuration"
            value={model.config.value}
            disabled={running}
            onChange={(e) => (model.config.value = (e.target as HTMLSelectElement).value as "" | "debug" | "release")}
          >
            <option value="">Default configuration</option>
            <option value="debug">debug</option>
            <option value="release">release</option>
          </select>
          <select
            aria-label="Archive"
            value={model.archive.value}
            disabled={running}
            onChange={(e) => (model.archive.value = (e.target as HTMLSelectElement).value as "" | "zip" | "7z")}
          >
            <option value="">No archive</option>
            <option value="zip">.zip archive</option>
            <option value="7z">.7z archive</option>
          </select>
          <button type="button" disabled={blocked !== null} onClick={() => target && void model.build(target.name, false)}>
            Build
          </button>
          <button type="button" disabled={blocked !== null} onClick={() => target && void model.build(target.name, true)}>
            Build and Run
          </button>
          <button type="button" class="secondary" disabled={!running} onClick={() => void model.cancel()}>
            Cancel
          </button>
          <span class="bs-status" role="status">
            {running
              ? `${state.request?.target ?? ""}: ${state.step?.title ?? "Starting..."}`
              : state.status === "succeeded"
                ? "Build succeeded"
                : state.status === "failed"
                  ? "Build failed"
                  : state.status === "cancelled"
                    ? "Build cancelled"
                    : ""}
          </span>
        </div>
      )}
      {!model.isRemote && blocked && !running && <div class="ps-help">{blocked}</div>}
      {model.startError.value && (
        <div class="ps-field-error" role="alert">
          {model.startError.value}
        </div>
      )}
      {state.result?.ok && state.result.output && (
        <div class="bs-output">
          Package: <code>{state.result.output}</code>
          {state.result.archive && (
            <>
              {" "}
              Archive: <code>{state.result.archive}</code>
            </>
          )}
          {state.result.url && (
            <>
              {" "}
              Serving at <code>{state.result.url}</code>
            </>
          )}
        </div>
      )}
      {lines.length > 0 && (
        <pre class="bs-log" ref={logRef} aria-label="Build log">
          {lines.map((line, i) => (
            <div key={i} class={`bs-log-${line.kind}`}>
              {line.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}
