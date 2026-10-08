import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { EventsResponse } from "../protocol/protocol.generated"
import { GameEndedMessage, InitialPlayState, PlayState } from "../shared/api"
import { ConsoleEntry } from "../renderer/console-store"
import {
  PlayControllerApi,
  PlayController,
  PlayReadOnlyReason,
  PlayRefreshMs,
  describePlay,
} from "../renderer/play-controller"

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const state = (status: PlayState["status"], extra: Partial<PlayState> = {}): PlayState => ({
  ...InitialPlayState,
  status,
  launch: 1,
  ...extra,
})

class FakeApi implements PlayControllerApi {
  current: PlayState = InitialPlayState
  listener: ((s: PlayState) => void) | null = null
  calls: string[] = []
  failNext: string | null = null
  polls: Array<[number, number, number]> = []
  events: Array<Record<string, unknown>> = []

  state(): PlayState {
    return this.current
  }
  onStateChange(listener: (s: PlayState) => void): void {
    this.listener = listener
  }
  /** The main process pushes a state */
  push(next: PlayState): void {
    this.current = next
    this.listener?.(next)
  }
  private act(call: string): Promise<void> {
    this.calls.push(call)
    if (this.failNext) {
      const message = this.failNext
      this.failNext = null
      return Promise.reject(new Error(message))
    }
    return Promise.resolve()
  }
  start = () => this.act("start")
  stop = () => this.act("stop")
  setPaused = (paused: boolean) => this.act(`setPaused ${paused}`)
  step = (frames: number) => this.act(`step ${frames}`)
  refresh = async (): Promise<PlayState> => {
    this.calls.push("refresh")
    return this.current
  }
  pollEvents = async (epoch: number, afterSeq: number, maxEvents: number): Promise<EventsResponse> => {
    this.polls.push([epoch, afterSeq, maxEvents])
    const events = this.events.splice(0)
    return { epoch: 7, nextSeq: afterSeq + events.length, dropped: 0, events } as unknown as EventsResponse
  }
}

