// The inspector's state, as signals: the selected object's header and components (GetEntity), the component types
// (GetComponentTypes) and a LuaComponent's script fields (GetLuaFields), the asset index, and the actions the panel
// offers: edit a field, add and remove a component, change the object's own properties. No DOM: it is given the
// page's engine API or a fake, so it is unit tested in Node.
//
// An edit is shown at once. It is kept as a pending patch for a moment (a slider sends many), then sent as one
// SetComponentFields (one request per component at a time); the answer is the component's values as stored, which
// replace what was shown (a clamped number, an enum in its canonical spelling). The engine takes a request all or
// nothing, so a refusal puts back every field of that request and its message is shown under the component. What
// the panel shows is the stored values with the request in flight and the pending patch over them (valuesOf).
import { batch, computed, signal } from "@preact/signals-core"
import type { ComponentSchema, EntityHeader } from "../protocol/protocol.generated"
import type { SceneChange } from "../protocol/editor-events"
import type { EngineApi, JsonObject, ProjectApi } from "../shared/api"
import { AssetLookup } from "./asset-lookup"
import type { EditGroups } from "./edit-groups"
import { applyPatch, isObject, mergePatch, planRequests } from "./inspector-fields"

type Engine = Pick<
  EngineApi,
  | "isConnected"
  | "getEntity"
  | "getComponentTypes"
  | "addComponent"
  | "removeComponent"
  | "setComponentFields"
  | "getLuaFields"
  | "setEntityProperties"
>
type Project = Pick<ProjectApi, "listAssets">

/** A component of the inspected object: its UUID, its type, and its values as the host stores them */
export interface ComponentView {
  id: string
  type: string
  values: JsonObject
}

/** Edits to a component that the host hasn't confirmed: the request in flight, and what was changed since */
export interface Overlay {
  inflight: JsonObject | null
  pending: JsonObject
}

/** The key of the object's own errors (the components' are under their UUIDs) */
export const EntityKey = "entity"

/** The type of the component a script runs in */
export const LuaComponentType = "LuaComponent"

/** How long an edit waits for another before it is sent (a slider's drag, typing in a field) */
export const DefaultDebounceMilliseconds = 250

export interface InspectorOptions {
  /** Whether the user agreed (the page's confirm dialog) */
  confirm(message: string, okLabel: string): Promise<boolean>
  /** A failure nobody is looking at (an edit's answer after the selection moved on) */
  onError?(what: string, error: unknown): void
  debounceMs?: number
  /**
   * Edit groups (protocol 1.6), for the drags that are one undo step (beginGesture, endGesture). Without it a drag is
   * as many steps as the host cuts it into (it merges edits of the same field made within 500 ms).
   */
  groups?: Pick<EditGroups, "begin" | "end">
  /** Whether res:// paths compare without regard to case (Windows and macOS file systems), for a dropped file */
  caseInsensitivePaths?: boolean
  /** Timers, replaceable in tests */
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const isEmpty = (object: JsonObject): boolean => Object.keys(object).length === 0

export class InspectorState {
  /** The component types the host can create; null until read (and after the connection changes) */
  readonly types = signal<readonly ComponentSchema[] | null>(null)
  /** Why the types couldn't be read (a host before protocol 1.5, say), or null */
  readonly typesProblem = signal<string | null>(null)
  readonly assets = signal<AssetLookup>(new AssetLookup([], false))

  /** The inspected object's id; null with none */
  readonly entityId = signal<string | null>(null)
  readonly header = signal<EntityHeader | null>(null)
  readonly components = signal<readonly ComponentView[]>([])
  /** The object can't be read (it is gone, or the read failed): why */
  readonly loadProblem = signal<string | null>(null)
  readonly loading = signal(false)
  /** A LuaComponent's fields (GetLuaFields), by component; none for one with no script */
  readonly luaSchemas = signal<ReadonlyMap<string, ComponentSchema>>(new Map())
  /** Why a LuaComponent's script fields couldn't be read, by component */
  readonly luaProblems = signal<ReadonlyMap<string, string>>(new Map())
  readonly overlays = signal<ReadonlyMap<string, Overlay>>(new Map())
  /** The last refusal of an edit, by component UUID (or EntityKey), until the next edit of it */
  readonly errors = signal<ReadonlyMap<string, string>>(new Map())
  /** The components that are folded up */
  readonly collapsed = signal<ReadonlySet<string>>(new Set())
  /** Why the inspector can't change anything (a play session is running); null when it can */
  readonly readOnlyReason = signal<string | null>(null)
  readonly readOnly = computed(() => this.readOnlyReason.value !== null)

