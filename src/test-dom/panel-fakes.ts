// Fakes for the panel tests: a store stub with the signals the Assets and Hierarchy panels read, and fake hosts whose
// engines record every command they receive.
import { computed, signal } from "@preact/signals"
import type { AssetInfo, HierarchyNode, HierarchyResponse, SceneInfoResponse } from "../protocol/protocol.generated"
import type { AssetPreview } from "../protocol/editor-tooling"
import { HostReadOnlyReason } from "../renderer/store"
import type { EditorStore } from "../renderer/store"

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The part of EditorStore the two panels use: its signals are real, its actions record their calls */
export function stubStore(options: { connected?: boolean; scene?: SceneInfoResponse | null } = {}) {
  const connected = signal(options.connected ?? true)
  const scene = signal<SceneInfoResponse | null>(
    options.scene === undefined
      ? { path: "res://scenes/a.scene", name: "a", uuid: "u1", revision: 1, savedRevision: 1 }
      : options.scene
  )
  const playMode = signal<string | null>(null)
  /** The host's Hello answer, as far as the panels read it (protocol 1.17.0 has the editor tooling commands) */
  const serverInfo = signal<{ protocolVersion: string } | null>({ protocolVersion: "1.17.0" })
  const hostReadOnly = signal(false)
  const readOnlyReason = computed<string | null>(() => playMode.value ?? (hostReadOnly.value ? HostReadOnlyReason : null))
  const canWrite = computed(() => readOnlyReason.value === null)
  const sceneLabel = computed(() => scene.value?.name ?? "")
  /** Errors the panels showed (what they were doing: the message) */
  const errors: string[] = []
  /** Calls to the store's own actions */
  const calls: string[] = []
  const members = {
    connected,
    serverInfo,
    scene,
    playMode,
    hostReadOnly,
    readOnlyReason,
    canWrite,
    sceneLabel,
    reportError: (what: string, e: unknown) => void errors.push(`${what}: ${messageOf(e)}`),
    openScene: async (path: string) => void calls.push(`openScene ${path}`),
    newScene: async (path: string) => {
      calls.push(`newScene ${path}`)
      return true
    },
  }
  return { store: members as unknown as EditorStore, signals: members, errors, calls }
}

// ==================== The assets ====================

export const U1 = "11111111-1111-1111-1111-111111111111"
export const U2 = "22222222-2222-2222-2222-222222222222"
export const U3 = "33333333-3333-3333-3333-333333333333"
export const U4 = "44444444-4444-4444-4444-444444444444"

/** A host's project files, with ListAssets, text files, and the commands that make folders and scripts */
export class FakeAssetHost {
  folders = ["res://scenes", "res://scripts"]
  assets: AssetInfo[] = [
    { path: "res://hero.png", uuid: U1, type: "Texture", size: 10, modified: 1 },
    { path: "res://scenes/main.scene", uuid: U2, type: "Scene", size: 20, modified: 1 },
    { path: "res://scripts/a.lua", uuid: U3, type: "LuaScript", size: 5, modified: 1 },
  ]
  files = new Map<string, string>([["res://scripts/a.lua", "print(1)"]])
  /** The commands received, as text */
  calls: string[] = []
  /** GetAssetPreview: the commands received, and what each asset (by path) answers (none: the host refuses) */
  previewCalls: string[] = []
  previews = new Map<string, AssetPreview>()
  /** A refusal the next command of this name throws */
  refuse = new Map<string, string>()

  private gate(name: string): void {
    const message = this.refuse.get(name)
    if (message) throw new Error(message)
  }

  engine = {
    listAssets: async (folder: string, recursive: boolean) => {
      this.calls.push(`listAssets ${folder} ${recursive}`)
      return { folders: [...this.folders], assets: this.assets.map((a) => ({ ...a })) }
    },
    getAssetInfo: async (path: string) => {
      this.calls.push(`getAssetInfo ${path}`)
      const asset = this.assets.find((a) => a.path === path)
      if (!asset) throw new Error(`No asset ${path}`)
      return { ...asset, customData: {}, loaded: false }
    },
    getAssetPreview: async (uuidOrPath: string, maxSize: number) => {
      this.previewCalls.push(`${uuidOrPath} ${maxSize}`)
      const asset = this.assets.find((a) => a.uuid === uuidOrPath || a.path === uuidOrPath)
      const preview = asset && this.previews.get(asset.path)
      if (!preview) throw new Error("No preview")
      return preview
    },
    setImportSettings: async () => {},
    readTextAsset: async (path: string) => {
      this.calls.push(`readTextAsset ${path}`)
      const text = this.files.get(path)
      if (text === undefined) throw new Error(`${path} does not exist`)
      return text
    },
    writeTextAsset: async () => {},
    createScriptAsset: async (path: string, className: string) => {
      this.calls.push(`createScriptAsset ${path} [${className}]`)
      this.gate("createScriptAsset")
      this.files.set(path, "-- template")
      this.assets.push({ path, uuid: U4, type: "LuaScript", size: 11, modified: 2 })
      return { path, uuid: U4 }
    },
    createFolder: async (path: string) => {
      this.calls.push(`createFolder ${path}`)
      this.gate("createFolder")
      this.folders.push(path)
    },
  }
}

