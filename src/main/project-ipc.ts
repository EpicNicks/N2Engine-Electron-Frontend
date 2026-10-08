// Project dialogs, recent projects, the project's host process and the open project's files, for the page
// (Channels.project* and Channels.host*). Opening, creating and closing go through ProjectSession, which launches
// and stops the host.
import { BrowserWindow, IpcMain, dialog } from "electron"
import { Channels, HostLocation } from "../shared/api"
import { EditorPage, handleResult } from "./ipc"
import { HostSettings } from "./host-settings"
import { ProjectFiles } from "./project-files"
import { ProjectSession } from "./project-session"
import { RecentProjects } from "./recent-projects"

export interface ProjectIpcDeps {
  getWindow: () => BrowserWindow | null
  page: EditorPage
  files: ProjectFiles
  recent: RecentProjects
  settings: HostSettings
  session: ProjectSession
}

export function registerProjectIpc(ipcMain: IpcMain, deps: ProjectIpcDeps): void {
  const { getWindow, page, files, recent, settings, session } = deps
  const handle = (channel: string, handler: (...args: unknown[]) => unknown): void =>
    handleResult(ipcMain, channel, page, handler)

  handle(Channels.projectOpenDialog, async () => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"], title: "Open Project Folder" })
    if (result.canceled || result.filePaths.length === 0) return null
    return session.openProject(result.filePaths[0])
  })

  handle(Channels.projectCreateDialog, async () => {
    const window = getWindow()
    if (!window) return null
    // Fail before the dialog when the host isn't set
    settings.require()
    const result = await dialog.showSaveDialog(window, {
      title: "Create New Project",
      buttonLabel: "Create Project",
      properties: ["createDirectory", "showOverwriteConfirmation"],
    })
    if (result.canceled || !result.filePath) return null
    // Whether the folder may already exist is up to N2EditorHost --create
    return session.createProject(result.filePath)
  })

  handle(Channels.projectOpenRecent, (projectPath) => {
    if (typeof projectPath !== "string" || !recent.includes(projectPath)) {
      throw new Error("Not a recent project")
    }
    return session.openProject(projectPath)
  })

  handle(Channels.projectGetRecent, () => recent.list())
  handle(Channels.projectRemoveRecent, (projectPath) => {
    if (typeof projectPath !== "string") throw new Error("Not a recent project")
    recent.remove(projectPath)
  })
  handle(Channels.projectClose, () => session.closeProject())

  handle(Channels.projectListFiles, () => files.listFiles())
  handle(Channels.projectReadTextFile, (filePath) => files.readTextFile(filePath as string))
  handle(Channels.projectWriteTextFile, (filePath, text) => files.writeTextFile(filePath as string, text as string))
  handle(Channels.projectCreateDirectory, (dirPath) => files.createDirectory(dirPath as string))
  handle(Channels.projectDeleteFile, (filePath) => files.deleteFile(filePath as string))

  handle(Channels.hostGetState, () => session.state)
  handle(Channels.hostRestart, () => session.restartHost())
  handle(Channels.hostStop, () => session.stopHost())
  handle(Channels.hostLocation, (): HostLocation => settings.locate())
  handle(Channels.hostLocate, async (): Promise<HostLocation | null> => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: "Locate N2EditorHost",
      properties: ["openFile"],
      filters:
        process.platform === "win32"
          ? [
              { name: "Programs", extensions: ["exe"] },
              { name: "All files", extensions: ["*"] },
            ]
          : [],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    settings.setHostPath(result.filePaths[0])
    return settings.locate()
  })
}