function setup(options: { canStart?: boolean } = {}) {
  const api = new FakeApi()
  const pumpCallbacks: Array<() => void> = []
  const modes: Array<string | null> = []
  const logs: Array<Omit<ConsoleEntry, "id">> = []
  const notes: Array<[string, string]> = []
  const errors: string[] = []
  const timers: Array<{ callback: () => void; ms: number; stopped: boolean }> = []
  let canStart = options.canStart ?? true
  const controller = new PlayController({
    api,
    setPlayMode: (reason) => modes.push(reason),
    canStart: () => canStart,
    addLog: (entries) => logs.push(...entries),
    note: (level, message) => notes.push([level, message]),
    onError: (what, e) => errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`),
    every: (callback, ms) => {
      const timer = { callback, ms, stopped: false }
      timers.push(timer)
      return () => (timer.stopped = true)
    },
    // The events pump polls on a timer of its own; tests run it by hand
    eventOptions: {
      timers: {
        setTimeout: (callback) => {
          pumpCallbacks.push(callback)
          return pumpCallbacks.length
        },
        clearTimeout: () => {},
      },
    },
  })
  const poll = async (): Promise<void> => {
    pumpCallbacks.shift()?.()
    await turn()
  }
  return { api, controller, modes, logs, notes, errors, timers, poll, setCanStart: (v: boolean) => (canStart = v) }
}

describe("PlayController", () => {
  test("starts stopped, with Play available when the editor can start a game", () => {
    const t = setup()
    assert.equal(t.controller.active.value, false)
    assert.equal(t.controller.live.value, false)
    assert.equal(t.controller.canPlay.value, true)
    assert.equal(t.controller.text.value, "")
  })

  test("Play is unavailable while the editor can't start (no scene, busy, not connected)", async () => {
    const t = setup({ canStart: false })
    await t.controller.start()
    assert.deepEqual(t.api.calls, [])
  })

  test("a game starting makes the scene read-only, from the first state to the last", async () => {
    const t = setup()
    await t.controller.start()
    assert.deepEqual(t.api.calls, ["start"])
    t.api.push(state("starting"))
    assert.deepEqual(t.modes.slice(-1), [PlayReadOnlyReason])
    assert.equal(t.controller.active.value, true)
    assert.equal(t.controller.live.value, false, "the editor view stays until the game is connected")
    assert.equal(t.controller.canPlay.value, false)
    t.api.push(state("playing"))
    assert.equal(t.controller.live.value, true)
    t.api.push(state("stopped", { message: null }))
    assert.deepEqual(t.modes.slice(-1), [null])
    assert.equal(t.controller.canPlay.value, true)
  })

  test("while the game is live its frame counter is read every 250 ms, and the child's events are followed", async () => {
    const t = setup()
    t.api.push(state("starting"))
    t.api.push(state("playing"))
    assert.equal(t.timers.length, 1)
    assert.equal(t.timers[0].ms, PlayRefreshMs)
    t.timers[0].callback()
    assert.deepEqual(t.api.calls, ["refresh"])
    // The child's log is read from its start (a new log: epoch 0, seq 0)
    await t.poll()
    assert.deepEqual(t.api.polls[0], [0, 0, 256])
    t.api.push(state("stopped"))
    assert.equal(t.timers[0].stopped, true)
  })

  test("the game's log lines join the console as the game's, with their levels", async () => {
    const t = setup()
    t.api.push(state("playing"))
    t.api.events.push(
      { kind: "log", level: "warn", message: "low health", time: 5 },
      { kind: "log", level: "error", message: "Lua: nil", time: 6 },
      { kind: "sceneChanged", revision: 3 }
    )
    await t.poll()
    assert.deepEqual(
      t.logs.map((e) => [e.level, e.message, e.source]),
      [
        ["warn", "low health", "game"],
        ["error", "Lua: nil", "game"],
      ]
    )
  })

  test("a playState event refreshes the toolbar at once", async () => {
    const t = setup()
    t.api.push(state("playing"))
    t.api.events.push({ kind: "playState", state: "Paused", frame: 40 })
    await t.poll()
    assert.equal(t.api.calls.includes("refresh"), true)
  })

  test("pause, resume and step go to the game; step only while paused", async () => {
    const t = setup()
    await t.controller.setPaused(true)
    assert.deepEqual(t.api.calls, [], "no game, nothing to pause")
    t.api.push(state("playing"))
    await t.controller.togglePause()
    t.api.push(state("paused", { frame: 12 }))
    await t.controller.step()
    await t.controller.step(5000)
    await t.controller.togglePause()
    assert.deepEqual(t.api.calls, ["setPaused true", "step 1", "step 1000", "setPaused false"])
    t.api.push(state("playing"))
    t.api.calls.length = 0
    await t.controller.step(1)
    assert.deepEqual(t.api.calls, [])
  })

  test("a failed request is shown, and a cancelled one isn't", async () => {
    const t = setup()
    t.api.failNext = "No project is open"
    await t.controller.start()
    assert.deepEqual(t.errors, ["The game couldn't start: No project is open"])
    t.api.failNext = "Cancelled: play was stopped while it started"
    await t.controller.start()
    assert.equal(t.errors.length, 1)
    assert.equal(t.controller.busy.value, false)
  })

  test("a snapshot or launch failure is in the console", () => {
    const t = setup()
    t.api.push(state("starting"))
    t.api.push(state("failed", { message: "Couldn't start the game: bad scene" }))
    assert.deepEqual(t.notes.slice(-1), [["error", "Couldn't start the game: bad scene"]])
    assert.equal(t.controller.active.value, false)
    assert.equal(t.controller.text.value, "The game couldn't start")
    assert.deepEqual(t.modes.slice(-1), [null])
  })

  test("a crash is in the console and on the banner; a game that quit is just a note", () => {
    const t = setup()
    t.api.push(state("playing"))
    t.api.push(state("exited", { message: "The game exited with code 139:\nLua: boom" }))
    assert.deepEqual(t.notes.slice(-1), [["error", "The game exited with code 139:\nLua: boom"]])
    assert.equal(t.errors.length, 1)
    assert.match(t.errors[0], /The game stopped unexpectedly: The game exited with code 139/)
    assert.equal(t.controller.text.value, "The game crashed")

    const u = setup()
    u.api.push(state("playing"))
    u.api.push(state("exited", { message: GameEndedMessage }))
    assert.deepEqual(u.notes.slice(-1), [["info", "The game ended"]])
    assert.deepEqual(u.errors, [])
    assert.equal(u.controller.text.value, "The game ended")
  })

  test("a stop, and the editor host going away, are noted", () => {
    const t = setup()
    t.api.push(state("playing"))
    t.api.push(state("stopped", { message: "The editor host's connection ended" }))
    assert.deepEqual(t.notes.slice(-1), [["info", "The editor host's connection ended"]])
    const u = setup()
    u.api.push(state("playing"))
    u.api.push(state("stopped"))
    assert.deepEqual(u.notes.slice(-1), [["info", "The game was stopped"]])
  })

  test("a failure of the picture or audio while the game still runs is shown; once it is gone it isn't", async () => {
    const t = setup()
    t.api.push(state("playing"))
    await t.controller.failure("The game's picture stopped", new Error("boom"))
    assert.deepEqual(t.errors, ["The game's picture stopped: boom"])
    // The game ended while the failure was on its way
    t.api.refresh = async () => {
      t.api.push(state("exited", { message: GameEndedMessage }))
      return t.api.current
    }
    await t.controller.failure("The game's picture stopped", new Error("Connection closed"))
    assert.equal(t.errors.length, 1)
    // And with no game at all
    await t.controller.failure("x", new Error("y"))
    assert.equal(t.errors.length, 1)
  })

  test("a new game starts a new log for its events", async () => {
    const t = setup()
    t.api.push(state("playing", { launch: 1 }))
    t.api.events.push({ kind: "log", level: "info", message: "one", time: 1 })
    await t.poll()
    t.api.push(state("stopped", { launch: 1 }))
    t.api.push(state("playing", { launch: 2 }))
    await t.poll()
    assert.deepEqual(t.api.polls[t.api.polls.length - 1], [0, 0, 256])
  })

  test("the toolbar's words", () => {
    assert.equal(describePlay(state("starting")), "Starting the game...")
    assert.equal(describePlay(state("playing", { frame: 120, time: 2.04 })), "Playing: frame 120, 2.0 s")
    assert.equal(describePlay(state("paused", { frame: 3, time: 0.06 })), "Paused: frame 3, 0.1 s")
    assert.equal(describePlay(state("stopped")), "")
  })
})
