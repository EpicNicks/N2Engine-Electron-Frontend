import { describe, test } from "node:test"
import * as assert from "node:assert/strict"
import { ClientStats, MaxMetricSamples, MaxPlaySamples } from "../renderer/client-stats"
import { InitialPlayState } from "../shared/api"
import { EditorStore } from "../renderer/store"
import { FakeApi, FakeTimers, settle } from "./fake-store-api"

function setup() {
  let now = 0
  const stats = new ClientStats(() => now)
  stats.connectionChanged(true)
  return { stats, at: (time: number) => { now = time } }
}

describe("ClientStats", () => {
  test("separates received editor payloads, successful presentation, and event poll timing", () => {
    const { stats, at } = setup()
    stats.viewportStarted("edit")
    assert.equal(stats.snapshot().displayedFramesPerSecond, null)
    const request = stats.beginFrameRequest("edit")
    const poll = stats.beginEventPoll()
    at(20)
    stats.frameReceived(request, 400)
    stats.eventPollReceived(poll)
    // A reply is not a displayed frame until the canvas accepts it.
    assert.equal(stats.snapshot().displayedFramesPerSecond, null)
    stats.framePresented("edit")
    at(1000)
    const result = stats.snapshot()
    assert.equal(result.editorRequestMs, 20)
    assert.equal(result.editorPixelBytesPerSecond, 400)
    assert.equal(result.displayedFramesPerSecond, 1)
    assert.equal(result.eventPollMs, 20)
    assert.equal(result.eventPollAgeMs, 980)
    at(6000)
    const idle = stats.snapshot()
    assert.equal(idle.editorRequestMs, null)
    assert.equal(idle.eventPollMs, null)
    assert.equal(idle.editorPixelBytesPerSecond, 0)
    assert.equal(idle.displayedFramesPerSecond, 0)
  })

  test("resets disconnected/reconnected sessions and rejects replies from an older viewport", () => {
    const { stats, at } = setup()
    stats.viewportStarted("edit")
    const editor = stats.beginFrameRequest("edit")
    stats.viewportStopped()
    stats.viewportStarted("game")
    at(10)
    stats.frameReceived(editor, 400)
    stats.framePresented("edit")
    assert.equal(stats.snapshot().editorRequestMs, null)
    assert.equal(stats.snapshot().displayedFramesPerSecond, null)
    stats.framePresented("game")
    assert.equal(stats.snapshot().displayedFramesPerSecond, 100)
    const oldPoll = stats.beginEventPoll()
    const oldPlay = stats.beginPlayObservation()
    stats.connectionChanged(false)
    stats.connectionChanged(true)
    at(20)
    stats.eventPollReceived(oldPoll)
    stats.playStateReceived(oldPlay, { ...InitialPlayState, status: "playing", launch: 1, frame: 20, time: 1 })
    assert.equal(stats.snapshot().eventPollMs, null)
    assert.equal(stats.snapshot().frameSource, null)
    assert.equal(stats.snapshot().playStatus, null)
    assert.equal(stats.retainedSamples, 0)
  })

  test("uses a capped measured window at high frequency, with a monotonic injectable clock", () => {
    const { stats, at } = setup()
    stats.viewportStarted("edit")
    for (let i = 1; i <= 10000; i++) {
      at(i)
      stats.frameReceived(stats.beginFrameRequest("edit"), 4)
      stats.framePresented("edit")
      stats.eventPollReceived(stats.beginEventPoll())
      stats.observePlayState({ ...InitialPlayState, status: "playing", launch: 1, frame: i, time: i / 1000 })
    }
    assert.ok(stats.retainedSamples <= 4 * MaxMetricSamples + MaxPlaySamples)
    assert.equal(stats.snapshot().editorPixelBytesPerSecond, 4000)
    assert.equal(stats.snapshot().displayedFramesPerSecond, 1000)
    const request = stats.beginEventPoll()
    at(9990) // A buggy clock cannot produce a negative latency or age.
    stats.eventPollReceived(request)
    assert.equal(stats.snapshot().eventPollMs, 0)
    assert.equal(stats.snapshot().eventPollAgeMs, 0)
  })

  test("derives game progress from observed counters, including paused zero, expiry and counter resets", () => {
    const { stats, at } = setup()
    const sample = (frame: number, time: number, launch = 1, status: "playing" | "paused" = "playing") =>
      stats.observePlayState({ ...InitialPlayState, status, launch, frame, time })
    sample(0, 0)
    assert.equal(stats.snapshot().playFramesPerSecond, null)
    at(1000)
    sample(60, 1)
    assert.equal(stats.snapshot().playFramesPerSecond, 60)
    assert.equal(stats.snapshot().playTimePerSecond, 1)
    at(5500)
    assert.equal(stats.snapshot().playFramesPerSecond, null) // Only one sample is still in the window.
    at(7000)
    assert.equal(stats.snapshot().playFramesPerSecond, null)
    sample(60, 1, 2, "paused")
    at(7250)
    sample(60, 1, 2, "paused")
    assert.equal(stats.snapshot().playFramesPerSecond, 0)
    assert.equal(stats.snapshot().playTimePerSecond, 0)
    at(7500)
    sample(1, 0.01, 2)
    assert.equal(stats.snapshot().playFramesPerSecond, null)
    stats.observePlayState(InitialPlayState)
    assert.equal(stats.snapshot().playTimePerSecond, null)
  })

  test("EditorStore records its existing event polls without extra requests and clears them on disconnect", async () => {
    const { stats, at } = setup()
    const api = new FakeApi()
    const timers = new FakeTimers()
    const original = api.engine.pollEvents
    let polls = 0
    api.engine.pollEvents = async (...args) => {
      polls++
      at(35)
      return original(...args)
    }
    new EditorStore(api, { timers }, {}, stats)
    api.pushConnection(true)
    await timers.fire()
    await settle()
    assert.equal(polls, 1)
    assert.equal(stats.snapshot().eventPollMs, 35)
    api.pushConnection(false)
    assert.equal(stats.snapshot().eventPollMs, null)
    assert.equal(timers.pending.size, 0)
  })
})
