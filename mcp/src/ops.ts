// The scene edits, as typed operations (design 3.2: n2_apply_edits' ops are typed JSON, never parsed text). Each operation
// has a zod schema (shared by its own tool and the batch tool), a cost (host write commands it runs) and an executor that
// runs it against the host. Executors never open edit groups: the caller (a tool, or the batch) wraps them in one.
import { z } from "zod"
import type { HostContext } from "./bridge"
import { BridgeError } from "./errors"
import { NameChars } from "./limits"
import type { ComponentSchema } from "../../src/protocol/protocol.generated"
import { Budget } from "./scrub"
import * as limits from "./limits"
import { invalidArgument } from "./tools"
import type { Touched } from "./write-core"

// ===== schemas =====

const idPlain = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z-]+$/, "an entity or component UUID")

/** In a batch an id may also be a reference to an earlier op's result: $<index>.entityId or $<index>.componentId */
const idRef = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(?:[0-9A-Za-z-]+|\$\d{1,3}\.(?:entityId|componentId))$/, "a UUID, or $<op index>.entityId / $<op index>.componentId")

const entityIdDesc = "The entity's UUID (from n2_get_hierarchy or n2_create_entity)."
const refDesc = " In a batch it can be $<n>.entityId, the entityId an earlier op (index n, counting from 0) created or duplicated."

const number = z.number()
const vec3 = z.object({ x: number, y: number, z: number }).strict()
const quat = z.object({ x: number, y: number, z: number, w: number }).strict()

const entityName = z
  .string()
  .min(1)
  .max(NameChars)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001F\u007F-\u009F]+$/, "no control characters")
  .describe(`The entity's name (1 to ${NameChars} characters, one line).`)

const tagText = z.string().max(NameChars).regex(/^[^\u0000-\u001F\u007F-\u009F]*$/, "no control characters")

const transformFields = {
  position: vec3.optional().describe("Local position {x,y,z}. Omitted: unchanged."),
  rotation: quat
    .optional()
    .describe("Local rotation as a quaternion {x,y,z,w} (identity is {0,0,0,1}; a turn of angle a about Y is {0, sin(a/2), 0, cos(a/2)}). It is normalised. Omitted: unchanged."),
  scale: vec3.optional().describe("Local scale {x,y,z}. Omitted: unchanged."),
}

const presetEnum = z.enum(["Empty", "Cube", "Sphere", "Quad", "Light", "DirectionalLight", "PointLight", "SpotLight"])

const componentSpec = z
  .object({
    type: z.string().min(1).max(128).describe("A component type name from n2_get_component_types, e.g. Light."),
    values: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Field values to set after adding it (keys and shapes as n2_describe_component says). Omitted: the type's defaults."),
  })
  .strict()

export const createEntityFields = {
  name: entityName,
  parentId: idPlain.optional().describe("The parent entity; omitted: a root of the scene."),
  siblingIndex: z.number().int().min(0).max(100000).optional().describe("Its place among its siblings; omitted: the last."),
  preset: presetEnum.optional().describe("What to make: Empty (default), a Cube, Sphere or Quad (with a renderer), or a light."),
  ...transformFields,
  tag: tagText.optional(),
  layer: z.number().int().min(0).max(31).optional().describe("Layer 0 to 31."),
  active: z.boolean().optional(),
  components: z.array(componentSpec).max(32).optional().describe("Components to add, in order."),
}

export const setTransformFields = {
  entityId: idPlain.describe(entityIdDesc),
  ...transformFields,
}

export const setParentFields = {
  entityId: idPlain.describe(entityIdDesc),
  parentId: idPlain.nullable().describe("The new parent's UUID, or null to make the entity a root of the scene."),
  siblingIndex: z.number().int().min(0).max(100000).optional().describe("Its place among its new siblings; omitted: the last."),
  keepWorldTransform: z.boolean().optional().describe("true (default) keeps where the entity is in the world (its local transform changes); false keeps its local transform."),
}

