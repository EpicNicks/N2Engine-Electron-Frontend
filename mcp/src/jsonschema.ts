// The host describes every component field (FieldSchema); agents want JSON Schema (design 3.3). The shapes are the
// ones GetComponentTypes documents: Bool/Int/Float/String are scalars; Vector2/3/4 and Quaternion are objects of
// numbers; Color is {r,g,b,a} (typeName Color) or a vector marked as a colour; Enum is one of enumOptions; the
// reference kinds are UUID strings (or null); Json is anything. A field with a container is not at the top of the
// component's JSON but inside its object of that name (a LuaComponent's script fields, in scriptData).
import type { ComponentSchema, FieldSchema } from "../../src/protocol/protocol.generated"
import type { Scrubber } from "./scrub"

export type JsonSchema = Record<string, unknown>

const num: JsonSchema = { type: "number" }

function objectOf(keys: string[]): JsonSchema {
  return {
    type: "object",
    properties: Object.fromEntries(keys.map((k) => [k, num])),
    required: keys,
    additionalProperties: false,
  }
}

const uuid: JsonSchema = { type: ["string", "null"], format: "uuid" }

/** The JSON Schema of one field's value (host strings scrubbed: the host's text is data) */
export function fieldToJsonSchema(field: FieldSchema, scrubber: Scrubber): JsonSchema {
  let schema: JsonSchema
  switch (field.kind) {
    case "Bool":
      schema = { type: "boolean" }
      break
    case "Int":
      schema = { type: "integer" }
      break
    case "Float":
      schema = { type: "number" }
      break
    case "String":
      schema = { type: "string" }
      break
    case "Vector2":
      schema = objectOf(["x", "y"])
      break
    case "Vector3":
      schema = objectOf(["x", "y", "z"])
      break
    case "Vector4":
      schema = objectOf(["w", "x", "y", "z"])
      break
    case "Quaternion":
      schema = objectOf(["x", "y", "z", "w"])
      break
    case "Color":
      schema = field.typeName === "Color" ? objectOf(["r", "g", "b", "a"]) : objectOf(["x", "y", "z"])
      break
    case "Enum":
      schema = { type: "string", enum: (field.enumOptions ?? []).map((o) => scrubber.name(o)) }
      break
    case "AssetRef":
    case "GameObjectRef":
    case "ComponentRef":
      schema = { ...uuid }
      break
    case "AssetRefList":
    case "GameObjectRefList":
    case "ComponentRefList":
      schema = { type: "array", items: { ...uuid } }
      break
    default:
      // Json, and a kind a newer host added: anything goes
      schema = {}
  }
  if ((field.kind === "Int" || field.kind === "Float") && typeof field.min === "number") schema.minimum = field.min
  if ((field.kind === "Int" || field.kind === "Float") && typeof field.max === "number") schema.maximum = field.max
  const notes: string[] = []
  if (field.displayName && field.displayName !== field.name) notes.push(scrubber.name(field.displayName))
  if (field.tooltip) notes.push(scrubber.str(field.tooltip, { maxChars: 500 }))
  if (field.assetType) notes.push(`asset type: ${scrubber.name(field.assetType)}`)
  if (field.kind === "Color" || field.kind === "Json" || !isKnown(field.kind)) notes.push(`field kind: ${scrubber.name(field.kind)}`)
  if (notes.length > 0) schema.description = notes.join(". ")
  if (field.readOnly) schema.readOnly = true
  return schema
}

function isKnown(kind: string): boolean {
  return [
    "Bool", "Int", "Float", "String", "Vector2", "Vector3", "Vector4", "Quaternion", "Color", "Enum",
    "AssetRef", "AssetRefList", "GameObjectRef", "GameObjectRefList", "ComponentRef", "ComponentRefList", "Json",
  ].includes(kind)
}

/** A component type as a JSON Schema (2020-12) for its saved form: hidden fields are left out, a container nests its fields */
export function componentToJsonSchema(schema: ComponentSchema, scrubber: Scrubber): JsonSchema {
  // Every component also saves its own uuid and its active flag, besides the registered fields
  const properties: Record<string, JsonSchema> = {
    uuid: { type: "string", format: "uuid", readOnly: true },
    isActive: { type: "boolean" },
  }
  const containers = new Map<string, Record<string, JsonSchema>>()
  for (const field of schema.fields) {
    if (field.hidden) continue
    const name = scrubber.name(field.name)
    const target = field.container ? containers.get(field.container) ?? containers.set(field.container, {}).get(field.container)! : properties
    target[name] = fieldToJsonSchema(field, scrubber)
  }
  for (const [container, inner] of containers) {
    properties[scrubber.name(container)] = { type: "object", properties: inner, additionalProperties: false }
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: scrubber.name(schema.typeName),
    type: "object",
    properties,
    additionalProperties: false,
  }
}
