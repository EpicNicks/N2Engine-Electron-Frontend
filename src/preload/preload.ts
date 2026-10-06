// Exposes the typed editor API (shared/api.ts) to the page. Each call is forwarded to the main process over IPC;
// the preload holds no state but the last connection state. It runs sandboxed, so it is bundled
// (scripts/bundle.js) and can require only "electron".
import { contextBridge, ipcRenderer } from "electron"
import {
  Channels,
  ConnectionState,
  EngineApi,
  EngineCommandNames,
  EngineCommands,
  IpcResult,
  ProjectApi,
} from "../shared/api"

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.value
}

// ==================== Connection state ====================

let connection: ConnectionState = { connected: false, epoch: -1 }
const connectionListeners: Array<(connected: boolean) => void> = []

/** Applies a state unless a newer one has already arrived (a reply and an event can cross) */
function applyState(state: ConnectionState): void {
  if (state.epoch < connection.epoch) return
  const changed = state.connected !== connection.connected
  connection = state
  if (changed) {
    connectionListeners.forEach((listener) => {
      try {
        listener(state.connected)
      } catch (e) {
        console.error("Connection listener failed:", e)
      }
    })
  }
}

ipcRenderer.on(Channels.engineState, (_event, state: ConnectionState) => applyState(state))

// This page starts without a connection: drop one a previous page (before a reload) left open
const attached = invoke<ConnectionState>(Channels.engineAttach).then(applyState, (e) => {
  console.error("Failed to attach to the engine connection:", e)
})

// ==================== window.engine ====================

const commands = {} as Record<string, (...args: unknown[]) => Promise<unknown>>
for (const name of EngineCommandNames) {
  commands[name] = (...args: unknown[]) => invoke(Channels.engineCall, name, args)
}

const engine: EngineApi = {
  ...(commands as unknown as EngineCommands),

  async connect(host = "localhost", port = 9999) {
    await attached
    applyState(await invoke<ConnectionState>(Channels.engineConnect, host, port))
  },

  async disconnect() {
    applyState(await invoke<ConnectionState>(Channels.engineDisconnect))
  },

  isConnected: () => connection.connected,

  onConnectionChange(listener) {
    connectionListeners.push(listener)
  },
}

// ==================== window.project ====================

const project: ProjectApi = {
  openDialog: () => invoke(Channels.projectOpenDialog),
  createDialog: () => invoke(Channels.projectCreateDialog),
  openRecent: (projectPath) => invoke(Channels.projectOpenRecent, projectPath),
  getRecent: () => invoke(Channels.projectGetRecent),
  listFiles: () => invoke(Channels.projectListFiles),
  readTextFile: (filePath) => invoke(Channels.projectReadTextFile, filePath),
  writeTextFile: (filePath, text) => invoke(Channels.projectWriteTextFile, filePath, text),
  createDirectory: (dirPath) => invoke(Channels.projectCreateDirectory, dirPath),
  deleteFile: (filePath) => invoke(Channels.projectDeleteFile, filePath),
}

contextBridge.exposeInMainWorld("engine", engine)
contextBridge.exposeInMainWorld("project", project)
