// The project settings the editor can edit, as data: a typed table per section (label, type, range, default, help and
// whether the engine reads the value only at Init, so a change needs a host restart), the validation that mirrors the
// engine's (engine/src/ProjectSettings.cpp, Layers.cpp), and the builders of the minimal RFC 7386 merge patches that
// SetProjectSettings takes. Framework-free and pure, so it is unit tested in Node.
//
// Where the table comes from (N2Engine docs/editor.html "Settings", docs/application.html "Init", ProjectSettings.hpp):
//   physics.fixedTimestep   seconds > 0, applied live          physics.gravity   {x, y, z} numbers, applied live
//   physics.gpu             off | auto | on, read before Init   physics.deterministic   boolean, read before Init
//   physics.backend         physx | jolt, read before Init      math.simdTier         read before Init
//   determinism.luaSeed     integer >= 0, read before Init, ADMIN ONLY to change (audit item 11)
//   rendering.colorSpace    gamma | linear, applied live        rendering.forceShaderEncode   boolean, applied live
//   layers                  {layers: [32 names], collisionMatrix: [32 masks]}    input   {actionMaps: {...}}

/** A JSON value */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && deepEqual(a[k], b[k]))
  }
  return false
}

// ==================== Field tables ====================

export type FieldKind = "number" | "integer" | "enum" | "bool"

export interface FieldOption {
  /** "" is the unset option (the engine's default applies) */
  value: string
  label: string
}

export interface FieldSpec {
  /** Unique across sections: the key of a draft, and what a restart note lists */
  id: string
  /** Where the value is in the settings object */
  path: readonly string[]
  label: string
  kind: FieldKind
  help: string
  /** The engine reads the value only before Application::Init: a change takes effect after the host restarts */
  restart: boolean
  /** What an unset value means, shown as the hint of the empty field */
  defaultText: string
  unit?: string
  /** number: the value must be greater than this */
  exclusiveMin?: number
  /** integer: the value must be at least this */
  min?: number
  /** enum and bool: the choices (the first, "", is unset) */
  options?: readonly FieldOption[]
  /** The fields with the same group are written together (the host needs all of gravity's x, y and z) */
  group?: string
  advanced?: boolean
}

const optionList = (labelOfDefault: string, ...values: string[]): FieldOption[] => [
  { value: "", label: labelOfDefault },
  ...values.map((value) => ({ value, label: value })),
]

const boolOptions = (labelOfDefault: string): FieldOption[] => [
  { value: "", label: labelOfDefault },
  { value: "true", label: "true" },
  { value: "false", label: "false" },
]

export const SimdTiers = ["auto", "scalar", "sse2", "sse4.1", "avx", "neon"] as const

export const PhysicsFields: readonly FieldSpec[] = [
  {
    id: "physics.fixedTimestep",
    path: ["physics", "fixedTimestep"],
    label: "Fixed timestep",
    kind: "number",
    unit: "s",
    exclusiveMin: 0,
    defaultText: "0.02",
    restart: false,
    help: "Seconds between fixed updates and physics steps. Must be greater than 0. A very small value makes a game run many fixed updates a frame. Applied at once.",
  },
  ...(["x", "y", "z"] as const).map(
    (axis): FieldSpec => ({
      id: `physics.gravity.${axis}`,
      path: ["physics", "gravity", axis],
      label: `Gravity ${axis}`,
      kind: "number",
      group: "physics.gravity",
      defaultText: "the backend's own",
      restart: false,
      help:
        axis === "x"
          ? "The physics world's gravity, in metres per second squared. The host needs all three components: set x, y and z together. Applied at once."
          : "",
    })
  ),
  {
    id: "physics.gpu",
    path: ["physics", "gpu"],
    label: "GPU physics",
    kind: "enum",
    options: optionList("default (off)", "off", "auto", "on"),
    defaultText: "off",
    restart: true,
    help: "Whether the rigid-body scene may run on an NVIDIA GPU. The scene's GPU flag is fixed when it is created, so the host reads it before Init.",
  },
  {
    id: "physics.deterministic",
    path: ["physics", "deterministic"],
    label: "Deterministic physics",
    kind: "bool",
    options: boolOptions("default (false)"),
    defaultText: "false",
    restart: true,
    help: "Asks the physics backend for its reproducible-replay configuration (PhysX: enhanced determinism and no worker threads). Read before Init.",
  },
  {
    id: "physics.backend",
    path: ["physics", "backend"],
    label: "Physics backend",
    kind: "enum",
    options: optionList("default (physx)", "physx", "jolt"),
    defaultText: "physx",
    restart: true,
    help: "The project's 3D physics backend. Read before Init creates the backend.",
  },
]

