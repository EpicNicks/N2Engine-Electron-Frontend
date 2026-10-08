// What the editor's existing panels show, as signals: the loaded scene and its entities, the selection and its
// transform, the project's file tree and the open script tabs. These are today's commands (flat entity list, world
// transforms, scene JSON through the page); the hierarchy, inspector and asset panels are rebuilt on the #6
// protocol in F3, F4 and F6.
import { batch, signal } from "@preact/signals-core"
import type { EngineApi, FileInfo, ProjectApi } from "../shared/api"
import type { EntityInfo, Vec3 } from "../protocol/protocol.generated"
import { basename, join } from "./paths"

export interface Transform {
  position: Vec3
  rotation: Vec3
  scale: Vec3
}

export interface ScriptTab {
  path: string
  text: string
  /** Edited since opened or saved */
  dirty: boolean
}

type Engine = Pick<
  EngineApi,
  | "isConnected"
  | "getCurrentScene"
  | "loadScene"
  | "createScene"
  | "getAllEntities"
  | "createEntity"
  | "destroyEntity"
  | "getEntityTransform"
  | "setEntityTransform"
  | "createScript"
  | "rescanAssets"
>
type Project = Pick<ProjectApi, "listFiles" | "readTextFile" | "writeTextFile" | "createDirectory" | "deleteFile">

export class SceneState {
  /** The engine's current scene's name; null when none is loaded (or not connected) */
  readonly sceneName = signal<string | null>(null)
  readonly entities = signal<readonly EntityInfo[]>([])
  readonly selectedId = signal<string | null>(null)
  /** The selected entity's world transform; null while loading or with nothing selected */
  readonly transform = signal<Transform | null>(null)

  readonly files = signal<readonly FileInfo[]>([])
  readonly collapsed = signal<ReadonlySet<string>>(new Set())

  readonly scripts = signal<readonly ScriptTab[]>([])
  readonly activeScript = signal<string | null>(null)

  constructor(
    private readonly engine: Engine,
    private readonly project: Project
  ) {}

  /** Everything the engine holds is gone (disconnected, or another host) */
  reset(): void {
    batch(() => {
      this.sceneName.value = null
      this.entities.value = []
      this.selectedId.value = null
      this.transform.value = null
    })
  }

  /** Forgets the project too (closed) */
  resetProject(): void {
    batch(() => {
      this.reset()
      this.files.value = []
      this.collapsed.value = new Set()
      this.scripts.value = []
      this.activeScript.value = null
    })
  }

  // ==================== Scene and entities ====================

  async refreshScene(): Promise<void> {
    if (!this.engine.isConnected()) {
      this.reset()
      return
    }
    const sceneData = await this.engine.getCurrentScene()
    let name: string | null = null
    if (sceneData) {
      try {
        name = (JSON.parse(sceneData.sceneJson) as { name?: unknown }).name as string
      } catch {
        // not JSON: still a scene
      }
      name = typeof name === "string" && name !== "" ? name : "Untitled"
    }
    this.sceneName.value = name
    if (name) await this.refreshEntities()
    else this.entities.value = []
  }

  async refreshEntities(): Promise<void> {
    this.entities.value = await this.engine.getAllEntities()
    if (this.selectedId.value && !this.entities.value.some((e) => e.id === this.selectedId.value)) {
      this.select(null)
    }
  }

  async select(entityId: string | null): Promise<void> {
    batch(() => {
      this.selectedId.value = entityId
      this.transform.value = null
    })
    if (!entityId) return
    const transform = await this.engine.getEntityTransform(entityId)
    if (this.selectedId.value === entityId) this.transform.value = transform
  }

  async createEntity(name: string): Promise<void> {
    const id = await this.engine.createEntity(name)
    if (!id) throw new Error("The engine created no entity (is a scene loaded?)")
    await this.refreshEntities()
    await this.select(id)
  }

  async destroySelected(): Promise<void> {
    const id = this.selectedId.value
    if (!id) return
    await this.engine.destroyEntity(id)
    this.select(null)
    await this.refreshEntities()
  }

