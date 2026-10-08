// Checks for the component commands (protocol 1.5.0): the schemas the host answers with (GetComponentTypes,
// GetLuaFields) are validated before anything uses them, and the arguments the engine would refuse anyway are refused
// before a request is sent. The engine stays the authority on values: it checks every one against its field and
// answers an Error naming it (SetComponentFields is all or nothing).
import type { ComponentSchema, FieldSchema } from "./protocol.generated"

/** The kinds of field the engine describes (FieldKind), which decide the editor and the shape of the value */
export const FieldKinds = [
  "Bool",
  "Int",
  "Float",
  "String",
  "Vector2",
  "Vector3",
  "Vector4",
  "Quaternion",
  "Color",
  "Enum",
  "AssetRef",
  "AssetRefList",
  "GameObjectRef",
  "GameObjectRefList",
  "ComponentRef",
  "ComponentRefList",
  "Json",
] as const

export type FieldKind = (typeof FieldKinds)[number]

export function isFieldKind(kind: string): kind is FieldKind {
  return (FieldKinds as readonly string[]).includes(kind)
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function requireString(object: Record<string, unknown>, key: string, where: string): string {
  const value = object[key]
  if (typeof value !== "string") throw new Error(`${where}: ${key} must be a string`)
  return value
}

function requireBool(object: Record<string, unknown>, key: string, where: string): boolean {
  const value = object[key]
  if (typeof value !== "boolean") throw new Error(`${where}: ${key} must be a boolean`)
  return value
}

/** A FieldSchema as the host sent it, or an Error naming what is wrong. Keys it doesn't know are dropped. */
export function parseFieldSchema(value: unknown, where: string): FieldSchema {
  if (!isObject(value)) throw new Error(`${where} must be an object`)
  const name = requireString(value, "name", where)
  if (name === "") throw new Error(`${where}: name must not be empty`)
  const field: FieldSchema = {
    name,
    displayName: requireString(value, "displayName", where),
    // An unknown kind is kept (a newer minor version may add some): the editor falls back to JSON for it
    kind: requireString(value, "kind", where),
    typeName: requireString(value, "typeName", where),
    hidden: requireBool(value, "hidden", where),
    readOnly: requireBool(value, "readOnly", where),
  }
  if (value.enumOptions !== undefined) {
    if (!Array.isArray(value.enumOptions) || !value.enumOptions.every((o) => typeof o === "string")) {
      throw new Error(`${where}: enumOptions must be an array of strings`)
    }
    field.enumOptions = [...(value.enumOptions as string[])]
  }
  for (const key of ["assetType", "tooltip", "container"] as const) {
    if (value[key] !== undefined) field[key] = requireString(value, key, where)
  }
  for (const key of ["min", "max"] as const) {
    if (value[key] !== undefined) {
      const bound = value[key]
      if (typeof bound !== "number" || !Number.isFinite(bound)) throw new Error(`${where}: ${key} must be a number`)
      field[key] = bound
    }
  }
  return field
}

/** A ComponentSchema as the host sent it (GetLuaFields has no defaults), or an Error naming what is wrong */
export function parseComponentSchema(value: unknown, where: string): ComponentSchema {
  if (!isObject(value)) throw new Error(`${where} must be an object`)
  const typeName = requireString(value, "typeName", where)
  if (typeName === "") throw new Error(`${where}: typeName must not be empty`)
  if (!Array.isArray(value.fields)) throw new Error(`${where}: fields must be an array`)
  const fields = value.fields.map((field, i) => parseFieldSchema(field, `${where} (${typeName}) field ${i}`))
  const schema: ComponentSchema = { typeName, singleton: requireBool(value, "singleton", where), fields }
  if (value.defaults !== undefined) schema.defaults = value.defaults
  return schema
}

/** GetComponentTypes' answer: an array of schemas, each type once */
export function parseComponentTypes(value: unknown): ComponentSchema[] {
  if (!Array.isArray(value)) throw new Error("The component types must be an array")
  const seen = new Set<string>()
  return value.map((entry, i) => {
    const schema = parseComponentSchema(entry, `Component type ${i}`)
    if (seen.has(schema.typeName)) throw new Error(`Component type ${schema.typeName} is listed twice`)
    seen.add(schema.typeName)
    return schema
  })
}

/** An id (an entity's or a component's UUID string) must be a non-empty string without NUL */
export function checkId(value: unknown, what: string): void {
  if (typeof value !== "string" || value === "" || value.includes("\0")) {
    throw new Error(`${what} must be a non-empty string`)
  }
}

/** The values of SetComponentFields must be a plain JSON object (a partial of what GetComponent returns) */
export function checkComponentValues(values: unknown): void {
  if (!isObject(values)) throw new Error("values must be a JSON object")
  const prototype = Object.getPrototypeOf(values)
  if (prototype !== Object.prototype && prototype !== null) throw new Error("values must be a plain JSON object")
}
