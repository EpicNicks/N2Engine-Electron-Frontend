import { app, BrowserWindow, screen, ipcMain } from "electron"
import * as path from "path"
import { EngineClient } from "../protocol/engine-client"
import { EngineHost } from "./engine-ipc"
import { registerProjectIpc } from "./project-ipc"
import { ProjectFiles } from "./project-files"
import { RecentProjects } from "./recent-projects"

// dist/main/main.js: the repo root is two levels up
const appRoot = path.join(__dirname, "..", "..")

let mainWindow: BrowserWindow | null = null
const getWindow = (): BrowserWindow | null => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)

const engine = new EngineHost(new EngineClient(), () => getWindow()?.webContents ?? null)
engine.register(ipcMain)

registerProjectIpc(
  ipcMain,
  getWindow,
  new ProjectFiles(),
  new RecentProjects(path.join(app.getPath("userData"), "recent-projects.json"))
)

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
      // A bundle (scripts/bundle.js): a sandboxed preload can require only "electron"
      preload: path.join(appRoot, "dist", "bundle", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The page has no Node: the engine connection and the project's files are reached through the typed IPC API
      sandbox: true,
      // The engine's audio starts playing on connect, without waiting for a click
      autoplayPolicy: "no-user-gesture-required",
      // Chromium throttles timers in a hidden or minimized window to about once a second, which would starve the
      // 25 ms GetAudio polling (audio-player.ts) and underrun playback, even while muted or quiet
      backgroundThrottling: false,
    },
    backgroundColor: "#1e1e1e",
  })

  // The page never navigates or opens windows
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))

  mainWindow.on("closed", () => {
    mainWindow = null
    engine.close()
  })

  mainWindow.loadFile(path.join(appRoot, "src", "index.html"))
  mainWindow.webContents.openDevTools()
}

app.whenReady().then(createWindow)

app.on("window-all-closed", () => {
  engine.close()
  app.quit()
})
