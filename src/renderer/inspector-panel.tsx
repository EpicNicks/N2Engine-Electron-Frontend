// The inspector panel: the selected object's own properties and transform, then its components, each with an editor per
// field (inspector-editors.tsx) from the component's schema, and the Add Component menu. The logic is in
// inspector-state.ts and inspector-fields.ts (tested in Node); this is the DOM around it.
import { useState } from "preact/hooks"
import type { FieldSchema } from "../protocol/protocol.generated"
import type { Vec3 } from "../protocol/protocol.generated"
import { FieldEditor, NumberInput, PickerButton, PickerEntry, TextInput } from "./inspector-editors"
import { MaxLayer } from "../protocol/entity-args"
import { ComponentView, EntityKey } from "./inspector-state"
import {
  checkValue,
  displayTypeName,
  displayValue,
  fieldPatch,
  groupComponentTypes,
  visibleFields,
} from "./inspector-fields"
import { Empty, Panel, useApp } from "./ui"

// ==================== The object's own properties and transform ====================

function VectorRow(props: {
  label: string
  value: Vec3
  step: number
  disabled: boolean
  onChange: (value: Vec3) => void
}) {
  return (
    <div class="inspector-row">
      <label>{props.label}</label>
      <div class="vector-inputs">
        {(["x", "y", "z"] as const).map((axis) => (
          <input
            key={axis}
            type="number"
            step={props.step}
            aria-label={`${props.label} ${axis}`}
            value={props.value[axis].toFixed(2)}
            disabled={props.disabled}
            onChange={(e) => {
              const n = parseFloat((e.currentTarget as HTMLInputElement).value)
              if (Number.isFinite(n)) props.onChange({ ...props.value, [axis]: n })
            }}
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

function TransformSection() {
  const { store, scene, inspector } = useApp()
  const transform = scene.transform.value
  const disabled = inspector.readOnly.value
  if (!transform) return <Empty>This object has no transform</Empty>
  const set = (change: Partial<typeof transform>) =>
    scene.setTransform({ ...transform, ...change }).catch((e) => store.reportError("Failed to set the transform", e))
  return (
    <div class="inspector-section">
      <h4>Transform</h4>
      <VectorRow
        label="Position"
        value={transform.position}
        step={0.1}
        disabled={disabled}
        onChange={(position) => set({ position })}
      />
      <VectorRow
        label="Rotation"
        value={transform.rotation}
        step={1}
        disabled={disabled}
        onChange={(rotation) => set({ rotation })}
      />
      <VectorRow
        label="Scale"
        value={transform.scale}
        step={0.1}
        disabled={disabled}
        onChange={(scale) => set({ scale })}
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
  const tip = [field.tooltip, field.readOnly ? "Read only" : null].filter(Boolean).join(". ")
  return (
    <div class="field-row">
      <label title={tip || undefined}>{field.displayName}</label>
      <div class="field-editor">
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

// ==================== The panel ====================

export function InspectorPanel() {
  const { store, scene, hierarchy, inspector } = useApp()
  const selected = scene.selectedId.value
  const readOnlyReason = inspector.readOnlyReason.value

  let content
  if (!selected || !store.connected.value) content = <Empty>Select an entity to inspect</Empty>
  else if (inspector.loadProblem.value) content = <Empty error>{inspector.loadProblem.value}</Empty>
  else if (inspector.loading.value || !inspector.header.value) content = <Empty>Loading...</Empty>
  else {
    const selectedCount = hierarchy.selection.value.ids.size
    const typesProblem = inspector.typesProblem.value
    content = (
      <>
        {readOnlyReason && <div class="inspector-banner">Read only: {readOnlyReason}</div>}
        <EntitySection />
        {/* An object with no transform (CreateEntity's) is shown without one, not as a failure */}
        {scene.transform.value || scene.noTransform.value ? <TransformSection /> : <Empty>Loading...</Empty>}
        <div class="inspector-section">
          <h4>Components</h4>
          {typesProblem && <Empty error>Component types: {typesProblem}</Empty>}
          {inspector.components.value.length === 0 && !typesProblem && <Empty>No components</Empty>}
          {inspector.components.value.map((view) => (
            <ComponentCard view={view} key={view.id} />
          ))}
          <AddComponent />
        </div>
        <button
          class="danger"
          disabled={inspector.readOnly.value}
          onClick={() => hierarchy.deleteSelected().catch((e) => store.reportError("Failed to delete the entity", e))}
        >
          {selectedCount > 1 ? `Delete ${selectedCount} Selected` : "Delete Entity"}
        </button>
      </>
    )
  }
  return (
    <Panel title="Inspector" icon="⚙️" class="inspector-panel">
      {content}
    </Panel>
  )
}
