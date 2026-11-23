// The inspector's shader section (protocol 1.35.0): which Shader asset a Sprite2D, UI Image or ParticleSystem draws with, and the
// values of the shader's parameters. Shown only on a host with the "shaderState" capability. The rules are in shader-state.ts.
import { useEffect, useState } from "preact/hooks"
import type { FieldSchema, ShaderInfo, ShaderParamInfo } from "../protocol/protocol.generated"
import { hasCapability } from "../protocol/extensions"
import { NumberInput, PickerButton, type PickerEntry } from "./inspector-editors"
import type { ComponentView } from "./inspector-state"
import {
  ShaderStateCapability,
  ShaderStateTypes,
  componentCount,
  editableParams,
  paramBool,
  paramNumbers,
  readShaderState,
  shaderStatePatch,
  withParam,
  type ShaderState,
} from "./shader-state"
import { useApp } from "./ui"

const AxisNames = ["x", "y", "z", "w"]
const ColorNames = ["r", "g", "b", "a"]

export function numberField(param: ShaderParamInfo, axis: string | null): FieldSchema {
  // The engine clamps only a float's or an int's range (Material's .mat reader), so a vector's axes get none here
  const scalar = axis === null
  return {
    name: axis ? `${param.name}.${axis}` : param.name,
    displayName: param.label ?? param.name,
    kind: param.type === "int" ? "Int" : "Float",
    typeName: param.type === "int" ? "int" : "float",
    hidden: false,
    readOnly: false,
    ...(scalar && param.min !== undefined ? { min: param.min } : {}),
    ...(scalar && param.max !== undefined ? { max: param.max } : {}),
  }
}

function ParamRow(props: { param: ShaderParamInfo; state: ShaderState; disabled: boolean; set(state: ShaderState): void; invalid(message: string): void }) {
  const { param, state, disabled } = props
  const label = param.label ?? param.name
  if (param.type === "bool") {
    return (
      <div class="field-row shader-param" data-shader-param={param.name}>
        <label>{label}</label>
        <input
          type="checkbox"
          aria-label={label}
          checked={paramBool(state, param)}
          disabled={disabled}
          onChange={(e) => props.set(withParam(state, param, (e.currentTarget as HTMLInputElement).checked))}
        />
      </div>
    )
  }
  const count = componentCount(param.type)
  if (count === 0) {
    return (
      <div class="field-row shader-param" data-shader-param={param.name}>
        <label>{label}</label>
        <span class="field-note" title="Set it in a .mat or from Lua (GetMaterialInstance)">
          {param.type}: not edited here
        </span>
      </div>
    )
  }
  const numbers = paramNumbers(state, param)
  const names = param.type === "color" ? ColorNames : AxisNames
  return (
    <div class="field-row shader-param" data-shader-param={param.name}>
      <label>{label}</label>
      <div class="vector-editor">
        {numbers.map((value, index) => (
          <NumberInput
            key={index}
            field={numberField(param, count > 1 ? names[index] : null)}
            value={value}
            disabled={disabled}
            label={count > 1 ? names[index] : undefined}
            ariaLabel={count > 1 ? `${label} ${names[index]}` : label}
            onValue={(next) => {
              const changed = numbers.slice()
              changed[index] = next
              props.set(withParam(state, param, changed))
            }}
            onInvalid={props.invalid}
          />
        ))}
      </div>
    </div>
  )
}

/** The section, on a component that can have a shader (nothing otherwise, without reading anything) */
export function ShaderStateSection({ view }: { view: ComponentView }) {
  return ShaderStateTypes.has(view.type) ? <ShaderStateBody view={view} /> : null
}

/** What GetShaderInfo said about one shader: kept with the UUID it was read for, so another shader's parameters never show */
interface LoadedInfo {
  shader: string
  info: ShaderInfo
}

function ShaderStateBody({ view }: { view: ComponentView }) {
  const { store, inspector } = useApp()
  const supported = hasCapability(store.serverInfo.value?.capabilities, ShaderStateCapability)
  const state = readShaderState(inspector.valuesOf(view))
  const [loaded, setLoaded] = useState<LoadedInfo | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const shader = state?.shader ?? null
  // The asset listing changes when a file does (a saved or cooked .n2shader): the parameters are read again then
  const assets = inspector.assets.value
  useEffect(() => {
    setProblem(null)
    if (!supported || shader === null) return
    let stale = false
    window.engine.getShaderInfo(shader).then(
      (read) => {
        if (!stale) setLoaded({ shader, info: read })
      },
      (e) => {
        if (!stale) setProblem(String(e instanceof Error ? e.message : e))
      }
    )
    return () => {
      stale = true
    }
  }, [supported, shader, assets])
  const info = loaded !== null && loaded.shader === shader ? loaded.info : null
  if (!supported) return null

  const disabled = inspector.readOnly.value
  const edit = (next: ShaderState | null) => {
    try {
      inspector.edit(view.id, shaderStatePatch(next), { immediate: true })
    } catch (e) {
      store.reportError("Failed to set the shader", e)
    }
  }
  const shaders = (): PickerEntry[] =>
    inspector.assets.value.ofType("Shader").map((entry) => ({ key: entry.uuid, label: entry.path.replace(/^res:\/\//, "") }))
  const current = shader ? inspector.assets.value.byUuid(shader) : undefined
  return (
    <div class="shader-state" data-shader-state="">
      <div class="field-row">
        <label>Shader</label>
        <PickerButton
          label={shader ? (current?.path.replace(/^res:\/\//, "") ?? shader) : "None"}
          title={shader ?? "No shader: the component draws as built in"}
          disabled={disabled}
          entries={shaders}
          placeholder="Search shaders"
          emptyText="No Shader assets in the project"
          // The same shader again changes nothing: no request, no undo step
          onPick={(uuid) => (uuid === shader ? undefined : edit({ shader: uuid, params: {} }))}
        />
        {shader && (
          <button class="secondary" aria-label="Remove the shader" title="Draw as built in" disabled={disabled} onClick={() => edit(null)}>
            ×
          </button>
        )}
      </div>
      {problem && <div class="field-error">The shader can't be read: {problem}</div>}
      {state &&
        info &&
        editableParams(info).map((param) => (
          <ParamRow
            key={param.name}
            param={param}
            state={state}
            disabled={disabled}
            set={edit}
            invalid={(message) => store.reportError(`Shader parameter ${param.name}`, new Error(message))}
          />
        ))}
    </div>
  )
}
