import { app, BrowserWindow, screen, ipcMain, dialog } from "electron"
import * as path from "path"
import * as fs from "fs"

let mainWindow: BrowserWindow | null = null

// Store for recent projects
const RECENT_PROJECTS_FILE = path.join(app.getPath("userData"), "recent-projects.json")

function getRecentProjects(): string[] {
  try {
    if (fs.existsSync(RECENT_PROJECTS_FILE)) {
      return JSON.parse(fs.readFileSync(RECENT_PROJECTS_FILE, "utf-8"))
    }
  } catch (err) {
    console.error("Error reading recent projects:", err)
  }
  return []
}

function addRecentProject(projectPath: string): void {
  const recent = getRecentProjects().filter((p) => p !== projectPath)
  recent.unshift(projectPath)
  const trimmed = recent.slice(0, 10) // Keep last 10
  fs.writeFileSync(RECENT_PROJECTS_FILE, JSON.stringify(trimmed))
}

function createWindow(): void {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.bounds
  const { width: workW, height: workH } = primaryDisplay.workAreaSize
  const windowWidth = Math.round(workW * 0.8)
  const windowHeight = Math.round(workH * 0.8)

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: Math.round((width - windowWidth) / 2),
    y: Math.round((height - windowHeight) / 2),
    center: true,
    fullscreen: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The engine's audio starts playing on connect, without waiting for a click
      autoplayPolicy: "no-user-gesture-required",
    },
    backgroundColor: "#1e1e1e",
  })

  mainWindow.loadFile("src/index.html")
  mainWindow.webContents.openDevTools()
}

// IPC Handlers
ipcMain.handle("dialog:openProject", async () => {
  if (!mainWindow) return null

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Open Project Folder",
  })

  if (!result.canceled && result.filePaths.length > 0) {
    const projectPath = result.filePaths[0]
    addRecentProject(projectPath)
    return projectPath
  }
  return null
})

ipcMain.handle("dialog:createProject", async () => {
  if (!mainWindow) return null

  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Create New Project",
    buttonLabel: "Create Project",
  })

  if (!result.canceled && result.filePath) {
    const projectPath = result.filePath

    // Create project directory structure with assets folder
    fs.mkdirSync(projectPath, { recursive: true })
    fs.mkdirSync(path.join(projectPath, "assets"), { recursive: true })
    fs.mkdirSync(path.join(projectPath, "assets", "scenes"), { recursive: true })
    fs.mkdirSync(path.join(projectPath, "assets", "scripts"), { recursive: true })

    // Create a basic project file
    const projectFile = {
      name: path.basename(projectPath),
      version: "1.0.0",
      engine: "N2Engine",
    }
    fs.writeFileSync(path.join(projectPath, "project.json"), JSON.stringify(projectFile, null, 2))

    // Create a sample Lua script in assets/scripts
    fs.writeFileSync(
      path.join(projectPath, "assets", "scripts", "main.lua"),
      `-- Main script\n\nfunction OnStart()\n    print("Hello from N2Engine!")\nend\n\nfunction OnUpdate(deltaTime)\n    -- Update logic here\nend\n`
    )

    addRecentProject(projectPath)
    return projectPath
  }
  return null
})

ipcMain.handle("project:getRecent", () => {
  return getRecentProjects()
})

app.whenReady().then(createWindow)

app.on("window-all-closed", () => {
  app.quit()
})