// ==================== The scene ====================

interface Obj {
  id: string
  name: string
  active: boolean
  children: Obj[]
}

/** A host's scene given as text, "A(A1,A2(A2a)),B", with the semantics of the hierarchy commands the panel uses */
export class FakeSceneHost {
  roots: Obj[] = []
  revision = 1
  connected = true
  /** The commands received, as text (GetHierarchy is not listed: every action reads it) */
  calls: string[] = []
  private next = 1

  constructor(spec: string) {
    let pos = 0
    const parse = (): Obj[] => {
      const list: Obj[] = []
      while (pos < spec.length && spec[pos] !== ")") {
        let name = ""
        while (pos < spec.length && !"(),".includes(spec[pos])) name += spec[pos++]
        const obj: Obj = { id: "id-" + name, name, active: true, children: [] }
        if (spec[pos] === "(") {
          pos++
          obj.children = parse()
          pos++
        }
        list.push(obj)
        if (spec[pos] === ",") pos++
      }
      return list
    }
    this.roots = parse()
  }

  find(id: string): { obj: Obj; siblings: Obj[] } | null {
    const visit = (siblings: Obj[]): { obj: Obj; siblings: Obj[] } | null => {
      for (const obj of siblings) {
        if (obj.id === id) return { obj, siblings }
        const inner = visit(obj.children)
        if (inner) return inner
      }
      return null
    }
    return visit(this.roots)
  }

  /** The tree as text again */
  text(): string {
    const show = (list: Obj[]): string =>
      list.map((o) => o.name + (o.children.length ? `(${show(o.children)})` : "")).join(",")
    return show(this.roots)
  }

  engine = {
    isConnected: () => this.connected,
    getHierarchy: async (): Promise<HierarchyResponse> => {
      const nodes: HierarchyNode[] = []
      const visit = (list: Obj[], parentId: string) =>
        list.forEach((o, index) => {
          nodes.push({
            id: o.id,
            parentId,
            index,
            name: o.name,
            active: o.active,
            activeInHierarchy: o.active,
            layer: 0,
            tag: "",
            components: [],
          })
          visit(o.children, o.id)
        })
      visit(this.roots, "")
      return { revision: this.revision, nodes }
    },
    createEntityEx: async (name: string, parentId: string, siblingIndex: number, preset: string) => {
      this.calls.push(`createEntityEx ${name}|${parentId}|${siblingIndex}|${preset}`)
      const obj: Obj = { id: "new-" + this.next, name: name || preset || "GameObject", active: true, children: [] }
      this.next++
      const list = parentId === "" ? this.roots : this.find(parentId)!.obj.children
      list.splice(siblingIndex < 0 ? list.length : Math.min(siblingIndex, list.length), 0, obj)
      this.revision++
      return obj.id
    },
    setEntityParent: async (entityId: string, parentId: string, siblingIndex: number, keepWorld: boolean) => {
      this.calls.push(`setEntityParent ${entityId}|${parentId}|${siblingIndex}|${keepWorld}`)
      const found = this.find(entityId)!
      found.siblings.splice(found.siblings.indexOf(found.obj), 1)
      const list = parentId === "" ? this.roots : this.find(parentId)!.obj.children
      list.splice(siblingIndex < 0 ? list.length : Math.min(siblingIndex, list.length), 0, found.obj)
      this.revision++
    },
    setEntityProperties: async (id: string, properties: { name?: string; active?: boolean }) => {
      this.calls.push(`setEntityProperties ${id} ${JSON.stringify(properties)}`)
      const obj = this.find(id)!.obj
      if (properties.name !== undefined) obj.name = properties.name
      if (properties.active !== undefined) obj.active = properties.active
      this.revision++
    },
    duplicateEntity: async (id: string) => {
      this.calls.push(`duplicateEntity ${id}`)
      const found = this.find(id)!
      const copy: Obj = { id: "copy-" + this.next++, name: found.obj.name + " (1)", active: true, children: [] }
      found.siblings.splice(found.siblings.indexOf(found.obj) + 1, 0, copy)
      this.revision++
      return copy.id
    },
    destroyEntity: async (id: string) => {
      this.calls.push(`destroyEntity ${id}`)
      const found = this.find(id)!
      found.siblings.splice(found.siblings.indexOf(found.obj), 1)
      this.revision++
    },
  }
}
