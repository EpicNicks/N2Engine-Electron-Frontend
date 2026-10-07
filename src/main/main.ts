import { app, BrowserWindow, screen, ipcMain, session } from "electron"
import * as path from "path"
import { pathToFileURL } from "url"
import { EngineClient } from "../protocol/engine-client"
import { EngineHost } from "./engine-ipc"
import { EditorPage } from "./ipc"
import { registerProjectIpc } from "./project-ipc"
import { ProjectFiles } from "./project-files"
import { RecentProjects } from "./recent-projects"

// The editor host's access token, for a host started with one. Until the editor launches its own host with a token
// it generates, it can be given in N2_EDITOR_TOKEN, the variable the host will read it from once it has --token-env
// (engine #74). Taken out of the environment before any window or child process starts, so none inherits it.
const accessToken = process.env.N2_EDITOR_TOKEN
delete process.env.N2_EDITOR_TOKEN

// dist/main/main.js: the repo root is two levels up
const appRoot = path.join(__dirname, "..", "..")
const pagePath = path.join(appRoot, "src", "index.html")

// DevTools open with the window only when asked for: npm run dev, or N2_EDITOR_DEVTOOLS=1
const openDevTools = process.argv.includes("--devtools") || process.env.N2_EDITOR_DEVTOOLS === "1"

let mainWindow: BrowserWindow | null = null
const getWindow = (): BrowserWindow | null => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)

// Only the editor's own page, in the main frame of its window, may call the IPC API
const page: EditorPage = {
  getEditor: () => getWindow()?.webContents ?? null,
  url: pathToFileURL(pagePath).href,
}

const engine = new EngineHost(new EngineClient(), page, { token: accessToken })
engine.register(ipcMain)

registerProjectIpc(
  ipcMain,
  getWindow,
  page,
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

  // The page never navigates, redirects or opens windows
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault())
  mainWindow.webContents.on("will-redirect", (event) => event.preventDefault())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))

  mainWindow.on("closed", () => {
    mainWindow = null
    engine.close()
  })

  mainWindow.loadFile(pagePath)
  if (openDevTools) {
    mainWindow.webContents.openDevTools()
  }
}

app.whenReady().then(() => {
  // The editor needs no permission (camera, microphone, notifications, ...): refuse every request and check
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  createWindow()
})

app.on("window-all-closed", () => {
  engine.close()
  app.quit()
})
