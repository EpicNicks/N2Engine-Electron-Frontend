// The Profiler's logic (FE-S5, protocol 1.28.0): the EngineStats shape check, the client-side frame history, the summary
// maths, and ProfilerModel's polling (start and stop, one request at a time, an older host, a switch of host).
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { signal } from "@preact/signals-core"
import {
  EngineStatsCapability,
  EngineStatsPollMs,
  FrameHistory,
  LuaMemoryWarnShare,
  formatBytes,
  formatMs,
  luaMemoryShare,
  summarise,
  timingOf,
  validateEngineStats,
} from "../protocol/engine-stats"
import { decodeEngineStatsResponse, type EngineFrameRecord, type EngineStats } from "../protocol/protocol.generated"
import { ProfilerModel, ProfilerUnsupportedReason, type ProfilerDeps, type ProfilerTarget } from "../renderer/profiler-state"
import { EngineCommandArgs, PlayCommandArgs } from "../shared/api"

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function rec(frame: number, over: Partial<EngineFrameRecord> = {}): EngineFrameRecord {
  return {
    frame,
    intervalMs: 16,
    tickMs: 4,
    fixedMs: 1.5,
    fixedTicks: 1,
    physicsMs: 1,
    updateMs: 1,
    audioMs: 0.5,
    renderMs: 0,
    commandsMs: 0,
    renderRequestMs: 0,
    readbackMs: 0,
    ...over,
  }
}

function stats(frames: EngineFrameRecord[], over: Partial<EngineStats> = {}): EngineStats {
  return {
    host: { kind: "play", state: "Playing", renderer: "OpenGL", timersEnabled: true, timeScale: 1 },
    frame: frames.length === 0 ? 0 : frames[frames.length - 1].frame,
    frames,
    summary: { windowFrames: frames.length, fps: 60, tickMs: { avg: 4, p95: 4, max: 4 } },
    ...over,
  }
}

describe("the EngineStats answer (protocol 1.28.0)", () => {
  const vectorsPath = path.join(__dirname, "..", "..", "src", "protocol", "test-vectors.json")
  const vectors = JSON.parse(fs.readFileSync(vectorsPath, "utf-8")) as {
    responseVariants: Array<{ response: string; payload: string; fields: { stats: unknown } }>
  }

  test("the engine's golden EngineStats variant decodes and passes the shape check unchanged", () => {
    const variant = vectors.responseVariants.find((v) => v.response === "EngineStats")
    assert.ok(variant, "test-vectors.json has an EngineStats variant")
    const decoded = decodeEngineStatsResponse(Uint8Array.from(Buffer.from(variant.payload, "hex")))
    const checked = validateEngineStats(decoded.stats)
    assert.deepEqual(checked, variant.fields.stats)
    assert.equal(checked.physics?.backend, "physx")
  })

  test("the blocks a host leaves out stay absent; a record's missing numbers read as 0", () => {
    const checked = validateEngineStats({
      host: { kind: "edit", state: "Edit", timersEnabled: true, timeScale: 1 },
      frame: 3,
      frames: [{ frame: 3, tickMs: 2 }],
      summary: { windowFrames: 0, fps: 0, tickMs: { avg: 0, p95: 0, max: 0 } },
    })
    assert.equal(checked.render, undefined)
    assert.equal(checked.process, undefined)
    assert.equal(checked.frames[0].tickMs, 2)
    assert.equal(checked.frames[0].commandsMs, 0)
  })

  test("a malformed answer is refused with the problem named", () => {
    assert.throws(() => validateEngineStats(null), /must be an object/)
    assert.throws(() => validateEngineStats({ host: {}, frame: 0, frames: [] }), /host must have a kind/)
    const host = { kind: "edit", state: "Edit" }
    assert.throws(() => validateEngineStats({ host, frame: "1", frames: [] }), /frame must be a number/)
    assert.throws(() => validateEngineStats({ host, frame: 1, frames: [{}] }), /frames\[0\]/)
    assert.throws(() => validateEngineStats({ host, frame: 1, frames: [], render: { drawCalls: "x" } }), /render\.drawCalls/)
    assert.throws(() => validateEngineStats({ host, frame: 1, frames: [], process: { workingSetBytes: 1, peakWorkingSetBytes: "2" } }), /process\.peakWorkingSetBytes/)
  })

  test("the page reaches GetEngineStats on both hosts with one uint32", () => {
    assert.equal(EngineStatsCapability, "engineStats")
    assert.deepEqual(EngineCommandArgs.getEngineStats, ["uint32"])
    assert.deepEqual(PlayCommandArgs.getEngineStats, ["uint32"])
  })
})

