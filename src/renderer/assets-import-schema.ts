// The typed import settings of the asset types whose loader reads any (roadmap section 6, FE10, decision U7): a table
// per resource type mirroring the engine's parsers, the check of a settings object against it (what the engine would
// ignore with a warning is an error here, so it never reaches the host unnoticed), and the edit of one field in the
// settings text. The settings text (JSON) stays the one source of truth: the form reads from it and writes into it,
// keys the table does not know are kept as they are. No DOM, so it is unit tested in Node.
//
// Where every field comes from (N2Engine master, read 2026-10-21; no command describes these schemas):
//   texture  engine/src/rendering/Texture.cpp Texture::ParseSettings, defaults engine/include/engine/rendering/Texture.hpp
//            TextureSettings: srgb true, filter "linear"|"nearest" (linear), wrap "repeat"|"clamp" (repeat),
//            mipmaps true, flipY true
//   model    engine/src/rendering/Model.cpp Model::ParseSettings, defaults engine/include/engine/rendering/Model.hpp
//            ModelSettings: scale finite number > 0 (1), importMaterials true, generateNormals and generateTangents
//            "never"|"ifMissing"|"always" (ifMissing), pbrMaterials false, mergeSubmeshesByMaterial false
//   font     engine/src/text/Font.cpp Font::ParseAtlasSettings, defaults and limits text/include/text/FontAtlas.hpp
//            AtlasSettings and FontAtlas::kMin/kMax*: basePx number 4..256 (48), spreadPx integer 1..32 (8, and the
//            engine lowers it to MaxSpreadPx(basePx) = clamp(floor(basePx / 2), 1, 32)), paddingPx integer 0..16 (2),
//            charset "ascii"|"latin1" (latin1), extraChars string ("")
// The enum names are compared exactly (case matters) by the engine, and so they are here.
import type { JsonObject } from "../shared/api"

export type ImportFieldKind = "bool" | "enum" | "number" | "integer" | "text"

export interface ImportField {
  /** The key in the type's block */
  key: string
  label: string
  kind: ImportFieldKind
  /** The engine's value when the key is absent */
  defaultValue: boolean | number | string
  /** enum: the names the engine reads */
  options?: readonly string[]
  /** number/integer: the value must be at least this */
  min?: number
  /** number/integer: the value must be at most this */
  max?: number
  /** number: the value must be greater than this */
  exclusiveMin?: number
  unit?: string
  help: string
}

export interface ImportSchema {
  /** The resource type as ListAssets names it */
  type: string
  /** The key of customData the loader reads its settings from */
  block: string
  fields: readonly ImportField[]
  /** Where the engine parses it, for the hint under the form */
  source: string
}

/** The largest spreadPx the engine keeps at this basePx (text/src/text/FontAtlas.cpp MaxSpreadPx) */
export function maxSpreadPx(basePx: number): number {
  return Math.min(Math.max(Math.trunc(basePx / 2), 1), 32)
}

const generation = ["never", "ifMissing", "always"] as const

export const TextureSchema: ImportSchema = {
  type: "Texture",
  block: "texture",
  source: "Texture::ParseSettings",
  fields: [
    {
      key: "srgb",
      label: "sRGB colour",
      kind: "bool",
      defaultValue: true,
      help: "The colours are sRGB-encoded; decoded to linear light only in linear lighting (base colour and emissive)",
    },
    {
      key: "filter",
      label: "Filter",
      kind: "enum",
      options: ["linear", "nearest"],
      defaultValue: "linear",
      help: "nearest keeps hard pixel edges",
    },
    {
      key: "wrap",
      label: "Wrap",
      kind: "enum",
      options: ["repeat", "clamp"],
      defaultValue: "repeat",
      help: "clamp clamps to the edge",
    },
    { key: "mipmaps", label: "Mipmaps", kind: "bool", defaultValue: true, help: "Generate mipmaps (the software renderer ignores them)" },
    {
      key: "flipY",
      label: "Flip Y",
      kind: "bool",
      defaultValue: true,
      help: "Store the rows bottom to top so images show upright on v-up UVs; off only for data read top row first",
    },
  ],
}

