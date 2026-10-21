// Inspector multi-edit: with several objects selected, the shared fields (the object's active flag, tag and layer, its
// local transform, and the fields of the component types every one of them has) are shown once, with a mixed-value
// indicator where the objects differ, and an edit of a field is applied to ALL of them as ONE edit group (one undo
// step, named "Edit N objects"). No DOM: it is given the page's engine API or a fake, so it is unit tested in Node.
//
// What is shared: components are matched by type, the first of each type on every object; a LuaComponent only when
// all of them run the same script (its script fields are then the shared ones). Fields of kinds that have no neutral
// "mixed" display and no safe way to apply one value to many (references, lists, JSON) are not shown: those are edited
// one object at a time. The name is not multi-edited. Add Component adds the type to every object, and Remove removes
// a shared component (the first of its type) from every object, each as one edit group too.
//
// A failure: each object is a request of its own, and the host takes a request all or nothing. The first refusal
// aborts the edit: nothing more is sent, and the group is ended as every edit group is (in a finally; never left open,
// since the host refuses Undo and extension invokes while one is), so what was applied before it is one undo step.
// The panel says how many were applied, how many were not sent and why the object refused, and reads the objects
// again, so what is shown is what the host has. An edit that ends after the selection moved on reports nothing there.
import { batch, computed, signal } from "@preact/signals-core"
import type { ComponentSchema, EntityDetails, FieldSchema, Quat, Vec3 } from "../protocol/protocol.generated"
import type { SceneChange } from "../protocol/editor-events"
import { errorCodeOf, errorTextOf } from "../shared/api"
import type { EngineApi, JsonObject } from "../shared/api"
import type { EditGroups } from "./edit-groups"
import { eulerToQuat, quatToEuler, quatsEquivalent } from "./euler"
import {
  displayValue,
  fieldPatch,
  jsonEqual,
  kindOf,
  axesOf,
  colorChannels,
  isObject,
  planRequests,
  visibleFields,
} from "./inspector-fields"

type Engine = Pick<
  EngineApi,
  | "isConnected"
  | "getEntity"
  | "getLuaFields"
  | "setEntityProperties"
  | "setComponentFields"
  | "setLocalTransform"
  | "addComponent"
  | "removeComponent"
> &
  // Undo takes back an edit group that a refusal cut short (protocol 1.6); without it the panel only says so
  Partial<Pick<EngineApi, "undo">>

/** What the multi inspector needs of the single one: the component types, and whether anything may be changed */
interface Host {
  readonly types: { readonly value: readonly ComponentSchema[] | null }
  readonly readOnlyReason: { readonly value: string | null }
}

interface Options {
  groups?: Pick<EditGroups, "begin" | "end">
  /** A failure that is news to everyone (a denial: it turns the writes off) */
  onError?(what: string, error: unknown): void
  /** Whether the user agreed (the page's confirm dialog), asked before a component is removed from every object */
  confirm?(message: string, okLabel: string): Promise<boolean>
  /**
   * Undoes the last step the way the Undo menu does (the page's EditController: pending edits settled, groups closed,
   * the history read before and the panels synced after). Used to take back an edit group that stopped at a refusal.
   * Without it nothing is rolled back and the message says Undo takes back what was applied.
   */
  undo?(): Promise<void>
}

/** What a refusal mid-batch leaves to take back once the edit is no longer counted as running */
interface Rollback {
  done: number
  skipped: number
  selection: number
  /** The refusal, as said to the user */
  failure: string
  /** The message shown while the rollback is not (yet) done: what a rollback that fails or is skipped leaves */
  problem: string
}

/** The type of the component a script runs in */
const LuaType = "LuaComponent"

/** Two angles (degrees) or other numbers closer than this are not told apart when deciding whether they are mixed */
const MixedTolerance = 1e-3

// ==================== The view model ====================

/** A value shared by the selected objects (mixed false) or not (mixed true: value is the first object's) */
export interface Mixed<T> {
  value: T
  mixed: boolean
}

