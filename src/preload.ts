import { contextBridge, ipcRenderer } from "electron"
import { EngineClient } from "./engine-client"
import * as fs from "fs"
import * as path from "path"

const client = new EngineClient()

contextBridge.exposeInMainWorld("engine", {
  // Connection
  connect: (host?: string, port?: number) => client.connect(host, port),
  disconnect: () => client.disconnect(),
  isConnected: () => client.isConnected,

  // Rendering
  renderFrame: () => client.renderFrame(),
  setViewportSize: (width: number, height: number) => client.setViewportSize(width, height),

  // Camera
  setCameraPosition: (x: number, y: number, z: number) => client.setCameraPosition(x, y, z),
  getCameraPosition: () => client.getCameraPosition(),

  // Scene management
  createScene: (name: string) => client.createScene(name),
  loadScene: (sceneJson: string) => client.loadScene(sceneJson),
  saveScene: () => client.saveScene(),
  deleteScene: (sceneName: string) => client.deleteScene(sceneName),
  getCurrentScene: () => client.getCurrentScene(),

  createScript: (name: string) => client.createScript(name),
  rescanAssets: () => client.rescanAssets(),

  // Diagnostics
  getEngineHealth: () => client.getEngineHealth(),

  // Entity management
  createEntity: (name: string) => client.createEntity(name),
  destroyEntity: (entityId: string) => client.destroyEntity(entityId),
  getAllEntities: () => client.getAllEntities(),
  setEntityTransform: (id: string, pos: any, rot: any, scale: any) => client.setEntityTransform(id, pos, rot, scale),
  getEntityTransform: (id: string) => client.getEntityTransform(id),
})

interface FileInfo {
  name: string
  path: string
  isDirectory: boolean
  children?: FileInfo[]
}

function readDirectoryRecursive(dirPath: string, depth: number = 0, maxDepth: number = 10): FileInfo[] {
  if (depth > maxDepth) return []

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    return entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => {
        const fullPath = path.join(dirPath, entry.name)
        const info: FileInfo = {
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
        }
        if (entry.isDirectory() && depth < maxDepth) {
          info.children = readDirectoryRecursive(fullPath, depth + 1, maxDepth)
        }
        return info
      })
      .sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return a.name.localeCompare(b.name)
      })
  } catch (err) {
    console.error("Error reading directory:", err)
    return []
  }
}

contextBridge.exposeInMainWorld("fileSystem", {
  // Project management
  openProjectDialog: () => ipcRenderer.invoke("dialog:openProject"),
  createProjectDialog: () => ipcRenderer.invoke("dialog:createProject"),
  getRecentProjects: () => ipcRenderer.invoke("project:getRecent"),

  // File operations
  readDirectory: (dirPath: string) => readDirectoryRecursive(dirPath, 0, 3),
  readFile: (filePath: string) => fs.readFileSync(filePath, "utf-8"),
  writeFile: (filePath: string, content: string) => fs.writeFileSync(filePath, content, "utf-8"),
  createFile: (filePath: string) => fs.writeFileSync(filePath, "", "utf-8"),
  createDirectory: (dirPath: string) => fs.mkdirSync(dirPath, { recursive: true }),
  deleteFile: (filePath: string) => fs.unlinkSync(filePath),
  deleteDirectory: (dirPath: string) => fs.rmSync(dirPath, { recursive: true }),
  rename: (oldPath: string, newPath: string) => fs.renameSync(oldPath, newPath),
  exists: (filePath: string) => fs.existsSync(filePath),
  isDirectory: (filePath: string) => fs.statSync(filePath).isDirectory(),

  // Path utilities
  join: (...paths: string[]) => path.join(...paths),
  dirname: (filePath: string) => path.dirname(filePath),
  basename: (filePath: string) => path.basename(filePath),
  extname: (filePath: string) => path.extname(filePath),
})
