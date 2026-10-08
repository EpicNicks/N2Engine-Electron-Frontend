// The inspector's field logic, without a DOM: which editor a field gets (its FieldKind), how a value is read from a
// component's JSON (a Lua field is inside its container, a reference there is written {"$ref": uuid}), how typed text
// becomes a value the engine will accept, how an edit becomes the partial SetComponentFields takes, and how the
// component types are grouped for the Add Component menu. The engine checks every value again (and is the authority);
// these checks give the person a message at once and keep a request from being sent that would be refused.
import type { ComponentSchema, FieldSchema } from "../protocol/protocol.generated"
import { FieldKind, isFieldKind } from "../protocol/component-schema"
import type { JsonObject } from "../shared/api"

/** The outcome of checking a value: the value to use, or why it can't be */
export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

const ok = <T>(value: T): Checked<T> => ({ ok: true, value })
const fail = (error: string): Checked<never> => ({ ok: false, error })

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

/** Structural equality of two JSON values (key order doesn't matter) */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]))
  if (isObject(a)) {
    if (!isObject(b)) return false
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && jsonEqual(a[key], b[key]))
  }
  return false
}

// ==================== Kinds ====================

/** The kind that decides a field's editor; one this client doesn't know is edited as JSON, which the engine checks */
export function kindOf(field: FieldSchema): FieldKind {
  return isFieldKind(field.kind) ? field.kind : "Json"
}

export const isRefKind = (kind: FieldKind): boolean =>
  kind === "AssetRef" ||
  kind === "GameObjectRef" ||
  kind === "ComponentRef" ||
  kind === "AssetRefList" ||
  kind === "GameObjectRefList" ||
  kind === "ComponentRefList"

export const isListKind = (kind: FieldKind): boolean =>
  kind === "AssetRefList" || kind === "GameObjectRefList" || kind === "ComponentRefList"

/** The axes of a vector kind, in the order the editor shows them */
export function axesOf(kind: FieldKind): readonly string[] {
  switch (kind) {
    case "Vector2":
      return ["x", "y"]
    case "Vector3":
      return ["x", "y", "z"]
    case "Vector4":
    case "Quaternion":
      return ["x", "y", "z", "w"]
    default:
      return []
  }
}

/**
 * The channels of a Color field, in the order shown: {r,g,b,a} when typeName is "Color", {x,y,z} for a Vector3 marked
 * as a colour (Light.color) and {x,y,z,w} for a Vector4 (alpha is w). hasAlpha: the last one is the alpha.
 */
export function colorChannels(field: FieldSchema): { keys: readonly string[]; hasAlpha: boolean } {
  switch (field.typeName) {
    case "Vector3":
      return { keys: ["x", "y", "z"], hasAlpha: false }
    case "Vector4":
      return { keys: ["x", "y", "z", "w"], hasAlpha: true }
    default:
      return { keys: ["r", "g", "b", "a"], hasAlpha: true }
  }
}

// ==================== Reading and writing a field in a component's JSON ====================

/** Whether the field is a reference written {"$ref": uuid} (a Lua field: it has a container and is a single reference) */
function isWrappedRef(field: FieldSchema): boolean {
  if (!field.container) return false
  const kind = kindOf(field)
  return kind === "GameObjectRef" || kind === "ComponentRef" || kind === "AssetRef"
}

/** What a field holds in a component's values: inside its container when it has one, a {"$ref"} unwrapped */
export function getFieldValue(field: FieldSchema, values: unknown): unknown {
  if (!isObject(values)) return undefined
  let holder: unknown = values
  if (field.container) {
    holder = values[field.container]
    if (!isObject(holder)) return undefined
  }
  const value = (holder as JsonObject)[field.name]
  if (isWrappedRef(field) && isObject(value) && "$ref" in value) return value["$ref"]
  return value
}

/** What a field shows when the component has no value for it: the kind's neutral value (not sent unless edited) */
export function defaultFieldValue(field: FieldSchema): unknown {
  switch (kindOf(field)) {
    case "Bool":
      return false
    case "Int":
    case "Float":
      return field.min !== undefined && field.min > 0 ? field.min : 0
    case "String":
      return ""
    case "Vector2":
      return { x: 0, y: 0 }
    case "Vector3":
      return { x: 0, y: 0, z: 0 }
    case "Vector4":
    case "Quaternion":
      return { x: 0, y: 0, z: 0, w: kindOf(field) === "Quaternion" ? 1 : 0 }
    case "Color":
      return Object.fromEntries(colorChannels(field).keys.map((key) => [key, 1]))
    case "Enum":
      return field.enumOptions?.[0] ?? ""
    case "AssetRefList":
    case "GameObjectRefList":
    case "ComponentRefList":
      return []
    case "Json":
      return null
    default:
      return null
  }
}

