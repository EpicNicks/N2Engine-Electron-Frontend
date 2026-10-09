import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { effect } from "@preact/signals-core"
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
  RemoteSettings,
  ServerInfo,
} from "../shared/api"
import type { Timers } from "../protocol/event-pump"
import { ConsoleStore, entryFromEvent } from "../renderer/console-store"
import { EditorStore, StoreApi, UnsavedChoice, createUnavailableReason, describeHost } from "../renderer/store"

/** Timers that fire only when the test says so */
class FakeTimers implements Timers {
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

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A scene path's file name without ".scene" */
const basenameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.scene$/i, "")

const log = (seq: number, message: string, level = "info"): EditorEvent => ({
  seq,
  kind: "log",
  level,
  message,
  time: 1000 + seq,
})

/** A host's PollEvents: its epoch, its events (seqs 1..n), and the epoch rule */
class FakeHostEvents {
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

describe("ConsoleStore", () => {
  test("log events become entries; other kinds and unknown levels are handled", () => {
    assert.deepEqual(entryFromEvent(log(1, "hello", "warn")), {
      level: "warn",
      message: "hello",
      time: 1001,
      source: "host",
    })
    assert.equal(entryFromEvent({ seq: 2, kind: "sceneChanged" }), null)
    assert.equal(entryFromEvent({ seq: 3, kind: "log", level: "verbose", message: "x", time: 5 })?.level, "info")
    const odd = entryFromEvent({ seq: 4, kind: "log" } as EditorEvent)
    assert.equal(odd?.message, "")
    assert.equal(typeof odd?.time, "number")
  })

  test("polls from (0, 0), then with the response's epoch and nextSeq", async () => {
    const host = new FakeHostEvents()
    host.add("Engine initialized", "Editor server started")
    const timers = new FakeTimers()
    const store = new ConsoleStore(host.poll, { timers })

    store.connect(1)
    await timers.fire()
    assert.deepEqual(
      store.entries.value.map((e) => e.message),
      ["Engine initialized", "Editor server started"]
    )
    assert.deepEqual(store.position, { epoch: host.epoch, seq: 2 })

    host.add("Editor client said Hello")
    await timers.fire()
    assert.deepEqual(host.polls, [
      [0, 0],
      [host.epoch, 2],
    ])
    assert.equal(store.entries.value.length, 3)
  })

  test("a reconnect to the same host carries on from its cursor: nothing missed or repeated", async () => {
    const host = new FakeHostEvents()
    host.add("a", "b")
    const timers = new FakeTimers()
    const store = new ConsoleStore(host.poll, { timers })
    store.connect(1)
    await timers.fire()
    store.disconnect()
    assert.equal(store.isPolling, false)
    host.add("c")

    store.connect(1)
    await timers.fire()
    assert.deepEqual(host.polls[host.polls.length - 1], [host.epoch, 2])
    assert.deepEqual(
      store.entries.value.map((e) => e.message),
      ["a", "b", "c"]
    )
  })

  test("a newly launched host starts from (0, 0), so its whole log is read", async () => {
    const host = new FakeHostEvents()
    host.add("first host")
    const timers = new FakeTimers()
    const store = new ConsoleStore(host.poll, { timers })
    store.connect(1)
    await timers.fire()

    host.restart("second host starting", "second host ready")
    store.connect(2)
    await timers.fire()
    assert.deepEqual(host.polls[host.polls.length - 1], [0, 0])
    assert.deepEqual(
      store.entries.value.map((e) => e.message),
      ["first host", "second host starting", "second host ready"]
    )
  })

  test("a new epoch in a response (the host isn't the one the cursor is from) starts a new log, noted", async () => {
    const host = new FakeHostEvents()
    host.add("1", "2", "3")
    const timers = new FakeTimers()
    const store = new ConsoleStore(host.poll, { timers, now: () => 42 })
    store.connect(1)
    await timers.fire()

    host.restart("new")
    await timers.fire()
    assert.deepEqual(store.position, { epoch: host.epoch, seq: 1 })
    const messages = store.entries.value.map((e) => `${e.source}:${e.message}`)
    assert.deepEqual(messages, ["host:1", "host:2", "host:3", "editor:The host started a new log", "host:new"])
  })

  test("dropped events are noted", async () => {
    const timers = new FakeTimers()
    const store = new ConsoleStore(async () => ({ epoch: 1, nextSeq: 10, dropped: 7, events: [log(10, "late")] }), {
      timers,
    })
    store.connect(1)
    await timers.fire()
    assert.deepEqual(
      store.entries.value.map((e) => [e.level, e.message]),
      [
        ["warn", "7 host events were dropped before the editor read them"],
        ["info", "late"],
      ]
    )
  })

  test("keeps at most maxEntries, filters by level and text, counts, and clears", async () => {
    const store = new ConsoleStore(async () => ({ epoch: 1, nextSeq: 0, dropped: 0, events: [] }), { maxEntries: 3 })
    store.note("info", "one")
    store.note("warn", "two")
    store.note("error", "Three")
    store.note("info", "four")
    assert.deepEqual(
      store.entries.value.map((e) => e.message),
      ["two", "Three", "four"]
    )
    assert.deepEqual(store.counts.value, { info: 1, warn: 1, error: 1 })
    const ids = store.entries.value.map((e) => e.id)
    assert.equal(new Set(ids).size, 3)

    store.toggleLevel("info")
    assert.deepEqual(
      store.visible.value.map((e) => e.message),
      ["two", "Three"]
    )
    store.search.value = "three"
    assert.deepEqual(
      store.visible.value.map((e) => e.message),
      ["Three"]
    )
    store.clear()
    assert.deepEqual(store.visible.value, [])
  })
})

/** The page's API, faked: the main process's pushes are made by the test */
class FakeApi implements StoreApi {
  hostState: HostState = { status: "stopped", mode: "local", launch: 0, projectPath: null, message: null }
  connectedNow = false
  info: ServerInfo = { protocolVersion: "1.2.0", engineVersion: "1.0.0", capabilities: [], projectLoaded: true }
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
  }

  /** What the main process pushes while opening a project */
  private launchAndConnect(projectPath: string): void {
    this.pushHost({ status: "starting", launch: this.hostState.launch + 1, projectPath, message: null })
    this.pushConnection(true)
    this.pushHost({ status: "running" })
  }
}

function makeStore() {
  const api = new FakeApi()
  const timers = new FakeTimers()
  const store = new EditorStore(api, { timers, now: () => 0 })
  return { api, store, timers }
}