export const setPropertiesFields = {
  entityId: idPlain.describe(entityIdDesc),
  name: entityName.optional(),
  active: z.boolean().optional().describe("Whether the entity is active."),
  tag: tagText.optional(),
  layer: z.number().int().min(0).max(31).optional(),
}

export const addComponentFields = {
  entityId: idPlain.describe(entityIdDesc),
  type: z.string().min(1).max(128).describe("A component type name from n2_get_component_types."),
  values: z.record(z.string(), z.unknown()).optional().describe("Field values to set right after adding it; omitted: the defaults."),
}

export const removeComponentFields = {
  entityId: idPlain.describe(entityIdDesc),
  componentId: idPlain.describe("The component's UUID (from n2_get_entity)."),
}

export const setComponentFieldsFields = {
  entityId: idPlain.describe(entityIdDesc),
  componentId: idPlain.describe("The component's UUID (from n2_get_entity or n2_add_component)."),
  values: z
    .record(z.string(), z.unknown())
    .refine((v) => Object.keys(v).length > 0, "give at least one field")
    .describe("The fields to change, keyed by name, with the shapes n2_describe_component gives. All or nothing: one bad value changes none."),
}

export const duplicateFields = { entityId: idPlain.describe(entityIdDesc) }

export const destroyFields = { entityId: idPlain.describe(entityIdDesc) }

function batchFields<T extends Record<string, z.ZodType>>(fields: T, idKeys: string[]): Record<string, z.ZodType> {
  const out: Record<string, z.ZodType> = {}
  for (const [key, schema] of Object.entries(fields)) {
    if (idKeys.includes(key)) {
      const nullable = key === "parentId"
      const base = idRef.describe((schema.description ?? "An id.") + refDesc)
      const typed = nullable ? base.nullable() : base
      out[key] = schema.safeParse(undefined).success ? typed.optional() : typed
    } else out[key] = schema
  }
  return out
}

/** The batch's ops: each is an object with an `op` tag and the arguments of the matching single-purpose tool */
export const batchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create_entity"), ...batchFields(createEntityFields, ["parentId"]) }).strict(),
  z.object({ op: z.literal("destroy_entity"), ...batchFields(destroyFields, ["entityId"]) }).strict(),
  z.object({ op: z.literal("set_transform"), ...batchFields(setTransformFields, ["entityId"]) }).strict(),
  z.object({ op: z.literal("set_parent"), ...batchFields(setParentFields, ["entityId", "parentId"]) }).strict(),
  z.object({ op: z.literal("set_properties"), ...batchFields(setPropertiesFields, ["entityId"]) }).strict(),
  z.object({ op: z.literal("add_component"), ...batchFields(addComponentFields, ["entityId"]) }).strict(),
  z.object({ op: z.literal("remove_component"), ...batchFields(removeComponentFields, ["entityId", "componentId"]) }).strict(),
  z.object({ op: z.literal("set_component_fields"), ...batchFields(setComponentFieldsFields, ["entityId", "componentId"]) }).strict(),
  z.object({ op: z.literal("duplicate_entity"), ...batchFields(duplicateFields, ["entityId"]) }).strict(),
])

export type BatchOp = z.infer<typeof batchOp>

// ===== costs =====

export type Plain = Record<string, unknown>

/** Host write commands an op runs */
export function opCost(op: Plain): number {
  switch (op.op) {
    case "create_entity": {
      const components = (op.components as Array<{ values?: unknown }> | undefined) ?? []
      const hasTransform = op.position !== undefined || op.rotation !== undefined || op.scale !== undefined
      const hasProps = op.tag !== undefined || op.layer !== undefined || op.active !== undefined
      return 1 + (hasTransform ? 1 : 0) + (hasProps ? 1 : 0) + components.reduce((n, c) => n + 1 + (c.values && Object.keys(c.values as object).length ? 1 : 0), 0)
    }
    case "add_component":
      return 1 + (op.values && Object.keys(op.values as object).length ? 1 : 0)
    default:
      return 1
  }
}