describe("the client's frame history", () => {
  test("appends what the host sends after the newest held, and asks again from the frame before it", () => {
    const history = new FrameHistory()
    assert.equal(history.sinceFor(), 0, "the first request asks for the whole ring")
    history.merge(3, [rec(1), rec(2), rec(3)])
    assert.deepEqual(history.records.map((r) => r.frame), [1, 2, 3])
    assert.equal(history.sinceFor(), 2, "the newest record comes again: its command times may have grown")
    history.merge(5, [rec(3, { commandsMs: 7 }), rec(4), rec(5)])
    assert.deepEqual(history.records.map((r) => r.frame), [1, 2, 3, 4, 5])
    assert.equal(history.records[2].commandsMs, 7, "the record sent again replaces the one held")
    assert.equal(history.missed, 0)
  })

  test("counts the frames that never arrived (the host's ring wrapped between two answers)", () => {
    const history = new FrameHistory()
    history.merge(2, [rec(1), rec(2)])
    history.merge(300, [rec(61), rec(300)])
    assert.deepEqual(history.records.map((r) => r.frame), [1, 2, 61, 300])
    assert.equal(history.missed, 58 + 238)
  })

  test("a frame number going backwards is a new play session: the history starts again", () => {
    const history = new FrameHistory()
    history.merge(100, [rec(99), rec(100)])
    assert.equal(history.merge(2, [rec(1), rec(2)]), true)
    assert.deepEqual(history.records.map((r) => r.frame), [1, 2])
  })

  test("keeps at most its capacity, dropping the oldest; records out of order are sorted", () => {
    const history = new FrameHistory(4)
    history.merge(6, [rec(6), rec(5), rec(4), rec(3), rec(2), rec(1)])
    assert.deepEqual(history.records.map((r) => r.frame), [3, 4, 5, 6])
  })
})

describe("the summary maths", () => {
  test("avg, nearest-rank p95 and max", () => {
    assert.equal(timingOf([]), null)
    const values = Array.from({ length: 100 }, (_, i) => i + 1)
    assert.deepEqual(timingOf(values), { avg: 50.5, p95: 95, max: 100 })
    assert.deepEqual(timingOf([2]), { avg: 2, p95: 2, max: 2 })
  })

  test("the breakdown splits physics out of the fixed ticks; fps skips the 0 intervals; command parts only for a play host's commands", () => {
    const edit = summarise([rec(1, { intervalMs: 0 }), rec(2, { intervalMs: 20 }), rec(3, { intervalMs: 20 })])
    assert.equal(edit.fps, 50)
    assert.equal(edit.commandsMs, null)
    const ids = edit.sections.map((s) => s.section.id)
    assert.deepEqual(ids, ["fixed", "physics", "update", "audio", "render", "otherTick"])
    assert.equal(edit.sections[0].timing.avg, 0.5, "fixedMs 1.5 less physicsMs 1")
    // tickMs 4 - fixed 1.5 - update 1 - audio 0.5 - render 0
    assert.equal(edit.sections[5].timing.avg, 1)
    const play = summarise([rec(1, { commandsMs: 5, renderRequestMs: 3, readbackMs: 1 })])
    assert.deepEqual(
      play.sections.slice(6).map((s) => [s.section.id, s.timing.avg]),
      [["renderRequest", 3], ["readback", 1], ["otherCommands", 1]]
    )
    assert.equal(play.commandsMs?.avg, 5)
    assert.equal(summarise([]).fps, null)
  })

  test("Lua memory against its cap, and the words for absent figures", () => {
    const s = stats([], { lua: { memoryBytes: 90, memoryCapBytes: 100 } })
    assert.ok(luaMemoryShare(s)! > LuaMemoryWarnShare)
    assert.equal(luaMemoryShare(stats([])), null)
    assert.equal(luaMemoryShare(stats([], { lua: { memoryBytes: 1, memoryCapBytes: 0 } })), null)
    assert.equal(formatBytes(undefined), "—")
    assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MiB")
    assert.equal(formatMs(null), "—")
    assert.equal(formatMs(2.125), "2.13 ms")
  })
})

/** A ProfilerModel over fakes: the host's answers are queued, and the timer is the test's */
function harness(options: { supported?: boolean; connected?: boolean } = {}) {
  const connected = signal(options.connected ?? true)
  const supported = signal(options.supported ?? true)
  const target = signal<ProfilerTarget>({ kind: "edit", session: 0 })
  const connection = signal<unknown>({})
  const calls: Array<[string, number]> = []
  const pending: Array<{ resolve(s: EngineStats): void; reject(e: Error): void }> = []
  let tick: (() => void) | null = null
  let stops = 0
  let hidden = false
  const deps: ProfilerDeps = {
    getEngineStats(kind, since) {
      calls.push([kind, since])
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    },
    connected,
    supported,
    target,
    connection,
    every(callback, ms) {
      assert.equal(ms, EngineStatsPollMs)
      tick = callback
      return () => {
        stops++
        tick = null
      }
    },
    hidden: () => hidden,
  }
  const model = new ProfilerModel(deps)
  return {
    model,
    connected,
    supported,
    target,
    connection,
    calls,
    pending,
    tick: () => tick?.(),
    get ticking() {
      return tick !== null
    },
    get stops() {
      return stops
    },
    setHidden(value: boolean) {
      hidden = value
    },
    /** Answers the oldest request still waiting */
    async answer(s: EngineStats) {
      pending.shift()!.resolve(s)
      await turn()
    },
  }
}

