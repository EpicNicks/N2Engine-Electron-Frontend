// The fake host's write side (MCP2): installWrites(host) gives a FakeHost a small editable world that behaves like the real
// one where the bridge depends on it: edit groups (one undo step per group), Undo and Redo (refused while a group is open),
// a history with a cursor, revisions and a saved revision, scenes that are opened, created and saved (which clears the
// history), project settings merged by a patch, and text assets with the host's refusals (editor/, extensions).
// Everything a command does to the world happens only after its checks pass, so a refusal changes nothing.
import type { ComponentSchema, HierarchyNode } from "../../src/protocol/protocol.generated"
import { FakeHost, LightType, Refusal, UserDataRoot, ProjectRoot, entityData } from "./fake-host"

type EntityRecord = ReturnType<typeof entityData>

interface Snapshot {
  nodes: HierarchyNode[]
  entities: Array<[string, EntityRecord]>
}

interface Step {
  label: string
  before: Snapshot
  after: Snapshot
}

interface SceneFile {
  name: string
  world: Snapshot
}

const TextExtensions = [".lua", ".json", ".txt", ".md", ".csv", ".xml", ".yaml", ".toml", ".ini", ".glsl", ".mat"]

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const Presets: Record<string, { name: string; components: string[]; light?: string }> = {
  "": { name: "GameObject", components: [] },
  Empty: { name: "GameObject", components: [] },
  Cube: { name: "Cube", components: ["CubeRenderer"] },
  Sphere: { name: "Sphere", components: ["SphereRenderer"] },
  Quad: { name: "Quad", components: ["QuadRenderer"] },
  Light: { name: "Light", components: ["Light"] },
  DirectionalLight: { name: "Directional Light", components: ["Light"] },
  PointLight: { name: "Point Light", components: ["Light"] },
  SpotLight: { name: "Spot Light", components: ["Light"] },
}

export class FakeWorld {
  steps: Step[] = []
  cursor = 0
  depth = 0
  private groupLabel = ""
  private groupBefore: Snapshot | null = null
  private groupChanged = false
  revision = 1
  savedRevision = 1
  scenePath = "res://scenes/Main.scene"
  sceneName = "Main"
  scenes = new Map<string, SceneFile>()
  settings: Record<string, unknown> = { window: { title: "Demo" } }
  counter = 100
  /** Commands that changed the world, by name: to see that a refused call changed nothing */
  mutations: string[] = []

  constructor(readonly host: FakeHost) {}

  nextId(): string {
    return uuid(++this.counter)
  }

  snap(): Snapshot {
    return structuredClone({ nodes: this.host.nodes, entities: [...this.host.entities.entries()] })
  }

  restore(s: Snapshot): void {
    const copy = structuredClone(s)
    this.host.nodes = copy.nodes
    this.host.entities = new Map(copy.entities)
  }

  /** Runs a change as one step (or as part of the open group) */
  mutate<T>(command: string, label: string, fn: () => T): T {
    if (this.depth > 0) {
      const result = fn()
      this.groupChanged = true
      this.revision++
      this.mutations.push(command)
      return result
    }
    const before = this.snap()
    const result = fn()
    this.revision++
    this.mutations.push(command)
    this.pushStep({ label, before, after: this.snap() })
    return result
  }

  private pushStep(step: Step): void {
    this.steps.length = this.cursor
    this.steps.push(step)
    this.cursor = this.steps.length
  }

  begin(label: string): void {
    if (this.depth === 0) {
      this.groupLabel = label
      this.groupBefore = this.snap()
      this.groupChanged = false
    }
    this.depth++
  }

  end(): void {
    if (this.depth === 0) throw new Refusal("No edit group is open")
    this.depth--
    if (this.depth === 0 && this.groupChanged && this.groupBefore) {
      this.pushStep({ label: this.groupLabel, before: this.groupBefore, after: this.snap() })
      this.groupBefore = null
    }
  }

  /** A person edits the scene in the editor: one more step, with the human's own label */
  humanEdit(label: string, fn: () => void): void {
    this.mutate("humanEdit", label, fn)
  }

  clearHistory(): void {
    this.steps = []
    this.cursor = 0
    this.depth = 0
    this.groupBefore = null
  }

  dirty(): boolean {
    return this.revision !== this.savedRevision
  }
}

function descendants(nodes: HierarchyNode[], id: string): Set<string> {
  const out = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const n of nodes) {
      if (n.parentId !== "" && out.has(n.parentId) && !out.has(n.id)) {
        out.add(n.id)
        grew = true
      }
    }
  }
  return out
}