  /** Counts reads of the object, so a slow answer can't replace a newer one */
  private fetches = 0
  /** Counts the answers to edits of each component: a read that began before one mustn't replace its values */
  private versions = new Map<string, number>()
  /** The script (scriptUUID) each LuaComponent's fields were read for */
  private luaKeys = new Map<string, string>()
  private readonly luaReads = new Map<string, { script: string; promise: Promise<void> }>()
  /** Components being removed: their edits are dropped, and a refusal of one that was on its way isn't news */
  private readonly removing = new Set<string>()
  private readonly timers = new Map<string, unknown>()
  private readonly sending = new Map<string, Promise<void>>()
  /** Counts the object's own property edits, so a read that began before one doesn't undo it */
  private headerEdits = 0
  /** A drag in progress that is one undo step: the answer to opening its group; null when none */
  private gesture: Promise<boolean> | null = null
  private typesRead: Promise<void> | null = null
  /** Counts connections that ended, so a read of the types for an earlier one is dropped */
  private typesEpoch = 0
  /** Components other than the inspected one's that were seen, by UUID: what a component reference points at */
  readonly known = signal<ReadonlyMap<string, { type: string; entityId: string }>>(new Map())
  /** The objects whose components were listed for the labels */
  private readonly scanned = new Set<string>()

  private readonly debounceMs: number
  private readonly timer: NonNullable<InspectorOptions["timers"]>