export const RenderingFields: readonly FieldSpec[] = [
  {
    id: "rendering.colorSpace",
    path: ["rendering", "colorSpace"],
    label: "Colour space",
    kind: "enum",
    options: optionList("default (gamma)", "gamma", "linear"),
    defaultText: "gamma",
    restart: false,
    help: "The colour space the lit shaders work in. Applied at once.",
  },
  {
    id: "rendering.forceShaderEncode",
    path: ["rendering", "forceShaderEncode"],
    label: "Force shader encode",
    kind: "bool",
    options: boolOptions("default (false)"),
    defaultText: "false",
    advanced: true,
    restart: false,
    help: "Makes OpenGL's lit shader encode its own output in linear lighting: an escape hatch for a driver that reports the wrong framebuffer encoding.",
  },
]

export const MathFields: readonly FieldSpec[] = [
  {
    id: "math.simdTier",
    path: ["math", "simdTier"],
    label: "SIMD tier",
    kind: "enum",
    options: optionList("default (auto)", ...SimdTiers.filter((t) => t !== "auto")),
    defaultText: "auto",
    restart: true,
    help: "Forces the math tier (a tier above what the CPU supports is lowered). Chosen once by Init before any scene loads.",
  },
]

export const LuaSeedWarning =
  "Security trade-off: a constant hash seed makes hash flooding of string-keyed tables possible. Anyone who knows the seed (it is in the project file) and controls keys a script stores in a table (network input, save data, text a player types) can make inserts and lookups slow. Leave it unset unless the script data is trusted, or the game needs reproducible Lua (a replay, a lockstep simulation)."

export const DeterminismFields: readonly FieldSpec[] = [
  {
    id: "determinism.luaSeed",
    path: ["determinism", "luaSeed"],
    label: "Lua seed",
    kind: "integer",
    min: 0,
    defaultText: "unset (Lua seeds itself from the clock)",
    restart: true,
    help: "An integer of 0 or more. Set, Lua's string hash seed is a constant and math.random starts from it, so pairs() order over string keys and math.random are the same on every run. Read before the Lua state is created.",
  },
]

/** Every field of the form sections, by id */
export const AllFields: readonly FieldSpec[] = [
  ...PhysicsFields,
  ...RenderingFields,
  ...MathFields,
  ...DeterminismFields,
]

export function fieldById(id: string): FieldSpec | undefined {
  return AllFields.find((f) => f.id === id)
}

/** The ids of the fields that are read only at Init: the restart badge list (kept next to the table to be checked against the docs) */
export const RestartFieldIds: readonly string[] = AllFields.filter((f) => f.restart).map((f) => f.id)

// ==================== Reading and parsing a field ====================

/** The value at a path, or undefined when a step is missing or is not an object */
export function readPath(root: unknown, path: readonly string[]): Json | undefined {
  let at: unknown = root
  for (const key of path) {
    if (!isPlainObject(at) || !(key in at)) return undefined
    at = at[key]
  }
  return at === null ? undefined : (at as Json)
}

/** The text a field shows for a value in the settings: "" when unset */
export function textOfValue(spec: FieldSpec, value: Json | undefined): string {
  if (value === undefined || value === null) return ""
  if (spec.kind === "number" || spec.kind === "integer") return typeof value === "number" ? String(value) : JSON.stringify(value)
  if (spec.kind === "bool") return typeof value === "boolean" ? String(value) : JSON.stringify(value)
  return typeof value === "string" ? value : JSON.stringify(value)
}

export type Parsed = { ok: true; value: Json | undefined } | { ok: false; error: string }