// ===== validation against the host's component types =====

/** Levenshtein distance, for "did you mean" */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next.push(Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)))
    row = next
  }
  return row[b.length]
}

/** The component type, or an invalid_argument naming the nearest real names */
export function findType(types: ComponentSchema[], typeName: string, scrub: HostContext["scrubber"]): ComponentSchema {
  const found = types.find((t) => t.typeName === typeName)
  if (found) return found
  const needle = typeName.toLowerCase()
  const near = types
    .filter((t) => t.typeName.toLowerCase().includes(needle) || needle.includes(t.typeName.toLowerCase()) || editDistance(t.typeName.toLowerCase(), needle) <= 2)
    .slice(0, 5)
  const hint = near.length ? ` Did you mean ${near.map((t) => scrub.name(t.typeName, 64)).join(", ")}?` : ""
  throw invalidArgument(`No component type is named ${JSON.stringify(scrub.name(typeName, 64))}.${hint} n2_get_component_types lists them.`)
}

/** Checks the keys of component values against the type's fields (a LuaComponent's script fields are the host's to check) */
export function checkValueKeys(type: ComponentSchema, values: Plain, scrub: HostContext["scrubber"]): void {
  if (type.typeName === "LuaComponent") return
  const fields = new Map(type.fields.map((f) => [f.name, f]))
  for (const key of Object.keys(values)) {
    const field = fields.get(key)
    if (!field || field.hidden) {
      const names = type.fields.filter((f) => !f.hidden && !f.readOnly).map((f) => f.name)
      throw invalidArgument(
        `${scrub.name(type.typeName, 64)} has no field ${JSON.stringify(scrub.name(key, 64))}. Its fields: ${names.map((n) => scrub.name(n, 48)).join(", ") || "(none)"}. n2_describe_component gives their shapes.`
      )
    }
    if (field.readOnly) throw invalidArgument(`${scrub.name(type.typeName, 64)}.${scrub.name(key, 64)} is read-only.`)
  }
}

// ===== executors =====

export interface ComponentAdded {
  type: string
  componentId: string
}

function normalise(q: { x: number; y: number; z: number; w: number }): { x: number; y: number; z: number; w: number } {
  const len = Math.hypot(q.x, q.y, q.z, q.w)
  if (!(len > 1e-9)) throw invalidArgument("rotation must be a non-zero quaternion.")
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len }
}

type Trs = { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number }; scale: { x: number; y: number; z: number } }

/** SetLocalTransform needs all three parts: the ones not given are read from the entity */
async function applyTransform(ctx: HostContext, entityId: string, part: Partial<Trs>): Promise<void> {
  let base: Trs | null = null
  if (part.position === undefined || part.rotation === undefined || part.scale === undefined) {
    const t = (await ctx.client.getEntity(entityId)).entity.transform
    if (!t) throw invalidArgument("That entity has no transform to change.")
    base = { position: t.position, rotation: t.rotation, scale: t.scale }
  }
  const position = part.position ?? base!.position
  const rotation = normalise(part.rotation ?? base!.rotation)
  const scale = part.scale ?? base!.scale
  await ctx.client.setLocalTransform(entityId, position, rotation, scale)
}

function hasKeys(o: unknown): o is Plain {
  return typeof o === "object" && o !== null && Object.keys(o).length > 0
}

/** The result of one op: a small record, plus what it touched (added to `touched`) */
export type OpResult = Record<string, unknown>

