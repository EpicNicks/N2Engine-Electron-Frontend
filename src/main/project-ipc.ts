// Project dialogs, recent projects, the project's host process and the open project's files, for the page
// (Channels.project* and Channels.host*). Opening, creating and closing go through ProjectSession, which launches
// and stops the host.
import { BrowserWindow, IpcMain, dialog } from "electron"
import * as path from "path"
import { Channels, CreateProjectResult, HostLocation, OpenProjectResult } from "../shared/api"
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

/** A project's name is passed to N2EditorHost --name as one argument; anything sensible fits in this */
const MaxProjectNameLength = 256

export function registerProjectIpc(ipcMain: IpcMain, deps: ProjectIpcDeps): void {
  const { getWindow, page, files, recent, settings, session } = deps
  const handle = (channel: string, handler: (...args: unknown[]) => unknown): void =>
    handleResult(ipcMain, channel, page, handler)

  // The folders the editor itself offered the page: picked with a dialog, or named by an open or create result.
  // The page can open or create a project only in these (or a recent project), never in a folder of its choosing.
  const offered = new Set<string>()
  const offer = <R extends OpenProjectResult | CreateProjectResult>(result: R): R => {
    if (result.kind !== "opened") offered.add(path.resolve(result.path))
    return result
  }
  const requireOffered = (folder: unknown): string => {
    if (typeof folder !== "string" || !(offered.has(path.resolve(folder)) || recent.includes(folder))) {
      throw new Error("Not a folder the editor offered")
    }
    return folder
  }

  /** The host's location, and whether it can create projects (asked with --help, never by starting it) */
  async function location(): Promise<HostLocation> {
    const where = settings.locate()
    let canCreate: boolean | null = null
    if (where.path !== null && where.problem === null) {
      try {
        canCreate = (await session.capabilities(where.path)).create
      } catch (e) {
        console.error("Couldn't ask N2EditorHost what it can do:", e)
      }
    }
    return { ...where, canCreate }
  }

  handle(Channels.projectOpenDialog, async () => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"], title: "Open Project Folder" })
    if (result.canceled || result.filePaths.length === 0) return null
    return offer(await session.openProject(result.filePaths[0]))
  })

  handle(Channels.projectOpenRecent, async (projectPath) => {
    if (typeof projectPath !== "string" || !recent.includes(projectPath)) {
      throw new Error("Not a recent project")
    }
    return offer(await session.openProject(projectPath))
  })

  handle(Channels.projectOpenFolder, async (folder) => offer(await session.openProject(requireOffered(folder))))

  handle(Channels.projectPickNewFolder, async () => {
    const window = getWindow()
    if (!window) return null
    // Fail before the dialog when the host isn't set, or can't create projects
    if ((await location()).canCreate === false) {
      throw new Error("This N2EditorHost can't create projects: it is older than engine #90 (no --create)")
    }
    settings.require()
    const result = await dialog.showSaveDialog(window, {
      title: "New Project Folder",
      buttonLabel: "Create Project",
      properties: ["createDirectory"],
    })
    if (result.canceled || !result.filePath) return null
    // N2EditorHost --create makes the folder if it's missing, and adopts it (keeping its files) if not
    offered.add(path.resolve(result.filePath))
    return result.filePath
  })

  handle(Channels.projectCreate, async (folder, name, adopt) => {
    const projectDir = requireOffered(folder)
    if (typeof name !== "string" || name.length > MaxProjectNameLength || name.includes("\0")) {
      throw new Error("Invalid project name")
    }
    if (typeof adopt !== "boolean") throw new Error("adopt must be a boolean")
    return offer(await session.createProject(projectDir, { name: name.trim(), adopt }))
  })

  handle(Channels.projectGetRecent, () => recent.list())
  handle(Channels.projectRemoveRecent, (projectPath) => {
    if (typeof projectPath !== "string") throw new Error("Not a recent project")
    recent.remove(projectPath)
  })
  handle(Channels.projectClose, () => session.closeProject())

  handle(Channels.hostGetState, () => session.state)
  handle(Channels.hostRestart, () => session.restartHost())
  handle(Channels.hostStop, () => session.stopHost())
  handle(Channels.hostLocation, () => location())
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
    return location()
  })
}