export interface MultiAxes {
  x: Mixed<number>
  y: Mixed<number>
  z: Mixed<number>
}

/** One selected object's component of a shared type */
export interface MultiEntry {
  entityId: string
  componentId: string
  values: JsonObject
}

export interface MultiComponent {
  type: string
  /** One per selected object, in selection order */
  entries: MultiEntry[]
}

export interface MultiView {
  count: number
  active: Mixed<boolean>
  tag: Mixed<string>
  layer: Mixed<number>
  /** The shared local transform; null when one of the objects has none */
  transform: { position: MultiAxes; rotation: MultiAxes; scale: MultiAxes } | null
  components: MultiComponent[]
}

export type TransformPart = "position" | "rotation" | "scale"

const mixedOf = <T>(values: T[], same: (a: T, b: T) => boolean = (a, b) => a === b): Mixed<T> => ({
  value: values[0],
  mixed: values.some((value) => !same(value, values[0])),
})

const sameNumber = (a: number, b: number): boolean => Math.abs(a - b) <= MixedTolerance

/** Angles (degrees) that differ by a whole turn are the same: float noise at the +-180 wrap is not "mixed" */
const sameAngle = (a: number, b: number): boolean => {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d) <= MixedTolerance
}

function axesOfVec(vectors: Vec3[], same: (a: number, b: number) => boolean = sameNumber): MultiAxes {
  return {
    x: mixedOf(vectors.map((v) => v.x), same),
    y: mixedOf(vectors.map((v) => v.y), same),
    z: mixedOf(vectors.map((v) => v.z), same),
  }
}

/** The first of each component type on the object */
function firstOfType(details: EntityDetails): Map<string, MultiEntry> {
  const found = new Map<string, MultiEntry>()
  for (const component of details.components) {
    if (found.has(component.type)) continue
    found.set(component.type, {
      entityId: details.header.id,
      componentId: component.uuid,
      values: isObject(component.values) ? component.values : {},
    })
  }
  return found
}

const scriptOf = (entry: MultiEntry): string =>
  typeof entry.values.scriptUUID === "string" ? entry.values.scriptUUID : ""

/**
 * What the selected objects share. The component types are those every object has (a LuaComponent only when all
 * run the same, non-empty script), in the order of the first object's components.
 */
export function buildMultiView(objects: readonly EntityDetails[]): MultiView {
  const headers = objects.map((object) => object.header)
  const transforms = objects.map((object) => object.transform)
  let transform: MultiView["transform"] = null
  if (transforms.length > 0 && transforms.every((t) => t !== undefined)) {
    const all = transforms as NonNullable<(typeof transforms)[number]>[]
    transform = {
      position: axesOfVec(all.map((t) => t.position)),
      rotation: axesOfVec(all.map((t) => quatToEuler(t.rotation)), sameAngle),
      scale: axesOfVec(all.map((t) => t.scale)),
    }
  }
  const perObject = objects.map(firstOfType)
  const components: MultiComponent[] = []
  for (const type of perObject[0]?.keys() ?? []) {
    const entries = perObject.map((found) => found.get(type))
    if (!entries.every((entry): entry is MultiEntry => entry !== undefined)) continue
    if (type === LuaType) {
      const script = scriptOf(entries[0])
      if (script === "" || entries.some((entry) => scriptOf(entry) !== script)) continue
    }
    components.push({ type, entries })
  }
  return {
    count: objects.length,
    active: mixedOf(headers.map((h) => h.active)),
    tag: mixedOf(headers.map((h) => h.tag)),
    layer: mixedOf(headers.map((h) => h.layer)),
    transform,
    components,
  }
}

/** The kinds that are edited on several objects at once */
const MultiKinds: ReadonlySet<string> = new Set([
  "Bool",
  "Int",
  "Float",
  "String",
  "Enum",
  "Vector2",
  "Vector3",
  "Vector4",
  "Quaternion",
  "Color",
])