export async function execCreateEntity(ctx: HostContext, a: Plain, touched: Touched): Promise<OpResult> {
  const components = (a.components as Array<{ type: string; values?: Plain }> | undefined) ?? []
  const entityId = await ctx.client.createEntityEx(String(a.name), (a.parentId as string | undefined) ?? "", (a.siblingIndex as number | undefined) ?? -1, (a.preset as string | undefined) === "Empty" ? "" : ((a.preset as string | undefined) ?? ""))
  touched.created.push(entityId)
  if (a.position !== undefined || a.rotation !== undefined || a.scale !== undefined) {
    await applyTransform(ctx, entityId, { position: a.position as Trs["position"], rotation: a.rotation as Trs["rotation"], scale: a.scale as Trs["scale"] })
  }
  if (a.tag !== undefined || a.layer !== undefined || a.active !== undefined) {
    const properties: Plain = {}
    if (a.tag !== undefined) properties.tag = a.tag
    if (a.layer !== undefined) properties.layer = a.layer
    if (a.active !== undefined) properties.active = a.active
    await ctx.client.setEntityProperties(entityId, properties)
  }
  const added: ComponentAdded[] = []
  for (const c of components) {
    const result = await ctx.client.addComponent(entityId, c.type)
    added.push({ type: ctx.scrubber.name(c.type, 128), componentId: result.componentId })
    if (hasKeys(c.values)) await ctx.client.setComponentFields(entityId, result.componentId, c.values)
  }
  return { entityId, components: added }
}

export async function execDestroyEntity(ctx: HostContext, a: Plain, touched: Touched): Promise<OpResult> {
  await ctx.client.destroyEntity(String(a.entityId))
  touched.destroyed.push(String(a.entityId))
  return { entityId: a.entityId }
}

export async function execSetTransform(ctx: HostContext, a: Plain, touched: Touched): Promise<OpResult> {
  if (a.position === undefined && a.rotation === undefined && a.scale === undefined) throw invalidArgument("Give at least one of position, rotation and scale.")
  await applyTransform(ctx, String(a.entityId), { position: a.position as Trs["position"], rotation: a.rotation as Trs["rotation"], scale: a.scale as Trs["scale"] })
  touched.modified.push(String(a.entityId))
  return { entityId: a.entityId }
}

export async function execSetParent(ctx: HostContext, a: Plain, touched: Touched): Promise<OpResult> {
  await ctx.client.setEntityParent(String(a.entityId), (a.parentId as string | null) ?? "", (a.siblingIndex as number | undefined) ?? -1, (a.keepWorldTransform as boolean | undefined) ?? true)
  touched.modified.push(String(a.entityId))
  return { entityId: a.entityId }
}

export async function execSetProperties(ctx: HostContext, a: Plain, touched: Touched): Promise<OpResult> {
  const properties: Plain = {}
  for (const key of ["name", "active", "tag", "layer"]) if (a[key] !== undefined) properties[key] = a[key]
  if (Object.keys(properties).length === 0) throw invalidArgument("Give at least one of name, active, tag and layer.")
  await ctx.client.setEntityProperties(String(a.entityId), properties)
  touched.modified.push(String(a.entityId))
  return { entityId: a.entityId }
}

export async function execAddComponent(ctx: HostContext, a: Plain, touched: Touched): Promise<OpResult> {
  const added = await ctx.client.addComponent(String(a.entityId), String(a.type))
  let values: unknown = added.values
  if (hasKeys(a.values)) values = await ctx.client.setComponentFields(String(a.entityId), added.componentId, a.values)
  touched.modified.push(String(a.entityId))
  return { entityId: a.entityId, type: ctx.scrubber.name(String(a.type), 128), componentId: added.componentId, values: ctx.scrubber.deep(values, new Budget(limits.SmallJsonBytes)) }
}

export async function execRemoveComponent(ctx: HostContext, a: Plain, touched: Touched): Promise<OpResult> {
  await ctx.client.removeComponent(String(a.entityId), String(a.componentId))
  touched.modified.push(String(a.entityId))
  return { entityId: a.entityId, componentId: a.componentId }
}

export async function execSetComponentFields(ctx: HostContext, a: Plain, touched: Touched): Promise<OpResult> {
  const values = await ctx.client.setComponentFields(String(a.entityId), String(a.componentId), a.values)
  touched.modified.push(String(a.entityId))
  return { entityId: a.entityId, componentId: a.componentId, values: ctx.scrubber.deep(values, new Budget(limits.SmallJsonBytes)) }
}