const NumberText = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** Parses a field's text: ok with undefined means unset (empty text); the validation mirrors the engine's */
export function parseField(spec: FieldSpec, text: string): Parsed {
  const t = text.trim()
  if (spec.kind === "enum" || spec.kind === "bool") {
    if (t === "") return { ok: true, value: undefined }
    const options = (spec.options ?? []).filter((o) => o.value !== "")
    const match = options.find((o) => o.value === t.toLowerCase())
    if (!match) return { ok: false, error: `${t} is not one of ${options.map((o) => o.value).join(", ")}` }
    return { ok: true, value: spec.kind === "bool" ? match.value === "true" : match.value }
  }
  if (t === "") return { ok: true, value: undefined }
  if (spec.kind === "integer") {
    if (!/^\d+$/.test(t)) return { ok: false, error: "Must be a whole number of 0 or more" }
    const n = Number(t)
    if (!Number.isSafeInteger(n)) return { ok: false, error: "Too large (at most 9007199254740991)" }
    if (spec.min !== undefined && n < spec.min) return { ok: false, error: `Must be at least ${spec.min}` }
    return { ok: true, value: n }
  }
  if (!NumberText.test(t)) return { ok: false, error: "Not a number" }
  const n = Number(t)
  if (!Number.isFinite(n)) return { ok: false, error: "Not a finite number" }
  if (spec.exclusiveMin !== undefined && !(n > spec.exclusiveMin)) {
    return { ok: false, error: `Must be greater than ${spec.exclusiveMin}` }
  }
  return { ok: true, value: n }
}

/** Whether two settings values mean the same to the engine (enum names are case-insensitive, as it reads them) */
export function sameValue(spec: FieldSpec, a: Json | undefined, b: Json | undefined): boolean {
  if (spec.kind === "enum" && typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase()
  return deepEqual(a, b)
}

// ==================== Patch building ====================

export type Edits = Readonly<Record<string, string>>

export interface BuiltSection {
  /** The merge patch (only the changed keys), or null when nothing changed or something is invalid */
  patch: JsonObject | null
  /** The startup scene to set (General): sent with SetStartupScene, not in a patch */
  startupScene?: string
  /** Edit keys that are invalid, with what is wrong */
  errors: Record<string, string>
  /** Edit keys whose value differs from the host's (an invalid edit counts) */
  changed: string[]
  /** The ids of the changed fields the engine reads only at Init */
  restart: string[]
}

export const NothingBuilt: BuiltSection = Object.freeze({ patch: null, errors: {}, changed: [], restart: [] }) as BuiltSection

/** Sets value at path in root, creating the objects on the way */
export function setPath(root: JsonObject, path: readonly string[], value: Json): void {
  let at = root
  for (let i = 0; i < path.length - 1; i++) {
    const next = at[path[i]]
    if (!isPlainObject(next)) at[path[i]] = {}
    at = at[path[i]] as JsonObject
  }
  at[path[path.length - 1]] = value
}

/**
 * The minimal patch for a form section: a key only when the field's value differs from the host's, null for a cleared
 * one, and the whole group (all of gravity) when one member changed.
 */
export function buildFieldsPatch(fields: readonly FieldSpec[], settings: unknown, edits: Edits): BuiltSection {
  const patch: JsonObject = {}
  const errors: Record<string, string> = {}
  const changed: string[] = []
  const restart: string[] = []
  const groupsChanged = new Set<string>()
  for (const spec of fields) {
    if (!(spec.id in edits)) continue
    const parsed = parseField(spec, edits[spec.id])
    if (!parsed.ok) {
      errors[spec.id] = parsed.error
      changed.push(spec.id)
      continue
    }
    const current = readPath(settings, spec.path)
    if (sameValue(spec, current, parsed.value)) continue
    changed.push(spec.id)
    if (spec.restart) restart.push(spec.id)
    if (spec.group !== undefined) {
      groupsChanged.add(spec.group)
    } else {
      setPath(patch, spec.path, parsed.value === undefined ? null : parsed.value)
    }
  }
  for (const group of groupsChanged) {
    const members = fields.filter((f) => f.group === group)
    const values: Json[] = []
    // Every member empty: the group is cleared (the host takes the whole gravity away, back to its default)
    const texts = members.map((m) => (m.id in edits ? edits[m.id] : textOfValue(m, readPath(settings, m.path))))
    if (texts.every((t) => t.trim() === "")) {
      setPath(patch, members[0].path.slice(0, -1), null)
      continue
    }
    for (const member of members) {
      const text = member.id in edits ? edits[member.id] : textOfValue(member, readPath(settings, member.path))
      const parsed = parseField(member, text)
      if (!parsed.ok) {
        errors[member.id] = parsed.error
      } else if (parsed.value === undefined) {
        errors[member.id] = "Needed: the host takes x, y and z together"
      } else {
        values.push(parsed.value)
      }
    }
    if (values.length === members.length) members.forEach((m, i) => setPath(patch, m.path, values[i]))
  }
  const ok = Object.keys(errors).length === 0
  return { patch: ok && changed.length > 0 ? patch : null, errors, changed, restart: ok ? restart : [] }
}

/** RFC 7386: target with the patch applied (the host's rule; the tests' fake host uses it) */
export function applyMergePatch(target: Json | undefined, patch: Json): Json {
  if (!isPlainObject(patch)) return patch
  const out: JsonObject = isPlainObject(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key]
    else out[key] = applyMergePatch(out[key], value)
  }
  return out
}