/** Whether a field can be multi-edited (references, lists and JSON can't) */
export const isMultiEditable = (field: FieldSchema): boolean => MultiKinds.has(kindOf(field)) && !field.readOnly

/** The fields of a schema that are shown for several objects, and whether some were left out */
export function multiFields(schema: ComponentSchema): { fields: FieldSchema[]; skipped: number } {
  const visible = visibleFields(schema)
  const fields = visible.filter(isMultiEditable)
  // A read-only field is shown nowhere in a card either way (it can't be edited): it isn't "left out"
  return { fields, skipped: visible.filter((field) => !field.readOnly).length - fields.length }
}

/** The value of a field on the first object, and whether the objects differ (any axis of a vector counts) */
export function fieldMixed(field: FieldSchema, entries: readonly MultiEntry[]): Mixed<unknown> {
  const values = entries.map((entry) => displayValue(field, entry.values))
  return { value: values[0], mixed: values.some((value) => !jsonEqual(value, values[0])) }
}

/** The axes of a vector (or colour) field on which the objects differ */
export function mixedAxes(field: FieldSchema, entries: readonly MultiEntry[]): string[] {
  const kind = kindOf(field)
  const keys = kind === "Color" ? colorChannels(field).keys : axesOf(kind)
  const values = entries.map((entry) => displayValue(field, entry.values))
  return keys.filter((key) =>
    values.some((value) => {
      const a = isObject(value) ? value[key] : undefined
      const b = isObject(values[0]) ? (values[0] as JsonObject)[key] : undefined
      return !jsonEqual(a, b)
    })
  )
}

// ==================== The state ====================

const messageOf = (e: unknown): string => errorTextOf(e)

/** A change to send to one object */
interface Job {
  /** The object's name, as it was when the edit was asked for (the selection may move on meanwhile) */
  name: string
  send(): Promise<void>
}

export class MultiInspectorState {
  /** The selected objects (two or more; empty otherwise) */
  readonly ids = signal<readonly string[]>([])
  /** The objects as the host has them, in the order of ids; null while they are read, or when they can't be */
  readonly objects = signal<readonly EntityDetails[] | null>(null)
  readonly loading = signal(false)
  readonly loadProblem = signal<string | null>(null)
  /** Why the last edit changed fewer objects than were asked for, or null */
  readonly editProblem = signal<string | null>(null)
  /** A shared LuaComponent's script fields, by script (GetLuaFields) */
  readonly luaSchemas = signal<ReadonlyMap<string, ComponentSchema>>(new Map())
  readonly view = computed<MultiView | null>(() => {
    const objects = this.objects.value
    return objects && objects.length > 1 ? buildMultiView(objects) : null
  })
  /** The component types ANY selected object has: a singleton one of them can't be added to all */
  readonly presentTypes = computed<ReadonlySet<string>>(
    () => new Set((this.objects.value ?? []).flatMap((object) => object.components.map((component) => component.type)))
  )

  private fetches = 0
  /** Counts selections: an edit that ends after the selection moved on doesn't report on the new one */
  private selections = 0
  private queue: Promise<void> = Promise.resolve()
  /** Edits not finished (an edit and the read after it): Undo and Save wait for them */
  private running = 0
  private readonly idle: Array<() => void> = []

  constructor(
    private readonly host: Host,
    private readonly engine: Engine,
    private readonly options: Options
  ) {}

  private readonly pendingSenders = new Set<() => void>()

  /** Registers what sends a debounced edit that is waiting (the panel's timer); returns how to remove it */
  onPending(send: () => void): () => void {
    this.pendingSenders.add(send)
    return () => void this.pendingSenders.delete(send)
  }

  /** Sends the debounced edits that are waiting now, so Undo and Save don't pass them */
  sendPending(): void {
    for (const send of [...this.pendingSenders]) send()
  }