export const ModelSchema: ImportSchema = {
  type: "Model",
  block: "model",
  source: "Model::ParseSettings",
  fields: [
    {
      key: "scale",
      label: "Scale",
      kind: "number",
      defaultValue: 1,
      exclusiveMin: 0,
      help: "Multiplies every vertex position and node translation (0.01 for a model made in centimetres)",
    },
    {
      key: "importMaterials",
      label: "Import materials",
      kind: "bool",
      defaultValue: true,
      help: "Make Material and Texture sub-assets from the file; off, every submesh draws with the default material",
    },
    {
      key: "generateNormals",
      label: "Generate normals",
      kind: "enum",
      options: generation,
      defaultValue: "ifMissing",
      help: "Flat normals for primitives without any (ifMissing), everywhere (always) or never",
    },
    {
      key: "generateTangents",
      label: "Generate tangents",
      kind: "enum",
      options: generation,
      defaultValue: "ifMissing",
      help: "MikkTSpace tangents; ifMissing only for a mesh whose material has a normal texture",
    },
    {
      key: "pbrMaterials",
      label: "PBR materials",
      kind: "bool",
      defaultValue: false,
      help: "Imported materials use Pbr (metallic-roughness) shading instead of Blinn-Phong",
    },
    {
      key: "mergeSubmeshesByMaterial",
      label: "Merge submeshes by material",
      kind: "bool",
      defaultValue: false,
      help: "One submesh per material in each mesh",
    },
  ],
}

export const FontSchema: ImportSchema = {
  type: "Font",
  block: "font",
  source: "Font::ParseAtlasSettings",
  fields: [
    {
      key: "basePx",
      label: "Base size",
      kind: "number",
      defaultValue: 48,
      min: 4,
      max: 256,
      unit: "px",
      help: "The atlas's rasterisation size, in pixels per em",
    },
    {
      key: "spreadPx",
      label: "SDF spread",
      kind: "integer",
      defaultValue: 8,
      min: 1,
      max: 32,
      unit: "px",
      help: "The distance range each side of the outline; at most half the base size",
    },
    {
      key: "paddingPx",
      label: "Padding",
      kind: "integer",
      defaultValue: 2,
      min: 0,
      max: 16,
      unit: "px",
      help: "Empty pixels between glyphs and around the atlas edge",
    },
    {
      key: "charset",
      label: "Charset",
      kind: "enum",
      options: ["ascii", "latin1"],
      defaultValue: "latin1",
      help: "ascii: U+0020-U+007E; latin1 adds U+00A0-U+00FF",
    },
    { key: "extraChars", label: "Extra characters", kind: "text", defaultValue: "", help: "Added to the charset" },
  ],
}

export const ImportSchemas: readonly ImportSchema[] = [TextureSchema, ModelSchema, FontSchema]

/** The typed form of a resource type, or null for a type whose settings are edited as JSON only */
export function importSchemaFor(type: string | undefined | null): ImportSchema | null {
  return ImportSchemas.find((s) => s.type === type) ?? null
}

// ==================== Reading and checking ====================

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The type's block of the settings: absent is {}, null when it is there but not an object */
export function blockOf(schema: ImportSchema, settings: JsonObject): JsonObject | null {
  const block = settings[schema.block]
  if (block === undefined) return {}
  return isObject(block) ? block : null
}

function describe(field: ImportField): string {
  switch (field.kind) {
    case "bool":
      return "true or false"
    case "enum":
      return (field.options ?? []).map((o) => `"${o}"`).join(" or ")
    case "text":
      return "a string"
    case "integer":
      return `an integer from ${field.min} to ${field.max}`
    case "number":
      if (field.exclusiveMin !== undefined) return `a number above ${field.exclusiveMin}`
      return `a number from ${field.min} to ${field.max}`
  }
}

/** Why the engine would ignore this value of the field; null when it reads it */
export function checkFieldValue(field: ImportField, value: unknown): string | null {
  let good: boolean
  switch (field.kind) {
    case "bool":
      good = typeof value === "boolean"
      break
    case "enum":
      good = typeof value === "string" && (field.options ?? []).includes(value)
      break
    case "text":
      good = typeof value === "string"
      break
    case "integer":
    case "number":
      good =
        typeof value === "number" &&
        Number.isFinite(value) &&
        (field.kind === "number" || Number.isInteger(value)) &&
        (field.min === undefined || value >= field.min) &&
        (field.max === undefined || value <= field.max) &&
        (field.exclusiveMin === undefined || value > field.exclusiveMin)
      break
  }
  return good ? null : `${field.label} must be ${describe(field)} (the engine would ignore ${JSON.stringify(value)})`
}

