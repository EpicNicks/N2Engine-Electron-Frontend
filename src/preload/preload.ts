// Exposes the typed editor API (shared/api.ts) to the page. Each call is forwarded to the main process over IPC;
// the preload holds no state but the last connection and host states. It runs sandboxed, so it is bundled
// (scripts/bundle.js) and can require only "electron".
import { contextBridge, ipcRenderer } from "electron"
import {
  Channels,
  ConnectionState,
  EngineApi,
  EngineCommandNames,
  EngineCommands,
  HostApi,
  HostState,
  IpcResult,
  ProjectApi,
} from "../shared/api"

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.value
}

/** Calls each listener, so one that throws doesn't stop the others */
function notify<T>(listeners: Array<(value: T) => void>, value: T, what: string): void {
  listeners.forEach((listener) => {
    try {
      listener(value)
    } catch (e) {
      console.error(`${what} listener failed:`, e)
    }
  })
}

// ==================== Connection state ====================

let connection: ConnectionState = { connected: false, epoch: -1, serverInfo: null }
const connectionListeners: Array<(connected: boolean) => void> = []

/** Applies a state unless a newer one has already arrived (a reply and an event can cross) */
function applyState(state: ConnectionState): void {
  if (state.epoch < connection.epoch) return
  const changed = state.connected !== connection.connected
  connection = state
  if (changed) notify(connectionListeners, state.connected, "Connection")
}

ipcRenderer.on(Channels.engineState, (_event, state: ConnectionState) => applyState(state))

// This page starts without a project, host or connection: drop any a previous page (before a reload) left open
invoke<ConnectionState>(Channels.engineAttach).then(applyState, (e) => {
  console.error("Failed to attach to the engine connection:", e)
})

// ==================== Host state ====================

let host: HostState = { status: "stopped", launch: 0, projectPath: null, message: null }
let hostPushed = false
const hostListeners: Array<(state: HostState) => void> = []

function applyHostState(state: HostState): void {
  host = state
  notify(hostListeners, state, "Host state")
}

// Pushes arrive in order; the first fetch only counts if none has arrived yet
ipcRenderer.on(Channels.hostState, (_event, state: HostState) => {
  hostPushed = true
  applyHostState(state)
})
invoke<HostState>(Channels.hostGetState).then(
  (state) => {
    if (!hostPushed) applyHostState(state)
  },
  (e) => console.error("Failed to get the host's state:", e)
)

// ==================== window.engine ====================

const commands = {} as Record<string, (...args: unknown[]) => Promise<unknown>>
for (const name of EngineCommandNames) {
  commands[name] = (...args: unknown[]) => invoke(Channels.engineCall, name, args)
}

const engine: EngineApi = {
  ...(commands as unknown as EngineCommands),

  isConnected: () => connection.connected,

  serverInfo: () => connection.serverInfo,

  onConnectionChange(listener) {
    connectionListeners.push(listener)
  },
}

// ==================== window.host ====================

const hostApi: HostApi = {
  state: () => host,
  onStateChange(listener) {
    hostListeners.push(listener)
  },
  restart: () => invoke(Channels.hostRestart),
  stop: () => invoke(Channels.hostStop),
  location: () => invoke(Channels.hostLocation),
  locate: () => invoke(Channels.hostLocate),
}

// ==================== window.project ====================

const project: ProjectApi = {
  openDialog: () => invoke(Channels.projectOpenDialog),
  openFolder: (folder) => invoke(Channels.projectOpenFolder, folder),
  pickNewFolder: () => invoke(Channels.projectPickNewFolder),
  create: (folder, name, adopt) => invoke(Channels.projectCreate, folder, name, adopt),
  openRecent: (projectPath) => invoke(Channels.projectOpenRecent, projectPath),
  getRecent: () => invoke(Channels.projectGetRecent),
  removeRecent: (projectPath) => invoke(Channels.projectRemoveRecent, projectPath),
  close: () => invoke(Channels.projectClose),
  listFiles: () => invoke(Channels.projectListFiles),
  readTextFile: (filePath) => invoke(Channels.projectReadTextFile, filePath),
  writeTextFile: (filePath, text) => invoke(Channels.projectWriteTextFile, filePath, text),
  createDirectory: (dirPath) => invoke(Channels.projectCreateDirectory, dirPath),
  deleteFile: (filePath) => invoke(Channels.projectDeleteFile, filePath),
}

contextBridge.exposeInMainWorld("engine", engine)
contextBridge.exposeInMainWorld("host", hostApi)
contextBridge.exposeInMainWorld("project", project)