  /** Resolves when the edits made so far have been sent and read back */
  get settled(): Promise<void> {
    if (this.running === 0) return Promise.resolve()
    return new Promise((resolve) => this.idle.push(resolve))
  }

  reset(): void {
    this.fetches++
    this.selections++
    batch(() => {
      this.ids.value = []
      this.objects.value = null
      this.loading.value = false
      this.loadProblem.value = null
      this.editProblem.value = null
      this.luaSchemas.value = new Map()
    })
  }

  /** The component's fields: its type's, or a shared LuaComponent's script fields; null when not known (yet) */
  schemaFor(component: MultiComponent): ComponentSchema | null {
    if (component.type === LuaType) return this.luaSchemas.value.get(scriptOf(component.entries[0])) ?? null
    return this.host.types.value?.find((type) => type.typeName === component.type) ?? null
  }

  // ==================== Reading ====================

  /** Shows the shared fields of these objects (fewer than two: none) */
  async select(ids: readonly string[]): Promise<void> {
    const current = this.ids.value
    const next = ids.length > 1 ? [...ids] : []
    if (next.length === current.length && next.every((id, i) => id === current[i])) return
    this.fetches++
    this.selections++
    batch(() => {
      this.ids.value = next
      this.objects.value = null
      this.loadProblem.value = null
      this.editProblem.value = null
      this.luaSchemas.value = new Map()
      this.loading.value = next.length > 0
    })
    await this.refresh()
  }

  async applyChange(change: SceneChange): Promise<void> {
    const ids = this.ids.value
    if (ids.length === 0) return
    if (change.full || change.entityIds.some((id) => ids.includes(id))) await this.refresh()
  }

  /** Reads the objects again (GetEntity each); a slow answer doesn't replace a newer one */
  async refresh(): Promise<void> {
    const ids = this.ids.value
    if (ids.length === 0) return
    if (!this.engine.isConnected()) {
      this.loading.value = false
      return
    }
    const fetch = ++this.fetches
    let objects: EntityDetails[]
    try {
      objects = (await Promise.all(ids.map((id) => this.engine.getEntity(id)))).map((data) => data.entity)
    } catch (e) {
      if (fetch === this.fetches) {
        batch(() => {
          this.loading.value = false
          this.loadProblem.value = messageOf(e)
          this.objects.value = null
        })
      }
      return
    }
    if (fetch !== this.fetches) return
    batch(() => {
      this.loading.value = false
      this.loadProblem.value = null
      this.objects.value = objects
    })
    await this.readLuaFields(fetch)
  }

  /** Reads the script fields of the shared LuaComponents whose script they weren't read for */
  private async readLuaFields(fetch: number): Promise<void> {
    const view = this.view.peek()
    if (!view) return
    for (const component of view.components) {
      if (component.type !== LuaType) continue
      const script = scriptOf(component.entries[0])
      if (this.luaSchemas.peek().has(script)) continue
      try {
        const first = component.entries[0]
        const schema = await this.engine.getLuaFields(first.entityId, first.componentId)
        // The selection moved on while it was read
        if (fetch !== this.fetches && !this.ids.peek().includes(first.entityId)) return
        this.luaSchemas.value = new Map(this.luaSchemas.peek()).set(script, schema)
      } catch (e) {
        // Its fields can't be shown: the component is shown without any
        console.debug("GetLuaFields failed:", e)
      }
    }
  }

  // ==================== Editing ====================

  private requireEditable(): void {
    const reason = this.host.readOnlyReason.value
    if (reason !== null) throw new Error(`The inspector is read-only: ${reason}`)
  }

  private nameOf(entityId: string): string {
    return this.objects.peek()?.find((object) => object.header.id === entityId)?.header.name ?? entityId
  }

  private job(entityId: string, send: () => Promise<unknown>): Job {
    return { name: this.nameOf(entityId), send: () => send().then(() => undefined) }
  }

