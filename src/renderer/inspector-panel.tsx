// The inspector panel: the selected object's own properties and transform, then its components, each with an editor per
// field (inspector-editors.tsx) from the component's schema, and the Add Component menu. The logic is in
// inspector-state.ts and inspector-fields.ts (tested in Node); this is the DOM around it.
import { useEffect, useRef, useState } from "preact/hooks"
import type { FieldSchema } from "../protocol/protocol.generated"
import type { Vec3 } from "../protocol/protocol.generated"
import { FieldEditor, NumberInput, PickerButton, PickerEntry, TextInput } from "./inspector-editors"
import { MaxLayer } from "../protocol/entity-args"
import { ComponentView, DefaultDebounceMilliseconds, EntityKey } from "./inspector-state"
import { MultiComponent, TransformPart, fieldMixed, mixedAxes, multiFields } from "./inspector-multi"
import {
  checkValue,
  displayTypeName,
  displayValue,
  fieldPatch,
  groupComponentTypes,
  visibleFields,
} from "./inspector-fields"
import { endWhenReleased } from "./edit-groups"
import { clean } from "./extension-menu"
import { formatFieldValue } from "./extension-inspector"
import { Empty, Panel, useApp } from "./ui"

// ==================== The object's own properties and transform ====================

const Axes = ["x", "y", "z"] as const

/** A field of a vector row, for NumberInput's checks: any finite number */
const axisField = (label: string): FieldSchema => ({
  name: label,
  displayName: label,
  kind: "Float",
  typeName: "float",
  hidden: false,
  readOnly: false,
})

/**
 * A row of three number boxes (X, Y, Z): each is committed on Enter or on leaving it (a typed text is kept while it is
 * typed), and is one edit. mixed: the axes on which several selected objects differ show a dash.
 */
function VectorRow(props: {
  label: string
  value: Vec3
  mixed?: { x: boolean; y: boolean; z: boolean }
  disabled: boolean
  title?: string
  /** Changes when the values were read again (see NumberInput's syncKey) */
  syncKey?: unknown
  onAxis: (axis: (typeof Axes)[number], value: number) => void
  onInvalid: (message: string) => void
}) {
  const field = axisField(props.label)
  return (
    <div class="inspector-row">
      <label title={props.title}>{props.label}</label>
      <div class="vector-inputs">
        {Axes.map((axis) => (
          <NumberInput
            key={axis}
            field={field}
            label={axis}
            ariaLabel={`${props.label} ${axis}`}
            value={props.value[axis]}
            mixed={props.mixed?.[axis] === true}
            syncKey={props.syncKey}
            disabled={props.disabled}
            onValue={(n) => props.onAxis(axis, n)}
            onInvalid={props.onInvalid}
          />
        ))}
      </div>
    </div>
  )
}

/** A field of the object's own, for NumberInput's checks: the layer */
const LayerField: FieldSchema = {
  name: "layer",
  displayName: "Layer",
  kind: "Int",
  typeName: "int",
  hidden: false,
  readOnly: false,
  min: 0,
  max: MaxLayer,
}

function EntitySection() {
  const { store, inspector } = useApp()
  const header = inspector.header.value
  const disabled = inspector.readOnly.value
  const error = inspector.errors.value.get(EntityKey)
  const set = (properties: Parameters<typeof inspector.setEntityProperties>[0]) =>
    inspector.setEntityProperties(properties).catch((e) => store.reportError("Failed to change the object", e))
  if (!header) return null
  return (
    <div class="inspector-section">
      <h4>Entity</h4>
      <div class="inspector-row">
        <label>Name</label>
        <TextInput
          label="Name"
          value={header.name}
          disabled={disabled}
          onCommit={(name) => name !== header.name && void set({ name })}
        />
      </div>
      <div class="inspector-row">
        <label>Active</label>
        <input
          type="checkbox"
          aria-label="Active"
          checked={header.active}
          disabled={disabled}
          onChange={(e) => void set({ active: (e.currentTarget as HTMLInputElement).checked })}
        />
        {!header.activeInHierarchy && header.active && <span class="hint">inactive through a parent</span>}
      </div>
      <div class="inspector-row">
        <label>Tag</label>
        <TextInput
          label="Tag"
          value={header.tag}
          disabled={disabled}
          onCommit={(tag) => tag !== header.tag && void set({ tag })}
        />
      </div>
      <div class="inspector-row">
        <label>Layer</label>
        <NumberInput
          field={LayerField}
          value={header.layer}
          disabled={disabled}
          onValue={(layer) => layer !== header.layer && void set({ layer })}
          onInvalid={(message) => store.reportError("Layer", message)}
        />
      </div>
      {error && <div class="field-error">{error}</div>}
    </div>
  )
}

