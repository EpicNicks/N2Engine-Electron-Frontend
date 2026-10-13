import type {
  AutosaveInfo,
  EditorEvent,
  EventsResponse,
  HistoryResponse,
  SceneInfoResponse,
} from "../protocol/protocol.generated"
import type { AutosaveChoice } from "../renderer/autosave"
import type {
  CreateProjectResult,
  HostLocation,
  HostState,
  OpenProjectResult,
  PinInspection,
  RemoteSettings,
  ServerInfo,
} from "../shared/api"
import type { Timers } from "../protocol/event-pump"
import type { StoreApi, UnsavedChoice } from "../renderer/store"

/** Timers that fire only when the test says so */
export class FakeTimers implements Timers {
  private next = 1
  pending = new Map<number, () => void>()
  setTimeout(callback: () => void): unknown {
    const handle = this.next++
    this.pending.set(handle, callback)
    return handle
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number)
  }
  /** Fires every pending timer and lets the polls they start settle */
  async fire(): Promise<void> {
    const callbacks = [...this.pending.values()]
    this.pending.clear()
    callbacks.forEach((callback) => callback())
    await settle()
  }
}

export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A scene path's file name without ".scene" */
export const basenameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.scene$/i, "")

export const log = (seq: number, message: string, level = "info"): EditorEvent => ({
  seq,
  kind: "log",
  level,
  message,
  time: 1000 + seq,
})

/** A host's PollEvents: its epoch, its events (seqs 1..n), and the epoch rule */
export class FakeHostEvents {
  epoch = 0xabc
  events: EditorEvent[] = []
  /** [epoch, afterSeq] of each poll */
  polls: Array<[number, number]> = []

  add(...messages: string[]): void {
    for (const message of messages) this.events.push(log(this.events.length + 1, message))
  }

  /** Another host process */
  restart(...messages: string[]): void {
    this.epoch++
    this.events = []
    this.add(...messages)
  }

  poll = async (epoch: number, afterSeq: number, maxEvents: number): Promise<EventsResponse> => {
    this.polls.push([epoch, afterSeq])
    if ((epoch !== 0 && epoch !== this.epoch) || afterSeq > this.events.length) afterSeq = 0
    const events = this.events.filter((e) => e.seq > afterSeq).slice(0, maxEvents)
    const nextSeq = events.length > 0 ? events[events.length - 1].seq : Math.max(afterSeq, this.events.length)
    return { epoch: this.epoch, nextSeq, dropped: 0, events }
  }
}

/** The page's API, faked: the main process's pushes are made by the test */
export class FakeApi implements StoreApi {
  hostState: HostState = { status: "stopped", mode: "local", launch: 0, projectPath: null, message: null }
  connectedNow = false
  info: ServerInfo = { protocolVersion: "1.2.0", engineVersion: "1.0.0", capabilities: [], projectLoaded: true, readOnly: false }
  recentList = ["C:\\Games\\A", "C:\\Games\\B"]
  events = new FakeHostEvents()
  hostListeners: Array<(state: HostState) => void> = []
  connectionListeners: Array<(connected: boolean) => void> = []
  /** What openDialog resolves with, or a failure */
  dialogResult: string | null | Error = "C:\\Games\\C"
  /** Folders without a project.n2proj: opening one is notAProject */
  plainFolders = new Set<string>()
  /** Folders that already are projects: creating in one is alreadyAProject */
  projectFolders = new Set<string>()
  /** What pickNewFolder resolves with */
  newFolder: string | null = "C:\\Games\\New"
  canCreate: boolean | null = true
  calls: string[] = []
  /** The answers the user gives, in order */
  confirmAnswers: boolean[] = []
  promptAnswers: Array<string | null> = []
  unsavedAnswers: UnsavedChoice[] = []
  autosaveAnswers: AutosaveChoice[] = []
  /** The autosave question waits on screen for answerAutosave */
  autosaveHold = false
  autosaveOnScreen: ((choice: AutosaveChoice) => void) | null = null
  /** How many times the store closed the autosave question */
  dismissed = 0
  answerAutosave(choice: AutosaveChoice): void {
    const resolve = this.autosaveOnScreen
    this.autosaveOnScreen = null
    resolve?.(choice)
  }
  asked: string[] = []
  /** What GetHistory answers (it is not in calls: the store reads it often) */
  history: HistoryResponse = { cursor: 0, entries: [] }
  /** What GetAutosave answers; null: an error (a host before protocol 1.6) */
  autosave: AutosaveInfo | null = { exists: false }
  /** The autosave commands the store sent, in order */
  autosaveCalls: string[] = []
  /** What RestoreAutosave answers, when the scene changes with it */
  restored: SceneInfoResponse | null = null

