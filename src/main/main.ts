import { app, BrowserWindow, dialog, Menu, screen, ipcMain, session } from "electron"
import * as path from "path"
import { pathToFileURL } from "url"
import { EngineClient } from "../protocol/engine-client"
import { Channels, HostState, PlayState } from "../shared/api"
import { buildAppMenuTemplate } from "./app-menu"
import { EngineHost } from "./engine-ipc"
import { TokenEnvVariable } from "./host-launcher"
import { HostSettings } from "./host-settings"
import { EditorPage } from "./ipc"
import { PlaySession } from "./play-session"
import { registerPlayIpc } from "./play-ipc"
import { registerProjectIpc } from "./project-ipc"
import { ProjectFiles } from "./project-files"
import { ProjectSession } from "./project-session"
import { RecentProjects } from "./recent-projects"

// The editor generates a fresh access token for each host it launches and puts it in that child's environment only
// (host-launcher.ts). A token inherited from whatever started the editor is removed before anything starts, so no
// window or child process inherits it.
delete process.env[TokenEnvVariable]

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

function publishHostState(state: HostState): void {
  const editor = page.getEditor()
  if (editor && !editor.isDestroyed()) editor.send(Channels.hostState, state)
}

function publishPlayState(state: PlayState): void {
  const editor = page.getEditor()
  if (editor && !editor.isDestroyed()) editor.send(Channels.playState, state)
}

const userData = app.getPath("userData")
const files = new ProjectFiles()
const recent = new RecentProjects(path.join(userData, "recent-projects.json"))
const settings = new HostSettings(path.join(userData, "settings.json"))

const engine = new EngineHost(new EngineClient(), page, {
  // A page that (re)loads starts at the welcome screen: no project, no host
  onAttach: () => {
    play.stop().catch((e) => console.error("Failed to stop the game:", e))
    projectSession.reset().catch((e) => console.error("Failed to close the project:", e))
  },
})
engine.register(ipcMain)

const projectSession = new ProjectSession({
  files,
  recent,
  settings,
  engine,
  publish: publishHostState,
  renderer: () => settings.renderer(),
  log: (message) => console.log(message),
})

// The game runs in a second host process (play-session.ts), beside the project's editor host
const play = new PlaySession({
  editor: {
    get isConnected() {
      return engine.client.isConnected
    },
    writePlaySnapshot: (scenePath) => engine.client.writePlaySnapshot(scenePath),
  },
  projectPath: () => projectSession.projectPath,
  hostPath: () => settings.require(),
  // What the edit host was launched with, not what settings.json says now: a changed setting mustn't split the two
  renderer: () => projectSession.hostRenderer,
  readyTimeoutMs: () => settings.readyTimeoutMs(),
  createConnection: () => new EngineClient(),
  publish: publishPlayState,
  log: (message) => console.log(message),
})
// A game outlives neither the editor host it was made from nor its connection (a stopped, restarted or crashed host)
engine.client.onClose(() => {
  play.stop("The editor host's connection ended").catch((e) => console.error("Failed to stop the game:", e))
})
registerPlayIpc(ipcMain, { page, session: play })

registerProjectIpc(ipcMain, { getWindow, page, files, recent, settings, session: projectSession })

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
      // The page has no Node: the engine connection, the host process and the project's files are reached through
      // the typed IPC API
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

  // The page vetoes closing or reloading with unsaved scene changes (beforeunload, index.tsx); this is where the user
  // answers: preventDefault here lets the page go.
  const win = mainWindow
  win.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Discard changes", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: "Unsaved changes",
      message: "The open scene has unsaved changes.",
      detail: "Closing or reloading the editor now discards them.",
    })
    if (choice === 0) event.preventDefault()
  })

  mainWindow.on("closed", () => {
    mainWindow = null
    play.shutdown()
    projectSession.killHost()
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
  // macOS: the menu bar's Edit items drive the editor's undo and redo (Windows and Linux have no menu bar)
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildAppMenuTemplate(app.name, (command) => {
          const editor = page.getEditor()
          if (editor && !editor.isDestroyed()) editor.send(Channels.editCommand, command)
        })
      )
    )
  }
  createWindow()
})

/** Kills the game and the editor host, synchronously (the game first: it is the one that depends on the other) */
function shutdownAll(): void {
  play.shutdown()
  projectSession.shutdown()
}

// The host never outlives the editor: it's killed however the editor ends. Once connected, closing the connection
// would end it anyway (--exit-on-disconnect); the kill also covers a host still starting.
app.on("before-quit", shutdownAll)
app.on("window-all-closed", () => {
  shutdownAll()
  app.quit()
})
// Ending some other way (process.exit, a fatal error): "exit" handlers are synchronous, and so is the kill
process.on("exit", shutdownAll)
// Ctrl+C in the terminal that started the editor, or a kill: quit properly instead of dying with the host running
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdownAll()
    app.quit()
  })
}