/** The value to show: what the component holds, or the kind's neutral value when it holds none */
export function displayValue(field: FieldSchema, values: unknown): unknown {
  const value = getFieldValue(field, values)
  return value === undefined ? defaultFieldValue(field) : value
}

/**
 * The partial SetComponentFields takes to set one field: {name: value}, or {container: {name: value}} for a Lua field,
 * whose reference is written {"$ref": uuid}
 */
export function fieldPatch(field: FieldSchema, value: unknown): JsonObject {
  const written = isWrappedRef(field) ? { $ref: value } : value
  return field.container ? { [field.container]: { [field.name]: written } } : { [field.name]: written }
}

/** The patch with another merged over it: objects merge key by key, anything else (a list, a vector) is replaced */
export function mergePatch(base: JsonObject, patch: JsonObject): JsonObject {
  const merged: JsonObject = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key]
    merged[key] = isObject(current) && isObject(value) && isMergeKey(key) ? mergePatch(current, value) : value
  }
  return merged
}

/**
 * A key whose object value merges into the one under it instead of replacing it: a container (scriptData), which
 * holds one entry per field. A field's own value (a vector {x, y, z}) is replaced whole, as the engine does.
 */
const isMergeKey = (key: string): boolean => Containers.includes(key)

/** The objects that hold a component's fields besides its own top level (a LuaComponent's script fields) */
const Containers: readonly string[] = ["scriptData"]

/** The component's values with a patch applied, as the inspector shows them while the edit is on its way */
export function applyPatch(values: JsonObject, patch: JsonObject): JsonObject {
  return mergePatch(values, patch)
}

/**
 * The part of a patch that differs from the values: a field set to what it already is is left out (and a container
 * with nothing left), so an edit that changed nothing sends nothing. Like the engine, which moves no revision for it.
 */
export function pruneUnchanged(values: JsonObject, patch: JsonObject): JsonObject {
  const changed: JsonObject = {}
  for (const [key, value] of Object.entries(patch)) {
    const current = values[key]
    if (isMergeKey(key) && isObject(value)) {
      const inner = pruneUnchanged(isObject(current) ? current : {}, value)
      if (Object.keys(inner).length > 0) changed[key] = inner
    } else if (!jsonEqual(current, value)) {
      changed[key] = value
    }
  }
  return changed
}

/** The requests an edit becomes, and what was left out */
export interface RequestPlan {
  /** Sent in order, each when the one before has been answered */
  requests: JsonObject[]
  /** The scriptData keys not sent: they were written for the script that is being replaced */
  droppedScriptData: string[]
}

/**
 * What to send for an edit of a component whose stored values are `values`: only what changed, and never a new
 * scriptUUID together with scriptData (the engine refuses it: the data would be checked against the old script), so the
 * script change goes alone and the data written for the script it replaces is dropped. Echo keys (uuid, scriptPath) are
 * never sent.
 */
export function planRequests(values: JsonObject, patch: JsonObject): RequestPlan {
  const { uuid: _uuid, scriptPath: _scriptPath, ...own } = patch
  const changed = pruneUnchanged(values, own)
  if ("scriptUUID" in changed && "scriptData" in changed) {
    const dropped = isObject(changed.scriptData) ? Object.keys(changed.scriptData) : []
    return { requests: [{ scriptUUID: changed.scriptUUID }], droppedScriptData: dropped }
  }
  return { requests: Object.keys(changed).length > 0 ? [changed] : [], droppedScriptData: [] }
}

// ==================== Numbers ====================

/** The most a C++ float holds (a larger one would be written as infinity, and a scene with null for it won't load) */
export const MaxFloat = 3.4028234663852886e38

export interface NumberLimits {
  min: number
  max: number
  integer: boolean
  /** The field has both bounds, so the editor shows a slider */
  ranged: boolean
}

/** What a number field can hold: its range when it has one, else the limits of its C++ type (typeName) */
export function numberLimits(field: FieldSchema): NumberLimits {
  const integer = kindOf(field) === "Int"
  let min: number
  let max: number
  if (integer) {
    const unsigned = /^(unsigned|uint|size_t)/.test(field.typeName)
    // How many bits the C++ type has, from its name (int, uint32_t, int64_t, short, unsigned char, ...)
    const bits = /64|size_t|long long/.test(field.typeName)
      ? 53 // a JSON number holds integers exactly only up to 2^53
      : /16|short/.test(field.typeName)
        ? 16
        : /(^|[^0-9])8([^0-9]|$)|char/.test(field.typeName)
          ? 8
          : 32
    max = bits === 53 ? Number.MAX_SAFE_INTEGER : unsigned ? 2 ** bits - 1 : 2 ** (bits - 1) - 1
    min = unsigned ? 0 : bits === 53 ? Number.MIN_SAFE_INTEGER : -(2 ** (bits - 1))
  } else {
    max = MaxFloat
    min = -MaxFloat
  }
  const lowest = field.min
  const highest = field.max
  return {
    min: lowest !== undefined ? lowest : min,
    max: highest !== undefined ? highest : max,
    integer,
    ranged: lowest !== undefined && highest !== undefined,
  }
}