export async function execDuplicate(ctx: HostContext, a: Plain, touched: Touched): Promise<OpResult> {
  const id = await ctx.client.duplicateEntity(String(a.entityId))
  touched.created.push(id)
  return { entityId: id, duplicateOf: a.entityId }
}

/** Validates an op's component types and field names against the host's types before anything runs */
export async function validateOp(ctx: HostContext, op: Plain): Promise<void> {
  const check = async (type: unknown, values: unknown): Promise<void> => {
    const t = findType(await ctx.componentTypes(), String(type), ctx.scrubber)
    if (hasKeys(values)) checkValueKeys(t, values, ctx.scrubber)
  }
  if (op.op === "set_transform" && op.position === undefined && op.rotation === undefined && op.scale === undefined) {
    throw invalidArgument("Give at least one of position, rotation and scale.")
  }
  if (op.op === "set_properties" && op.name === undefined && op.active === undefined && op.tag === undefined && op.layer === undefined) {
    throw invalidArgument("Give at least one of name, active, tag and layer.")
  }
  if (op.op === "create_entity") for (const c of (op.components as Array<{ type: string; values?: unknown }> | undefined) ?? []) await check(c.type, c.values)
  if (op.op === "add_component") await check(op.type, op.values)
}

/** Runs one resolved op */
export async function execOp(ctx: HostContext, op: Plain, touched: Touched): Promise<OpResult> {
  switch (op.op) {
    case "create_entity":
      return execCreateEntity(ctx, op, touched)
    case "destroy_entity":
      return execDestroyEntity(ctx, op, touched)
    case "set_transform":
      return execSetTransform(ctx, op, touched)
    case "set_parent":
      return execSetParent(ctx, op, touched)
    case "set_properties":
      return execSetProperties(ctx, op, touched)
    case "add_component":
      return execAddComponent(ctx, op, touched)
    case "remove_component":
      return execRemoveComponent(ctx, op, touched)
    case "set_component_fields":
      return execSetComponentFields(ctx, op, touched)
    case "duplicate_entity":
      return execDuplicate(ctx, op, touched)
    default:
      throw new BridgeError("invalid_argument", "Unknown op.", "Use one of the ops the schema lists.")
  }
}

// ===== references in a batch =====

const RefPattern = /^\$(\d{1,3})\.(entityId|componentId)$/

/** Replaces $<n>.entityId / $<n>.componentId in an op's id fields with the result of op n (which must be an earlier one) */
export function resolveRefs(op: Plain, index: number, results: OpResult[]): Plain {
  const out: Plain = { ...op }
  for (const key of ["entityId", "parentId", "componentId"]) {
    const value = out[key]
    if (typeof value !== "string") continue
    const m = RefPattern.exec(value)
    if (!m) continue
    const n = Number(m[1])
    if (n >= index) throw invalidArgument(`Op ${index}: ${key} refers to op ${n}, which does not come before it.`)
    const found = results[n]?.[m[2]]
    if (typeof found !== "string") throw invalidArgument(`Op ${index}: ${key} refers to ${value}, but op ${n} (${String(results[n]?.op ?? "?")}) made no ${m[2]}.`)
    out[key] = found
  }
  return out
}

/** Static check of refs before anything runs: only earlier ops, and only for ids */
export function checkRefs(ops: Plain[]): void {
  ops.forEach((op, index) => {
    for (const key of ["entityId", "parentId", "componentId"]) {
      const m = typeof op[key] === "string" ? RefPattern.exec(op[key] as string) : null
      if (!m) continue
      const n = Number(m[1])
      if (n >= index) throw invalidArgument(`Op ${index}: ${key} refers to op ${n}, which does not come before it.`)
      const producer = ops[n]
      const makes = m[2] === "componentId" ? producer.op === "add_component" : producer.op === "create_entity" || producer.op === "duplicate_entity"
      if (!makes) throw invalidArgument(`Op ${index}: ${key} refers to ${op[key]}, but op ${n} (${String(producer.op)}) does not make a ${m[2]}.`)
    }
  })
}