function stripNulls(value: Json): Json {
  if (!isPlainObject(value)) return value
  const out: JsonObject = {}
  for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = stripNulls(v)
  return out
}

/**
 * The smallest merge patch that turns before into after (undefined when they are the same): null for a removed key,
 * objects key by key, anything else (an array too) replaced. A null in after counts as the key being absent.
 */
export function mergePatchDiff(before: Json | undefined, after: Json | undefined): Json | undefined {
  const target = after === null ? undefined : after
  if (target === undefined) return before === undefined ? undefined : null
  if (isPlainObject(before) && isPlainObject(target)) {
    const out: JsonObject = {}
    for (const key of Object.keys(before)) {
      if (!(key in target) || target[key] === null) out[key] = null
    }
    for (const [key, value] of Object.entries(target)) {
      if (value === null) continue
      const d = mergePatchDiff(before[key], value)
      if (d !== undefined) out[key] = d
    }
    return Object.keys(out).length === 0 ? undefined : out
  }
  return deepEqual(before, target) ? undefined : stripNulls(target)
}

/** Whether a patch names the determinism block (the host refuses that to anyone but an admin, whatever the value) */
export function patchTouchesDeterminism(patch: unknown): boolean {
  return isPlainObject(patch) && "determinism" in patch
}

// ==================== Layers ====================

export const LayerCount = 32

/** The built-in layers: reserved names the host keeps whatever is sent (Layers.cpp BuiltinNames) */
export const BuiltinLayers: Readonly<Record<number, string>> = {
  0: "Default",
  1: "TransparentFX",
  2: "Ignore Raycast",
  4: "Water",
  5: "UI",
}

export const isBuiltinLayer = (index: number): boolean => index in BuiltinLayers

/** The 32 layer names of the settings (the built-in ones where the project does not say, empty for the free ones) */
export function layerNames(settings: unknown): string[] {
  const written = readPath(settings, ["layers", "layers"])
  const names: string[] = []
  for (let i = 0; i < LayerCount; i++) {
    const w = Array.isArray(written) ? written[i] : undefined
    names.push(isBuiltinLayer(i) ? BuiltinLayers[i] : typeof w === "string" ? w : "")
  }
  return names
}

export const layerKey = (index: number): string => `layer.${index}`

// ---- The collision matrix (Layers.cpp Serialize / Deserialize)
//
// collisionMatrix is 32 row masks: bit b of row a (1 << b) says layer a collides with layer b. The host refuses the block
// unless it is an array of exactly 32 integers in 0..0xFFFFFFFF, and it treats the matrix as symmetric: a pair collides
// only when both rows say so. With no matrix every layer collides with every layer.

/** Every layer: a row mask with all 32 bits */
export const AllLayersMask = 0xffffffff

/** Whether a value is what the host takes as a row mask: an integer in 0..0xFFFFFFFF */
export function isRowMask(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= AllLayersMask
}

/** The edit key of a pair of layers: the same for (a, b) and (b, a), so a toggle of either is one edit */
export function pairKey(a: number, b: number): string {
  return a <= b ? `pair.${a}.${b}` : `pair.${b}.${a}`
}

/** The two layers of a pair key (lower first), or null for another key or a layer out of 0..31 */
export function parsePairKey(key: string): [number, number] | null {
  const m = /^pair\.(\d+)\.(\d+)$/.exec(key)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  if (a > b || b >= LayerCount) return null
  return [a, b]
}

