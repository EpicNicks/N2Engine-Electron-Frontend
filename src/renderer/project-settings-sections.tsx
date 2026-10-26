// The built-in sections of the project settings panel, and the registry the panel lists (settingsSections). A section is
// a component over the model plus, for the ones that are forms, the logic that turns its drafts into a patch
// (project-settings-logic.ts). A later change adds Network (B11) or Editor Extensions (E-X4) with one register() call:
// see the extension point in project-settings-registry.ts. Nothing in the panel or in these sections changes for it.
import type { ComponentChildren, ComponentType } from "preact"
import { useState } from "preact/hooks"
import {
  DeterminismLogic,
  GeneralLogic,
  InputLogic,
  LayersLogic,
  MathLogic,
  PhysicsLogic,
  RawLogic,
  RenderingLogic,
  StartupSceneKey,
} from "./project-settings-logic"
import { ExtensionsSection } from "./extensions-ui"
import { NetworkSection } from "./network-panel-ui"
import { PhysicsBackendTakesEffectNote, determinismLabel } from "../protocol/physics-backends"
import type { PhysicsBackendInfo } from "../protocol/protocol.generated"
import { SectionRegistry, type SettingsSectionDef } from "./project-settings-registry"
import type { ProjectSettingsModel } from "./project-settings-state"
import {
  DeterminismFields,
  JsonKey,
  LayerCount,
  LuaSeedWarning,
  MathFields,
  PhysicsFields,
  RenderingFields,
  collisionMatrixOf,
  isBuiltinLayer,
  layerKey,
  pairKey,
  pairText,
  rowsCollide,
  type FieldSpec,
} from "./project-settings-schema"

export interface SectionProps {
  model: ProjectSettingsModel
  def: SettingsSectionDef<ComponentType<SectionProps>>
}

export type SectionComponent = ComponentType<SectionProps>

const RestartTitle = "Takes effect after the host restarts: the engine reads this value only when it starts"

// ==================== Shared pieces ====================

function inputId(section: string, key: string): string {
  return `ps-${section}-${key}`.replace(/[^A-Za-z0-9_-]/g, "-")
}

function Row(props: {
  htmlFor: string
  label: string
  restart?: boolean
  dirty?: boolean
  unit?: string
  help?: string
  error?: string
  children: ComponentChildren
}) {
  return (
    <div class={`ps-row${props.dirty ? " dirty" : ""}`}>
      <label for={props.htmlFor}>{props.label}</label>
      <span class="ps-control">
        {props.children}
        {props.unit && <span class="ps-unit">{props.unit}</span>}
        {props.restart && (
          <span class="ps-badge restart" title={RestartTitle}>
            applies after restart
          </span>
        )}
      </span>
      {props.help && <div class="ps-help">{props.help}</div>}
      {props.error && (
        <div class="ps-field-error" role="alert">
          {props.error}
        </div>
      )}
    </div>
  )
}

