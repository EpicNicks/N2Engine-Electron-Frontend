// Project dialogs, recent projects and the open project's files, for the page (Channels.project*)
import { BrowserWindow, IpcMain, dialog } from "electron"
import * as fs from "fs"
import * as path from "path"
import { Channels } from "../shared/api"
import { EditorPage, handleResult } from "./ipc"
import { ProjectFiles } from "./project-files"
import { RecentProjects } from "./recent-projects"

export function registerProjectIpc(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
  page: EditorPage,
  files: ProjectFiles,
  recent: RecentProjects
): void {
  const handle = (channel: string, handler: (...args: unknown[]) => unknown): void =>
    handleResult(ipcMain, channel, page, handler)

  function open(projectPath: string): string {
    const opened = files.open(projectPath)
    recent.add(projectPath)
    return opened
  }

  handle(Channels.projectOpenDialog, async () => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"], title: "Open Project Folder" })
    if (result.canceled || result.filePaths.length === 0) return null
    return open(result.filePaths[0])
  })

  handle(Channels.projectCreateDialog, async () => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showSaveDialog(window, { title: "Create New Project", buttonLabel: "Create Project" })
    if (result.canceled || !result.filePath) return null
    createProject(result.filePath)
    return open(result.filePath)
  })

  handle(Channels.projectOpenRecent, (projectPath) => {
    if (typeof projectPath !== "string" || !recent.includes(projectPath)) {
      throw new Error("Not a recent project")
    }
    return open(projectPath)
  })

  handle(Channels.projectGetRecent, () => recent.list())
  handle(Channels.projectListFiles, () => files.listFiles())
  handle(Channels.projectReadTextFile, (filePath) => files.readTextFile(filePath as string))
  handle(Channels.projectWriteTextFile, (filePath, text) => files.writeTextFile(filePath as string, text as string))
  handle(Channels.projectCreateDirectory, (dirPath) => files.createDirectory(dirPath as string))
  handle(Channels.projectDeleteFile, (filePath) => files.deleteFile(filePath as string))
}

/** The project layout the editor creates: assets/scenes, assets/scripts with a sample script, and project.json */
function createProject(projectPath: string): void {
  fs.mkdirSync(path.join(projectPath, "assets", "scenes"), { recursive: true })
  fs.mkdirSync(path.join(projectPath, "assets", "scripts"), { recursive: true })

  const projectFile = {
    name: path.basename(projectPath),
    version: "1.0.0",
    engine: "N2Engine",
  }
  fs.writeFileSync(path.join(projectPath, "project.json"), JSON.stringify(projectFile, null, 2))

  fs.writeFileSync(
    path.join(projectPath, "assets", "scripts", "main.lua"),
    `-- Main script\n\nfunction OnStart()\n    print("Hello from N2Engine!")\nend\n\nfunction OnUpdate(deltaTime)\n    -- Update logic here\nend\n`
  )
}
