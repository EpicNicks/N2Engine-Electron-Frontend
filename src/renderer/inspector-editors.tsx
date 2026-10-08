// The inspector's field editors, one per FieldKind: what each shows and how it turns what the person did into a value.
// They hold no state about the component: each is given the value to show and a commit callback (the field's row checks
// the value, and the inspector state sends it). The logic they use is in inspector-fields.ts and asset-lookup.ts
// (tested in Node); this is the DOM around it.
import { ComponentChildren } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"
import type { FieldSchema } from "../protocol/protocol.generated"
import { assetName } from "./asset-lookup"
import { AssetDragType, EntityDragType, dragHas } from "./drag-types"
import {
  axesOf,
  checkNumber,
  colorChannels,
  colorToHex,
  formatJson,
  formatNumber,
  hexToColor,
  isObject,
  kindOf,
  numberLimits,
  parseJsonText,
  parseNumberText,
} from "./inspector-fields"
import { toResPath } from "./paths"
import { useApp } from "./ui"

/** What every editor is given */
export interface EditorProps {
  field: FieldSchema
  /** The value to show (the kind's neutral one when the component holds none) */
  value: unknown
  disabled: boolean
  /** Sets the value: immediate sends it now, else it waits for the debounce delay (a drag of a slider) */
  commit(value: unknown, immediate: boolean): void
  /** Says why what was typed isn't a value; the row shows it */
  invalid(message: string): void
}

// ==================== A searchable list in a popover ====================

export interface PickerEntry {
  key: string
  label: string
  detail?: string
  indent?: number
  /** Why it can't be picked, or null/absent */
  disabled?: string | null
  /** A heading between groups, not pickable */
  header?: boolean
}

/**
 * A list with a search field, shown at x, y until something is picked or it is dismissed (Escape, or a click
 * outside). entries is null while they are being read.
 */
export function SearchPicker(props: {
  x: number
  y: number
  entries: PickerEntry[] | null
  /** Makes the entries for what was typed, instead of the picker's own filter (a grouped menu does its own search) */
  search?: (query: string) => PickerEntry[]
  problem?: string | null
  placeholder: string
  emptyText: string
  onPick(key: string): void
  onClose(): void
}) {
  const [query, setQuery] = useState("")
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    const outside = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) props.onClose()
    }
    document.addEventListener("mousedown", outside)
    window.addEventListener("blur", props.onClose)
    return () => {
      document.removeEventListener("mousedown", outside)
      window.removeEventListener("blur", props.onClose)
    }
  }, [])

  const needle = query.replace(/\s+/g, "").toLowerCase()
  const matches = (entry: PickerEntry) =>
    needle === "" || `${entry.label}${entry.detail ?? ""}`.replace(/\s+/g, "").toLowerCase().includes(needle)
  let shown: PickerEntry[] = []
  if (props.search) shown = props.search(query)
  else {
    // A heading stays only with a match under it
    ;(props.entries ?? []).forEach((entry, i, all) => {
      if (entry.header) {
        const rest = all.slice(i + 1)
        const next = rest.findIndex((e) => e.header)
        if ((next < 0 ? rest : rest.slice(0, next)).some(matches)) shown.push(entry)
      } else if (matches(entry)) shown.push(entry)
    })
  }

  const left = Math.max(0, Math.min(props.x, window.innerWidth - 280))
  const top = Math.max(0, Math.min(props.y, window.innerHeight - 340))
  return (
    <div class="picker" ref={root} style={{ left: `${left}px`, top: `${top}px` }} role="listbox">
      <input
        ref={input}
        type="text"
        class="picker-search"
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        value={query}
        onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose()
          else if (e.key === "Enter") {
            const first = shown.find((entry) => !entry.header && !entry.disabled)
            if (first) props.onPick(first.key)
          }
        }}
      />
      <div class="picker-list">
        {props.problem ? (
          <div class="picker-empty error">{props.problem}</div>
        ) : props.entries === null && !props.search ? (
          <div class="picker-empty">Loading...</div>
        ) : shown.length === 0 ? (
          <div class="picker-empty">{props.emptyText}</div>
        ) : (
          shown.map((entry) =>
            entry.header ? (
              <div class="picker-header" key={"h:" + entry.label}>
                {entry.label}
              </div>
            ) : (
              <div
                class={entry.disabled ? "picker-item disabled" : "picker-item"}
                role="option"
                aria-disabled={entry.disabled ? true : false}
                title={entry.disabled ?? entry.detail}
                style={entry.indent ? { paddingLeft: `${8 + entry.indent * 12}px` } : undefined}
                key={entry.key}
                onClick={() => !entry.disabled && props.onPick(entry.key)}
              >
                <span>{entry.label}</span>
                {entry.detail && <span class="picker-detail">{entry.detail}</span>}
              </div>
            )
          )
        )}
      </div>
    </div>
  )
}