function FieldControl(props: { model: ProjectSettingsModel; section: string; spec: FieldSpec; disabled: boolean }) {
  const { model, section, spec, disabled } = props
  const text = model.textOf(section, spec.id)
  const error = model.built(section).errors[spec.id]
  const id = inputId(section, spec.id)
  let control
  if (spec.kind === "enum" || spec.kind === "bool") {
    const options = spec.options ?? []
    // A value the project has that is not one of ours (another case, another type) is shown as written
    const known = options.find((o) => o.value === text.toLowerCase())
    const value = known ? known.value : text
    control = (
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => model.setEdit(section, spec.id, (e.currentTarget as HTMLSelectElement).value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {!known && <option value={text}>{text} (as written)</option>}
      </select>
    )
  } else {
    control = (
      <input
        id={id}
        type="text"
        inputMode={spec.kind === "integer" ? "numeric" : "decimal"}
        value={text}
        placeholder={spec.defaultText}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onInput={(e) => model.setEdit(section, spec.id, (e.currentTarget as HTMLInputElement).value)}
      />
    )
  }
  return (
    <Row
      htmlFor={id}
      label={spec.label}
      restart={spec.restart}
      dirty={model.isKeyDirty(section, spec.id)}
      unit={spec.unit}
      help={spec.help}
      error={error}
    >
      {control}
    </Row>
  )
}

/** A form over a field table; extra is shown under the intro (the determinism warning) */
function FieldsForm(props: SectionProps & { fields: readonly FieldSpec[]; intro?: string; extra?: ComponentChildren }) {
  const { model, def, fields } = props
  const disabled = model.disabledReason(def.id) !== null || model.applying.value !== null
  const basic = fields.filter((f) => !f.advanced)
  const advanced = fields.filter((f) => f.advanced)
  return (
    <div class="ps-form">
      {props.intro && <p class="ps-intro">{props.intro}</p>}
      {props.extra}
      {basic.map((spec) => (
        <FieldControl key={spec.id} model={model} section={def.id} spec={spec} disabled={disabled} />
      ))}
      {advanced.length > 0 && (
        <details class="ps-advanced">
          <summary>Advanced</summary>
          {advanced.map((spec) => (
            <FieldControl key={spec.id} model={model} section={def.id} spec={spec} disabled={disabled} />
          ))}
        </details>
      )}
    </div>
  )
}

// ==================== The sections ====================

function GeneralSection({ model, def }: SectionProps) {
  const info = model.info.value
  if (!info) return null
  const disabled = model.disabledReason(def.id) !== null || model.applying.value !== null
  const current = model.textOf(def.id, StartupSceneKey)
  const scenes = info.project.scenes.includes(current) || current === "" ? info.project.scenes : [...info.project.scenes, current]
  const id = inputId(def.id, StartupSceneKey)
  return (
    <div class="ps-form">
      <div class="ps-facts">
        <div>
          <span>Name</span> <b>{info.project.name}</b>
        </div>
        <div>
          <span>Project id</span> <code>{info.project.projectId}</code>
        </div>
        <div>
          <span>Engine version</span> <b>{info.project.engineVersion}</b>
        </div>
      </div>
      <Row
        htmlFor={id}
        label="Startup scene"
        dirty={model.isKeyDirty(def.id, StartupSceneKey)}
        help="The scene a game opens first. Choose from the project's scenes; Apply saves it to project.n2proj."
      >
        <select
          id={id}
          value={current}
          disabled={disabled}
          onChange={(e) => model.setEdit(def.id, StartupSceneKey, (e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">(none)</option>
          {scenes.map((scene) => (
            <option key={scene} value={scene}>
              {scene}
            </option>
          ))}
        </select>
      </Row>
    </div>
  )
}

const PhysicsSection = (props: SectionProps) => (
  <FieldsForm {...props} fields={PhysicsFields} intro="Empty means the engine's default." />
)
const RenderingSection = (props: SectionProps) => <FieldsForm {...props} fields={RenderingFields} />
const MathSection = (props: SectionProps) => <FieldsForm {...props} fields={MathFields} />

const DeterminismSection = (props: SectionProps) => (
  <FieldsForm
    {...props}
    fields={DeterminismFields}
    extra={
      <p class="ps-warning" role="note">
        {LuaSeedWarning}
      </p>
    }
  />
)

function LayersSection({ model, def }: SectionProps) {
  const disabled = model.disabledReason(def.id) !== null || model.applying.value !== null
  const errors = model.built(def.id).errors
  const rows = []
  for (let i = 0; i < LayerCount; i++) {
    const key = layerKey(i)
    const builtin = isBuiltinLayer(i)
    const id = inputId(def.id, key)
    rows.push(
      <div class={`ps-layer${model.isKeyDirty(def.id, key) ? " dirty" : ""}`} key={key}>
        <label for={id}>{i}</label>
        <input
          id={id}
          type="text"
          aria-label={`Layer ${i}`}
          value={model.textOf(def.id, key)}
          disabled={disabled || builtin}
          title={builtin ? "A built-in layer: its name is fixed" : undefined}
          placeholder="(unnamed)"
          aria-invalid={errors[key] ? true : undefined}
          onInput={(e) => model.setEdit(def.id, key, (e.currentTarget as HTMLInputElement).value)}
        />
        {errors[key] && (
          <span class="ps-field-error" role="alert">
            {errors[key]}
          </span>
        )}
      </div>
    )
  }
  return (
    <div class="ps-form">
      <p class="ps-intro">The 32 layer names. The built-in layers are fixed; a name can be used once.</p>
      <div class="ps-layers">{rows}</div>
      <CollisionMatrixEditor model={model} def={def} disabled={disabled} />
    </div>
  )
}

/**
 * The collision matrix as a grid of checkboxes: (a, b) and (b, a) are one pair (one edit key), so ticking either ticks
 * both. The unnamed layers are left out until "Show the unnamed layers" is ticked; a row's or a column's own checkbox
 * sets every pair of that layer that is shown.
 */
function CollisionMatrixEditor({ model, def, disabled }: SectionProps & { disabled: boolean }) {
  const [showAll, setShowAll] = useState(false)
  const matrix = collisionMatrixOf(model.settings.value)
  const edits = model.edits.value[def.id] ?? {}
  const dirty = new Set(model.built(def.id).changed)
  const names: string[] = []
  for (let i = 0; i < LayerCount; i++) names.push(model.textOf(def.id, layerKey(i)))
  const unnamed = names.filter((n) => n === "").length
  const shown: number[] = []
  for (let i = 0; i < LayerCount; i++) if (showAll || names[i] !== "") shown.push(i)
  const collides = (a: number, b: number): boolean => {
    const edit = edits[pairKey(a, b)]
    return edit !== undefined ? edit === "1" : rowsCollide(matrix.rows, a, b)
  }
  const title = (i: number) => (names[i] === "" ? `Layer ${i} (unnamed)` : `Layer ${i}: ${names[i]}`)
  /** A line's checkbox: ticked when every shown pair of the layer collides, mixed when some do */
  const lineBox = (layer: number, label: string) => {
    const count = shown.filter((other) => collides(layer, other)).length
    const all = shown.length > 0 && count === shown.length
    return (
      <input
        type="checkbox"
        aria-label={label}
        title={`Every layer shown collides with ${title(layer)} (or, unticked, none does)`}
        checked={all}
        indeterminate={count > 0 && !all}
        disabled={disabled}
        onChange={() => {
          const texts: Record<string, string> = {}
          for (const other of shown) texts[pairKey(layer, other)] = pairText(!all)
          model.setEdits(def.id, texts)
        }}
      />
    )
  }
  return (
    <div class="ps-matrix-block">
      <h4>Collision matrix</h4>
      <p class="ps-intro">
        Which layers' colliders touch (contacts and triggers). A pair is one setting: ticking row a, column b ticks row b,
        column a too. Apply writes all 32 rows to the project.
      </p>
      {matrix.problem && (
        <p class="ps-warning" role="note">
          {matrix.problem}
        </p>
      )}
      <label class="ps-matrix-toggle">
        <input type="checkbox" checked={showAll} onChange={() => setShowAll(!showAll)} /> Show the unnamed layers ({unnamed})
      </label>
      <div class="ps-matrix-scroll">
        <table class="ps-matrix" aria-label="Layer collision matrix">
          <thead>
            <tr>
              <th />
              {shown.map((b) => (
                <th key={b} scope="col" title={title(b)}>
                  <span class="ps-matrix-name">{names[b] === "" ? String(b) : `${b} ${names[b]}`}</span>
                  {lineBox(b, `All of column ${b}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => (
              <tr key={a}>
                <th scope="row" title={title(a)}>
                  <span class="ps-matrix-name">{names[a] === "" ? String(a) : `${a} ${names[a]}`}</span>
                  {lineBox(a, `All of row ${a}`)}
                </th>
                {shown.map((b) => {
                  const key = pairKey(a, b)
                  const on = collides(a, b)
                  return (
                    <td key={b} class={dirty.has(key) ? "dirty" : undefined}>
                      <input
                        type="checkbox"
                        aria-label={`Layers ${a} and ${b} collide`}
                        title={`${title(a)} and ${title(b)}`}
                        checked={on}
                        disabled={disabled}
                        onChange={() => model.setEdit(def.id, key, pairText(!on))}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** One backend of the picker: what the host says it declares, and the button that chooses it */
function BackendCard(props: { model: ProjectSettingsModel; backend: PhysicsBackendInfo }) {
  const { model, backend } = props
  const picker = model.backends
  const info = picker?.info.value
  if (!picker || !info) return null
  const isCurrent = info.current === backend.id
  const isActive = info.active === backend.id
  const block = picker.blockReason(backend)
  const busy = picker.choosing.value !== null
  const deterministicPreset = info.networkPreset.toLowerCase() === "deterministic"
  return (
    <div class={`ps-backend${isCurrent ? " current" : ""}${backend.compiledIn ? "" : " missing"}`} data-backend={backend.id} role="group" aria-label={backend.displayName}>
      <div class="ps-backend-head">
        <b>{backend.displayName}</b> <code>{backend.id}</code>
        {isCurrent && <span class="ps-badge">project setting</span>}
        {isActive && <span class="ps-badge">running in this host</span>}
        {!backend.compiledIn && <span class="ps-badge restart">not compiled in</span>}
      </div>
      <dl class="ps-backend-facts">
        <dt>Compiled in</dt>
        <dd>{backend.compiledIn ? "Yes" : "No"}</dd>
        <dt>Determinism</dt>
        <dd>
          {determinismLabel(backend.determinism)}
          {backend.determinism !== backend.determinismDefault && <span class="ps-help"> (default: {determinismLabel(backend.determinismDefault)})</span>}
        </dd>
        <dt>Missing features</dt>
        <dd>{backend.missingFeatures.length === 0 ? "None" : backend.missingFeatures.join(", ")}</dd>
        <dt>Snapshots</dt>
        <dd>
          {backend.supportsSnapshot ? "Snapshot" : "No snapshot"}, {backend.supportsSetState ? "set state" : "no set state"}
        </dd>
        <dt>Deterministic preset</dt>
        <dd>{backend.deterministicSelectable ? "Selectable" : "Not selectable"}</dd>
      </dl>
      {backend.note && <p class="ps-help">{backend.note}</p>}
      {deterministicPreset && !backend.deterministicSelectable && backend.compiledIn && (
        <p class="ps-warning" role="note">
          The network preset is Deterministic and this backend is not deterministic-selectable: the host refuses it.
        </p>
      )}
      <div class="ps-buttons">
        <button type="button" disabled={isCurrent || block !== null || busy} title={block ?? undefined} onClick={() => void picker.choose(backend.id)}>
          {picker.choosing.value === backend.id ? "Choosing..." : isCurrent ? "Chosen" : "Use this backend"}
        </button>
      </div>
    </div>
  )
}

/** The Physics backend section (protocol 1.20.0): the host's backends as cards, and which the project uses */
function PhysicsBackendSection(props: SectionProps) {
  const model = props.model
  const picker = model.backends
  if (!picker) return <p class="ps-intro">The backend picker is not available in this panel.</p>
  const info = picker.info.value
  const reason = picker.disabledReason
  const loadError = picker.loadError.value
  const error = picker.error.value
  return (
    <div class="ps-form ps-backends">
      <p class="ps-intro">
        The 3D physics backend the project uses (the setting <code>physics.backend</code>). {PhysicsBackendTakesEffectNote}
      </p>
      {reason && !picker.supported && (
        <div class="ps-note" role="status">
          {reason}
        </div>
      )}
      {loadError && (
        <p class="ps-field-error" role="alert">
          Failed to read the physics backends: {loadError}
        </p>
      )}
      {info && (
        <>
          <div class="ps-facts">
            <div>
              <span>Current</span> <b>{info.current}</b> {!info.configured && <span class="ps-help">(the project does not set it; the default)</span>}
            </div>
            <div>
              <span>Configured</span> <b>{info.configured ? "Yes" : "No"}</b>
            </div>
            <div>
              <span>Active</span> <b>{info.active === "" ? "none" : info.active}</b>
            </div>
            <div>
              <span>Network preset</span> <b>{info.networkPreset === "" ? "(none)" : info.networkPreset}</b>
            </div>
          </div>
          {info.restartRequired && (
            <div class="ps-restart" role="status">
              The host runs {info.active === "" ? "no backend" : info.active}, the project names {info.current}: {PhysicsBackendTakesEffectNote}{" "}
              {model.canRestartHost && (
                <button type="button" onClick={() => void model.restartHost()}>
                  Restart host
                </button>
              )}
            </div>
          )}
          {info.backends.map((backend) => (
            <BackendCard key={backend.id} model={model} backend={backend} />
          ))}
        </>
      )}
      {error && (
        <div class="ps-host-error" role="alert">
          <b>The host refused it.</b> <pre>{error}</pre>
        </div>
      )}
      {picker.lastChosen.value && !error && (
        <div class="ps-restart" role="status">
          Saved {picker.lastChosen.value}. {PhysicsBackendTakesEffectNote}
        </div>
      )}
    </div>
  )
}

function JsonSection(props: SectionProps & { help: string; rows: number }) {
  const { model, def } = props
  const disabled = model.disabledReason(def.id) !== null || model.applying.value !== null
  const error = model.built(def.id).errors[JsonKey]
  const id = inputId(def.id, JsonKey)
  return (
    <div class="ps-form">
      <p class="ps-intro">{props.help}</p>
      <textarea
        id={id}
        class="ps-json"
        aria-label={`${def.title} as JSON`}
        spellcheck={false}
        rows={props.rows}
        value={model.textOf(def.id, JsonKey)}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onInput={(e) => model.setEdit(def.id, JsonKey, (e.currentTarget as HTMLTextAreaElement).value)}
      />
      {error && (
        <div class="ps-field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

const InputSection = (props: SectionProps) => (
  <JsonSection
    {...props}
    rows={16}
    help={'The input action maps, as {"actionMaps": {...}}. The shape is the engine\'s; a structured editor is a later change. Empty removes the block.'}
  />
)

const RawSection = (props: SectionProps) => (
  <JsonSection
    {...props}
    rows={22}
    help="The whole settings object of project.n2proj, for blocks this editor has no form for (window, and keys of other tools). Apply sends only what differs, as a merge patch, and asks first."
  />
)

// ==================== The registry ====================

/** The sections the panel lists. Later changes register theirs here (see project-settings-registry.ts). */
export const settingsSections = new SectionRegistry<SectionComponent>()

export const DeterminismAdminReason =
  "Only an admin can change the determinism settings: the host refuses an editor. The values are shown read-only."

settingsSections.register({ id: "general", title: "General", order: 10, component: GeneralSection, logic: GeneralLogic })
settingsSections.register({ id: "physics", title: "Physics", order: 20, component: PhysicsSection, logic: PhysicsLogic })
settingsSections.register({ id: "rendering", title: "Rendering", order: 30, component: RenderingSection, logic: RenderingLogic })
settingsSections.register({ id: "math", title: "Math", order: 40, component: MathSection, logic: MathLogic })
settingsSections.register({
  id: "determinism",
  title: "Determinism",
  order: 50,
  component: DeterminismSection,
  logic: DeterminismLogic,
  requires: (gate) =>
    gate.isAdmin
      ? gate.determinismDenied
        ? "The host refused the change: determinism settings need the admin role. The values are shown read-only."
        : null
      : DeterminismAdminReason,
})
settingsSections.register({ id: "layers", title: "Layers", order: 60, component: LayersSection, logic: LayersLogic })
settingsSections.register({ id: "physics-backend", title: "Physics backend", order: 25, component: PhysicsBackendSection })
settingsSections.register({ id: "network", title: "Network", order: 70, component: NetworkSection })
settingsSections.register({ id: "extensions", title: "Extensions", order: 80, component: ExtensionsSection })
settingsSections.register({ id: "input", title: "Input", order: 90, component: InputSection, logic: InputLogic })
settingsSections.register({ id: "raw", title: "Raw JSON", order: 100, component: RawSection, logic: RawLogic })