const TransformTitle =
  "The local transform (relative to the parent), the one the gizmo moves. Rotation is Euler angles in degrees, applied X, then Y, then Z."

function TransformSection() {
  const { store, inspector } = useApp()
  const transform = inspector.transform.value
  const euler = inspector.euler.value
  const disabled = inspector.readOnly.value
  if (!transform || !euler) return <Empty>This object has no transform</Empty>
  // One axis of a box is one edit: SetLocalTransform with the whole local transform, the rotation as a quaternion
  const edit = (part: TransformPart, axis: (typeof Axes)[number], value: number) => {
    const current = part === "position" ? transform.position : part === "scale" ? transform.scale : euler
    const next = { ...current, [axis]: value }
    try {
      inspector
        .setTransform(part === "position" ? { position: next } : part === "scale" ? { scale: next } : { rotation: next })
        .catch((e) => store.reportError("Failed to set the transform", e))
    } catch (e) {
      store.reportError("Failed to set the transform", e)
    }
  }
  const invalid = (message: string) => store.reportError("Transform", message)
  const syncKey = inspector.transformRev.value
  return (
    <div class="inspector-section">
      <h4 title={TransformTitle}>Transform</h4>
      <VectorRow
        label="Position"
        syncKey={syncKey}
        value={transform.position}
        disabled={disabled}
        onAxis={(axis, n) => edit("position", axis, n)}
        onInvalid={invalid}
      />
      <VectorRow
        label="Rotation"
        title={TransformTitle}
        syncKey={syncKey}
        value={euler}
        disabled={disabled}
        onAxis={(axis, n) => edit("rotation", axis, n)}
        onInvalid={invalid}
      />
      <VectorRow
        label="Scale"
        syncKey={syncKey}
        value={transform.scale}
        disabled={disabled}
        onAxis={(axis, n) => edit("scale", axis, n)}
        onInvalid={invalid}
      />
    </div>
  )
}

// ==================== Components ====================

/** One field of a component: its label and editor, and why a value was refused before it was sent */
function FieldRow({ view, field }: { view: ComponentView; field: FieldSchema }) {
  const { store, inspector } = useApp()
  const [error, setError] = useState<string | null>(null)
  const value = displayValue(field, inspector.valuesOf(view))
  const disabled = inspector.readOnly.value || field.readOnly

  const commit = (next: unknown, immediate: boolean) => {
    const checked = checkValue(field, next)
    if (!checked.ok) return setError(checked.error)
    setError(null)
    try {
      inspector.edit(view.id, fieldPatch(field, checked.value), { immediate })
    } catch (e) {
      store.reportError(`Failed to edit ${field.displayName}`, e)
    }
  }
  // A drag of a slider is one undo step: its group opens when the pointer goes down and ends when it is released
  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as HTMLInputElement | null
    if (target?.tagName !== "INPUT" || target.type !== "range") return
    // Listening for the end only when a drag started: no listeners for one that didn't
    if (inspector.beginGesture(`Edit ${field.displayName}`)) endWhenReleased(document, window, () => void inspector.endGesture())
  }
  const tip = [field.tooltip, field.readOnly ? "Read only" : null].filter(Boolean).join(". ")
  return (
    <div class="field-row">
      <label title={tip || undefined}>{field.displayName}</label>
      <div class="field-editor" onPointerDownCapture={onPointerDown}>
        <FieldEditor field={field} value={value} disabled={disabled} commit={commit} invalid={setError} />
        {error && <div class="field-error">{error}</div>}
      </div>
    </div>
  )
}