function reindex(nodes: HierarchyNode[]): void {
  const byParent = new Map<string, HierarchyNode[]>()
  for (const n of nodes) {
    const list = byParent.get(n.parentId) ?? []
    list.push(n)
    byParent.set(n.parentId, list)
  }
  for (const list of byParent.values()) list.sort((a, b) => a.index - b.index).forEach((n, i) => (n.index = i))
}

function typeOf(host: FakeHost, name: string): ComponentSchema {
  const t = host.componentTypes.find((x) => x.typeName === name)
  if (!t) throw new Refusal(`Unknown component type '${name}'`)
  return t
}

/** Makes host's world editable; returns the world to look at and to change from a test */
export function installWrites(host: FakeHost, role: string = "editor"): FakeWorld {
  const world = new FakeWorld(host)
  host.entities.clear()
  host.componentTypes = [LightType, { typeName: "LuaComponent", singleton: false, fields: [{ name: "scriptUUID", displayName: "Script", kind: "AssetRef", typeName: "uuid", hidden: false, readOnly: false, assetType: "LuaScript" }] }]
  world.scenes.set("res://scenes/Main.scene", { name: "Main", world: world.snap() })
  world.scenes.set("res://scenes/Level1.scene", { name: "Level1", world: { nodes: [], entities: [] } })
  const h = (name: string, fn: (r: any) => unknown): void => host.on(name, fn)

  const node = (id: string): HierarchyNode => {
    const n = host.nodes.find((x) => x.id === id)
    if (!n) throw new Refusal("No such object")
    return n
  }
  const entity = (id: string): EntityRecord => {
    const e = host.entities.get(id)
    if (!e) {
      // The seed hierarchy has nodes with no entity record: make one on demand
      const n = node(id)
      const made = entityData(id, n.parentId, n.name, [])
      host.entities.set(id, made)
      return made
    }
    return e
  }

  h("GetOpenScene", () => ({ path: world.scenePath, name: world.sceneName, uuid: "33333333-0000-0000-0000-000000000000", revision: world.revision, savedRevision: world.savedRevision }))
  h("GetHierarchy", () => ({ revision: world.revision, nodes: host.nodes }))
  h("GetEntity", (r) => {
    const n = node(r.entityId)
    const e = entity(r.entityId)
    e.entity.header = { ...e.entity.header, parentId: n.parentId, index: n.index, name: n.name, active: n.active, layer: n.layer, tag: n.tag }
    return e
  })
  h("GetHistory", () => ({ cursor: world.cursor, entries: world.steps.map((s) => ({ label: s.label, bytes: 10 })) }))
  h("BeginEditGroup", (r) => world.begin(r.label))
  h("EndEditGroup", () => world.end())
  const move = (dir: "undo" | "redo") => () => {
    if (world.depth > 0) throw new Refusal(`Cannot ${dir} while an edit group is open`)
    if (dir === "undo" ? world.cursor === 0 : world.cursor === world.steps.length) throw new Refusal(`Nothing to ${dir}`)
    const step = dir === "undo" ? world.steps[--world.cursor] : world.steps[world.cursor++]
    world.restore(dir === "undo" ? step.before : step.after)
    world.revision++
    return { label: step.label, revision: world.revision, canUndo: world.cursor > 0, canRedo: world.cursor < world.steps.length, savedRevision: world.savedRevision }
  }
  h("Undo", move("undo"))
  h("Redo", move("redo"))

  h("CreateEntityEx", (r) => {
    const preset = Presets[r.preset]
    if (!preset) throw new Refusal(`Unknown preset '${r.preset}'`)
    if (r.parentId !== "") node(r.parentId)
    return world.mutate("CreateEntityEx", "Create Object", () => {
      const id = world.nextId()
      const siblings = host.nodes.filter((n) => n.parentId === r.parentId)
      const index = r.siblingIndex < 0 || r.siblingIndex > siblings.length ? siblings.length : r.siblingIndex
      for (const s of siblings) if (s.index >= index) s.index++
      const name = r.name === "" ? preset.name : r.name
      host.nodes.push({ id, parentId: r.parentId, index, name, active: true, activeInHierarchy: true, layer: 0, tag: "", components: [...preset.components] })
      host.entities.set(id, entityData(id, r.parentId, name, preset.components.map((type) => ({ type, uuid: world.nextId(), values: type === "Light" ? { intensity: 1 } : {} }))))
      host.entities.get(id)!.entity.transform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }
      return { entityId: id }
    })
  })
  h("DestroyEntity", (r) => {
    node(r.entityId)
    world.mutate("DestroyEntity", "Delete Object", () => {
      const gone = descendants(host.nodes, r.entityId)
      host.nodes = host.nodes.filter((n) => !gone.has(n.id))
      for (const id of gone) host.entities.delete(id)
      reindex(host.nodes)
    })
  })
  h("SetLocalTransform", (r) => {
    const e = entity(r.entityId)
    const q = r.rotation
    if (!(Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 1e-3)) throw new Refusal("The rotation must be a unit quaternion")
    world.mutate("SetLocalTransform", "Move Object", () => {
      e.entity.transform = { position: r.position, rotation: r.rotation, scale: r.scale }
    })
  })
  h("SetEntityParent", (r) => {
    const n = node(r.entityId)
    if (r.parentId !== "") {
      node(r.parentId)
      if (descendants(host.nodes, r.entityId).has(r.parentId)) throw new Refusal("An object can't become its own descendant's child")
    }
    world.mutate("SetEntityParent", "Reparent Object", () => {
      n.parentId = r.parentId
      const siblings = host.nodes.filter((x) => x.parentId === r.parentId && x.id !== n.id)
      n.index = r.siblingIndex < 0 || r.siblingIndex > siblings.length ? siblings.length : r.siblingIndex
      for (const s of siblings) if (s.index >= n.index) s.index++
      reindex(host.nodes)
    })
  })
  h("SetEntityProperties", (r) => {
    const n = node(r.entityId)
    const p = r.properties as Record<string, unknown>
    world.mutate("SetEntityProperties", "Edit Object", () => {
      if (typeof p.name === "string") n.name = p.name
      if (typeof p.active === "boolean") {
        n.active = p.active
        n.activeInHierarchy = p.active
      }
      if (typeof p.tag === "string") n.tag = p.tag
      if (typeof p.layer === "number") n.layer = p.layer
    })
  })
  h("DuplicateEntity", (r) => {
    node(r.entityId)
    return world.mutate("DuplicateEntity", "Duplicate Object", () => {
      const ids = descendants(host.nodes, r.entityId)
      const map = new Map<string, string>()
      for (const id of ids) map.set(id, world.nextId())
      const copies: HierarchyNode[] = []
      for (const n of host.nodes.filter((x) => ids.has(x.id))) {
        const copy = { ...n, id: map.get(n.id)!, parentId: n.id === r.entityId ? n.parentId : map.get(n.parentId)!, name: n.id === r.entityId ? `${n.name} (1)` : n.name, index: n.id === r.entityId ? n.index + 1 : n.index }
        copies.push(copy)
        host.entities.set(copy.id, structuredClone(entity(n.id)))
      }
      for (const s of host.nodes.filter((x) => x.parentId === host.nodes.find((y) => y.id === r.entityId)!.parentId && x.index > host.nodes.find((y) => y.id === r.entityId)!.index)) s.index++
      host.nodes.push(...copies)
      reindex(host.nodes)
      return { entityId: map.get(r.entityId)! }
    })
  })
  h("AddComponent", (r) => {
    const type = typeOf(host, r.typeName)
    const e = entity(r.entityId)
    return world.mutate("AddComponent", "Add Component", () => {
      const componentId = world.nextId()
      const values = { ...((type.defaults as object | undefined) ?? {}) }
      e.entity.components.push({ type: type.typeName, uuid: componentId, values })
      node(r.entityId).components.push(type.typeName)
      return { componentId, values }
    })
  })
  h("RemoveComponent", (r) => {
    const e = entity(r.entityId)
    const at = e.entity.components.findIndex((c: { uuid: string }) => c.uuid === r.componentId)
    if (at < 0) throw new Refusal("No such component")
    world.mutate("RemoveComponent", "Remove Component", () => {
      const [gone] = e.entity.components.splice(at, 1)
      const n = node(r.entityId)
      const i = n.components.indexOf((gone as { type: string }).type)
      if (i >= 0) n.components.splice(i, 1)
    })
  })
  h("SetComponentFields", (r) => {
    const e = entity(r.entityId)
    const c = e.entity.components.find((x: { uuid: string }) => x.uuid === r.componentId) as { type: string; values: Record<string, unknown> } | undefined
    if (!c) throw new Refusal("No such component")
    const type = typeOf(host, c.type)
    const next = { ...c.values }
    for (const [key, value] of Object.entries(r.values as Record<string, unknown>)) {
      const field = type.fields.find((f) => f.name === key)
      if (!field) throw new Refusal(`Component ${c.type} has no field '${key}'`)
      if (field.readOnly) throw new Refusal(`Field '${key}' is read-only`)
      if (field.kind === "Float") {
        if (typeof value !== "number") throw new Refusal(`Field '${key}' needs a number`)
        next[key] = Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, value))
      } else next[key] = value
    }
    world.mutate("SetComponentFields", "Edit Component", () => {
      c.values = next
    })
    return { values: next }
  })

  // ----- files -----
  const checkTextPath = (path: string): void => {
    if (!path.startsWith("res://")) throw new Refusal("The path must start with res://")
    const rest = path.slice("res://".length)
    if (rest.split("/").some((s) => s === ".." || s === "." || s === "")) throw new Refusal("Bad path")
    if (/^(assets\/)?editor(\/|$)/i.test(rest)) throw new Refusal("Editor extensions can't be written")
    if (!TextExtensions.some((e) => rest.toLowerCase().endsWith(e))) throw new Refusal("Not a text asset extension")
  }
  h("WriteTextAsset", (r) => {
    checkTextPath(r.path)
    if (Buffer.byteLength(r.text) > 4 * 1024 * 1024) throw new Refusal("Too large")
    host.texts.set(r.path, r.text)
    world.mutations.push("WriteTextAsset")
    if (!host.assets.some((a) => a.path === r.path)) host.assets.push({ path: r.path, uuid: world.nextId(), type: r.path.endsWith(".lua") ? "LuaScript" : "Text", size: r.text.length, modified: 1700000002000 })
  })
  h("CreateScriptAsset", (r) => {
    checkTextPath(r.path)
    if (!r.path.endsWith(".lua")) throw new Refusal("A script ends in .lua")
    if (host.texts.has(r.path) || host.assets.some((a) => a.path === r.path)) throw new Refusal("That file already exists")
    host.texts.set(r.path, `-- ${r.className}\nlocal ${r.className} = {}\nreturn ${r.className}\n`)
    world.mutations.push("CreateScriptAsset")
    const id = world.nextId()
    host.assets.push({ path: r.path, uuid: id, type: "LuaScript", size: 40, modified: 1700000002000 })
    return { path: r.path, uuid: id }
  })

  // ----- scenes and settings -----
  h("OpenScene", (r) => {
    const file = world.scenes.get(r.path)
    if (!file) throw new Refusal("No such scene file")
    world.restore(file.world)
    world.scenePath = r.path
    world.sceneName = file.name
    world.revision = 1
    world.savedRevision = 1
    world.clearHistory()
    world.mutations.push("OpenScene")
    return { path: world.scenePath, name: world.sceneName, uuid: "33333333-0000-0000-0000-000000000000", revision: 1, savedRevision: 1 }
  })
  h("NewScene", (r) => {
    if (r.path !== "" && world.scenes.has(r.path)) throw new Refusal("That scene file already exists")
    world.restore({ nodes: [], entities: [] })
    world.scenePath = r.path
    world.sceneName = r.name
    world.revision = 1
    world.savedRevision = 1
    world.clearHistory()
    if (r.path !== "") world.scenes.set(r.path, { name: r.name, world: world.snap() })
    world.mutations.push("NewScene")
    return { path: world.scenePath, name: world.sceneName, uuid: "33333333-0000-0000-0000-000000000000", revision: 1, savedRevision: 1 }
  })
  h("SaveSceneToFile", (r) => {
    const path = r.path === "" ? world.scenePath : r.path
    if (path === "") throw new Refusal("The scene has no file: give a path")
    world.scenes.set(path, { name: world.sceneName, world: world.snap() })
    world.scenePath = path
    world.savedRevision = world.revision
    world.mutations.push("SaveSceneToFile")
    return { path: world.scenePath, name: world.sceneName, uuid: "33333333-0000-0000-0000-000000000000", revision: world.revision, savedRevision: world.savedRevision }
  })
  const projectInfo = () => ({
    rootPath: ProjectRoot,
    userDataPath: UserDataRoot,
    project: { formatVersion: 1, name: host.projectName, projectId: "22222222-0000-0000-0000-000000000000", engineVersion: "0.9.0", startupScene: "res://scenes/Main.scene", scenes: [...world.scenes.keys()], settings: world.settings },
  })
  h("GetProjectInfo", projectInfo)
  const merge = (target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...target }
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete out[k]
      else if (typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] !== null) out[k] = merge(out[k] as Record<string, unknown>, v as Record<string, unknown>)
      else out[k] = v
    }
    return out
  }
  h("SetProjectSettings", (r) => {
    const patch = r.settings as Record<string, unknown>
    if ("determinism" in patch && role !== "admin") throw new Refusal("The determinism settings need the admin role", "forbidden")
    world.settings = merge(world.settings, patch)
    world.mutations.push("SetProjectSettings")
    return projectInfo()
  })
  return world
}