/** Whether layers a and b collide in the row masks (bit b of row a) */
export function rowsCollide(rows: readonly number[], a: number, b: number): boolean {
  return ((rows[a] >>> b) & 1) === 1
}

/** Sets or clears the pair in both rows (bit b of row a and bit a of row b), keeping the masks unsigned */
export function setRowsPair(rows: number[], a: number, b: number, collide: boolean): void {
  if (collide) {
    rows[a] = (rows[a] | (1 << b)) >>> 0
    rows[b] = (rows[b] | (1 << a)) >>> 0
  } else {
    rows[a] = (rows[a] & ~(1 << b)) >>> 0
    rows[b] = (rows[b] & ~(1 << a)) >>> 0
  }
}

export interface CollisionMatrix {
  /** The 32 row masks as the engine uses them: symmetric (a pair collides only when both rows say so) */
  rows: number[]
  /** Why the project's matrix is not used as written (not 32 masks), or null */
  problem: string | null
}

/** The project's collision matrix as the engine reads it: all colliding when absent, a pair only when both rows agree */
export function collisionMatrixOf(settings: unknown): CollisionMatrix {
  const written = readPath(settings, ["layers", "collisionMatrix"])
  const rows: number[] = new Array<number>(LayerCount).fill(AllLayersMask)
  if (written === undefined) return { rows, problem: null }
  if (!Array.isArray(written) || written.length !== LayerCount || !written.every(isRowMask)) {
    return {
      rows,
      problem: `The project's collision matrix is not ${LayerCount} masks of 0 to ${AllLayersMask}, so the host does not use it; it is shown as every layer colliding, and Apply writes a valid one.`,
    }
  }
  const masks = written as number[]
  for (let a = 0; a < LayerCount; a++) {
    for (let b = a; b < LayerCount; b++) setRowsPair(rows, a, b, rowsCollide(masks, a, b) && rowsCollide(masks, b, a))
  }
  return { rows, problem: null }
}

/** The text of a pair's edit: "1" collides, "0" does not */
export const pairText = (collide: boolean): string => (collide ? "1" : "0")

export function buildLayersPatch(settings: unknown, edits: Edits): BuiltSection {
  const current = layerNames(settings)
  const next = [...current]
  const changed: string[] = []
  for (let i = 0; i < LayerCount; i++) {
    const key = layerKey(i)
    if (isBuiltinLayer(i) || !(key in edits)) continue
    next[i] = edits[key]
    if (edits[key] !== current[i]) changed.push(key)
  }
  const errors: Record<string, string> = {}
  const seen = new Map<string, number>()
  for (let i = 0; i < LayerCount; i++) {
    const name = next[i]
    if (name === "") continue
    // The host compares names exactly and refuses a name used twice (the built-in ones count)
    const earlier = seen.get(name)
    if (earlier !== undefined) {
      // The one that can be edited is the one to fix
      const culprit = isBuiltinLayer(i) ? earlier : i
      const other = culprit === i ? earlier : i
      errors[layerKey(culprit)] = `The name ${name} is used twice (layer ${other} has it)`
    } else {
      seen.set(name, i)
    }
  }
  // The matrix: the pairs whose edit differs from the host's, on top of the matrix the host uses
  const matrix = collisionMatrixOf(settings)
  const rows = [...matrix.rows]
  let matrixChanged = false
  for (let a = 0; a < LayerCount; a++) {
    for (let b = a; b < LayerCount; b++) {
      const key = pairKey(a, b)
      if (!(key in edits)) continue
      const collide = edits[key] === "1"
      setRowsPair(rows, a, b, collide)
      if (collide !== rowsCollide(matrix.rows, a, b)) {
        changed.push(key)
        matrixChanged = true
      }
    }
  }
  // A matrix the host does not use is replaced on Apply (the notice says so), when a pair was edited, also when every edit is the value shown (a rename alone leaves it)
  if (matrix.problem !== null && !matrixChanged) {
    const pairEdits = Object.keys(edits).filter((key) => parsePairKey(key) !== null)
    if (pairEdits.length > 0) {
      matrixChanged = true
      for (const key of pairEdits) if (!changed.includes(key)) changed.push(key)
    }
  }
  if (changed.length === 0) return { ...NothingBuilt, errors }
  if (Object.keys(errors).length > 0) return { patch: null, errors, changed, restart: [] }
  // An array is replaced whole by a merge patch: all 32 names go when one changed, all 32 rows when a pair changed
  const block: JsonObject = {}
  if (changed.some((key) => key.startsWith("layer."))) block.layers = next
  if (matrixChanged) block.collisionMatrix = rows
  return { patch: { layers: block }, errors, changed, restart: [] }
}