  /** The active flag, tag or layer of every selected object */
  setProperties(properties: { active?: boolean; tag?: string; layer?: number }): Promise<void> {
    this.requireEditable()
    const objects = this.objects.peek() ?? []
    const jobs: Job[] = objects
      .filter((object) => Object.entries(properties).some(([key, value]) => object.header[key as "tag"] !== value))
      .map((object) => this.job(object.header.id, () => this.engine.setEntityProperties(object.header.id, properties)))
    return this.run(objects.length, jobs)
  }

  /** One axis of the position, rotation (Euler degrees) or scale of every selected object, each keeping its other axes */
  setTransformAxis(part: TransformPart, axis: "x" | "y" | "z", value: number): Promise<void> {
    this.requireEditable()
    const objects = this.objects.peek() ?? []
    const jobs: Job[] = []
    for (const object of objects) {
      const local = object.transform
      if (!local) continue
      let position: Vec3 = local.position
      let rotation: Quat = local.rotation
      let scale: Vec3 = local.scale
      let changed = false
      if (part === "position" && position[axis] !== value) {
        position = { ...position, [axis]: value }
        changed = true
      } else if (part === "scale" && scale[axis] !== value) {
        scale = { ...scale, [axis]: value }
        changed = true
      } else if (part === "rotation") {
        const quat = eulerToQuat({ ...quatToEuler(local.rotation), [axis]: value })
        // The same rotation as stored (180 for -180): nothing to send
        if (!quatsEquivalent(quat, local.rotation)) {
          rotation = quat
          changed = true
        }
      }
      if (!changed) continue
      jobs.push(
        this.job(object.header.id, () => this.engine.setLocalTransform(object.header.id, position, rotation, scale))
      )
    }
    return this.run(objects.length, jobs)
  }

  /**
   * A field of a shared component, set on every selected object (a checked value: see checkValue). axis: only that axis
   * of a vector (or colour) value was edited, so each object keeps its own other axes.
   */
  setField(
    component: MultiComponent,
    field: FieldSchema,
    value: unknown,
    axis?: string | readonly string[]
  ): Promise<void> {
    this.requireEditable()
    const jobs: Job[] = []
    for (const entry of component.entries) {
      let own = value
      if (axis !== undefined && isObject(value)) {
        const stored = displayValue(field, entry.values)
        own = { ...(isObject(stored) ? stored : {}) }
        for (const key of typeof axis === "string" ? [axis] : axis) (own as JsonObject)[key] = value[key]
      }
      // Only what differs, and in the order the host wants (inspector-fields' planRequests)
      for (const request of planRequests(entry.values, fieldPatch(field, own)).requests) {
        jobs.push(
          this.job(entry.entityId, () => this.engine.setComponentFields(entry.entityId, entry.componentId, request))
        )
      }
    }
    return this.run(component.entries.length, jobs)
  }

  /** Adds a component of this type (with its default values) to every selected object, as one edit group */
  addComponent(typeName: string): Promise<void> {
    this.requireEditable()
    const objects = this.objects.peek() ?? []
    const type = this.host.types.value?.find((schema) => schema.typeName === typeName)
    if (type?.singleton && this.presentTypes.peek().has(typeName)) {
      throw new Error(`An object can have only one ${typeName}, and a selected object has one`)
    }
    const jobs = objects.map((object) =>
      this.job(object.header.id, () => this.engine.addComponent(object.header.id, typeName))
    )
    return this.run(objects.length, jobs)
  }

  /**
   * Removes a shared component (the first of its type on each object) from every selected object after asking, as one
   * edit group; resolves false when the user said no. The host clears the references to them (Undo puts them back).
   */
  async removeComponent(component: MultiComponent): Promise<boolean> {
    this.requireEditable()
    const count = component.entries.length
    const confirm = this.options.confirm
    // The selection the user was asked about: the list of components belongs to it
    const asked = this.selections
    if (confirm && !(await confirm(`Remove ${component.type} from ${count} objects?`, "Remove"))) return false
    // The selection changed while the dialog was open: the user agreed to remove from other objects, so nothing is sent
    if (asked !== this.selections) return false
    // Read-only meanwhile (a play session started while the dialog was open): nothing is sent
    this.requireEditable()
    const jobs = component.entries.map((entry) =>
      this.job(entry.entityId, () => this.engine.removeComponent(entry.entityId, entry.componentId))
    )
    await this.run(count, jobs)
    return true
  }

