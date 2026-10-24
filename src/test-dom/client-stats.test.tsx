import "./setup"
import { test } from "node:test"
import * as assert from "node:assert/strict"
import { act, render, screen, within } from "@testing-library/preact"
import { signal } from "@preact/signals"
import { ClientStatsPanel, ClientStatsView } from "../renderer/client-stats-panel"
import { ClientStats } from "../renderer/client-stats"
import type { AudioPlayerStatus } from "../renderer/audio-player"
import { renderWithApp } from "./helpers"

const audio: AudioPlayerStatus = {
  state: "playing", message: "", bufferedMs: 42, underruns: 3,
  sampleRate: 48000, channels: 2, sampleFormat: "f32", gaps: 0, serverDroppedFrames: 0,
}

function result(label: string): string | null {
  return screen.getByText(label, { selector: "dt" }).nextElementSibling!.textContent
}

test("client statistics distinguish missing samples, measured zero and existing audio counters", () => {
  const stats = new ClientStats(() => 1000)
  stats.connectionChanged(true)
  const view = render(<ClientStatsView stats={stats.snapshot()} audio={null} />)
  const region = screen.getByRole("region", { name: "Client statistics" })
  assert.equal(within(region).getAllByText("—").length, 9)
  view.rerender(<ClientStatsView stats={{ ...stats.snapshot(), editorRequestMs: 12.5,
    editorPixelBytesPerSecond: 2048, displayedFramesPerSecond: 0, frameSource: "game",
    eventPollMs: 5, eventPollAgeMs: 80, playFramesPerSecond: 60, playTimePerSecond: 1 }} audio={audio} />)
  assert.equal(result("Editor frame request"), "12.5 ms")
  assert.equal(result("Editor pixel payload"), "2.0 KiB/s")
  assert.equal(result("Displayed game frames"), "0.0 fps")
  assert.equal(result("Event poll round trip"), "5.0 ms")
  assert.equal(result("Since last event poll"), "80.0 ms")
  assert.equal(result("Audio buffer"), "42.0 ms")
  assert.equal(result("Audio underruns"), "3")
  assert.equal(result("Game frame progress"), "60.0 frames/s")
  assert.equal(result("Game clock progress"), "1.0 s/s")
  view.rerender(<ClientStatsView stats={stats.snapshot()} audio={{ ...audio, state: "unavailable" }} />)
  assert.equal(result("Audio buffer"), "—")
  assert.equal(result("Audio underruns"), "—")
  stats.connectionChanged(false)
  view.rerender(<ClientStatsView stats={stats.snapshot()} audio={audio} />)
  assert.equal(screen.queryByRole("region", { name: "Client statistics" }), null)
})

test("the panel samples while connected and tears down its timer on disconnect and unmount", async (t) => {
  let now = 0
  const stats = new ClientStats(() => now)
  const connected = signal(false)
  let sample: (() => void) | null = null
  let cleared = 0
  t.mock.method(globalThis, "setInterval", ((callback: () => void, ms: number) => {
    assert.equal(ms, 250)
    sample = callback
    return 42
  }) as unknown as typeof setInterval)
  t.mock.method(globalThis, "clearInterval", (() => { cleared++; sample = null }) as typeof clearInterval)
  const view = renderWithApp(<ClientStatsPanel />, { store: { connected, clientStats: stats }, audio: { status: signal(null) } })
  assert.equal(sample, null)
  await act(() => { stats.connectionChanged(true); connected.value = true })
  assert.ok(sample)
  const poll = stats.beginEventPoll()
  now = 10
  stats.eventPollReceived(poll)
  await act(() => sample!())
  assert.equal(result("Event poll round trip"), "10.0 ms")
  await act(() => { stats.connectionChanged(false); connected.value = false })
  assert.equal(screen.queryByRole("region", { name: "Client statistics" }), null)
  assert.equal(cleared, 1)
  await act(() => { stats.connectionChanged(true); connected.value = true })
  assert.ok(sample)
  assert.equal(result("Event poll round trip"), "—")
  await act(() => { view.unmount() })
  assert.equal(cleared, 2)
})