// ==================== Input and raw JSON ====================

/** The text of a JSON block (pretty printed), "" when unset */
export function jsonText(value: Json | undefined): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2)
}

export const JsonKey = "json"
/** The settings text the draft was typed against: the patch is the draft's change from it, not from what the host has now */
export const JsonBaseKey = "json.base"

/** The block the draft started from: its base text when the draft has one, else what the host has now */
function baseOf(edits: Edits, current: Json | undefined, parse: (text: string) => Json | undefined): Json | undefined {
  const text = edits[JsonBaseKey]
  if (text === undefined) return current
  try {
    return parse(text)
  } catch {
    return current
  }
}

export function buildInputPatch(settings: unknown, edits: Edits): BuiltSection {
  if (!(JsonKey in edits)) return NothingBuilt
  const text = edits[JsonKey].trim()
  const current = baseOf(edits, readPath(settings, ["input"]), (t) => (t.trim() === "" ? undefined : (JSON.parse(t) as Json)))
  let after: Json | undefined
  if (text !== "") {
    try {
      after = JSON.parse(text) as Json
    } catch (e) {
      return { patch: null, errors: { [JsonKey]: `Not valid JSON: ${(e as Error).message}` }, changed: [JsonKey], restart: [] }
    }
    // The host checks this shape too and refuses anything else
    if (!isPlainObject(after) || !isPlainObject(after.actionMaps)) {
      return { patch: null, errors: { [JsonKey]: 'Expected {"actionMaps": {...}}' }, changed: [JsonKey], restart: [] }
    }
  }
  const diff = mergePatchDiff(current, after)
  if (diff === undefined) return NothingBuilt
  return { patch: { input: diff }, errors: {}, changed: [JsonKey], restart: [] }
}

/** The reason a raw edit can't be sent by someone who is not an admin, or null */
export const DeterminismAdminOnly =
  "The determinism block can only be changed by an admin: the host refuses an editor's patch that names it"

export function buildRawPatch(settings: unknown, edits: Edits, isAdmin: boolean): BuiltSection {
  if (!(JsonKey in edits)) return NothingBuilt
  let after: Json
  try {
    after = JSON.parse(edits[JsonKey]) as Json
  } catch (e) {
    return { patch: null, errors: { [JsonKey]: `Not valid JSON: ${(e as Error).message}` }, changed: [JsonKey], restart: [] }
  }
  if (!isPlainObject(after)) {
    return { patch: null, errors: { [JsonKey]: "The settings must be a JSON object" }, changed: [JsonKey], restart: [] }
  }
  const base = baseOf(edits, isPlainObject(settings) ? settings : {}, (t) => JSON.parse(t) as Json)
  const diff = mergePatchDiff(isPlainObject(base) ? base : {}, after)
  if (diff === undefined) return NothingBuilt
  if (!isPlainObject(diff)) {
    return { patch: null, errors: { [JsonKey]: "The settings must be a JSON object" }, changed: [JsonKey], restart: [] }
  }
  if (!isAdmin && patchTouchesDeterminism(diff)) {
    return { patch: null, errors: { [JsonKey]: DeterminismAdminOnly }, changed: [JsonKey], restart: [] }
  }
  const restart = RestartFieldIds.filter((id) => {
    const spec = fieldById(id)
    return spec !== undefined && touchesPath(diff, spec.path)
  })
  return { patch: diff, errors: {}, changed: [JsonKey], restart }
}

/** Whether a patch names the path, a removal (null) of it or of a block above it included */
export function touchesPath(patch: Json | undefined, path: readonly string[]): boolean {
  let at: Json | undefined = patch
  for (const key of path) {
    if (!isPlainObject(at) || !(key in at)) return false
    at = at[key]
    if (at === null) return true
  }
  return true
}

// ==================== The project settings of a host's answer ====================

/** The settings object of a GetProjectInfo answer ({} when the project has none) */
export function settingsOf(project: { settings: unknown } | null | undefined): JsonObject {
  return project !== null && project !== undefined && isPlainObject(project.settings) ? project.settings : {}
}