  constructor(
    private readonly engine: Engine,
    private readonly project: Project,
    private readonly options: InspectorOptions
  ) {
    this.debounceMs = options.debounceMs ?? DefaultDebounceMilliseconds
    this.timer = options.timers ?? {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
  }

  // ==================== What is shown ====================

  /** A component's values as the panel shows them: the stored ones, the request in flight and the pending edits over them */
  valuesOf(view: ComponentView): JsonObject {
    const overlay = this.overlays.value.get(view.id)
    if (!overlay) return view.values
    let values = view.values
    if (overlay.inflight) values = applyPatch(values, overlay.inflight)
    return isEmpty(overlay.pending) ? values : applyPatch(values, overlay.pending)
  }

  /** The fields a component is edited through: a LuaComponent's script fields, else its type's; null for an unknown type */
  schemaFor(view: ComponentView): ComponentSchema | null {
    if (view.type === LuaComponentType) {
      const lua = this.luaSchemas.value.get(view.id)
      if (lua) return lua
    }
    return this.types.value?.find((type) => type.typeName === view.type) ?? null
  }

  /** The types of the components the object has, for the Add Component menu's singletons */
  readonly presentTypes = computed(() => new Set(this.components.value.map((component) => component.type)))

  /** A component somewhere in the scene, by UUID, when it has been seen (the inspected object's, or one listed for a picker) */
  componentInfo(uuid: string): { type: string; entityId: string } | undefined {
    const own = this.components.value.find((component) => component.id === uuid)
    return own && this.entityId.value ? { type: own.type, entityId: this.entityId.value } : this.known.value.get(uuid)
  }

  toggleCollapsed(componentId: string): void {
    const next = new Set(this.collapsed.value)
    if (!next.delete(componentId)) next.add(componentId)
    this.collapsed.value = next
  }

  /** Lets go of everything held: the connection changed (another host), or none */
  reset(): void {
    this.cancelTimers()
    this.gesture = null // its group ended with the connection
    batch(() => {
      this.fetches++
      this.typesRead = null
      this.typesEpoch++
      this.types.value = null
      this.typesProblem.value = null
      this.clearEntity()
      this.known.value = new Map()
      this.scanned.clear()
    })
  }

  private clearEntity(): void {
    this.fetches++
    this.versions = new Map()
    this.luaKeys = new Map()
    this.luaReads.clear()
    batch(() => {
      this.entityId.value = null
      this.header.value = null
      this.components.value = []
      this.loadProblem.value = null
      this.loading.value = false
      this.luaSchemas.value = new Map()
      this.luaProblems.value = new Map()
      this.overlays.value = new Map()
      this.errors.value = new Map()
    })
  }

  /** Makes the inspector read-only (a play session is running, with the reason to show) or editable again (null) */
  setReadOnly(reason: string | null): void {
    // What was edited a moment ago still goes to the host it was made for
    if (reason !== null) void this.flush()
    this.readOnlyReason.value = reason
  }

  // ==================== Types and assets ====================

  /** Reads the component types once per connection (they don't change while the host runs) */
  loadTypes(): Promise<void> {
    if (this.types.value !== null) return Promise.resolve()
    if (this.typesRead) return this.typesRead
    const epoch = this.typesEpoch
    const read = (async () => {
      try {
        const types = await this.engine.getComponentTypes()
        // Not for a connection that ended while waiting
        if (epoch !== this.typesEpoch) return
        batch(() => {
          this.types.value = types
          this.typesProblem.value = null
        })
      } catch (e) {
        if (epoch !== this.typesEpoch) return
        this.typesProblem.value = messageOf(e)
        console.error("Failed to read the component types:", e)
      } finally {
        if (epoch === this.typesEpoch) this.typesRead = null
      }
    })()
    this.typesRead = read
    return read
  }

  /** Reads the project's asset index (the asset fields' names, and what a dropped file means) */
  async loadAssets(): Promise<void> {
    try {
      this.assets.value = new AssetLookup(await this.project.listAssets(), this.options.caseInsensitivePaths ?? false)
    } catch (e) {
      console.error("Failed to read the project's assets:", e)
    }
  }

  // ==================== The inspected object ====================

  /** Inspects another object (or none): what was edited and not yet sent is sent to the object it was edited on first */
  async select(entityId: string | null): Promise<void> {
    if (entityId === this.entityId.value) return
    void this.flush()
    this.cancelTimers()
    this.clearEntity()
    if (entityId === null) return
    this.entityId.value = entityId
    this.loading.value = true
    // Types that couldn't be read are asked for again
    void this.loadTypes()
    await this.refresh()
  }

  /** The scene changed: reads the object again when the change touched it */
  async applyChange(change: SceneChange): Promise<void> {
    // Every object was rebuilt (an undo of a delete, a restored autosave, another scene): what was learned about the
    // other objects' components is for objects that may not be there
    if (change.full) {
      this.known.value = new Map()
      this.scanned.clear()
    }
    const id = this.entityId.value
    if (id === null) return
    if (change.full || change.entityIds.includes(id)) await this.refresh()
  }

  /** Reads the object again (GetEntity), keeping the edits that are still on their way */
  async refresh(): Promise<void> {
    const id = this.entityId.value
    if (id === null) return
    if (!this.engine.isConnected()) {
      this.loading.value = false
      return
    }
    const fetch = ++this.fetches
    const seen = new Map(this.versions)
    const headerEdits = this.headerEdits
    let data
    try {
      data = await this.engine.getEntity(id)
    } catch (e) {
      if (fetch === this.fetches && this.entityId.value === id) {
        batch(() => {
          this.loading.value = false
          // An object that is gone (destroyed, or another scene) leaves nothing to show
          this.loadProblem.value = messageOf(e)
          this.components.value = []
          this.header.value = null
        })
      }
      return
    }
    if (fetch !== this.fetches || this.entityId.value !== id) return

    const previous = new Map(this.components.value.map((component) => [component.id, component]))
    const views: ComponentView[] = data.entity.components.map((component) => {
      const old = previous.get(component.uuid)
      // An edit of it was answered since this read began: the answer is newer than what was read
      const newer = old !== undefined && (this.versions.get(component.uuid) ?? 0) !== (seen.get(component.uuid) ?? 0)
      return {
        id: component.uuid,
        type: component.type,
        values: newer ? old.values : isObject(component.values) ? component.values : {},
      }
    })
    const ids = new Set(views.map((view) => view.id))
    batch(() => {
      this.loading.value = false
      this.loadProblem.value = null
      if (headerEdits === this.headerEdits) this.header.value = data.entity.header
      this.components.value = views
      // What belonged to a component that is gone goes too
      this.overlays.value = new Map([...this.overlays.value].filter(([key]) => ids.has(key)))
      this.errors.value = new Map([...this.errors.value].filter(([key]) => key === EntityKey || ids.has(key)))
      this.collapsed.value = new Set([...this.collapsed.value].filter((key) => ids.has(key)))
    })
    await this.syncLua(false)
  }

  /**
   * Reads the script fields of each LuaComponent whose script they weren't read for (all of them with force: a script
   * was edited, which GetLuaFields has to be asked about again). Calls overlap (a read of the object, a script change,
   * an assetsChanged): one read per component and script is shared, and an answer counts whenever the component still
   * runs the script it was asked for.
   */
  private async syncLua(force: boolean): Promise<void> {
    const id = this.entityId.value
    if (id === null) return
    const lua = this.components.value.filter((view) => view.type === LuaComponentType)
    await Promise.all(lua.map((view) => this.syncLuaOne(id, view, force)))
    // Components gone since
    const alive = new Set(this.components.value.map((view) => view.id))
    for (const key of this.luaKeys.keys()) if (!alive.has(key)) this.luaKeys.delete(key)
  }

  private syncLuaOne(entityId: string, view: ComponentView, force: boolean): Promise<void> {
    const script = typeof view.values.scriptUUID === "string" ? view.values.scriptUUID : ""
    if (script === "") {
      this.luaKeys.delete(view.id)
      this.setLua(view.id, null, null)
      return Promise.resolve()
    }
    const running = this.luaReads.get(view.id)
    if (running && running.script === script && !force) return running.promise
    if (!force && this.luaKeys.get(view.id) === script) return Promise.resolve()
    this.luaKeys.set(view.id, script)
    const current = () => this.entityId.value === entityId && this.luaKeys.get(view.id) === script
    const read = { script, promise: Promise.resolve() }
    read.promise = (async () => {
      await Promise.resolve() // so a read that fails at once is still registered before it is dropped
      try {
        const schema = await this.engine.getLuaFields(entityId, view.id)
        if (current()) this.setLua(view.id, schema, null)
      } catch (e) {
        if (current()) {
          this.setLua(view.id, null, messageOf(e))
          // So the next read of the object asks again
          this.luaKeys.delete(view.id)
        }
      } finally {
        if (this.luaReads.get(view.id) === read) this.luaReads.delete(view.id)
      }
    })()
    this.luaReads.set(view.id, read)
    return read.promise
  }

  private setLua(componentId: string, schema: ComponentSchema | null, problem: string | null): void {
    batch(() => {
      const schemas = new Map(this.luaSchemas.value)
      if (schema) schemas.set(componentId, schema)
      else schemas.delete(componentId)
      this.luaSchemas.value = schemas
      const problems = new Map(this.luaProblems.value)
      if (problem) problems.set(componentId, problem)
      else problems.delete(componentId)
      this.luaProblems.value = problems
    })
  }

  /** A script changed (assetsChanged): asks again what its LuaComponents' fields are */
  async refreshLuaFields(): Promise<void> {
    await this.syncLua(true)
  }

  // ==================== Editing a component ====================

  /**
   * A drag of a slider starts: every edit until endGesture is one undo step named label. The edits wait for the group
   * to be open (the host numbers them after it). A second begin while one is in progress does nothing.
   */
  beginGesture(label: string): void {
    if (!this.options.groups || this.gesture) return
    this.gesture = this.options.groups.begin(label)
  }

  /**
   * The drag ended (pointer up, cancelled, or the window lost the focus): sends what is pending, so the last value is
   * in the step, and ends the group. Does nothing when no gesture is in progress, so it can be called for every
   * way a drag can end.
   */
  async endGesture(): Promise<void> {
    const gesture = this.gesture
    if (!gesture) return
    try {
      await this.flush()
    } finally {
      this.gesture = null
      if (await gesture) await this.options.groups?.end()
    }
  }

  private requireEditable(): void {
    const reason = this.readOnlyReason.value
    if (reason !== null) throw new Error(`The inspector is read-only: ${reason}`)
  }

  private setOverlay(componentId: string, overlay: Overlay | null): void {
    const next = new Map(this.overlays.value)
    if (overlay === null || (overlay.inflight === null && isEmpty(overlay.pending))) next.delete(componentId)
    else next.set(componentId, overlay)
    this.overlays.value = next
  }

  private setError(key: string, message: string | null): void {
    if ((message === null) === !this.errors.value.has(key)) return
    const next = new Map(this.errors.value)
    if (message === null) next.delete(key)
    else next.set(key, message)
    this.errors.value = next
  }

  /**
   * Edits fields of a component: patch is a partial of its values (see fieldPatch). It is shown at once, and sent
   * after the debounce delay (at once with immediate), merged with the edits made meanwhile. Throws when the inspector
   * is read-only. A refusal by the host isn't thrown: it is in errors, and the fields are put back.
   */
  edit(componentId: string, patch: JsonObject, options: { immediate?: boolean } = {}): void {
    this.requireEditable()
    if (!this.components.value.some((view) => view.id === componentId)) return
    batch(() => {
      const overlay = this.overlays.value.get(componentId) ?? { inflight: null, pending: {} }
      this.setOverlay(componentId, { inflight: overlay.inflight, pending: mergePatch(overlay.pending, patch) })
      this.setError(componentId, null)
    })
    this.cancelTimer(componentId)
    if (options.immediate) void this.send(componentId)
    else this.timers.set(componentId, this.timer.set(() => void this.send(componentId), this.debounceMs))
  }

  /** Sends everything pending, and resolves when it and what was already on its way has been answered */
  async flush(): Promise<void> {
    for (const [componentId, overlay] of this.overlays.value) {
      if (!isEmpty(overlay.pending)) {
        this.cancelTimer(componentId)
        void this.send(componentId)
      }
    }
    // An answer can leave more pending (edits made while it was on its way): send() drains those too
    while (this.sending.size > 0) await Promise.all([...this.sending.values()])
  }

  private cancelTimer(componentId: string): void {
    const handle = this.timers.get(componentId)
    if (handle !== undefined) {
      this.timer.clear(handle)
      this.timers.delete(componentId)
    }
  }

  private cancelTimers(): void {
    for (const handle of this.timers.values()) this.timer.clear(handle)
    this.timers.clear()
  }

  /** One request at a time per component: edits made while one is on its way wait, and go as the next */
  private send(componentId: string): Promise<void> {
    this.timers.delete(componentId)
    const running = this.sending.get(componentId)
    if (running) return running
    const run = this.drain(componentId)
      .catch((e) => this.options.onError?.("Failed to set the component's fields", e))
      .finally(() => this.sending.delete(componentId))
    this.sending.set(componentId, run)
    return run
  }

  private async drain(componentId: string): Promise<void> {
    // A drag's group is opened before its first edit is sent
    if (this.gesture) await this.gesture
    for (;;) {
      const entityId = this.entityId.value
      const overlay = this.overlays.value.get(componentId)
      const view = this.components.value.find((component) => component.id === componentId)
      if (entityId === null || !view || !overlay || isEmpty(overlay.pending)) return

      const plan = planRequests(view.values, overlay.pending)
      if (plan.requests.length === 0) {
        // Set back to what it was: nothing to send
        this.setOverlay(componentId, { inflight: null, pending: {} })
        return
      }
      this.setOverlay(componentId, { inflight: null, pending: {} })
      for (const request of plan.requests) {
        if (!(await this.sendOne(entityId, componentId, request))) break
      }
    }
  }

  /** Sends one request; true when the host took it */
  private async sendOne(entityId: string, componentId: string, request: JsonObject): Promise<boolean> {
    const pending = this.overlays.value.get(componentId)?.pending ?? {}
    this.setOverlay(componentId, { inflight: request, pending })
    let stored: unknown
    try {
      stored = await this.engine.setComponentFields(entityId, componentId, request)
    } catch (e) {
      if (this.removing.has(componentId)) return false
      const current = this.entityId.value === entityId
      if (current) {
        batch(() => {
          // All or nothing: the fields of the request go back to what the host has
          const overlay = this.overlays.value.get(componentId)
          if (overlay) this.setOverlay(componentId, { inflight: null, pending: overlay.pending })
          this.setError(componentId, messageOf(e))
        })
      } else {
        this.options.onError?.("Failed to set the component's fields", e)
      }
      return false
    }
    if (this.entityId.value !== entityId) return true
    batch(() => {
      this.versions.set(componentId, (this.versions.get(componentId) ?? 0) + 1)
      this.components.value = this.components.value.map((view) =>
        view.id === componentId
          ? { ...view, values: isObject(stored) ? stored : applyPatch(view.values, request) }
          : view
      )
      const overlay = this.overlays.value.get(componentId)
      if (overlay) this.setOverlay(componentId, { inflight: null, pending: overlay.pending })
    })
    // Another script has other fields
    if ("scriptUUID" in request) await this.syncLua(false)
    return true
  }

  // ==================== Adding and removing components ====================

  /** Adds a component of a listed type with its default values */
  async addComponent(typeName: string): Promise<void> {
    this.requireEditable()
    const entityId = this.entityId.value
    if (entityId === null) throw new Error("No object is selected")
    const type = this.types.value?.find((schema) => schema.typeName === typeName)
    if (type?.singleton && this.presentTypes.value.has(typeName)) {
      throw new Error(`An object can have only one ${typeName}`)
    }
    const added = await this.engine.addComponent(entityId, typeName)
    if (this.entityId.value !== entityId) return
    batch(() => {
      // The scene's change event reads the object again; until then this one is shown
      if (!this.components.value.some((view) => view.id === added.componentId)) {
        this.components.value = [
          ...this.components.value,
          { id: added.componentId, type: typeName, values: isObject(added.values) ? added.values : {} },
        ]
      }
    })
    await this.syncLua(false)
  }

  /**
   * Removes a component after asking; resolves false when the user said no. The host clears every reference to it in
   * the scene (and Undo puts them back).
   */
  async removeComponent(componentId: string): Promise<boolean> {
    this.requireEditable()
    const entityId = this.entityId.value
    const view = this.components.value.find((component) => component.id === componentId)
    if (entityId === null || !view) return false
    if (!(await this.options.confirm(`Remove ${view.type}?`, "Remove"))) return false
    // What was edited is gone with it: not sent, and a request already on its way may be refused (the component is
    // going): that isn't shown
    this.removing.add(componentId)
    try {
      this.cancelTimer(componentId)
      this.setOverlay(componentId, null)
      await this.sending.get(componentId)
      try {
        await this.engine.removeComponent(entityId, componentId)
      } finally {
        // Whatever happened, what the host has is the truth
        await this.refresh()
      }
    } finally {
      this.removing.delete(componentId)
    }
    return true
  }

  // ==================== The object's own properties ====================

  /**
   * Changes the object's name, active flag, tag or layer (SetEntityProperties). Shown at once; a refusal puts it back
   * and is in errors under EntityKey.
   */
  async setEntityProperties(properties: Partial<Pick<EntityHeader, "name" | "active" | "tag" | "layer">>): Promise<void> {
    this.requireEditable()
    const entityId = this.entityId.value
    const previous = this.header.value
    if (entityId === null || !previous) return
    const edits = ++this.headerEdits
    batch(() => {
      this.header.value = { ...previous, ...properties }
      this.setError(EntityKey, null)
    })
    try {
      await this.engine.setEntityProperties(entityId, properties)
    } catch (e) {
      if (this.entityId.value === entityId) {
        batch(() => {
          // Unless something newer replaced it meanwhile
          if (edits === this.headerEdits) this.header.value = previous
          this.setError(EntityKey, messageOf(e))
        })
      } else {
        this.options.onError?.("Failed to change the object", e)
      }
    }
  }

  // ==================== References ====================

  /** The components of an object, for a component reference's picker; remembers them for the labels */
  async componentsOf(entityId: string): Promise<Array<{ id: string; type: string }>> {
    if (entityId === this.entityId.value) {
      return this.components.value.map((view) => ({ id: view.id, type: view.type }))
    }
    const data = await this.engine.getEntity(entityId)
    const list = data.entity.components.map((component) => ({ id: component.uuid, type: component.type }))
    const known = new Map(this.known.value)
    for (const component of list) known.set(component.id, { type: component.type, entityId })
    this.known.value = known
    this.scanned.add(entityId)
    return list
  }

  /** How many objects are read at most to find what a component reference points at */
  static readonly MaxResolveReads = 64

  /**
   * Finds which object a component UUID belongs to, reading the candidate objects (those whose component types could
   * hold it) one by one until it is found, at most MaxResolveReads of them; each is read once. Resolves with whether it
   * is known now. A component reference's label shows "Object > Type" once it is.
   */
  async resolveComponent(uuid: string, candidates: readonly string[]): Promise<boolean> {
    let reads = 0
    for (const entityId of candidates) {
      if (this.componentInfo(uuid)) return true
      if (entityId === this.entityId.value || this.scanned.has(entityId)) continue
      if (++reads > InspectorState.MaxResolveReads) break
      try {
        await this.componentsOf(entityId)
      } catch {
        this.scanned.add(entityId) // gone or unreadable: not asked again
      }
    }
    return this.componentInfo(uuid) !== undefined
  }
}
