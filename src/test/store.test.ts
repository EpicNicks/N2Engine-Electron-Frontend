import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { EditorEvent, EventsResponse } from "../protocol/protocol.generated"
import type { HostLocation, HostState, ServerInfo } from "../shared/api"
import type { Timers } from "../protocol/event-pump"
import { ConsoleStore, entryFromEvent } from "../renderer/console-store"
import { EditorStore, StoreApi, describeHost } from "../renderer/store"

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
        ["warn", "7 host log lines were dropped before the editor read them"],
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
  hostState: HostState = { status: "stopped", launch: 0, projectPath: null, message: null }
  connectedNow = false
  info: ServerInfo = { protocolVersion: "1.2.0", engineVersion: "1.0.0", capabilities: [], projectLoaded: true }
  recentList = ["C:\\Games\\A", "C:\\Games\\B"]
  events = new FakeHostEvents()
  hostListeners: Array<(state: HostState) => void> = []
  connectionListeners: Array<(connected: boolean) => void> = []
  /** What openDialog resolves with, or a failure */
  dialogResult: string | null | Error = "C:\\Games\\C"
  calls: string[] = []

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
  }

  host = {
    state: () => this.hostState,
    onStateChange: (listener: (state: HostState) => void) => this.hostListeners.push(listener),
    restart: async () => {
      this.calls.push("restart")
    },
    stop: async () => {
      this.calls.push("stop")
    },
    location: async (): Promise<HostLocation> => ({ path: "C:\\N2EditorHost.exe", source: "setting", problem: null }),
    locate: async (): Promise<HostLocation | null> => ({
      path: "D:\\N2EditorHost.exe",
      source: "setting",
      problem: null,
    }),
  }

  project = {
    openDialog: async () => {
      this.calls.push("openDialog")
      const result = this.dialogResult
      if (result instanceof Error) throw result
      if (result) this.launchAndConnect(result)
      return result
    },
    createDialog: async () => {
      this.calls.push("createDialog")
      throw new Error("This N2EditorHost doesn't support --create: it started an editor host instead.")
    },
    openRecent: async (projectPath: string) => {
      this.calls.push(`openRecent ${projectPath}`)
      this.launchAndConnect(projectPath)
      return projectPath
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

  test("busy while an action runs", async () => {
    const { api, store } = makeStore()
    let release: () => void = () => {}
    api.project.openRecent = (projectPath: string) => new Promise((resolve) => (release = () => resolve(projectPath)))
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

    await store.createProject()
    assert.match(store.error.value ?? "", /--create/)
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

  test("removing a recent project and locating the host", async () => {
    const { store } = makeStore()
    await store.load()
    await store.removeRecent("C:\\Games\\A")
    assert.deepEqual(store.recent.value, ["C:\\Games\\B"])
    await store.locateHost()
    assert.equal(store.hostLocation.value?.path, "D:\\N2EditorHost.exe")
  })

  test("describeHost", () => {
    const state = (status: HostState["status"]): HostState => ({ status, launch: 1, projectPath: "p", message: null })
    assert.equal(describeHost(state("starting"), false), "Starting the editor host...")
    assert.equal(describeHost(state("running"), false), "Connecting...")
    assert.equal(describeHost(state("running"), true), "Connected")
    assert.equal(describeHost(state("failed"), false), "The editor host failed")
    assert.equal(describeHost(state("stopped"), false), "Editor host stopped")
  })
})