  dialogs = {
    unsaved: async (message: string, discardLabel: string): Promise<UnsavedChoice> => {
      this.asked.push(`unsaved ${discardLabel}: ${message}`)
      return this.unsavedAnswers.shift() ?? "cancel"
    },
    autosave: (message: string): Promise<AutosaveChoice> => {
      this.asked.push(`autosave: ${message}`)
      // Held: the question stays on screen until the test answers it (or the store dismisses it)
      if (this.autosaveHold) {
        return new Promise<AutosaveChoice>((resolve) => (this.autosaveOnScreen = resolve))
      }
      return Promise.resolve(this.autosaveAnswers.shift() ?? "later")
    },
    dismissAutosave: () => {
      this.dismissed++
      const resolve = this.autosaveOnScreen
      this.autosaveOnScreen = null
      resolve?.("later")
    },
    prompt: async (title: string, value: string) => {
      this.asked.push(`prompt ${title}: ${value}`)
      return this.promptAnswers.length > 0 ? this.promptAnswers.shift()! : value
    },
    confirm: async (message: string, okLabel: string) => {
      this.asked.push(`confirm ${okLabel}: ${message}`)
      return this.confirmAnswers.shift() ?? false
    },
  }

  private opened(projectPath: string): OpenProjectResult {
    if (this.plainFolders.has(projectPath)) {
      return {
        kind: "notAProject",
        path: projectPath,
        message: `${projectPath} isn't a project: it has no project.n2proj`,
      }
    }
    this.launchAndConnect(projectPath)
    return { kind: "opened", path: projectPath }
  }

  /** The main process pushes a host state */
  pushHost(change: Partial<HostState>): void {
    this.hostState = { ...this.hostState, ...change }
    this.hostListeners.forEach((l) => l(this.hostState))
  }
  pushConnection(connected: boolean): void {
    this.connectedNow = connected
    this.connectionListeners.forEach((l) => l(connected))
  }

  engine = {
    isConnected: () => this.connectedNow,
    serverInfo: () => (this.connectedNow ? this.info : null),
    onConnectionChange: (listener: (connected: boolean) => void) => this.connectionListeners.push(listener),
    pollEvents: (epoch: number, afterSeq: number, maxEvents: number) => this.events.poll(epoch, afterSeq, maxEvents),
    getHistory: async (): Promise<HistoryResponse> => this.history,
    getAutosave: async (): Promise<AutosaveInfo> => {
      this.autosaveCalls.push("getAutosave")
      if (!this.autosave) throw new Error("Unknown command 0x95")
      return this.autosave
    },
    restoreAutosave: async (): Promise<SceneInfoResponse> => {
      this.autosaveCalls.push("restoreAutosave")
      if (!this.restored) throw new Error("There is no autosave")
      return (this.openScene = this.restored)
    },
    discardAutosave: async (): Promise<void> => {
      this.autosaveCalls.push("discardAutosave")
    },
    getOpenScene: async (): Promise<SceneInfoResponse> => {
      this.calls.push("getOpenScene")
      if (this.sceneGate) await this.sceneGate
      if (!this.openScene) throw new Error("No scene is loaded")
      return { ...this.openScene }
    },
    openScene: async (path: string): Promise<SceneInfoResponse> => {
      this.calls.push(`openScene ${path}`)
      if (this.sceneError) throw new Error(this.sceneError)
      return (this.openScene = { path, name: basenameOf(path), uuid: "u-" + path, revision: 1, savedRevision: 1 })
    },
    newScene: async (path: string, name: string): Promise<SceneInfoResponse> => {
      this.calls.push(`newScene ${path} name=${name}`)
      if (this.sceneError) throw new Error(this.sceneError)
      return (this.openScene = { path, name: basenameOf(path), uuid: "u-" + path, revision: 1, savedRevision: 1 })
    },
    saveSceneToFile: async (path: string): Promise<SceneInfoResponse> => {
      this.calls.push(`saveSceneToFile ${path}`)
      if (this.sceneError) throw new Error(this.sceneError)
      const scene = this.openScene!
      return (this.openScene = {
        ...scene,
        path: path || scene.path,
        name: path ? basenameOf(path) : scene.name,
        savedRevision: scene.revision,
      })
    },
  }
  /** Fails openScene, newScene and saveSceneToFile with this message */
  sceneError: string | null = null
  /** What GetOpenScene answers; null: an error (no scene, or a host before protocol 1.3) */
  openScene: SceneInfoResponse | null = null
  /** While set, GetOpenScene waits for it */
  sceneGate: Promise<void> | null = null