  /** Runs the changes as one edit group, one after the other, one edit at a time; then reads the objects again */
  private run(count: number, jobs: Job[]): Promise<void> {
    this.running++
    // The selection the edit was asked for: a failure is reported only while it is still the one shown
    const selection = this.selections
    const task = this.queue.then(() => this.runJobs(count, jobs, selection))
    // Counted as finished before any rollback: the undo settles the edits first, and waiting for itself would never end
    const finished = task.then(
      (rollback) => {
        this.finished()
        return rollback
      },
      (e) => {
        this.finished()
        throw e
      }
    )
    this.queue = finished.then(
      () => undefined,
      () => undefined
    )
    return finished.then((rollback) => (rollback ? this.rollBack(rollback) : undefined))
  }

  /** Takes back the edit group that stopped at a refusal, through the page's Undo; the message tells which it was */
  private async rollBack(rollback: Rollback): Promise<void> {
    // Another edit is queued: Undo would take back that one (or the group stays half undone), so nothing is undone
    if (this.running > 0 || !this.options.undo) return
    let problem: string
    try {
      await this.options.undo()
      problem =
        `The edit stopped at a refusal and was rolled back: ${rollback.done} applied changes were undone, ` +
        `${rollback.skipped} not sent. ${rollback.failure}`
    } catch (e) {
      problem = `${rollback.problem} (rolling back failed: ${messageOf(e)})`
    }
    // An edit of objects that are no longer selected says nothing about the ones that are
    if (rollback.selection === this.selections && this.editProblem.value === rollback.problem) {
      this.editProblem.value = problem
    }
    await this.refresh()
  }

  private finished(): void {
    if (--this.running === 0) this.idle.splice(0).forEach((resolve) => resolve())
  }

  private async runJobs(count: number, jobs: Job[], selection: number): Promise<Rollback | null> {
    this.editProblem.value = null
    if (jobs.length === 0) return null
    let done = 0
    let failure: string | null = null
    let rollback: Rollback | null = null
    const label = `Edit ${count} objects`
    const handle = (await this.options.groups?.begin(label)) ?? null
    try {
      for (const job of jobs) {
        try {
          await job.send()
          done++
        } catch (e) {
          failure = `${job.name}: ${messageOf(e)}`
          // A denial is news to everyone (it turns the writes off)
          if (errorCodeOf(e) !== undefined) this.options.onError?.("Failed to edit the objects", e)
          // The first refusal aborts the edit: nothing more is sent
          break
        }
      }
    } finally {
      // Ended whatever happened: a group left open would swallow every later edit and block Undo
      await this.options.groups?.end(handle)
    }
    // An edit of objects that are no longer selected says nothing about the ones that are
    if (failure !== null) {
      const skipped = jobs.length - done - 1
      const problem =
        `The edit stopped at a refusal: ${done} of ${jobs.length} changes applied` +
        `${done > 0 ? " (Undo takes back what was applied)" : ""}, ${skipped} not sent. ${failure}`
      if (selection === this.selections) this.editProblem.value = problem
      // A refusal takes back what was applied before it: the group is one undo step. Only a group the host opened is
      // that step; without one, Undo would take back something else. The group is ended first (the host refuses Undo
      // while one is open); the undo itself runs once this edit is no longer counted as running.
      if (done > 0 && handle !== null && this.options.undo) rollback = { done, skipped, selection, failure, problem }
    }
    // What the host has is the truth, whatever happened
    await this.refresh()
    return rollback
  }
}