/** A button that opens a picker below it */
function PickerButton(props: {
  label: string
  title?: string
  disabled?: boolean
  entries: PickerEntry[] | null | (() => Promise<PickerEntry[]>)
  search?: (query: string) => PickerEntry[]
  placeholder: string
  emptyText: string
  /** at: where the picker was opened, for one that opens another next to it */
  onPick(key: string, at: { x: number; y: number }): void
  class?: string
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const [loaded, setLoaded] = useState<PickerEntry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const open = (e: MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setAt({ x: rect.left, y: rect.bottom })
    setProblem(null)
    if (typeof props.entries === "function") {
      setLoaded(null)
      props.entries().then(setLoaded, (err) => setProblem(err instanceof Error ? err.message : String(err)))
    }
  }
  const entries = typeof props.entries === "function" ? loaded : props.entries
  return (
    <>
      <button class={props.class ?? "secondary slot-pick"} title={props.title} disabled={props.disabled} onClick={open}>
        {props.label}
      </button>
      {at && (
        <SearchPicker
          x={at.x}
          y={at.y}
          entries={entries}
          search={props.search}
          problem={problem}
          placeholder={props.placeholder}
          emptyText={props.emptyText}
          onPick={(key) => {
            setAt(null)
            props.onPick(key, at)
          }}
          onClose={() => setAt(null)}
        />
      )}
    </>
  )
}

export { PickerButton }

// ==================== Numbers ====================

/** A number box: typed text is checked when it is left or Enter is pressed, and an invalid one stays shown with the reason */
export function NumberInput(props: {
  field: FieldSchema
  value: number
  disabled: boolean
  label?: string
  onValue(value: number): void
  onInvalid(message: string): void
}) {
  const [text, setText] = useState(formatNumber(props.value))
  const [bad, setBad] = useState(false)
  const typing = useRef(false)
  // The stored value changed (the host clamped it, another edit): show it, unless the person is typing
  useEffect(() => {
    if (!typing.current) {
      setText(formatNumber(props.value))
      setBad(false)
    }
  }, [props.value])

  // The text is read from the box itself: the last keystroke may not have been rendered yet
  const finish = (typed: string) => {
    typing.current = false
    const parsed = parseNumberText(props.field, typed)
    if (!parsed.ok) {
      setBad(true)
      props.onInvalid(parsed.error)
      return
    }
    setBad(false)
    setText(formatNumber(parsed.value))
    props.onValue(parsed.value)
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      class={bad ? "number-input invalid" : "number-input"}
      aria-label={props.label ?? props.field.displayName}
      title={props.label ? `${props.field.displayName} ${props.label}` : undefined}
      value={text}
      disabled={props.disabled}
      onInput={(e) => {
        typing.current = true
        setText((e.currentTarget as HTMLInputElement).value)
      }}
      onBlur={(e) => typing.current && finish((e.currentTarget as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish((e.currentTarget as HTMLInputElement).value)
        else if (e.key === "Escape") {
          typing.current = false
          setText(formatNumber(props.value))
          setBad(false)
        }
      }}
    />
  )
}

function NumberEditor({ field, value, disabled, commit, invalid }: EditorProps) {
  const limits = numberLimits(field)
  const current = typeof value === "number" ? value : 0
  const step = limits.integer ? 1 : Math.max((limits.max - limits.min) / 200, 0.0001)
  return (
    <div class="number-editor">
      {limits.ranged && (
        <input
          type="range"
          class="slider"
          aria-label={`${field.displayName} slider`}
          min={limits.min}
          max={limits.max}
          step={step}
          value={Math.min(limits.max, Math.max(limits.min, current))}
          disabled={disabled}
          onInput={(e) => {
            const checked = checkNumber(field, Number((e.currentTarget as HTMLInputElement).value))
            if (checked.ok) commit(checked.value, false)
          }}
        />
      )}
      <NumberInput
        field={field}
        value={current}
        disabled={disabled}
        onValue={(n) => commit(n, true)}
        onInvalid={invalid}
      />
    </div>
  )
}

function VectorEditor({ field, value, disabled, commit, invalid }: EditorProps) {
  const axes = axesOf(kindOf(field))
  const current = isObject(value) ? value : {}
  return (
    <div class="vector-inputs">
      {axes.map((axis) => (
        <NumberInput
          key={axis}
          field={field}
          label={axis}
          value={typeof current[axis] === "number" ? (current[axis] as number) : 0}
          disabled={disabled}
          onValue={(n) => commit({ ...Object.fromEntries(axes.map((a) => [a, current[a] ?? 0])), [axis]: n }, true)}
          onInvalid={invalid}
        />
      ))}
    </div>
  )
}

function ColorEditor({ field, value, disabled, commit, invalid }: EditorProps) {
  const { keys, hasAlpha } = colorChannels(field)
  const current = isObject(value) ? value : {}
  const alphaKey = keys[keys.length - 1]
  return (
    <div class="color-editor">
      <input
        type="color"
        aria-label={field.displayName}
        value={colorToHex(field, value)}
        disabled={disabled}
        onInput={(e) => {
          const next = hexToColor(field, (e.currentTarget as HTMLInputElement).value, value)
          if (next.ok) commit(next.value, false)
        }}
      />
      {hasAlpha && (
        <NumberInput
          field={{ ...field, min: 0, max: 1 }}
          label="alpha"
          value={typeof current[alphaKey] === "number" ? (current[alphaKey] as number) : 1}
          disabled={disabled}
          onValue={(n) => commit({ ...current, [alphaKey]: n }, true)}
          onInvalid={invalid}
        />
      )}
    </div>
  )
}

// ==================== Simple kinds ====================

function BoolEditor({ field, value, disabled, commit }: EditorProps) {
  return (
    <input
      type="checkbox"
      aria-label={field.displayName}
      checked={value === true}
      disabled={disabled}
      onChange={(e) => commit((e.currentTarget as HTMLInputElement).checked, true)}
    />
  )
}

function StringEditor({ field, value, disabled, commit }: EditorProps) {
  return (
    <input
      type="text"
      aria-label={field.displayName}
      value={typeof value === "string" ? value : ""}
      disabled={disabled}
      onChange={(e) => commit((e.currentTarget as HTMLInputElement).value, true)}
    />
  )
}

function EnumEditor({ field, value, disabled, commit }: EditorProps) {
  const options = field.enumOptions ?? []
  const current = typeof value === "string" ? value : ""
  return (
    <select
      aria-label={field.displayName}
      value={current}
      disabled={disabled}
      onChange={(e) => commit((e.currentTarget as HTMLSelectElement).value, true)}
    >
      {/* A value that isn't an option (the host refuses it on a set, but a file may hold one) is still shown */}
      {!options.includes(current) && <option value={current}>{current}</option>}
      {options.map((option) => (
        <option value={option} key={option}>
          {option}
        </option>
      ))}
    </select>
  )
}

/** JSON as text, checked when the field is left (or Ctrl+Enter): an invalid text stays and says why */
function JsonEditor({ field, value, disabled, commit, invalid }: EditorProps) {
  const shown = formatJson(value)
  const [text, setText] = useState(shown)
  const [bad, setBad] = useState(false)
  const typing = useRef(false)
  useEffect(() => {
    if (!typing.current) {
      setText(shown)
      setBad(false)
    }
  }, [shown])
  const finish = (typed: string) => {
    typing.current = false
    if (typed === shown) return setBad(false)
    const parsed = parseJsonText(field, typed)
    if (!parsed.ok) {
      setBad(true)
      return invalid(parsed.error)
    }
    setBad(false)
    commit(parsed.value, true)
  }
  return (
    <textarea
      class={bad ? "json-editor invalid" : "json-editor"}
      aria-label={field.displayName}
      spellcheck={false}
      rows={Math.min(10, Math.max(2, text.split("\n").length))}
      value={text}
      disabled={disabled}
      onInput={(e) => {
        typing.current = true
        setText((e.currentTarget as HTMLTextAreaElement).value)
      }}
      onBlur={(e) => typing.current && finish((e.currentTarget as HTMLTextAreaElement).value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          finish((e.currentTarget as HTMLTextAreaElement).value)
        } else if (e.key === "Escape") {
          typing.current = false
          setText(shown)
          setBad(false)
        }
      }}
    />
  )
}

// ==================== References ====================

/** A drop target for a reference: shows the value, takes a drag, has a picker and a clear button */
function Slot(props: {
  label: string
  known: boolean
  empty: boolean
  title?: string
  disabled: boolean
  accepts(event: DragEvent): boolean
  onDrop(event: DragEvent): void
  onClear(): void
  children: ComponentChildren
}) {
  const [over, setOver] = useState(false)
  return (
    <div
      class={over ? "slot drop-over" : "slot"}
      onDragOver={(e) => {
        if (props.disabled || !props.accepts(e)) return
        e.preventDefault() // allows the drop
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"
        if (!over) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        if (props.disabled || !props.accepts(e)) return
        e.preventDefault()
        e.stopPropagation()
        props.onDrop(e)
      }}
    >
      <span class={props.empty ? "slot-label none" : props.known ? "slot-label" : "slot-label missing"} title={props.title}>
        {props.empty ? "None" : props.label}
      </span>
      {props.children}
      {!props.empty && !props.disabled && (
        <button class="secondary slot-clear" title="Clear" aria-label="Clear" onClick={props.onClear}>
          ×
        </button>
      )}
    </div>
  )
}

/** One asset reference (an AssetRef, or an item of an AssetRefList) */
function AssetSlot(props: {
  field: FieldSchema
  uuid: string | null
  disabled: boolean
  onChange(uuid: string | null): void
  onProblem(message: string): void
}) {
  const { store, inspector } = useApp()
  const assets = inspector.assets.value
  const { field, uuid } = props
  const label = uuid ? assets.label(uuid) : null
  const choose = (key: string) => {
    if (key === "") return props.onChange(null)
    const entry = assets.byUuid(key)
    if (!entry) return props.onProblem("That asset isn't in the project")
    const checked = assets.check(field, entry)
    if (checked.ok) props.onChange(checked.value)
    else props.onProblem(checked.error)
  }
  const dropped = (e: DragEvent) => {
    const file = e.dataTransfer?.getData(AssetDragType) ?? ""
    const resPath = toResPath(store.projectPath.value ?? "", file)
    if (resPath === null) return props.onProblem("Only files in the project's assets folder are assets")
    const entry = assets.byPath(resPath)
    if (!entry) {
      return props.onProblem(`${resPath} isn't in the host's asset index (a file added just now is indexed on a rescan)`)
    }
    choose(entry.uuid)
  }
  return (
    <Slot
      label={label?.text ?? ""}
      known={label?.known ?? true}
      empty={uuid === null}
      title={uuid ? `${assets.byUuid(uuid)?.path ?? uuid}` : `Drop a ${field.assetType ?? "asset"} here`}
      disabled={props.disabled}
      accepts={(e) => dragHas(e, AssetDragType)}
      onDrop={dropped}
      onClear={() => props.onChange(null)}
    >
      {!props.disabled && (
        <PickerButton
          label="..."
          title={`Pick a${field.assetType ? ` ${field.assetType}` : "n asset"}`}
          entries={[
            { key: "", label: "None" },
            ...assets.ofType(field.assetType).map((entry) => ({
              key: entry.uuid,
              label: assetName(entry),
              detail: entry.path,
            })),
          ]}
          placeholder="Search assets"
          emptyText={`No ${field.assetType ?? ""} assets in the project`}
          onPick={choose}
        />
      )}
    </Slot>
  )
}

/** One object reference (a GameObjectRef, or an item of a GameObjectRefList) */
function ObjectSlot(props: {
  field: FieldSchema
  uuid: string | null
  disabled: boolean
  onChange(uuid: string | null): void
  onProblem(message: string): void
}) {
  const { hierarchy } = useApp()
  const tree = hierarchy.tree.value
  const node = props.uuid ? tree.nodes.get(props.uuid) : undefined
  const depthOf = (id: string): number => {
    let depth = 0
    for (let p = tree.parents.get(id); p !== undefined && p !== "" && depth < 64; p = tree.parents.get(p)) depth++
    return depth
  }
  return (
    <Slot
      label={node?.name ?? `${(props.uuid ?? "").slice(0, 8)}... (not in the scene)`}
      known={node !== undefined}
      empty={props.uuid === null}
      title={props.uuid ?? "Drop an object from the hierarchy here"}
      disabled={props.disabled}
      accepts={(e) => dragHas(e, EntityDragType)}
      onDrop={(e) => {
        const id = e.dataTransfer?.getData(EntityDragType) ?? ""
        if (tree.nodes.has(id)) props.onChange(id)
        else props.onProblem("That object isn't in the scene")
      }}
      onClear={() => props.onChange(null)}
    >
      {!props.disabled && (
        <PickerButton
          label="..."
          title="Pick an object"
          entries={[
            { key: "", label: "None" },
            ...tree.order.map((id) => ({ key: id, label: tree.nodes.get(id)?.name ?? id, indent: depthOf(id) })),
          ]}
          placeholder="Search objects"
          emptyText="No objects in the scene"
          onPick={(key) => props.onChange(key === "" ? null : key)}
        />
      )}
    </Slot>
  )
}

/** One component reference: pick an object, then one of its components of the type the field wants */
function ComponentSlot(props: {
  field: FieldSchema
  uuid: string | null
  disabled: boolean
  onChange(uuid: string | null): void
  onProblem(message: string): void
}) {
  const { hierarchy, inspector } = useApp()
  const tree = hierarchy.tree.value
  const [step, setStep] = useState<{ entityId: string; at: { x: number; y: number } } | null>(null)
  const [components, setComponents] = useState<PickerEntry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const wanted = props.field.typeName
  const info = props.uuid ? inspector.componentInfo(props.uuid) : undefined
  const owner = info ? tree.nodes.get(info.entityId) : undefined
  const label = info ? `${owner?.name ?? "?"} > ${info.type}` : `${(props.uuid ?? "").slice(0, 8)}...`
  const depthOf = (id: string): number => {
    let depth = 0
    for (let p = tree.parents.get(id); p !== undefined && p !== "" && depth < 64; p = tree.parents.get(p)) depth++
    return depth
  }

  const pickEntity = (key: string, at: { x: number; y: number }) => {
    if (key === "") return props.onChange(null)
    setStep({ entityId: key, at })
    setComponents(null)
    setProblem(null)
    inspector.componentsOf(key).then(
      (list) =>
        setComponents(
          list
            .filter((c) => wanted === "" || wanted === "Component" || c.type === wanted)
            .map((c) => ({ key: c.id, label: c.type, detail: tree.nodes.get(key)?.name }))
        ),
      (e) => setProblem(e instanceof Error ? e.message : String(e))
    )
  }
  return (
    <Slot
      label={label}
      known={info !== undefined}
      empty={props.uuid === null}
      title={props.uuid ?? `Pick a ${wanted === "Component" ? "component" : wanted}`}
      disabled={props.disabled}
      accepts={() => false}
      onDrop={() => {}}
      onClear={() => props.onChange(null)}
    >
      {!props.disabled && (
        <PickerButton
          label="..."
          title="Pick a component"
          entries={[
            { key: "", label: "None" },
            ...tree.order.map((id) => ({ key: id, label: tree.nodes.get(id)?.name ?? id, indent: depthOf(id) })),
          ]}
          placeholder="Search objects"
          emptyText="No objects in the scene"
          onPick={pickEntity}
        />
      )}
      {step && (
        <SearchPicker
          x={step.at.x}
          y={step.at.y}
          entries={components}
          problem={problem}
          placeholder={`Search ${wanted === "Component" ? "components" : wanted + "s"}`}
          emptyText={`No ${wanted === "Component" ? "components" : wanted} on that object`}
          onPick={(key) => {
            setStep(null)
            props.onChange(key)
          }}
          onClose={() => setStep(null)}
        />
      )}
    </Slot>
  )
}

type SlotComponent = typeof AssetSlot

function slotFor(kind: string): SlotComponent {
  if (kind.startsWith("Asset")) return AssetSlot
  if (kind.startsWith("GameObject")) return ObjectSlot
  return ComponentSlot
}

function RefEditor({ field, value, disabled, commit, invalid }: EditorProps) {
  const Single = slotFor(field.kind)
  return (
    <Single
      field={field}
      uuid={typeof value === "string" ? value : null}
      disabled={disabled}
      onChange={(uuid) => commit(uuid, true)}
      onProblem={invalid}
    />
  )
}

function RefListEditor({ field, value, disabled, commit, invalid }: EditorProps) {
  const Single = slotFor(field.kind)
  const items: Array<string | null> = Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : null)) : []
  return (
    <div class="ref-list">
      {items.length === 0 && <div class="ref-list-empty">Empty</div>}
      {items.map((uuid, i) => (
        <div class="ref-list-item" key={i}>
          <Single
            field={field}
            uuid={uuid}
            disabled={disabled}
            onChange={(next) => commit(items.map((item, j) => (j === i ? next : item)), true)}
            onProblem={invalid}
          />
          {!disabled && (
            <button
              class="secondary slot-clear"
              title="Remove from the list"
              aria-label="Remove from the list"
              onClick={() => commit(items.filter((_, j) => j !== i), true)}
            >
              −
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <button class="secondary" onClick={() => commit([...items, null], true)}>
          + Add
        </button>
      )}
    </div>
  )
}

// ==================== The editor for a field ====================

/** The editor of a field's kind. A kind this client doesn't know is edited as JSON, which the host checks. */
export function FieldEditor(props: EditorProps) {
  switch (kindOf(props.field)) {
    case "Bool":
      return <BoolEditor {...props} />
    case "Int":
    case "Float":
      return <NumberEditor {...props} />
    case "String":
      return <StringEditor {...props} />
    case "Vector2":
    case "Vector3":
    case "Vector4":
    case "Quaternion":
      return <VectorEditor {...props} />
    case "Color":
      return <ColorEditor {...props} />
    case "Enum":
      return <EnumEditor {...props} />
    case "AssetRef":
    case "GameObjectRef":
    case "ComponentRef":
      return <RefEditor {...props} />
    case "AssetRefList":
    case "GameObjectRefList":
    case "ComponentRefList":
      return <RefListEditor {...props} />
    case "Json":
      return <JsonEditor {...props} />
  }
}
