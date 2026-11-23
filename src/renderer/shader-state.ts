// The inspector's shader section (protocol 1.35.0, Hello capability "shaderState"): a Sprite2D's, UI Image's or ParticleSystem's
// optional shader and its values. The host keeps them in the component's shaderState key ({shader: <Shader asset UUID>, params:
// {name: value}}, the spellings a .mat uses), which is in no field schema; SetComponentFields takes it as a whole object, or null
// to clear the shader. Pure helpers here, the section is shader-state-ui.tsx.
import type { ShaderInfo, ShaderParamInfo } from "../protocol/protocol.generated"
import type { JsonObject } from "../shared/api"

export const ShaderStateCapability = "shaderState"
/** The components that have a shaderState (the engine's UserShaderSlot users) */
export const ShaderStateTypes: ReadonlySet<string> = new Set(["Sprite2D", "Image", "ParticleSystem"])

export interface ShaderState {
  shader: string
  params: JsonObject
}

/** The component's shaderState, or null when it has no shader */
export function readShaderState(values: JsonObject): ShaderState | null {
  const state = values.shaderState
  if (state === null || typeof state !== "object" || Array.isArray(state)) return null
  const shader = (state as JsonObject).shader
  if (typeof shader !== "string" || shader === "") return null
  const params = (state as JsonObject).params
  return { shader, params: params !== null && typeof params === "object" && !Array.isArray(params) ? (params as JsonObject) : {} }
}

/** How many numbers a parameter of this type is edited as (0: not edited here: a texture, a matrix, an unknown type) */
export function componentCount(type: string): number {
  switch (type) {
    case "float":
    case "int":
      return 1
    case "vec2":
      return 2
    case "vec3":
      return 3
    case "vec4":
    case "color":
      return 4
    default:
      return 0
  }
}

/** The parameter's value as numbers: the stored one when it has the right shape, else the shader's default, else zeros */
export function paramNumbers(state: ShaderState, param: ShaderParamInfo): number[] {
  const count = componentCount(param.type)
  const shape = (value: unknown): number[] | null => {
    if (count === 1 && typeof value === "number" && Number.isFinite(value)) return [value]
    if (Array.isArray(value) && value.length >= count && value.slice(0, count).every((n) => typeof n === "number" && Number.isFinite(n))) {
      return value.slice(0, count) as number[]
    }
    return null
  }
  return shape(state.params[param.name]) ?? shape(param.default) ?? new Array<number>(count).fill(0)
}

/** A bool parameter's value: stored, else the default */
export function paramBool(state: ShaderState, param: ShaderParamInfo): boolean {
  const stored = state.params[param.name]
  if (typeof stored === "boolean") return stored
  return param.default === true
}

/** The state with one parameter set (an int is rounded; one number is stored as a number, more as an array) */
export function withParam(state: ShaderState, param: ShaderParamInfo, value: number[] | boolean): ShaderState {
  let stored: unknown = value
  if (Array.isArray(value)) {
    const numbers = param.type === "int" ? value.map((n) => Math.round(n)) : value
    stored = numbers.length === 1 ? numbers[0] : numbers
  }
  return { shader: state.shader, params: { ...state.params, [param.name]: stored as JsonObject[string] } }
}

/** The SetComponentFields patch for a state (null clears the shader) */
export function shaderStatePatch(state: ShaderState | null): JsonObject {
  return { shaderState: state === null ? null : { shader: state.shader, params: state.params } }
}

/** The parameters a person edits here: not the reserved baseColorTexture the component itself fills */
export function editableParams(info: ShaderInfo): ShaderParamInfo[] {
  return info.params.filter((param) => param.name !== "baseColorTexture")
}
