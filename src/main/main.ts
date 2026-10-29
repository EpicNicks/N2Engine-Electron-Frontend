import { app, BrowserWindow, dialog, Menu, screen, ipcMain, session } from "electron"
import * as path from "path"
import { pathToFileURL } from "url"
import { EngineClient } from "../protocol/engine-client"
import { AgentState, Channels, EditMenuLabels, HostState, PlayState } from "../shared/api"
import { AgentController, AgentProjectStore } from "./agent-controller"
import { confirmAgentOperation, registerAgentIpc } from "./agent-ipc"
import { PrepareChannel } from "./agent-prepare"
import { buildAppMenuTemplate } from "./app-menu"
import { EngineHost } from "./engine-ipc"
import { askTrust } from "./extension-prompt"
import { ExtensionTrust, ExtensionTrustStore } from "./extension-trust"
import { TokenEnvVariable } from "./host-launcher"
import { HostSettings } from "./host-settings"
import { EditorPage, handleResult } from "./ipc"
import { PlaySession } from "./play-session"
import { registerPlayIpc } from "./play-ipc"
import { registerPreferencesIpc } from "./preferences-ipc"
import { registerProjectIpc } from "./project-ipc"
import { registerRemoteIpc } from "./remote-ipc"
import { ProjectFiles } from "./project-files"
import { ProjectSession } from "./project-session"
import { RecentProjects } from "./recent-projects"
import { RecentRemotes } from "./recent-remotes"
import { PinStore } from "./pin-store"

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
  // The agent endpoint follows the project and the connection (the switch may now be possible, or not)
  void agent?.refresh()
}

function publishPlayState(state: PlayState): void {
  const editor = page.getEditor()
  if (editor && !editor.isDestroyed()) editor.send(Channels.playState, state)
}

const userData = app.getPath("userData")
const files = new ProjectFiles()
const recent = new RecentProjects(path.join(userData, "recent-projects.json"))
const recentRemotes = new RecentRemotes(path.join(userData, "recent-remotes.json"))
const pins = new PinStore(path.join(userData, "pinned-fingerprints.json"))
const settings = new HostSettings(path.join(userData, "settings.json"))

// The size the page last set the editor view to: the agent endpoint puts it back after an agent's picture (risk R4)
let humanViewport: { width: number; height: number } | null = null

const engine = new EngineHost(new EngineClient(), page, {
  // A page that (re)loads starts at the welcome screen: no project, no host
  onAttach: () => {
    prepareChannel.cancelAll("the editor window reloaded")
    play.stop().catch((e) => console.error("Failed to stop the game:", e))
    projectSession.reset().catch((e) => console.error("Failed to close the project:", e))
  },
  // The person's requests wait while an AI agent's call is in progress (the agent endpoint, agent-mux.ts)
  gate: async (name, args, run) => {
    const result = await (agent ? agent.multiplexer.human(run) : run())
    if (name === "setViewportSize" && typeof args[0] === "number" && typeof args[1] === "number") humanViewport = { width: args[0], height: args[1] }
    return result
  },
})
engine.register(ipcMain)

// "Allow AI agent for this project" (MCP6): a local endpoint for ONE agent, working through this editor's own engine connection
const prepareChannel = new PrepareChannel((id) => {
  const editor = page.getEditor()
  if (!editor || editor.isDestroyed()) return false
  editor.send(Channels.agentPrepare, id)
  return true
})
let agent: AgentController | null = null

// Editor extensions (editor/*.lua) run code on the host: the editor passes --editor-extensions only for a local folder
// the user trusted (extension-trust.ts). The record is in the user data folder, which no project can write.
const extensionTrust = new ExtensionTrust({
  store: new ExtensionTrustStore(path.join(userData, "extension-trust.json")),
  ask: (projectDir, scan) => askTrust(getWindow(), projectDir, scan),
  log: (message) => console.log(message),
})

const projectSession = new ProjectSession({
  files,
  recent,
  settings,
  engine,
  recentRemotes,
  pins,
  publish: publishHostState,
  renderer: () => settings.renderer(),
  extensions: extensionTrust,
  log: (message) => console.log(message),
})

// The game runs in a second host process (play-session.ts), beside the project's editor host
const play = new PlaySession({
  editor: {
    get isConnected() {
      return engine.client.isConnected
    },
    writePlaySnapshot: (scenePath) => (agent ? agent.multiplexer.human(() => engine.client.writePlaySnapshot(scenePath)) : engine.client.writePlaySnapshot(scenePath)),
  },
  // Play launches a local host process of the project's folder: a remote engine has neither
  unavailable: () =>
    projectSession.isRemote
      ? "Play mode needs a local engine: it launches a second N2EditorHost on this machine, from the project's folder"
      : null,
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

agent = new AgentController({
  store: new AgentProjectStore(path.join(userData, "agent-projects.json")),
  userData,
  engine: engine.client,
  projectPath: () => projectSession.projectPath,
  isRemote: () => projectSession.isRemote,
  prepare: () => prepareChannel.request(),
  changed: () => {
    const editor = page.getEditor()
    if (editor && !editor.isDestroyed()) editor.send(Channels.agentDone)
  },
  confirm: (request, signal) => confirmAgentOperation(getWindow(), request, signal),
  publish: (state: AgentState) => {
    const editor = page.getEditor()
    if (editor && !editor.isDestroyed()) editor.send(Channels.agentState, state)
  },
  humanViewport: () => humanViewport,
  log: (message) => console.log(`[agent] ${message}`),
})
registerAgentIpc(ipcMain, { page, getWindow, controller: agent, prepare: prepareChannel })
// The endpoint follows the connection: a host that ended takes the agent's endpoint with it
engine.client.onClose(() => void agent?.refresh())

// macOS: the Edit menu names the steps Undo and Redo would take, so an agent's steps ("AI: ...") are visible there
let menuLabels: EditMenuLabels = { undo: "", redo: "" }
function applyAppMenu(): void {
  if (process.platform !== "darwin") return
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildAppMenuTemplate(
        app.name,
        (command) => {
          const editor = page.getEditor()
          if (editor && !editor.isDestroyed()) editor.send(Channels.editCommand, command)
        },
        menuLabels
      )
    )
  )
}
handleResult(ipcMain, Channels.editMenuLabels, page, (labels) => {
  const l = labels as Partial<EditMenuLabels> | null
  if (typeof l?.undo !== "string" || typeof l.redo !== "string") throw new Error("labels must be {undo, redo} strings")
  menuLabels = { undo: l.undo.slice(0, 200), redo: l.redo.slice(0, 200) }
  applyAppMenu()
})

registerProjectIpc(ipcMain, { getWindow, page, files, recent, settings, session: projectSession })
registerPreferencesIpc(ipcMain, { page, settings, chooseHostPath: async () => {
  const window = getWindow()
  if (!window) return null
  const result = await dialog.showOpenDialog(window, { title: "Choose N2EditorHost", properties: ["openFile"],
    filters: process.platform === "win32" ? [{ name: "Programs", extensions: ["exe"] }, { name: "All files", extensions: ["*"] }] : [] })
  return result.canceled ? null : result.filePaths[0] ?? null
} })
registerRemoteIpc(ipcMain, { page, session: projectSession, recent: recentRemotes, pins })

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
  applyAppMenu()
  createWindow()
})

/** Kills the game and the editor host, synchronously (the game first: it is the one that depends on the other) */
function shutdownAll(): void {
  agent?.dispose()
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