const NumberText = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/**
 * A number field's text as the value to store: undefined for empty (the engine's default), or why it is not a value
 * the engine reads. Only number and integer fields are typed as text.
 */
export function parseFieldText(field: ImportField, text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (trimmed === "") return { ok: true, value: undefined }
  if (field.kind === "text") return { ok: true, value: text }
  if (!NumberText.test(trimmed)) return { ok: false, error: `${field.label}: "${trimmed}" is not a number` }
  const value = Number(trimmed)
  const error = checkFieldValue(field, value)
  return error === null ? { ok: true, value } : { ok: false, error: `${field.label} must be ${describe(field)}` }
}

/** What a settings object holds for a form: errors stop an Apply, warnings do not */
export interface ImportCheck {
  /** By field key: a value the engine would ignore */
  fieldErrors: Record<string, string>
  /** The block is not an object */
  blockError: string | null
  /** Keys of the block the engine does not read (kept) */
  unknownKeys: string[]
  /** Things the engine changes itself (a spread too large for the base size) */
  warnings: string[]
}

/** Checks the type's block of the settings against the table; the rest of the settings is not the form's */
export function checkImportSettings(schema: ImportSchema, settings: JsonObject): ImportCheck {
  const result: ImportCheck = { fieldErrors: {}, blockError: null, unknownKeys: [], warnings: [] }
  const block = blockOf(schema, settings)
  if (block === null) {
    result.blockError = `"${schema.block}" must be an object (the engine ignores it)`
    return result
  }
  for (const [key, value] of Object.entries(block)) {
    const field = schema.fields.find((f) => f.key === key)
    if (!field) {
      result.unknownKeys.push(key)
      continue
    }
    const error = checkFieldValue(field, value)
    if (error !== null) result.fieldErrors[key] = error
  }
  if (schema === FontSchema && !result.fieldErrors.basePx && !result.fieldErrors.spreadPx) {
    const base = typeof block.basePx === "number" ? block.basePx : (FontSchema.fields[0].defaultValue as number)
    const spread = typeof block.spreadPx === "number" ? block.spreadPx : (FontSchema.fields[1].defaultValue as number)
    const most = maxSpreadPx(base)
    if (spread > most) result.warnings.push(`SDF spread ${spread} is too large for base size ${base}: the engine uses ${most}`)
  }
  return result
}

/** The first error of a check, as one sentence; null when Apply may send it */
export function firstImportError(check: ImportCheck, drafts: Readonly<Record<string, string>> = {}, schema?: ImportSchema): string | null {
  if (check.blockError) return check.blockError
  if (schema) {
    for (const field of schema.fields) {
      const text = drafts[field.key]
      if (text === undefined) continue
      const parsed = parseFieldText(field, text)
      if (!parsed.ok) return parsed.error
    }
  }
  const keys = Object.keys(check.fieldErrors)
  return keys.length > 0 ? check.fieldErrors[keys[0]] : null
}

/** The text a field shows: the draft being typed, else the value the settings hold ("" when absent) */
export function fieldText(field: ImportField, block: JsonObject, drafts: Readonly<Record<string, string>>): string {
  const draft = drafts[field.key]
  if (draft !== undefined) return draft
  const value = block[field.key]
  if (value === undefined) return ""
  return typeof value === "string" ? value : JSON.stringify(value)
}

/** The engine's default of a field, as the form shows it */
export function defaultText(field: ImportField): string {
  return String(field.defaultValue)
}

// ==================== Editing ====================

/**
 * The settings with one field set (undefined removes the key, so the engine's default applies). Other keys, of the
 * block and of the settings, stay as they are and where they are; a block left empty is removed. The settings must
 * have an object (or no) block.
 */
export function withField(schema: ImportSchema, settings: JsonObject, key: string, value: unknown): JsonObject {
  const block = blockOf(schema, settings) ?? {}
  const next: JsonObject = { ...block }
  if (value === undefined) delete next[key]
  else next[key] = value
  const result: JsonObject = { ...settings }
  if (Object.keys(next).length === 0) delete result[schema.block]
  else result[schema.block] = next
  return result
}

/** The settings without the type's block: what the "Other" box shows */
export function otherSettings(schema: ImportSchema, settings: JsonObject): JsonObject {
  const rest: JsonObject = { ...settings }
  delete rest[schema.block]
  return rest
}