  host = {
    state: () => this.hostState,
    onStateChange: (listener: (state: HostState) => void) => this.hostListeners.push(listener),
    restart: async () => {
      this.calls.push("restart")
    },
    stop: async () => {
      this.calls.push("stop")
    },
    location: async (): Promise<HostLocation> => ({
      path: "C:\\N2EditorHost.exe",
      source: "setting",
      problem: null,
      canCreate: this.canCreate,
    }),
    locate: async (): Promise<HostLocation | null> => ({
      path: "D:\\N2EditorHost.exe",
      source: "setting",
      problem: null,
      canCreate: this.canCreate,
    }),
  }

  project = {
    openDialog: async () => {
      this.calls.push("openDialog")
      const result = this.dialogResult
      if (result instanceof Error) throw result
      return result ? this.opened(result) : null
    },
    openRecent: async (projectPath: string) => {
      this.calls.push(`openRecent ${projectPath}`)
      return this.opened(projectPath)
    },
    openFolder: async (folder: string) => {
      this.calls.push(`openFolder ${folder}`)
      return this.opened(folder)
    },
    pickNewFolder: async () => {
      this.calls.push("pickNewFolder")
      return this.newFolder
    },
    create: async (folder: string, name: string, adopt: boolean): Promise<CreateProjectResult> => {
      this.calls.push(`create ${folder} name=${name} adopt=${adopt}`)
      if (this.projectFolders.has(folder)) {
        return {
          kind: "alreadyAProject",
          path: folder,
          message: `${folder} already has a project.n2proj; nothing was changed`,
        }
      }
      this.plainFolders.delete(folder)
      this.projectFolders.add(folder)
      this.launchAndConnect(folder)
      return { kind: "opened", path: folder }
    },
    getRecent: async () => [...this.recentList],
    removeRecent: async (projectPath: string) => {
      this.recentList = this.recentList.filter((p) => p !== projectPath)
    },
    close: async () => {
      this.calls.push("close")
      this.pushConnection(false)
      this.pushHost({ status: "stopped", projectPath: null })
    },
  }

  /** The remote engines the main process remembers; connect's calls and the tokens it was given */
  remoteRecent: RemoteSettings[] = [{ target: "me@cloud", hostPort: 7000 }]
  remoteTokens: string[] = []
  /** A failure for connect to reject with */
  remoteError: string | null = null

  remote = {
    connect: async (settings: RemoteSettings, token: string): Promise<string> => {
      this.calls.push(`remoteConnect ${settings.target}:${settings.hostPort}`)
      this.remoteTokens.push(token)
      if (this.remoteError) throw new Error(this.remoteError)
      const name = `${settings.target}:${settings.hostPort}`
      this.pushHost({ status: "starting", mode: "remote", launch: this.hostState.launch + 1, projectPath: name, message: null })
      this.pushConnection(true)
      this.pushHost({ status: "running" })
      this.remoteRecent = [settings, ...this.remoteRecent.filter((r) => r.target !== settings.target)]
      return name
    },
    getRecent: async () => [...this.remoteRecent],
    removeRecent: async (settings: RemoteSettings) => {
      this.remoteRecent = this.remoteRecent.filter((r) => r.target !== settings.target)
    },
    connectDirect: async (): Promise<string> => "",
    inspectDirect: async (): Promise<PinInspection> => ({ kind: "unknown", fingerprint: "" }),
    forgetPin: async (): Promise<void> => undefined,
  }

  /** What the main process pushes while opening a project */
  private launchAndConnect(projectPath: string): void {
    this.pushHost({ status: "starting", launch: this.hostState.launch + 1, projectPath, message: null })
    this.pushConnection(true)
    this.pushHost({ status: "running" })
  }
}


/** A fresh fake page API (the shared one: store.test.ts and the DOM tests build their EditorStore over it) */
export const fakeStoreApi = (): FakeApi => new FakeApi()