describe("EditorStore", () => {
  test("starts on the welcome screen with the recent projects and the host's location", async () => {
    const { store } = makeStore()
    assert.equal(store.view.value, "welcome")
    await store.load()
    assert.deepEqual(store.recent.value, ["C:\\Games\\A", "C:\\Games\\B"])
    assert.equal(store.hostLocation.value?.path, "C:\\N2EditorHost.exe")
  })

  test("opening a project shows the editor, connected, with the console polling the new host", async () => {
    const { api, store, timers } = makeStore()
    api.events.add("Engine initialized")
    await store.openProject()
    assert.equal(store.view.value, "editor")
    assert.equal(store.projectPath.value, "C:\\Games\\C")
    assert.equal(store.projectName.value, "C")
    assert.equal(store.connected.value, true)
    assert.equal(store.serverInfo.value?.engineVersion, "1.0.0")
    assert.equal(store.hostSummary.value, "Connected")
    assert.equal(store.busy.value, null)

    await timers.fire()
    assert.deepEqual(api.events.polls, [[0, 0]])
    assert.deepEqual(
      store.console.entries.value.map((e) => e.message),
      ["Starting N2EditorHost for C:\\Games\\C", "Engine initialized"]
    )
  })

  test("the open scene is fetched on connecting, and sceneChanged events keep its revisions current", async () => {
    const { api, store, timers } = makeStore()
    const a = "res://assets/scenes/a.scene"
    api.openScene = { path: a, name: "a", uuid: "u1", revision: 3, savedRevision: 3 }
    await store.openProject()
    await settle()
    assert.equal(store.scene.peek()?.name, "a")
    assert.equal(store.sceneDirty.value, false)
    assert.equal(store.sceneLabel.value, "a")

    // An edit moves the revision: dirty, without fetching again
    api.events.events.push({ seq: 1, kind: "sceneChanged", revision: 4, savedRevision: 3, path: a })
    await timers.fire()
    assert.equal(store.sceneDirty.value, true)
    assert.equal(store.sceneLabel.value, "a *")
    assert.equal(api.calls.filter((c) => c === "getOpenScene").length, 1)

    // A save: clean again
    api.events.events.push({ seq: 2, kind: "sceneChanged", revision: 4, savedRevision: 4, path: a })
    await timers.fire()
    assert.equal(store.sceneDirty.value, false)

    // Another scene was loaded: its name and uuid come from GetOpenScene
    const b = "res://assets/scenes/b.scene"
    api.openScene = { path: b, name: "b", uuid: "u2", revision: 9, savedRevision: 9 }
    api.events.events.push({ seq: 3, kind: "sceneChanged", revision: 9, savedRevision: 9, path: b })
    await timers.fire()
    assert.equal(store.scene.peek()?.name, "b")
    assert.equal(store.scene.peek()?.uuid, "u2")
    assert.equal(api.calls.filter((c) => c === "getOpenScene").length, 2)
  })

  test("a scene with no file is refetched on each sceneChanged, and no scene is none", async () => {
    const { api, store, timers } = makeStore()
    await store.openProject() // GetOpenScene fails: no scene
    await settle()
    assert.equal(store.scene.peek(), null)
    assert.equal(store.sceneLabel.value, "")

    api.openScene = { path: "", name: "", uuid: "u", revision: 1, savedRevision: 0 }
    api.events.events.push({ seq: 1, kind: "sceneChanged", revision: 1, savedRevision: 0, path: "" })
    await timers.fire()
    assert.equal(store.scene.peek()?.path, "")
    assert.equal(store.sceneLabel.value, "Untitled *")

    api.openScene = { path: "", name: "Other", uuid: "v", revision: 0, savedRevision: 0 }
    api.events.events.push({ seq: 2, kind: "sceneChanged", revision: 0, savedRevision: 0, path: "" })
    await timers.fire()
    assert.equal(store.sceneLabel.value, "Other")
  })

  test("a matching sceneChanged doesn't cancel a fetch in flight, and an older revision is ignored", async () => {
    const { api, store, timers } = makeStore()
    const a = "res://assets/scenes/a.scene"
    api.openScene = { path: a, name: "a", uuid: "u", revision: 3, savedRevision: 3 }
    await store.openProject()
    await settle()

    // A resync is waiting on the host when an event for the same scene arrives
    let release = (): void => undefined
    api.sceneGate = new Promise<void>((resolve) => (release = resolve))
    api.openScene = { path: a, name: "renamed", uuid: "u", revision: 6, savedRevision: 3 }
    const fetching = store.refreshScene()
    api.events.events.push({ seq: 1, kind: "sceneChanged", revision: 4, savedRevision: 3, path: a })
    await timers.fire()
    api.sceneGate = null
    release()
    await fetching
    await settle()
    assert.equal(store.scene.peek()?.name, "renamed")
    assert.equal(store.scene.peek()?.revision, 6)

    // An event older than what is known changes nothing
    api.events.events.push({ seq: 2, kind: "sceneChanged", revision: 2, savedRevision: 2, path: a })
    await timers.fire()
    assert.equal(store.scene.peek()?.revision, 6)
  })

  test("an answer that arrives after the connection dropped is discarded", async () => {
    const { api, store } = makeStore()
    api.openScene = { path: "res://a.scene", name: "a", uuid: "u", revision: 1, savedRevision: 1 }
    let release = (): void => undefined
    api.sceneGate = new Promise<void>((resolve) => (release = resolve))
    await store.openProject()
    await settle()
    api.pushConnection(false)
    release()
    await settle()
    assert.equal(store.scene.peek(), null)
  })

  test("missed events bump the assets and project counters, and the caller's hooks still run", async () => {
    const api = new FakeApi()
    const timers = new FakeTimers()
    const seen: string[] = []
    const store = new EditorStore(api, {
      timers,
      now: () => 0,
      onEvents: (events) => seen.push(`events ${events.length}`),
      onMissedEvents: () => seen.push("missed"),
    })
    api.events.add("one")
    await store.openProject()
    await timers.fire()
    assert.ok(seen.includes("events 1"))
    const assets = store.assetsChangeCount.peek()
    const project = store.projectChangeCount.peek()
    api.events.restart("another host")
    await timers.fire()
    assert.ok(seen.includes("missed"))
    assert.equal(store.assetsChangeCount.peek(), assets + 1)
    assert.equal(store.projectChangeCount.peek(), project + 1)
  })

  test("sceneChanged's entityIds and full reach the panels as one merged change per poll", async () => {
    const { api, store, timers } = makeStore()
    const a = "res://assets/scenes/a.scene"
    api.openScene = { path: a, name: "a", uuid: "u1", revision: 3, savedRevision: 3 }
    await store.openProject()
    await settle()
    const base = store.sceneChangeCount.peek() // connecting counts as a full change
    assert.deepEqual(store.lastSceneChange.peek(), { full: true, entityIds: [] })

    // An edit that names its objects: only those
    api.events.events.push({
      seq: 1,
      kind: "sceneChanged",
      revision: 4,
      savedRevision: 3,
      path: a,
      entityIds: ["u1", "u2"],
    })
    await timers.fire()
    assert.equal(store.sceneChangeCount.peek(), base + 1)
    assert.deepEqual(store.lastSceneChange.peek(), { full: false, entityIds: ["u1", "u2"] })
    assert.equal(store.scene.peek()?.revision, 4) // the revision still moves, and the hierarchy is refetched on it

    // Two events in one poll are one change, with the ids once
    api.events.events.push(
      { seq: 2, kind: "sceneChanged", revision: 5, savedRevision: 3, path: a, entityIds: ["u2", "u3"] },
      { seq: 3, kind: "sceneChanged", revision: 6, savedRevision: 3, path: a, entityIds: ["u4"] }
    )
    await timers.fire()
    assert.equal(store.sceneChangeCount.peek(), base + 2)
    assert.deepEqual(store.lastSceneChange.peek(), { full: false, entityIds: ["u2", "u3", "u4"] })

    // A save touches no object: no change
    api.events.events.push({ seq: 4, kind: "sceneChanged", revision: 6, savedRevision: 6, path: a })
    await timers.fire()
    assert.equal(store.sceneChangeCount.peek(), base + 2)
    assert.equal(store.sceneDirty.value, false)

    // An event with neither, past the known revision, is a change too big to list: everything
    api.events.events.push({ seq: 5, kind: "sceneChanged", revision: 7, savedRevision: 6, path: a })
    await timers.fire()
    assert.equal(store.sceneChangeCount.peek(), base + 3)
    assert.deepEqual(store.lastSceneChange.peek(), { full: true, entityIds: [] })

    // Another scene loaded (the host's revision only goes up): everything
    const b = "res://assets/scenes/b.scene"
    api.openScene = { path: b, name: "b", uuid: "u2", revision: 8, savedRevision: 8 }
    api.events.events.push({ seq: 6, kind: "sceneChanged", revision: 8, savedRevision: 8, path: b, full: true })
    await timers.fire()
    assert.equal(store.sceneChangeCount.peek(), base + 4)
    assert.deepEqual(store.lastSceneChange.peek(), { full: true, entityIds: [] })
    api.events.events.push({ seq: 7, kind: "sceneChanged", revision: 9, savedRevision: 8, path: b })
    await timers.fire()
    assert.equal(store.sceneChangeCount.peek(), base + 5)
    assert.deepEqual(store.lastSceneChange.peek(), { full: true, entityIds: [] })

    // A full event absorbs the ids that came with it in the same poll
    api.events.events.push(
      { seq: 8, kind: "sceneChanged", revision: 10, savedRevision: 8, path: b, entityIds: ["u9"] },
      { seq: 9, kind: "sceneChanged", revision: 11, savedRevision: 11, path: a, full: true }
    )
    await timers.fire()
    assert.deepEqual(store.lastSceneChange.peek(), { full: true, entityIds: [] })
  })

  test("a reset and the new log's sceneChanged events in one poll are a full change, not just their ids", async () => {
    const { api, store, timers } = makeStore()
    api.events.add("one")
    await store.openProject()
    await timers.fire()

    const seen: Array<{ full: boolean; entityIds: string[] } | null> = []
    const stop = effect(() => {
      store.sceneChangeCount.value
      seen.push(store.lastSceneChange.peek())
    })
    seen.length = 0
    // Another host's log starts with a retained sceneChanged that names objects (what every connect replays)
    api.events.restart("another host")
    api.events.events.push({ seq: 2, kind: "sceneChanged", revision: 3, savedRevision: 0, path: "", entityIds: ["u1"] })
    await timers.fire()
    stop()
    assert.deepEqual(store.lastSceneChange.peek(), { full: true, entityIds: [] })
    assert.ok(seen.length > 0)
    assert.ok(
      seen.every((change) => change?.full === true),
      "no observer saw the narrowed change"
    )

    // The flag is spent: the next poll's ids stand alone
    api.events.events.push({ seq: 3, kind: "sceneChanged", revision: 4, savedRevision: 0, path: "", entityIds: ["u2"] })
    await timers.fire()
    assert.deepEqual(store.lastSceneChange.peek(), { full: false, entityIds: ["u2"] })
  })

  test("a save while the scene is being fetched is not a change", async () => {
    const { api, store, timers } = makeStore()
    const a = "res://assets/scenes/a.scene"
    api.openScene = { path: a, name: "a", uuid: "u", revision: 3, savedRevision: 3 }
    await store.openProject()
    await settle()
    api.events.events.push({ seq: 1, kind: "sceneChanged", revision: 4, savedRevision: 3, path: a, entityIds: ["u1"] })
    await timers.fire()
    const count = store.sceneChangeCount.peek()
    let release = (): void => undefined
    api.sceneGate = new Promise<void>((resolve) => (release = resolve))
    const fetching = store.refreshScene()
    api.events.events.push({ seq: 2, kind: "sceneChanged", revision: 4, savedRevision: 4, path: a })
    await timers.fire()
    api.sceneGate = null
    release()
    await fetching
    assert.equal(store.sceneChangeCount.peek(), count)
  })

  test("missed events and a dropped connection are a full scene change", async () => {
    const api = new FakeApi()
    const timers = new FakeTimers()
    const store = new EditorStore(api, { timers, now: () => 0 })
    api.events.add("one")
    await store.openProject()
    await timers.fire()
    api.events.events.push({ seq: 2, kind: "sceneChanged", revision: 1, savedRevision: 0, path: "", entityIds: ["u1"] })
    await timers.fire()
    assert.deepEqual(store.lastSceneChange.peek(), { full: false, entityIds: ["u1"] })

    api.events.restart("another host")
    await timers.fire()
    assert.deepEqual(store.lastSceneChange.peek(), { full: true, entityIds: [] })

    api.events.events.push({ seq: 2, kind: "sceneChanged", revision: 2, savedRevision: 0, path: "", entityIds: ["u2"] })
    await timers.fire()
    assert.deepEqual(store.lastSceneChange.peek(), { full: false, entityIds: ["u2"] })
    api.pushConnection(false)
    assert.deepEqual(store.lastSceneChange.peek(), { full: true, entityIds: [] })
  })

  test("the scene is forgotten when the connection drops", async () => {
    const { api, store } = makeStore()
    api.openScene = { path: "res://a.scene", name: "a", uuid: "u", revision: 1, savedRevision: 1 }
    await store.openProject()
    await settle()
    assert.equal(store.scene.peek()?.name, "a")
    api.pushConnection(false)
    assert.equal(store.scene.peek(), null)
  })

  test("assetsChanged and projectChanged events are counted for the panels", async () => {
    const { api, store, timers } = makeStore()
    await store.openProject()
    api.events.events.push(
      { seq: 1, kind: "assetsChanged", added: ["res://assets/a.lua"], removed: [], modified: ["res://assets/b.lua"] },
      { seq: 2, kind: "projectChanged" },
      { seq: 3, kind: "assetsChanged", added: [], removed: ["res://assets/a.lua"], modified: [] }
    )
    await timers.fire()
    assert.equal(store.assetsChangeCount.value, 2)
    // Two events in one poll are one change that lists the paths of both
    assert.deepEqual(store.lastAssetsChange.value, {
      kind: "assetsChanged",
      added: ["res://assets/a.lua"],
      removed: ["res://assets/a.lua"],
      modified: ["res://assets/b.lua"],
    })
    assert.equal(store.projectChangeCount.value, 1)
  })

  test("frameChanged events are counted for the viewport and touch no other counter", async () => {
    const { api, store, timers } = makeStore()
    await store.openProject()
    const projects = store.projectChangeCount.peek()
    const assets = store.assetsChangeCount.peek()
    const frames = store.frameChangeCount.peek()
    api.events.events.push({ seq: 1, kind: "frameChanged", revision: 5 }, { seq: 2, kind: "frameChanged", revision: 6 })
    await timers.fire()
    assert.equal(store.frameChangeCount.peek(), frames + 2)
    assert.equal(store.projectChangeCount.peek(), projects)
    assert.equal(store.assetsChangeCount.peek(), assets)
  })

  test("a new host log (events the editor may have missed) refetches the scene", async () => {
    const { api, store, timers } = makeStore()
    api.openScene = { path: "res://a.scene", name: "a", uuid: "u", revision: 1, savedRevision: 1 }
    await store.openProject()
    await timers.fire()
    await settle()
    const before = api.calls.filter((c) => c === "getOpenScene").length
    api.openScene = { path: "res://a.scene", name: "a", uuid: "u", revision: 5, savedRevision: 1 }
    api.events.restart("Engine initialized")
    await timers.fire()
    await settle()
    assert.equal(api.calls.filter((c) => c === "getOpenScene").length, before + 1)
    assert.equal(store.scene.peek()?.revision, 5)
  })

  test("busy while an action runs", async () => {
    const { api, store } = makeStore()
    let release: () => void = () => {}
    api.project.openRecent = (projectPath: string) =>
      new Promise((resolve) => (release = () => resolve({ kind: "opened", path: projectPath })))
    const opening = store.openRecent("C:\\Games\\A")
    assert.equal(store.busy.value, "Opening A...")
    release()
    await opening
    assert.equal(store.busy.value, null)
  })

  test("a cancelled dialog stays on the welcome screen", async () => {
    const { api, store } = makeStore()
    api.dialogResult = null
    await store.openProject()
    assert.equal(store.view.value, "welcome")
    assert.equal(store.error.value, null)
  })

  test("a failure stays on the welcome screen with the error, until dismissed", async () => {
    const { api, store } = makeStore()
    api.dialogResult = new Error("N2EditorHost exited with code 1 before it was ready")
    await store.openProject()
    assert.equal(store.view.value, "welcome")
    assert.equal(store.error.value, "N2EditorHost exited with code 1 before it was ready")
    store.dismissError()
    assert.equal(store.error.value, null)
  })

  test("a host that exits is noted in the console, and the console stops polling", async () => {
    const { api, store } = makeStore()
    await store.openRecent("C:\\Games\\A")
    api.pushConnection(false)
    api.pushHost({ status: "exited", message: "N2EditorHost exited with code 3:\nboom" })
    assert.equal(store.connected.value, false)
    assert.equal(store.console.isPolling, false)
    assert.equal(store.hostSummary.value, "The editor host exited")
    const last = store.console.entries.value[store.console.entries.value.length - 1]
    assert.deepEqual(
      [last.level, last.source, last.message],
      ["error", "editor", "N2EditorHost exited with code 3:\nboom"]
    )
    assert.equal(store.view.value, "editor", "the project stays open, to restart its host")
  })

  test("restarting launches a new host whose log the console reads from its start", async () => {
    const { api, store, timers } = makeStore()
    api.events.add("old")
    await store.openRecent("C:\\Games\\A")
    await timers.fire()
    api.pushConnection(false)

    api.events.restart("new")
    api.host.restart = async () => {
      api.pushHost({ status: "starting", launch: 2, projectPath: "C:\\Games\\A" })
      api.pushConnection(true)
      api.pushHost({ status: "running" })
    }
    await store.restartHost()
    await timers.fire()
    assert.deepEqual(api.events.polls[api.events.polls.length - 1], [0, 0])
    assert.ok(store.console.entries.value.some((e) => e.message === "new"))
  })

  test("a remote engine: connecting shows the editor, with the remote's name, and the recent remotes are kept", async () => {
    const { api, store } = makeStore()
    await store.load()
    assert.deepEqual(store.recentRemotes.value, [{ target: "me@cloud", hostPort: 7000 }])
    assert.equal(store.welcomeMode.value, "local")
    assert.equal(store.remote.value, false)

    await store.connectRemote({ target: "dev@box", sshPort: 2222, hostPort: 7777 }, "secret")
    assert.deepEqual(api.remoteTokens, ["secret"])
    assert.equal(store.view.value, "editor")
    assert.equal(store.projectPath.value, "dev@box:7777")
    assert.equal(store.remote.value, true)
    assert.equal(store.hostSummary.value, "Connected (remote)")
    assert.deepEqual(store.recentRemotes.value[0], { target: "dev@box", sshPort: 2222, hostPort: 7777 })
    assert.ok(!JSON.stringify(store.host.value).includes("secret"))
    assert.ok(!store.console.entries.value.some((e) => e.message.includes("secret")))
    assert.ok(store.console.entries.value.some((e) => e.message === "Opening an SSH tunnel to dev@box:7777"))
  })

  test("a remote engine that can't be connected to stays on the welcome screen with the reason", async () => {
    const { api, store } = makeStore()
    api.remoteError = "ssh exited with code 255 before the tunnel was up:\nPermission denied (publickey)."
    await store.connectRemote({ target: "dev@box", hostPort: 7777 }, "secret")
    assert.equal(store.view.value, "welcome")
    assert.match(store.error.value ?? "", /Permission denied/)
    assert.equal(store.busy.value, null)
  })

  test("closing a remote engine disconnects, asking about unsaved changes as for a project", async () => {
    const { api, store } = makeStore()
    await store.connectRemote({ target: "dev@box", hostPort: 7777 }, "t")
    api.openScene = { path: "res://a.scene", name: "a", uuid: "u", revision: 2, savedRevision: 1 }
    api.unsavedAnswers = ["cancel"]
    await store.closeProject()
    assert.equal(store.view.value, "editor")
    assert.ok(
      api.asked.some((q) => q.startsWith("unsaved Disconnect without saving: a has unsaved changes. They stay in the remote host's memory")),
      "the question says the changes stay in the host"
    )
    api.unsavedAnswers = ["discard"]
    await store.closeProject()
    assert.equal(store.view.value, "welcome")
    assert.ok(api.calls.includes("close"))
  })

  test("closing the project goes back to the welcome screen", async () => {
    const { api, store } = makeStore()
    await store.openRecent("C:\\Games\\A")
    await store.closeProject()
    assert.equal(store.view.value, "welcome")
    assert.ok(api.calls.includes("close"))
  })

  test("the main process closing the project (a reload) shows the welcome screen too", async () => {
    const { api, store } = makeStore()
    await store.openRecent("C:\\Games\\A")
    api.pushHost({ status: "stopped", projectPath: null })
    assert.equal(store.view.value, "welcome")
  })

  test("closing a stopped host's project shows the welcome screen, though status and launch are unchanged", async () => {
    const { api, store } = makeStore()
    await store.openRecent("C:\\Games\\A")
    api.pushConnection(false)
    api.pushHost({ status: "stopped" })
    assert.equal(store.view.value, "editor", "stopping keeps the project open")
    api.pushHost({ status: "stopped", projectPath: null })
    assert.equal(store.view.value, "welcome")
  })

  test("removing a recent project and locating the host", async () => {
    const { store } = makeStore()
    await store.load()
    await store.removeRecent("C:\\Games\\A")
    assert.deepEqual(store.recent.value, ["C:\\Games\\B"])
    await store.locateHost()
    assert.equal(store.hostLocation.value?.path, "D:\\N2EditorHost.exe")
  })

  test("Create New Project picks a folder, asks for a name (the folder's by default) and creates it", async () => {
    const { api, store } = makeStore()
    await store.load()
    api.promptAnswers = ["My Game"]
    await store.createProject()
    assert.deepEqual(api.asked, ["prompt Project name: New"])
    assert.ok(api.calls.includes("create C:\\Games\\New name=My Game adopt=false"))
    assert.equal(store.projectPath.value, "C:\\Games\\New")
  })

  test("a cancelled folder or name creates nothing", async () => {
    const { api, store } = makeStore()
    api.newFolder = null
    await store.createProject()
    api.newFolder = "C:\\Games\\New"
    api.promptAnswers = [null]
    await store.createProject()
    assert.ok(!api.calls.some((c) => c.startsWith("create ")))
    assert.equal(store.view.value, "welcome")
  })

  test("creating in a folder that already is a project offers to open it", async () => {
    const { api, store } = makeStore()
    api.projectFolders.add("C:\\Games\\New")
    api.confirmAnswers = [true]
    await store.createProject()
    assert.match(
      api.asked[1],
      /^confirm Open project: C:\\Games\\New already has a project.n2proj; nothing was changed/
    )
    assert.ok(api.calls.includes("openFolder C:\\Games\\New"))
    assert.equal(store.projectPath.value, "C:\\Games\\New")
  })

  test("opening a folder that isn't a project offers to make it one, adopting it (its UUIDs kept)", async () => {
    const { api, store } = makeStore()
    await store.load()
    api.plainFolders.add("C:\\Games\\C")
    api.confirmAnswers = [true]
    await store.openProject()
    assert.match(api.asked[0], /^confirm Create project here: C:\\Games\\C isn't a project/)
    assert.equal(api.asked[1], "prompt Project name: C")
    assert.ok(api.calls.includes("create C:\\Games\\C name=C adopt=true"))
    assert.equal(store.projectPath.value, "C:\\Games\\C")
  })

  test("declining stays on the welcome screen", async () => {
    const { api, store } = makeStore()
    await store.load()
    api.plainFolders.add("C:\\Games\\C")
    await store.openProject()
    assert.equal(store.view.value, "welcome")
    assert.ok(!api.calls.some((c) => c.startsWith("create ")))
  })

  test("with a host that can't create, a folder that isn't a project is an error, not an offer", async () => {
    const { api, store } = makeStore()
    api.canCreate = false
    await store.load()
    api.plainFolders.add("C:\\Games\\C")
    await store.openProject()
    assert.deepEqual(api.asked, [])
    assert.match(store.error.value ?? "", /older than engine #90/)
  })

  test("Create is unavailable without a usable host, or with one older than engine #90", () => {
    const at = (canCreate: boolean | null, problem: string | null = null): HostLocation => ({
      path: "h",
      source: "setting",
      problem,
      canCreate,
    })
    assert.equal(createUnavailableReason(at(true)), null)
    assert.equal(createUnavailableReason(at(null)), null, "unknown: let --create itself say")
    assert.match(createUnavailableReason(at(false)) ?? "", /older than engine #90/)
    assert.match(createUnavailableReason(at(true, "Not found: h")) ?? "", /isn't set/)
    assert.match(createUnavailableReason(null) ?? "", /isn't set/)
  })

  describe("scene actions", () => {
    const a = "res://scenes/a.scene"
    /** A project with scene a open: clean, or dirty (revision 4, saved at 3) */
    async function withScene(dirty: boolean) {
      const made = makeStore()
      made.api.openScene = { path: a, name: "a", uuid: "u1", revision: dirty ? 4 : 3, savedRevision: 3 }
      await made.store.openProject()
      await settle()
      assert.equal(made.store.sceneDirty.value, dirty)
      return made
    }
    const engineCalls = (api: FakeApi) => api.calls.filter((c) => /^(openScene|newScene|saveSceneToFile)/.test(c))

    test("opening a scene opens it, and the loaded scene is the one answered", async () => {
      const { api, store } = await withScene(false)
      const result = await store.openScene("res://scenes/b.scene")
      assert.equal(result?.name, "b")
      assert.equal(store.scene.value?.path, "res://scenes/b.scene")
      assert.equal(store.sceneLabel.value, "b")
      assert.deepEqual(engineCalls(api), ["openScene res://scenes/b.scene"])
      assert.deepEqual(api.asked, [])
      assert.equal(store.busy.value, null)
    })

    test("unsaved changes: save then open, discard then open, or cancel", async () => {
      const { api, store } = await withScene(true)
      api.unsavedAnswers.push("cancel")
      assert.equal(await store.openScene("res://scenes/b.scene"), undefined)
      assert.deepEqual(engineCalls(api), [])
      assert.match(api.asked[0], /^unsaved Discard and open the scene: a has unsaved changes\.$/)

      api.unsavedAnswers.push("discard")
      assert.equal((await store.openScene("res://scenes/b.scene"))?.name, "b")
      assert.deepEqual(engineCalls(api), ["openScene res://scenes/b.scene"])

      // Dirty again, this time saved first (the scene has its file: no path is asked for)
      api.openScene = { path: a, name: "a", uuid: "u1", revision: 6, savedRevision: 5 }
      await store.refreshScene()
      assert.equal(store.sceneDirty.value, true)
      api.calls.length = 0
      api.unsavedAnswers.push("save")
      await store.openScene("res://scenes/c.scene")
      assert.deepEqual(engineCalls(api), ["saveSceneToFile ", "openScene res://scenes/c.scene"])
      assert.equal(store.scene.value?.name, "c")
    })

    test("a failed save stops the open that asked for it", async () => {
      const { api, store } = await withScene(true)
      api.unsavedAnswers.push("save")
      api.sceneError = "disk full"
      assert.equal(await store.openScene("res://scenes/b.scene"), undefined)
      assert.equal(store.error.value, "disk full")
      assert.equal(store.scene.value?.path, a)
      assert.deepEqual(engineCalls(api), ["saveSceneToFile "])
    })

    test("saving writes the scene's own file and shows it saved", async () => {
      const { api, store } = await withScene(true)
      const result = await store.saveScene()
      assert.deepEqual(engineCalls(api), ["saveSceneToFile "])
      assert.equal(result?.savedRevision, 4)
      assert.equal(store.sceneDirty.value, false)
      assert.equal(store.sceneLabel.value, "a")
    })

    test("a scene with no file asks for a path, and adds res:// and .scene to what is typed", async () => {
      const { api, store } = makeStore()
      api.openScene = { path: "", name: "Untitled", uuid: "u0", revision: 2, savedRevision: 0 }
      await store.openProject()
      await settle()
      api.promptAnswers.push("levels/First")
      await store.saveScene()
      assert.deepEqual(api.asked, ["prompt Save scene as (a res:// path): res://scenes/Untitled.scene"])
      assert.deepEqual(engineCalls(api), ["saveSceneToFile res://levels/First.scene"])
      assert.equal(store.scene.value?.path, "res://levels/First.scene")
      assert.equal(store.sceneDirty.value, false)

      // Cancelled: nothing is sent
      api.calls.length = 0
      api.promptAnswers.push(null)
      assert.equal(await store.saveSceneAs(), undefined)
      assert.deepEqual(engineCalls(api), [])
    })

    test("a new scene asks for its path, and unsaved changes first", async () => {
      const { api, store } = await withScene(true)
      api.promptAnswers.push("res://scenes/New.scene")
      api.unsavedAnswers.push("discard")
      const result = await store.newScene()
      assert.equal(result?.name, "New")
      assert.deepEqual(engineCalls(api), ["newScene res://scenes/New.scene name="])
      assert.equal(store.sceneDirty.value, false)

      // Cancelling the path asks nothing more
      api.calls.length = 0
      api.asked.length = 0
      api.promptAnswers.push(null)
      assert.equal(await store.newScene(), undefined)
      assert.deepEqual(api.asked, ["prompt New scene (a res:// path): res://scenes/Untitled.scene"])
      assert.deepEqual(engineCalls(api), [])
    })

    test("cancelling at the unsaved-changes question never asks for a path", async () => {
      const { api, store } = await withScene(true)
      api.unsavedAnswers.push("cancel")
      assert.equal(await store.newScene(), undefined)
      assert.equal(api.asked.length, 1)
      assert.match(api.asked[0], /^unsaved /)
      assert.deepEqual(engineCalls(api), [])
    })

    test("an edit the console hasn't polled yet still counts as unsaved changes", async () => {
      const { api, store } = await withScene(false)
      // The host's scene changed, and no sceneChanged event has been read yet
      api.openScene = { path: a, name: "a", uuid: "u1", revision: 9, savedRevision: 3 }
      assert.equal(store.sceneDirty.value, false)
      api.unsavedAnswers.push("cancel")
      assert.equal(await store.openScene("res://scenes/b.scene"), undefined)
      assert.match(api.asked[0], /^unsaved Discard and open the scene: a has unsaved changes\.$/)
    })

    test("restarting or stopping the host asks about unsaved changes, and a cancel keeps it running", async () => {
      const { api, store } = await withScene(true)
      api.unsavedAnswers.push("cancel", "cancel")
      await store.restartHost()
      await store.stopHost()
      assert.ok(!api.calls.includes("restart") && !api.calls.includes("stop"))
      assert.match(api.asked[0], /Discard and restart the host/)
      assert.match(api.asked[1], /Discard and stop the host/)
      api.unsavedAnswers.push("discard")
      await store.stopHost()
      assert.ok(api.calls.includes("stop"))
    })

    test("a path that can't be a scene's says why and sends nothing", async () => {
      const { api, store } = await withScene(false)
      for (const typed of ["C:\\Games\\P\\assets\\a.scene", "res://", "res://scenes/", "file:///x.scene"]) {
        store.dismissError()
        api.promptAnswers.push(typed)
        assert.equal(await store.newScene(), undefined, typed)
        assert.ok(store.error.value, typed)
      }
      assert.match(store.error.value ?? "", /starts with res:\/\//)
      assert.deepEqual(engineCalls(api), [])
    })

    test("the host's refusal (a file that exists, say) is shown and the scene stays", async () => {
      const { api, store } = await withScene(false)
      api.promptAnswers.push("res://scenes/a.scene")
      api.sceneError = "A file already exists at res://scenes/a.scene (open it with OpenScene)"
      assert.equal(await store.newScene(), undefined)
      assert.match(store.error.value ?? "", /already exists/)
      assert.equal(store.scene.value?.path, a)
    })

    test("closing the project asks about unsaved changes too", async () => {
      const { api, store } = await withScene(true)
      api.unsavedAnswers.push("cancel")
      await store.closeProject()
      assert.equal(store.view.value, "editor")
      assert.ok(!api.calls.includes("close"))
      api.unsavedAnswers.push("discard")
      await store.closeProject()
      assert.equal(store.view.value, "welcome")
    })

    test("closing the project asks about text files with unsaved changes, and ones without are no reason to ask", async () => {
      const { api, store } = await withScene(false)
      store.unsavedFiles = () => []
      api.confirmAnswers = []
      await store.closeProject()
      assert.equal(store.view.value, "welcome")
    })

    test("a dirty text file is asked about before the project closes", async () => {
      const { api, store } = await withScene(false)
      store.unsavedFiles = () => ["Player.lua"]
      api.confirmAnswers = [false]
      await store.closeProject()
      assert.equal(store.view.value, "editor")
      assert.ok(!api.calls.includes("close"))
      api.confirmAnswers = [true]
      await store.closeProject()
      assert.equal(store.view.value, "welcome")
    })

    test("newestSceneRevision is the newest revision an event named, and unknown after missed events", async () => {
      const { api, store, timers } = await withScene(false)
      assert.equal(store.newestSceneRevision, null)
      api.events.events.push({ seq: 1, kind: "sceneChanged", revision: 4, savedRevision: 3, path: a, entityIds: ["x"] })
      await timers.fire()
      assert.equal(store.newestSceneRevision, 4)
    })
  })

  test("describeHost", () => {
    const state = (status: HostState["status"]): HostState => ({ status, mode: "local", launch: 1, projectPath: "p", message: null })
    assert.equal(describeHost(state("starting"), false), "Starting the editor host...")
    assert.equal(describeHost(state("running"), false), "Connecting...")
    assert.equal(describeHost(state("running"), true), "Connected")
    assert.equal(describeHost(state("failed"), false), "The editor host failed")
    assert.equal(describeHost(state("stopped"), false), "Editor host stopped")
    const remote = (status: HostState["status"]): HostState => ({ ...state(status), mode: "remote" })
    assert.equal(describeHost(remote("starting"), false), "Opening the SSH tunnel...")
    assert.equal(describeHost(remote("running"), true), "Connected (remote)")
    assert.equal(describeHost(remote("running"), false), "Disconnected from the remote host")
    assert.equal(describeHost(remote("exited"), false), "The SSH tunnel ended")
    assert.equal(describeHost(remote("failed"), false), "The SSH tunnel failed")
  })
})

describe("EditorStore: the undo history", () => {
  const a = "res://assets/scenes/a.scene"
  const entries = [
    { label: "Create Cube", bytes: 100 },
    { label: "Move Cube", bytes: 100 },
  ]
  const history = (extra: Partial<EditorEvent> = {}): EditorEvent => ({
    seq: 1,
    kind: "historyChanged",
    canUndo: true,
    canRedo: false,
    label: "Delete Cube",
    redoLabel: "",
    undoCount: 3,
    redoCount: 0,
    ...extra,
  })

  test("is read on connecting (a running host has one), and historyChanged events keep it current", async () => {
    const { api, store, timers } = makeStore()
    assert.equal(store.history.value.canUndo, false)
    api.history = { cursor: 1, entries }
    await store.openProject()
    await settle()
    assert.deepEqual(store.history.value, {
      canUndo: true,
      canRedo: true,
      label: "Create Cube",
      redoLabel: "Move Cube",
      undoCount: 1,
      redoCount: 1,
    })

    api.events.events.push(history())
    await timers.fire()
    assert.deepEqual(store.history.value, {
      canUndo: true,
      canRedo: false,
      label: "Delete Cube",
      redoLabel: "",
      undoCount: 3,
      redoCount: 0,
    })

    // A group opening: nothing can be undone while it is open
    api.events.events.push(history({ seq: 2, canUndo: false, label: "", undoCount: 3 }))
    await timers.fire()
    assert.equal(store.history.value.canUndo, false)
  })

  test("a GetHistory answer that began before a newer event doesn't replace it", async () => {
    const { api, store, timers } = makeStore()
    await store.openProject()
    await settle()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    api.engine.getHistory = async () => {
      await gate
      return { cursor: 0, entries: [] }
    }
    const read = store.refreshHistory()
    api.events.events.push(history())
    await timers.fire()
    release()
    await read
    assert.equal(store.history.value.label, "Delete Cube")
  })

  test("it is empty when the connection drops, and for a host without the command", async () => {
    const { api, store } = makeStore()
    api.history = { cursor: 1, entries }
    await store.openProject()
    await settle()
    assert.equal(store.history.value.canUndo, true)
    api.pushConnection(false)
    assert.equal(store.history.value.canUndo, false)
    assert.equal(store.history.value.label, "")

    api.engine.getHistory = async () => {
      throw new Error("Unknown command 0x94")
    }
    api.pushConnection(true)
    await settle()
    assert.equal(store.history.value.canUndo, false)
  })

  test("missed events read the history again", async () => {
    const { api, store, timers } = makeStore()
    await store.openProject()
    await timers.fire()
    await settle()
    api.history = { cursor: 2, entries }
    api.events.restart("another host") // a new log: events may have been missed
    await timers.fire()
    await settle()
    assert.equal(store.history.value.label, "Move Cube")
  })

  test("undoing back to the saved state clears the unsaved marker, and redoing away brings it back", async () => {
    const { api, store, timers } = makeStore()
    api.openScene = { path: a, name: "a", uuid: "u1", revision: 3, savedRevision: 3 }
    await store.openProject()
    await settle()

    api.events.events.push({ seq: 1, kind: "sceneChanged", revision: 4, savedRevision: 3, path: a, entityIds: ["x"] })
    await timers.fire()
    assert.equal(store.sceneDirty.value, true)

    // Undo: the revision moves on, and the host says the saved state is the new revision
    const undone = { label: "Create Cube", revision: 5, canUndo: false, canRedo: true, savedRevision: 5 }
    store.applyEditResult(undone)
    assert.equal(store.sceneDirty.value, false)
    assert.equal(store.sceneLabel.value, "a")
    // The same answer's event, arriving later, agrees
    api.events.events.push({ seq: 2, kind: "sceneChanged", revision: 5, savedRevision: 5, path: a, entityIds: ["x"] })
    await timers.fire()
    assert.equal(store.sceneDirty.value, false)

    // Redo: dirty again
    store.applyEditResult({ ...undone, revision: 6, savedRevision: 5, canUndo: true, canRedo: false })
    assert.equal(store.sceneDirty.value, true)
    assert.equal(store.sceneLabel.value, "a *")

    // An answer older than what is known is ignored, and none without a scene does nothing
    store.applyEditResult({ ...undone, revision: 2, savedRevision: 2 })
    assert.equal(store.scene.peek()?.revision, 6)
    api.pushConnection(false)
    store.applyEditResult(undone)
    assert.equal(store.scene.peek(), null)
  })

  test("an undo that restored a snapshot is a full scene change for the panels", async () => {
    const { api, store, timers } = makeStore()
    api.openScene = { path: a, name: "a", uuid: "u1", revision: 3, savedRevision: 3 }
    await store.openProject()
    await settle()
    api.events.events.push({
      seq: 1,
      kind: "sceneChanged",
      revision: 4,
      savedRevision: 3,
      path: a,
      entityIds: [],
      full: true,
    })
    api.events.events.push(history({ seq: 2 }))
    await timers.fire()
    assert.deepEqual(store.lastSceneChange.value, { full: true, entityIds: [] })
    assert.equal(store.history.value.label, "Delete Cube")
  })

  test("syncAfterEdit polls the host's events and reads the history", async () => {
    const { api, store } = makeStore()
    await store.openProject()
    await settle()
    const polls = api.events.polls.length
    api.history = { cursor: 2, entries }
    await store.syncAfterEdit()
    assert.equal(api.events.polls.length, polls + 1)
    assert.equal(store.history.value.label, "Move Cube")
  })
})

describe("EditorStore: autosave recovery", () => {
  const a = "res://assets/scenes/a.scene"
  const found: AutosaveInfo = {
    exists: true,
    path: "C:/p/.n2/autosave/scenes/a.scene",
    size: 2048,
    modified: 1_790_000_000_000,
  }

  const opened = async (api: FakeApi, store: EditorStore) => {
    api.openScene = { path: a, name: "a", uuid: "u1", revision: 1, savedRevision: 1 }
    await store.openProject()
    await settle()
    await settle()
  }

  test("an autosave found when a scene is opened asks, with the scene, its size and its time", async () => {
    const { api, store } = makeStore()
    api.autosave = found
    await opened(api, store)
    assert.equal(api.asked.length, 1)
    assert.match(api.asked[0], /^autosave: a has an autosave from a session that ended with unsaved changes \(written /)
    assert.match(api.asked[0], /2\.0 KB\)/)
    // "Decide later" (the default answer) does nothing to the host
    assert.deepEqual(api.autosaveCalls, ["getAutosave"])
    assert.equal(store.scene.peek()?.revision, 1)
  })

  test("Restore restores it as the scene, and everything refetches", async () => {
    const { api, store } = makeStore()
    api.autosave = found
    api.autosaveAnswers = ["restore"]
    api.restored = { path: a, name: "a", uuid: "u1", revision: 2, savedRevision: 1 }
    const before = store.sceneChangeCount.value
    await opened(api, store)
    assert.deepEqual(api.autosaveCalls, ["getAutosave", "restoreAutosave"])
    assert.equal(store.sceneDirty.value, true)
    assert.equal(store.scene.peek()?.revision, 2)
    assert.deepEqual(store.lastSceneChange.value, { full: true, entityIds: [] })
    assert.ok(store.sceneChangeCount.value > before)
    assert.equal(store.error.value, null)
  })

  test("a refused restore shows the host's message and leaves the scene", async () => {
    const { api, store } = makeStore()
    api.autosave = found
    api.autosaveAnswers = ["restore"]
    api.restored = null // RestoreAutosave answers an Error
    await opened(api, store)
    assert.match(store.error.value ?? "", /There is no autosave/)
    assert.equal(store.scene.peek()?.revision, 1)
    assert.equal(store.busy.value, null)
  })

  test("Discard deletes it", async () => {
    const { api, store } = makeStore()
    api.autosave = found
    api.autosaveAnswers = ["discard"]
    await opened(api, store)
    assert.deepEqual(api.autosaveCalls, ["getAutosave", "discardAutosave"])
  })

  test("no autosave, or a host that doesn't have the command, asks nothing", async () => {
    const first = makeStore()
    await opened(first.api, first.store)
    assert.deepEqual(first.api.asked, [])

    const old = makeStore()
    old.api.autosave = null
    await opened(old.api, old.store)
    assert.deepEqual(old.api.asked, [])
    assert.equal(old.store.error.value, null)
  })

  test("a scene with unsaved changes is the host's own: its autosave is not a recovery", async () => {
    const { api, store } = makeStore()
    api.autosave = found
    api.openScene = { path: a, name: "a", uuid: "u1", revision: 5, savedRevision: 3 }
    await store.openProject()
    await settle()
    await settle()
    assert.deepEqual(api.asked, [])
  })

  test("the same scene is asked about once per connection, and again after it is opened again", async () => {
    const { api, store, timers } = makeStore()
    api.autosave = found
    await opened(api, store)
    assert.equal(api.asked.length, 1)

    // The scene is fetched again: not asked again
    await store.refreshScene()
    await settle()
    assert.equal(api.asked.length, 1)

    // Opening it again is reverting it: an autosave found then is a crash's
    await store.openScene(a)
    await settle()
    await settle()
    assert.equal(api.asked.length, 2)

    // Another scene is another question
    const b = "res://assets/scenes/b.scene"
    api.openScene = { path: b, name: "b", uuid: "u2", revision: 1, savedRevision: 1 }
    api.events.events.push({ seq: 1, kind: "sceneChanged", revision: 1, savedRevision: 1, path: b })
    await timers.fire()
    await settle()
    await settle()
    assert.equal(api.asked.length, 3)
    assert.match(api.asked[2], /^autosave: b has/)
  })

  test("a connection that ends closes the question on screen, which is not an answer; the next connection asks again", async () => {
    const { api, store } = makeStore()
    api.autosave = found
    api.autosaveHold = true
    api.restored = { path: a, name: "a", uuid: "u1", revision: 2, savedRevision: 1 }
    await opened(api, store)
    assert.equal(api.asked.length, 1)
    const dismissedBefore = api.dismissed

    api.pushConnection(false)
    await settle()
    assert.equal(api.dismissed, dismissedBefore + 1, "the question was about a host that is gone")
    assert.equal(store.autosaveDeferred.value, null, "closing it is not 'decide later'")
    assert.equal(store.autosaveOutstanding.value, false)

    api.pushConnection(true)
    await settle()
    await settle()
    assert.equal(api.asked.length, 2, "asked again on the new connection")
    assert.deepEqual(api.autosaveCalls.filter((c) => c !== "getAutosave"), [], "nothing was sent for the old answer")
    api.answerAutosave("restore")
    await settle()
    await settle()
    assert.deepEqual(api.autosaveCalls.filter((c) => c !== "getAutosave"), ["restoreAutosave"])
  })

  test("an answer is for the scene that was asked about: for another it is dropped, and the loaded one is asked", async () => {
    const { api, store, timers } = makeStore()
    api.autosave = found
    api.autosaveHold = true
    await opened(api, store)
    assert.equal(api.asked.length, 1)

    // While the question is on screen another scene is loaded: its own question can't be asked yet (one at a time)
    const b = "res://assets/scenes/b.scene"
    api.openScene = { path: b, name: "b", uuid: "u2", revision: 1, savedRevision: 1 }
    api.events.events.push({ seq: 1, kind: "sceneChanged", revision: 1, savedRevision: 1, path: b })
    await timers.fire()
    await settle()
    assert.equal(api.asked.length, 1)

    api.answerAutosave("restore") // meant for a
    await settle()
    await settle()
    assert.deepEqual(api.autosaveCalls.filter((c) => c === "restoreAutosave" || c === "discardAutosave"), [], "not applied to b")
    assert.equal(api.asked.length, 2)
    assert.match(api.asked[1], /^autosave: b has an autosave/)
    api.autosaveHold = false
    api.answerAutosave("discard") // for b
    await settle()
    await settle()
    assert.deepEqual(api.autosaveCalls.filter((c) => c === "discardAutosave"), ["discardAutosave"])
  })

  test("a failed restore asks again, saying why, so a bad file can be discarded", async () => {
    const { api, store } = makeStore()
    api.autosave = found
    api.autosaveAnswers = ["restore", "discard"]
    api.restored = null // RestoreAutosave answers an Error
    await opened(api, store)
    assert.equal(api.asked.length, 2)
    assert.match(api.asked[1], /^autosave: The autosave couldn't be restored: There is no autosave\n\na has an autosave/)
    assert.deepEqual(api.autosaveCalls, ["getAutosave", "restoreAutosave", "discardAutosave"])
    assert.equal(store.autosaveOutstanding.value, false)
  })

  test("Decide later, or a failed restore, leaves a decision outstanding that Recover autosave asks again, even for a dirty scene", async () => {
    const { api, store, timers } = makeStore()
    api.autosave = found
    api.autosaveAnswers = ["later"]
    await opened(api, store)
    assert.equal(store.autosaveOutstanding.value, true)

    // The scene is edited meanwhile: the automatic question would skip it, the menu's doesn't
    api.events.events.push({ seq: 1, kind: "sceneChanged", revision: 3, savedRevision: 1, path: a, entityIds: ["x"] })
    await timers.fire()
    assert.equal(store.sceneDirty.value, true)
    api.autosaveAnswers = ["restore"]
    api.restored = { path: a, name: "a", uuid: "u1", revision: 4, savedRevision: 1 }
    await store.recoverAutosave()
    assert.equal(api.asked.length, 2)
    assert.deepEqual(api.autosaveCalls.filter((c) => c === "restoreAutosave"), ["restoreAutosave"])
    assert.equal(store.autosaveOutstanding.value, false)
  })

  test("a decision outstanding for an autosave that is gone (saved meanwhile) is forgotten when asked", async () => {
    const { api, store } = makeStore()
    api.autosave = found
    await opened(api, store)
    assert.equal(store.autosaveOutstanding.value, true)
    api.autosave = { exists: false }
    await store.recoverAutosave()
    assert.equal(store.autosaveOutstanding.value, false)
    assert.equal(api.asked.length, 1)
  })

  test("the outstanding decision belongs to the scene and the connection", async () => {
    const { api, store, timers } = makeStore()
    api.autosave = found
    await opened(api, store)
    assert.equal(store.autosaveOutstanding.value, true)
    api.autosave = { exists: false }
    const b = "res://assets/scenes/b.scene"
    api.openScene = { path: b, name: "b", uuid: "u2", revision: 1, savedRevision: 1 }
    api.events.events.push({ seq: 1, kind: "sceneChanged", revision: 1, savedRevision: 1, path: b })
    await timers.fire()
    await settle()
    assert.equal(store.autosaveOutstanding.value, false, "b has none outstanding")
    api.openScene = { path: a, name: "a", uuid: "u1", revision: 1, savedRevision: 1 }
    api.pushConnection(false)
    api.pushConnection(true)
    await settle()
    assert.equal(store.autosaveDeferred.value, null)
  })

  test("a new scene and Save As ask about the autosave of the file they land on, as Open does", async () => {
    const { api, store } = makeStore()
    api.autosave = found
    api.autosaveAnswers = ["discard", "discard", "discard"]
    await opened(api, store)
    api.asked.length = 0
    api.autosaveCalls.length = 0

    api.promptAnswers = ["res://scenes/n.scene"]
    await store.newScene()
    await settle()
    await settle()
    assert.equal(api.asked.filter((m) => m.startsWith("autosave:")).length, 1)
    assert.match(api.asked.find((m) => m.startsWith("autosave:"))!, /^autosave: n has an autosave/)

    api.asked.length = 0
    api.promptAnswers = ["res://scenes/copy.scene"]
    await store.saveSceneAs()
    await settle()
    await settle()
    assert.match(api.asked.find((m) => m.startsWith("autosave:"))!, /^autosave: copy has an autosave/)
    assert.deepEqual(api.autosaveCalls.filter((c) => c === "discardAutosave").length, 2)
  })

  test("a GetAutosave that failed is not an answer: the scene is asked about again the next time it is fetched", async () => {
    const { api, store } = makeStore()
    api.autosave = null // a transient failure
    await opened(api, store)
    assert.deepEqual(api.asked, [])
    api.autosave = found
    await store.refreshScene()
    await settle()
    await settle()
    assert.equal(api.asked.length, 1)
  })

  test("the question is on screen before GetAutosave of another scene can start a second one", async () => {
    const { api, store } = makeStore()
    api.autosave = found
    api.autosaveHold = true
    api.openScene = { path: a, name: "a", uuid: "u1", revision: 1, savedRevision: 1 }
    await store.openProject()
    // Two checks at once (an open and a fetch): one question
    void store.checkAutosave(api.openScene)
    void store.checkAutosave(api.openScene)
    await settle()
    await settle()
    assert.equal(api.asked.length, 1)
  })

  test("canEdit: connected, with a scene, not busy, and not a play session", async () => {
    const { api, store } = makeStore()
    assert.equal(store.canEdit.value, false)
    api.openScene = { path: a, name: "a", uuid: "u1", revision: 1, savedRevision: 1 }
    await store.openProject()
    await settle()
    assert.equal(store.canEdit.value, true)

    store.setPlayMode("A play session is running")
    assert.equal(store.canEdit.value, false)
    store.setPlayMode(null)
    assert.equal(store.canEdit.value, true)

    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    api.engine.saveSceneToFile = async () => {
      await gate
      return api.openScene!
    }
    const saving = store.saveScene()
    assert.equal(store.canEdit.value, false, "busy saving")
    release()
    await saving
    assert.equal(store.canEdit.value, true)

    api.pushConnection(false)
    assert.equal(store.canEdit.value, false)
  })
})

describe("EditorStore while a game runs", () => {
  test("opening and creating scenes is refused with a message, and the host is not asked", async () => {
    const { api, store } = makeStore()
    await store.openProject()
    await Promise.resolve()
    store.setPlayMode("the game is running")
    assert.equal(store.canEdit.value, false)
    const before = api.calls.length
    assert.equal(await store.openScene("res://scenes/Other.scene"), undefined)
    assert.match(store.error.value ?? "", /Open scene: not while the game is running/)
    store.dismissError()
    assert.equal(await store.newScene(), undefined)
    assert.match(store.error.value ?? "", /New scene: not while the game is running/)
    assert.equal(api.calls.length, before)
    store.setPlayMode(null)
    assert.equal(store.refusedWhilePlaying("x"), false)
  })
})

describe("EditorStore autosave recovery while a game runs", () => {
  test("Recover autosave is refused", async () => {
    const { api, store } = makeStore()
    await store.openProject()
    await Promise.resolve()
    store.setPlayMode("the game is running")
    const before = api.calls.length
    await store.recoverAutosave()
    assert.match(store.error.value ?? "", /Recover autosave: not while the game is running/)
    assert.equal(api.calls.length, before)
  })
})