describe("ProfilerModel's polling", () => {
  test("start asks at once and then every 250 ms; stop ends it; nothing is asked before start", async () => {
    const h = harness()
    assert.equal(EngineStatsPollMs, 250)
    assert.equal(h.calls.length, 0)
    h.model.start()
    assert.equal(h.model.running.value, true)
    assert.deepEqual(h.calls, [["edit", 0]])
    await h.answer(stats([rec(1), rec(2)]))
    h.tick()
    assert.deepEqual(h.calls[1], ["edit", 1])
    await h.answer(stats([rec(1), rec(2), rec(3)]))
    assert.deepEqual(h.model.records.value.map((r) => r.frame), [1, 2, 3])
    h.model.start() // already started: no second timer
    assert.equal(h.calls.length, 2)
    h.model.stop()
    assert.equal(h.stops, 1)
    assert.equal(h.ticking, false)
    assert.equal(h.model.running.value, false)
  })

  test("one request at a time: a tick while one is on its way is skipped", async () => {
    const h = harness()
    h.model.start()
    h.tick()
    h.tick()
    assert.equal(h.calls.length, 1)
    await h.answer(stats([rec(1)]))
    h.tick()
    assert.equal(h.calls.length, 2)
  })

  test("an older host (no engineStats capability) is never asked, and the panel says why", async () => {
    const h = harness({ supported: false })
    h.model.start()
    h.tick()
    await turn()
    assert.equal(h.calls.length, 0)
    assert.equal(h.model.blockedReason, ProfilerUnsupportedReason)
    assert.equal(h.model.latest.value, null)
  })

  test("not connected: nothing is asked and what was shown is dropped", async () => {
    const h = harness()
    h.model.start()
    await h.answer(stats([rec(1)]))
    h.connected.value = false
    h.tick()
    await turn()
    assert.equal(h.calls.length, 1)
    assert.equal(h.model.blockedReason, "Not connected")
    assert.equal(h.model.latest.value, null)
    assert.equal(h.model.records.value.length, 0)
  })

  test("a hidden window is not asked", async () => {
    const h = harness()
    h.setHidden(true)
    h.model.start()
    h.tick()
    assert.equal(h.calls.length, 0)
    h.setHidden(false)
    h.tick()
    assert.equal(h.calls.length, 1)
  })

  test("an edit host's empty frames keep the counters; the play host while a game is live, with a fresh history", async () => {
    const h = harness()
    h.model.start()
    await h.answer(stats([], { host: { kind: "edit", state: "Edit", timersEnabled: true, timeScale: 1 }, scene: { objects: 5, activeObjects: 5, components: 9, luaComponents: 1 } }))
    assert.equal(h.model.records.value.length, 0)
    assert.equal(h.model.latest.value?.scene?.objects, 5)
    h.target.value = { kind: "play", session: 1 }
    h.tick()
    assert.deepEqual(h.calls[1], ["play", 0], "the play host is asked for its whole ring")
    await h.answer(stats([rec(10), rec(11)]))
    assert.deepEqual(h.model.records.value.map((r) => r.frame), [10, 11])
    // The next game: a new session starts the history again even when its frame numbers are higher
    h.target.value = { kind: "play", session: 2 }
    h.tick()
    assert.deepEqual(h.calls[2], ["play", 0])
    assert.equal(h.model.records.value.length, 0)
  })

  test("an answer that comes after a switch of host is dropped", async () => {
    const h = harness()
    h.model.start()
    h.target.value = { kind: "play", session: 1 }
    await h.answer(stats([rec(500)], { host: { kind: "edit", state: "Edit", timersEnabled: true, timeScale: 1 } }))
    assert.equal(h.model.latest.value, null)
    assert.equal(h.model.records.value.length, 0)
    h.tick()
    assert.deepEqual(h.calls[1], ["play", 0])
  })

  test("a reconnect starts the history again", async () => {
    const h = harness()
    h.model.start()
    await h.answer(stats([rec(1), rec(2)]))
    h.connection.value = {}
    h.tick()
    assert.deepEqual(h.calls[1], ["edit", 0])
    assert.equal(h.model.records.value.length, 0)
  })

  test("a failed request is shown until one succeeds; Pause freezes what is shown, not the polling", async () => {
    const h = harness()
    h.model.start()
    h.pending.shift()!.reject(new Error("boom"))
    await turn()
    assert.match(h.model.error.value ?? "", /boom/)
    h.tick()
    await h.answer(stats([rec(1), rec(2)]))
    assert.equal(h.model.error.value, null)
    h.model.setPaused(true)
    h.tick()
    await h.answer(stats([rec(1), rec(2), rec(3)]))
    assert.deepEqual(h.model.shown.value.map((r) => r.frame), [1, 2])
    assert.deepEqual(h.model.records.value.map((r) => r.frame), [1, 2, 3])
    h.model.setPaused(false)
    assert.deepEqual(h.model.shown.value.map((r) => r.frame), [1, 2, 3])
    assert.equal(h.model.summary.value.frames, 3)
  })
})