  /** Shows the new transform at once; if the engine refuses it, the inspector goes back to the one before */
  async setTransform(transform: Transform): Promise<void> {
    const id = this.selectedId.value
    if (!id) return
    const previous = this.transform.value
    this.transform.value = transform
    try {
      await this.engine.setEntityTransform(id, transform.position, transform.rotation, transform.scale)
    } catch (e) {
      // Unless something newer replaced it meanwhile (another edit, or another selection)
      if (this.selectedId.value === id && this.transform.value === transform) this.transform.value = previous
      throw e
    }
  }

  /** Reads a .scene file and loads it into the engine */
  async loadSceneFile(scenePath: string): Promise<void> {
    const sceneJson = await this.project.readTextFile(scenePath)
    await this.engine.loadScene(sceneJson)
    this.select(null)
    await this.refreshScene()
  }

  /** Creates a scene in the engine and writes it to <dir>/scenes/<name>.scene (or <dir> if it is scenes) */
  async createScene(dirPath: string, name: string): Promise<void> {
    const targetDir = basename(dirPath) === "scenes" ? dirPath : join(dirPath, "scenes")
    const sceneData = await this.engine.createScene(name)
    let sceneName = name
    try {
      const parsed = JSON.parse(sceneData.sceneJson) as { name?: unknown }
      if (typeof parsed.name === "string" && parsed.name !== "") sceneName = parsed.name
    } catch {
      // keep the name asked for
    }
    await this.project.createDirectory(targetDir)
    await this.project.writeTextFile(join(targetDir, sceneName + ".scene"), sceneData.sceneJson)
    await this.refreshFiles()
    await this.refreshScene()
  }

  // ==================== Files and scripts ====================

  async refreshFiles(): Promise<void> {
    this.files.value = await this.project.listFiles()
  }

  toggleFolder(folderPath: string): void {
    const collapsed = new Set(this.collapsed.value)
    if (!collapsed.delete(folderPath)) collapsed.add(folderPath)
    this.collapsed.value = collapsed
  }

  /** Writes the engine's script template to <dir>/scripts/<name>.lua (or <dir> if it is scripts) and opens it */
  async createScript(dirPath: string, name: string): Promise<void> {
    const targetDir = basename(dirPath) === "scripts" ? dirPath : join(dirPath, "scripts")
    const scriptPath = join(targetDir, name + ".lua")
    const template = await this.engine.createScript(name)
    await this.project.createDirectory(targetDir)
    await this.project.writeTextFile(scriptPath, template)
    try {
      // The host's ResourceLoader picks the new file up
      await this.engine.rescanAssets()
    } catch (e) {
      // Don't leave a script behind that the host never registered (deleting a missing file is not an error)
      await this.project
        .deleteFile(scriptPath)
        .catch((cleanup) => console.error("Failed to clean up the script:", cleanup))
      throw e
    }
    await this.refreshFiles()
    await this.openScript(scriptPath)
  }

  async openScript(filePath: string): Promise<void> {
    if (!this.scripts.value.some((tab) => tab.path === filePath)) {
      const text = await this.project.readTextFile(filePath)
      this.scripts.value = [...this.scripts.value, { path: filePath, text, dirty: false }]
    }
    this.activeScript.value = filePath
  }

  editScript(filePath: string, text: string): void {
    this.scripts.value = this.scripts.value.map((tab) => (tab.path === filePath ? { ...tab, text, dirty: true } : tab))
  }

  async saveScript(filePath: string): Promise<void> {
    const tab = this.scripts.value.find((t) => t.path === filePath)
    if (!tab) return
    await this.project.writeTextFile(filePath, tab.text)
    this.scripts.value = this.scripts.value.map((t) =>
      t.path === filePath && t.text === tab.text ? { ...t, dirty: false } : t
    )
  }

  closeScript(filePath: string): void {
    const remaining = this.scripts.value.filter((tab) => tab.path !== filePath)
    batch(() => {
      this.scripts.value = remaining
      if (this.activeScript.value === filePath) this.activeScript.value = remaining[0]?.path ?? null
    })
  }
}