/**
 * A number for a Float or Int field: a ranged one is clamped to its range (the engine does the same, and rounds an Int),
 * an Int must be a whole number, and one the C++ member can't hold is refused with the message the engine would give.
 */
export function checkNumber(field: FieldSchema, value: unknown): Checked<number> {
  if (!isFiniteNumber(value)) return fail(`${field.displayName} must be a number`)
  const limits = numberLimits(field)
  if (limits.integer && !Number.isInteger(value)) return fail(`${field.displayName} must be a whole number`)
  if (field.min !== undefined || field.max !== undefined) {
    return ok(Math.min(limits.max, Math.max(limits.min, value)))
  }
  if (value < limits.min || value > limits.max) {
    return fail(`${field.displayName} must be between ${limits.min} and ${limits.max}`)
  }
  return ok(value)
}

/** Typed text for a number field: empty text and anything that isn't a plain number are refused */
export function parseNumberText(field: FieldSchema, text: string): Checked<number> {
  const trimmed = text.trim()
  // Number() accepts "", "0x10" and "1e3": only decimal numbers (with an exponent) are meant
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return fail(`${field.displayName} must be a number`)
  return checkNumber(field, Number(trimmed))
}

/** A number as text for a field: at most 4 decimals, no trailing zeros */
export function formatNumber(value: unknown): string {
  if (!isFiniteNumber(value)) return ""
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(4)))
}

// ==================== Checking a value of a kind ====================

const UuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The most text a JSON field accepts (the engine refuses nesting past 64 levels and 200000 values on its own) */
export const MaxJsonTextLength = 1024 * 1024

function checkAxes(field: FieldSchema, value: unknown, keys: readonly string[]): Checked<JsonObject> {
  if (!isObject(value)) return fail(`${field.displayName} must be an object with ${keys.join(", ")}`)
  const result: JsonObject = {}
  for (const key of keys) {
    const axis = value[key]
    if (!isFiniteNumber(axis)) return fail(`${field.displayName}: ${key} must be a number`)
    if (Math.abs(axis) > MaxFloat) return fail(`${field.displayName}: ${key} is too large`)
    result[key] = axis
  }
  return ok(result)
}

function checkRef(field: FieldSchema, value: unknown): Checked<string | null> {
  if (value === null) return ok(null)
  if (typeof value !== "string" || !UuidLike.test(value)) return fail(`${field.displayName} must be a UUID or empty`)
  return ok(value.toLowerCase())
}

/** Whether a value can be sent as JSON: no undefined, NaN or infinity, no cycles (checked by depth), plain objects */
function checkJson(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (depth > 64) return false
  if (Array.isArray(value)) return value.every((item) => checkJson(item, depth + 1))
  return isObject(value) && Object.values(value).every((item) => checkJson(item, depth + 1))
}

/**
 * The value as the field's kind needs it, or the reason it can't be: the shape the engine's ValidateFieldValue wants
 * (every axis of a vector, an enum's option, a reference that is a UUID or null, numbers within the C++ type's limits).
 * A ranged number is clamped. Keys a vector doesn't have are dropped.
 */
export function checkValue(field: FieldSchema, value: unknown): Checked<unknown> {
  const kind = kindOf(field)
  switch (kind) {
    case "Bool":
      return typeof value === "boolean" ? ok(value) : fail(`${field.displayName} must be true or false`)
    case "Int":
    case "Float":
      return checkNumber(field, value)
    case "String":
      return typeof value === "string" ? ok(value) : fail(`${field.displayName} must be text`)
    case "Vector2":
    case "Vector3":
    case "Vector4":
    case "Quaternion":
      return checkAxes(field, value, axesOf(kind))
    case "Color": {
      const { keys, hasAlpha } = colorChannels(field)
      // The alpha of a {r,g,b,a} colour is optional
      if (hasAlpha && keys[0] === "r" && isObject(value) && !("a" in value)) return checkAxes(field, value, keys.slice(0, 3))
      return checkAxes(field, value, keys)
    }
    case "Enum": {
      const options = field.enumOptions ?? []
      return typeof value === "string" && options.includes(value)
        ? ok(value)
        : fail(`'${String(value)}' is not one of ${options.join(", ")}`)
    }
    case "AssetRef":
    case "GameObjectRef":
    case "ComponentRef":
      return checkRef(field, value)
    case "AssetRefList":
    case "GameObjectRefList":
    case "ComponentRefList": {
      if (!Array.isArray(value)) return fail(`${field.displayName} must be a list`)
      const items: Array<string | null> = []
      for (const item of value) {
        const checked = checkRef(field, item)
        if (!checked.ok) return checked
        items.push(checked.value)
      }
      return ok(items)
    }
    case "Json":
      return checkJson(value) ? ok(value) : fail(`${field.displayName} must be JSON`)
  }
}