/** Why a component has no fields to edit: the types are still being read, couldn't be, or its type isn't one */
function SchemaMissing({ type }: { type: string }) {
  const { inspector } = useApp()
  if (inspector.types.value === null) {
    const problem = inspector.typesProblem.value
    if (problem === null) return <Empty>Reading the component types...</Empty>
    return (
      <Empty error>
        The component types couldn't be read: {problem}{" "}
        <button class="link" onClick={() => void inspector.loadTypes()}>
          Try again
        </button>
      </Empty>
    )
  }
  return <Empty error>{type} isn't a registered component type, so it can't be edited</Empty>
}

/**
 * The inspector sections the project's editor extensions registered for this component's type (protocol 1.16.0): a title,
 * read-only fields (the component's values, as text) and buttons. A button runs on this component as one undo step, after
 * its form when it has one. Every string here is the extension's, so it is a text node or an attribute, never HTML. A
 * viewer sees the fields but no buttons (running one is a Write command).
 */
function ExtensionSections({ view }: { view: ComponentView }) {
  const { extensions, inspector } = useApp()
  const sections = extensions.sectionsFor(view.type)
  if (sections.length === 0) return null
  // The revision these sections were built from is what a press sends: a host that changed since refuses it (staleUi)
  const revision = extensions.uiRevision
  const values = inspector.valuesOf(view)
  const mayRun = extensions.mayRunButtons.value
  return (
    <>
      {sections.map((section, i) => (
        <div class="extension-section" data-extension-section={i} key={i}>
          <h5 class="extension-section-title" title={clean(section.extension)}>
            {clean(section.label)}
          </h5>
          {section.fields
            .filter((field) => !field.hidden)
            .map((field) => (
              <div class="field-row extension-field" key={(field.container ?? "") + "/" + field.name}>
                <label title={field.tooltip || undefined}>{clean(field.displayName)}</label>
                <div class="field-editor extension-value">{formatFieldValue(field, values)}</div>
              </div>
            ))}
          {mayRun && section.buttons.length > 0 && (
            <div class="extension-buttons">
              {section.buttons.map((button) => {
                const availability = extensions.buttonAvailability(section, button)
                return (
                  <button
                    class="secondary"
                    key={button.id}
                    disabled={!availability.enabled}
                    title={availability.reason ?? undefined}
                    onClick={() => void extensions.runButton(button, view.id, revision)}
                  >
                    {clean(button.label)}
                    {button.form !== undefined && button.form.fields.length > 0 ? "..." : ""}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      ))}
    </>
  )
}

function ComponentCard({ view }: { view: ComponentView }) {
  const { store, inspector } = useApp()
  const schema = inspector.schemaFor(view)
  const collapsed = inspector.collapsed.value.has(view.id)
  const values = inspector.valuesOf(view)
  const error = inspector.errors.value.get(view.id)
  const problem = inspector.luaProblems.value.get(view.id)
  const disabled = inspector.readOnly.value
  const active = typeof values.isActive === "boolean" ? values.isActive : null

  const setActive = (isActive: boolean) => {
    try {
      inspector.edit(view.id, { isActive }, { immediate: true })
    } catch (e) {
      store.reportError("Failed to edit the component", e)
    }
  }
  return (
    <div class="component-card">
      <div class="component-header">
        <span
          class="arrow"
          role="button"
          aria-label={collapsed ? "Expand" : "Collapse"}
          aria-expanded={!collapsed}
          onClick={() => inspector.toggleCollapsed(view.id)}
        >
          {collapsed ? "▸" : "▾"}
        </span>
        {active !== null && (
          <input
            type="checkbox"
            aria-label={`${view.type} enabled`}
            title="Enabled"
            checked={active}
            disabled={disabled}
            onChange={(e) => setActive((e.currentTarget as HTMLInputElement).checked)}
          />
        )}
        <span class="component-title" title={view.type} onClick={() => inspector.toggleCollapsed(view.id)}>
          {displayTypeName(view.type)}
        </span>
        <button
          class="secondary component-remove"
          title={`Remove ${view.type}`}
          aria-label={`Remove ${view.type}`}
          disabled={disabled}
          onClick={() =>
            inspector.removeComponent(view.id).catch((e) => store.reportError("Failed to remove the component", e))
          }
        >
          ×
        </button>
      </div>
      {!collapsed && (
        <div class="component-body">
          {schema === null ? (
            <SchemaMissing type={view.type} />
          ) : (
            visibleFields(schema).map((field) => (
              <FieldRow view={view} field={field} key={(field.container ?? "") + "/" + field.name} />
            ))
          )}
          {problem && <div class="field-error">The script's fields can't be read: {problem}</div>}
          <ExtensionSections view={view} />
          {error && <div class="field-error component-error">{error}</div>}
        </div>
      )}
    </div>
  )
}

function AddComponent() {
  const { store, inspector } = useApp()
  const types = inspector.types.value
  const present = inspector.presentTypes.value
  const search = (query: string): PickerEntry[] =>
    groupComponentTypes(types ?? [], query, present).flatMap((group) => [
      { key: "", label: group.name, header: true },
      ...group.items.map((item) => ({ key: item.typeName, label: item.label, disabled: item.disabledReason })),
    ])
  return (
    <div class="add-component">
      <PickerButton
        class="add-component-button"
        label="Add Component"
        disabled={inspector.readOnly.value}
        title={inspector.readOnly.value ? (inspector.readOnlyReason.value ?? "") : undefined}
        // Types that couldn't be read are asked for again
        onOpen={() => void inspector.loadTypes()}
        entries={null}
        search={search}
        placeholder="Search components"
        emptyText={
          types === null
            ? (inspector.typesProblem.value ?? "Reading the component types...")
            : "No component types match"
        }
        onPick={(typeName) =>
          inspector.addComponent(typeName).catch((e) => store.reportError(`Failed to add ${typeName}`, e))
        }
      />
    </div>
  )
}

// ==================== Several objects selected ====================

/** Runs an edit of the selected objects: a refusal that comes at once (read-only) or later is shown, never thrown */
function useMultiRun() {
  const { store } = useApp()
  return (what: string, edit: () => Promise<void>) => {
    try {
      edit().catch((e) => store.reportError(what, e))
    } catch (e) {
      store.reportError(what, e)
    }
  }
}

const IsActiveField: FieldSchema = {
  name: "isActive",
  displayName: "Enabled",
  kind: "Bool",
  typeName: "bool",
  hidden: false,
  readOnly: false,
}

/** One shared field: its editor shows a dash where the objects differ, and an edit sets it on all of them */
function MultiFieldRow({ component, field }: { component: MultiComponent; field: FieldSchema }) {
  const { inspector } = useApp()
  const run = useMultiRun()
  const [error, setError] = useState<string | null>(null)
  const { value, mixed } = fieldMixed(field, component.entries)
  const disabled = inspector.readOnly.value
  // What a slider or a colour picker sends while it is dragged waits for a pause: one edit group, not one per tick
  const waiting = useRef<{ value: unknown; axis?: string | readonly string[] } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const apply = (next: unknown, axis?: string | readonly string[]) =>
    run(`Failed to edit ${field.displayName}`, () => inspector.multi.setField(component, field, next, axis))
  // The latest render's apply: a pause or an unmount sends to the objects as they are now
  const latest = useRef(apply)
  latest.current = apply
  const flush = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    const held = waiting.current
    waiting.current = null
    if (held) latest.current(held.value, held.axis)
  }
  // Leaving the panel sends what is waiting, and so do Undo and Save (the state asks before it settles)
  useEffect(() => {
    const unregister = inspector.multi.onPending(flush)
    return () => {
      unregister()
      flush()
    }
  }, [])
  const commit = (next: unknown, immediate: boolean, axis?: string | readonly string[]) => {
    const checked = checkValue(field, next)
    if (!checked.ok) return setError(checked.error)
    setError(null)
    if (immediate) {
      // An earlier drag's last value is not sent after this one
      waiting.current = null
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
      return apply(checked.value, axis)
    }
    waiting.current = { value: checked.value, axis }
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(flush, DefaultDebounceMilliseconds)
  }
  const tip = field.tooltip
  return (
    <div class="field-row">
      <label title={tip || undefined}>{field.displayName}</label>
      <div class="field-editor">
        <FieldEditor
          field={field}
          value={value}
          mixed={mixed}
          mixedAxes={mixed ? mixedAxes(field, component.entries) : undefined}
          syncKey={inspector.multi.objects.value}
          disabled={disabled}
          commit={commit}
          invalid={setError}
        />
        {error && <div class="field-error">{error}</div>}
      </div>
    </div>
  )
}

function MultiComponentCard({ component }: { component: MultiComponent }) {
  const { inspector } = useApp()
  const run = useMultiRun()
  const schema = inspector.multi.schemaFor(component)
  const disabled = inspector.readOnly.value
  const enabled = component.entries.every((entry) => typeof entry.values.isActive === "boolean")
    ? fieldMixed(IsActiveField, component.entries)
    : null
  const shown = schema ? multiFields(schema) : null
  return (
    <div class="component-card multi-component">
      <div class="component-header">
        {enabled && (
          <FieldEditor
            field={IsActiveField}
            value={enabled.value}
            mixed={enabled.mixed}
            disabled={disabled}
            commit={(next) => run("Failed to edit the components", () => inspector.multi.setField(component, IsActiveField, next))}
            invalid={() => {}}
          />
        )}
        <span class="component-title" title={component.type}>
          {displayTypeName(component.type)}
        </span>
      </div>
      <div class="component-body">
        {shown === null ? (
          <Empty>Reading the fields...</Empty>
        ) : (
          <>
            {shown.fields.map((field) => (
              // Keyed by the first object's component too: another selection is another set of fields
              <MultiFieldRow
                component={component}
                field={field}
                key={component.entries[0].componentId + "/" + (field.container ?? "") + "/" + field.name}
              />
            ))}
            {shown.skipped > 0 && (
              <div class="hint multi-skipped">
                {shown.skipped} {shown.skipped === 1 ? "field" : "fields"} (references, lists, JSON) can be edited one object at a time
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** The fields the selected objects share (inspector-multi.ts): one edit sets them all, as one undo step */
function MultiInspector() {
  const { store, inspector } = useApp()
  const run = useMultiRun()
  const multi = inspector.multi
  const view = multi.view.value
  const problem = multi.loadProblem.value
  if (problem) return <Empty error>{problem}</Empty>
  if (!view) return <Empty>Loading...</Empty>
  const disabled = inspector.readOnly.value
  const layerField = LayerField
  const setProperties = (properties: Parameters<typeof multi.setProperties>[0]) =>
    run("Failed to change the objects", () => multi.setProperties(properties))
  const axisRow = (part: TransformPart, label: string) => {
    const axes = view.transform![part]
    return (
      <VectorRow
        label={label}
        title={part === "rotation" ? TransformTitle : undefined}
        syncKey={multi.objects.value}
        value={{ x: axes.x.value, y: axes.y.value, z: axes.z.value }}
        mixed={{ x: axes.x.mixed, y: axes.y.mixed, z: axes.z.mixed }}
        disabled={disabled}
        onAxis={(axis, n) => run("Failed to set the transform", () => multi.setTransformAxis(part, axis, n))}
        onInvalid={(message) => store.reportError("Transform", message)}
      />
    )
  }
  return (
    <>
      <div class="inspector-banner multi-banner" title="An edit applies to all of them, as one undo step">
        {view.count} objects
      </div>
      <div class="inspector-section">
        <h4>Entity</h4>
        <div class="inspector-row">
          <label>Active</label>
          <FieldEditor
            field={{ ...IsActiveField, name: "active", displayName: "Active" }}
            value={view.active.value}
            mixed={view.active.mixed}
            disabled={disabled}
            commit={(next) => setProperties({ active: next === true })}
            invalid={() => {}}
          />
        </div>
        <div class="inspector-row">
          <label>Tag</label>
          <TextInput
            label="Tag"
            value={view.tag.value}
            mixed={view.tag.mixed}
            syncKey={multi.objects.value}
            disabled={disabled}
            onCommit={(tag) => void setProperties({ tag })}
          />
        </div>
        <div class="inspector-row">
          <label>Layer</label>
          <NumberInput
            field={layerField}
            value={view.layer.value}
            mixed={view.layer.mixed}
            syncKey={multi.objects.value}
            disabled={disabled}
            onValue={(layer) => void setProperties({ layer })}
            onInvalid={(message) => store.reportError("Layer", message)}
          />
        </div>
      </div>
      <div class="inspector-section">
        <h4 title={TransformTitle}>Transform</h4>
        {view.transform ? (
          <>
            {axisRow("position", "Position")}
            {axisRow("rotation", "Rotation")}
            {axisRow("scale", "Scale")}
          </>
        ) : (
          <Empty>Not every selected object has a transform</Empty>
        )}
      </div>
      <div class="inspector-section">
        <h4>Components</h4>
        {view.components.length === 0 && <Empty>The selected objects share no components</Empty>}
        {view.components.map((component) => (
          <MultiComponentCard component={component} key={component.type + "/" + component.entries[0].componentId} />
        ))}
      </div>
      {multi.editProblem.value && <div class="field-error multi-error">{multi.editProblem.value}</div>}
    </>
  )
}

// ==================== The panel ====================

export function InspectorPanel() {
  const { store, scene, hierarchy, inspector } = useApp()
  const selected = scene.selectedId.value
  const readOnlyReason = inspector.readOnlyReason.value

  const selectedCount = hierarchy.selection.value.ids.size
  const deleteButton = (
    <button
      class="danger"
      disabled={inspector.readOnly.value}
      onClick={() => hierarchy.deleteSelected().catch((e) => store.reportError("Failed to delete the entity", e))}
    >
      {selectedCount > 1 ? `Delete ${selectedCount} Selected` : "Delete Entity"}
    </button>
  )

  let content
  if (!selected || !store.connected.value) content = <Empty>Select an entity to inspect</Empty>
  else if (selectedCount > 1) {
    // Several objects: their shared fields, edited together
    content = (
      <>
        {readOnlyReason && <div class="inspector-banner">Read only: {readOnlyReason}</div>}
        <MultiInspector />
        {deleteButton}
      </>
    )
  } else if (inspector.loadProblem.value) content = <Empty error>{inspector.loadProblem.value}</Empty>
  else if (inspector.loading.value || !inspector.header.value) content = <Empty>Loading...</Empty>
  else {
    const typesProblem = inspector.typesProblem.value
    content = (
      <>
        {readOnlyReason && <div class="inspector-banner">Read only: {readOnlyReason}</div>}
        <EntitySection />
        {/* An object with no transform (CreateEntity's) is shown without one, not as a failure */}
        <TransformSection />
        <div class="inspector-section">
          <h4>Components</h4>
          {typesProblem && <Empty error>Component types: {typesProblem}</Empty>}
          {inspector.components.value.length === 0 && !typesProblem && <Empty>No components</Empty>}
          {inspector.components.value.map((view) => (
            <ComponentCard view={view} key={view.id} />
          ))}
          <AddComponent />
        </div>
        {deleteButton}
      </>
    )
  }
  return (
    <Panel title="Inspector" icon="⚙️" class="inspector-panel">
      {content}
    </Panel>
  )
}