/** Typed text for a JSON field: valid JSON (any value), of a size the host will take */
export function parseJsonText(field: FieldSchema, text: string): Checked<unknown> {
  if (text.length > MaxJsonTextLength) return fail(`${field.displayName} is too large to send`)
  const trimmed = text.trim()
  if (trimmed === "") return fail(`${field.displayName} must be JSON (null for nothing)`)
  try {
    return ok(JSON.parse(trimmed))
  } catch (e) {
    return fail(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** A JSON value as indented text for the editor */
export function formatJson(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value, null, 2)
}

// ==================== Colours ====================

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))
const hexByte = (value: number): string =>
  Math.round(clamp01(value) * 255)
    .toString(16)
    .padStart(2, "0")

/** #rrggbb for a colour value (channels 0 to 1; an HDR channel shows as its clamped value) */
export function colorToHex(field: FieldSchema, value: unknown): string {
  const { keys } = colorChannels(field)
  const channels = isObject(value) ? keys.slice(0, 3).map((key) => (isFiniteNumber(value[key]) ? value[key] : 0)) : [0, 0, 0]
  return "#" + channels.map(hexByte).join("")
}

/** The colour value for #rrggbb, keeping the alpha (and any other channel) of the current value */
export function hexToColor(field: FieldSchema, hex: string, current: unknown): Checked<JsonObject> {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!match) return fail("A colour is #rrggbb")
  const { keys } = colorChannels(field)
  const next: JsonObject = isObject(current) ? { ...current } : {}
  keys.slice(0, 3).forEach((key, i) => (next[key] = Math.round((parseInt(match[i + 1], 16) / 255) * 10000) / 10000))
  for (const key of keys) if (!isFiniteNumber(next[key])) next[key] = 1
  return ok(next)
}

// ==================== The schema's fields ====================

/** The fields to show, in the schema's order: hidden ones are not shown (they are still saved) */
export function visibleFields(schema: ComponentSchema): FieldSchema[] {
  return schema.fields.filter((field) => !field.hidden)
}

// ==================== Add Component menu ====================

/**
 * The menu's groups, in this order. A type goes in the first group whose pattern matches its name; a type the host
 * registers for a game (REGISTER_COMPONENT) matches none and is in "Other".
 */
export const ComponentGroups: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "Rendering", pattern: /^(Light|Camera|.*Renderer)$/ },
  { name: "Physics", pattern: /^(Rigidbody|.*Collider)$/ },
  { name: "Audio", pattern: /^Audio/ },
  { name: "UI", pattern: /^(Canvas|RectTransform|Image|UIText|Button)$/ },
  { name: "Scripting", pattern: /^LuaComponent$/ },
]

export const OtherGroup = "Other"

export function groupOf(typeName: string): string {
  return ComponentGroups.find((group) => group.pattern.test(typeName))?.name ?? OtherGroup
}

/** "MeshRenderer" as "Mesh Renderer", "UIText" as "UI Text" (what the engine does for a field's display name) */
export function displayTypeName(typeName: string): string {
  return typeName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/_/g, " ")
}

export interface ComponentMenuItem {
  typeName: string
  label: string
  /** Why the type can't be added (a singleton the object has), or null */
  disabledReason: string | null
}

export interface ComponentMenuGroup {
  name: string
  items: ComponentMenuItem[]
}

/**
 * The Add Component menu: the types matching the query (a case-insensitive part of the name, ignoring spaces), grouped,
 * in the group order of ComponentGroups with Other last, and by name within one. A singleton type the object has is
 * listed but disabled.
 */
export function groupComponentTypes(
  types: readonly ComponentSchema[],
  query: string,
  present: ReadonlySet<string>
): ComponentMenuGroup[] {
  const needle = query.replace(/\s+/g, "").toLowerCase()
  const groups = new Map<string, ComponentMenuItem[]>()
  for (const type of types) {
    if (needle !== "" && !type.typeName.toLowerCase().includes(needle)) continue
    const group = groupOf(type.typeName)
    const items = groups.get(group) ?? []
    items.push({
      typeName: type.typeName,
      label: displayTypeName(type.typeName),
      disabledReason:
        type.singleton && present.has(type.typeName) ? `An object can have only one ${type.typeName}` : null,
    })
    groups.set(group, items)
  }
  const order = [...ComponentGroups.map((g) => g.name), OtherGroup]
  return order
    .filter((name) => groups.has(name))
    .map((name) => ({ name, items: groups.get(name)!.sort((a, b) => a.typeName.localeCompare(b.typeName)) }))
}
