// The Profiler panel (FE-S5, protocol 1.28.0) over a fake host: an older host, an edit host's empty frames, a play
// host's graph and breakdown, absent blocks, the Lua memory warning, and polling only while the panel is mounted.
import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { act, render, screen, within } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { signal } from "@preact/signals"
import { ProfilerPanel, ProfilerView } from "../renderer/profiler-panel"
import { ProfilerModel, type ProfilerTarget } from "../renderer/profiler-state"
import type { EngineFrameRecord, EngineStats } from "../protocol/protocol.generated"
import { renderWithApp } from "./helpers"

const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const rec = (frame: number, over: Partial<EngineFrameRecord> = {}): EngineFrameRecord => ({
  frame, intervalMs: 16.5, tickMs: 3, fixedMs: 1, fixedTicks: 1, physicsMs: 0.5, updateMs: 1, audioMs: 0.25, renderMs: 0,
  commandsMs: 4, renderRequestMs: 3, readbackMs: 0.5, ...over,
})

const editStats: EngineStats = {
  host: { kind: "edit", state: "Edit", renderer: "Software", timersEnabled: true, timeScale: 1 },
  frame: 0,
  frames: [],
  summary: { windowFrames: 0, fps: 0, tickMs: { avg: 0, p95: 0, max: 0 } },
  render: { counters: true, drawCalls: 12, triangles: 3400, vertices: 2000, framesRendered: 9, width: 640, height: 480 },
  scene: { objects: 30, activeObjects: 28, components: 70, luaComponents: 4 },
}

const playStats = (frames: EngineFrameRecord[]): EngineStats => ({
  host: { kind: "play", state: "Playing", renderer: "OpenGL", timersEnabled: true, timeScale: 1 },
  frame: frames[frames.length - 1].frame,
  frames,
  summary: { windowFrames: frames.length, fps: 60.6, tickMs: { avg: 3, p95: 3, max: 3 } },
  render: { counters: true, drawCalls: 412, triangles: 183220, vertices: 120004, framesRendered: 5, width: 1280, height: 720 },
  lua: { memoryBytes: 900, memoryCapBytes: 1000 },
  physics: { backend: "jolt", bodies: 20, staticBodies: 5, activeBodies: 3 },
  process: { workingSetBytes: 300 * 1024 * 1024 },
})

/** A model over a fake host that answers what the test set, polling on the test's timer */
function fakeModel(options: { supported?: boolean; answer: () => EngineStats }) {
  const calls: Array<[string, number]> = []
  let tick: (() => void) | null = null
  const model = new ProfilerModel({
    getEngineStats: async (kind, since) => {
      calls.push([kind, since])
      return options.answer()
    },
    connected: signal(true),
    supported: signal(options.supported ?? true),
    target: signal<ProfilerTarget>({ kind: "edit", session: 0 }),
    every: (callback) => {
      tick = callback
      return () => (tick = null)
    },
  })
  return { model, calls, tick: () => tick?.() }
}

const value = (label: string): string | null =>
  within(screen.getByRole("region", { name: "Host counters" })).getByText(label, { selector: "dt" }).nextElementSibling!.textContent

describe("the Profiler panel", () => {
  test("an older host: one line says it has no engine stats, and nothing is asked", async () => {
    const h = fakeModel({ supported: false, answer: () => editStats })
    render(<ProfilerView model={h.model} />)
    await act(async () => {
      h.model.start()
      await turn()
    })
    assert.ok(screen.getByText(/has no engine stats \(it is older than protocol 1\.28\.0/))
    assert.equal(h.calls.length, 0)
    assert.equal((screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled, true)
  })

  test("an edit host: no frames, a note to press Play, the counters it has and — for the blocks it left out", async () => {
    const h = fakeModel({ answer: () => editStats })
    render(<ProfilerView model={h.model} />)
    await act(async () => {
      h.model.start()
      await turn()
    })
    assert.ok(screen.getByText(/The edit host runs no game frames/))
    assert.equal(screen.queryByRole("img", { name: /Frame times/ }), null)
    assert.ok(screen.getByText(/Edit host, Edit, Software/))
    assert.equal(value("Draw calls"), "12")
    assert.equal(value("Triangles"), "3,400")
    assert.equal(value("Objects"), "30 (28 active)")
    assert.equal(value("Lua memory"), "—")
    assert.equal(value("Physics"), "—")
    assert.equal(value("Process memory"), "—")
    assert.equal(screen.queryByRole("meter"), null)
  })

  test("a play host: the stacked graph, the breakdown, counters, and Lua memory above 80% of its cap in the warning colour", async () => {
    let frames = [rec(1, { intervalMs: 0 }), rec(2), rec(3)]
    const h = fakeModel({ answer: () => playStats(frames) })
    render(<ProfilerView model={h.model} />)
    await act(async () => {
      h.model.start()
      await turn()
    })
    const graph = screen.getByRole("img", { name: "Frame times of the last 3 frames" })
    assert.equal(graph.querySelectorAll("g[data-frame]").length, 3)
    assert.match(graph.querySelector("g[data-frame='2'] title")!.textContent!, /Frame 2[\s\S]*render request 3\.00 ms/)
    const table = within(screen.getByRole("table", { name: "Frame time breakdown" }))
    assert.ok(table.getByText("Over 3 frames"))
    for (const label of ["Fixed ticks", "Physics", "Update", "Audio", "Render", "Render request", "Readback", "Commands after the frame"]) {
      assert.ok(table.getByText(label), label)
    }
    assert.equal(table.getByText("Frame interval").parentElement!.querySelector("td")!.textContent, "16.5 ms", "the 0 interval is left out")
    assert.equal(value("Draw calls"), "412")
    assert.equal(value("Triangles"), "183,220")
    assert.equal(value("Vertices"), "120,004")
    assert.equal(value("Physics"), "Jolt")
    assert.equal(value("Bodies"), "20 (5 static)")
    assert.equal(value("Active bodies"), "3")
    assert.equal(value("Process memory"), "300.0 MiB")
    assert.equal(value("Peak process memory"), "—")
    assert.match(value("Lua memory")!, /\(90%\)/)
    const luaRow = screen.getByText("Lua memory", { selector: "dt" }).parentElement!
    assert.equal(luaRow.getAttribute("data-warn"), "true")
    assert.ok(screen.getByRole("meter", { name: "Lua memory" }).classList.contains("warn"))
    assert.ok(screen.getByText(/60\.6 fps over the host's last 3 frames/))

    // Pause freezes the view while the polling goes on
    await userEvent.click(screen.getByRole("button", { name: "Pause" }))
    frames = [rec(3), rec(4)]
    await act(async () => {
      h.tick()
      await turn()
    })
    assert.deepEqual(h.calls[1], ["edit", 2])
    assert.ok(screen.getByRole("img", { name: "Frame times of the last 3 frames" }))
    await userEvent.click(screen.getByRole("button", { name: "Resume" }))
    assert.ok(screen.getByRole("img", { name: "Frame times of the last 4 frames" }))
    await userEvent.click(screen.getByRole("button", { name: "Clear" }))
    assert.equal(screen.queryByRole("img", { name: /Frame times/ }), null)
  })

  test("the registered panel polls GetEngineStats only while it is mounted, on the play host while a game is live", async (t) => {
    const intervals: Array<{ ms: number; cleared: boolean }> = []
    t.mock.method(globalThis, "setInterval", ((_callback: () => void, ms: number) => {
      intervals.push({ ms, cleared: false })
      return intervals.length
    }) as unknown as typeof setInterval)
    t.mock.method(globalThis, "clearInterval", ((handle: number) => {
      intervals[handle - 1].cleared = true
    }) as unknown as typeof clearInterval)
    const engineCalls: number[] = []
    const playCalls: number[] = []
    const w = window as unknown as { engine: unknown; play: unknown }
    const old = { engine: w.engine, play: w.play }
    w.engine = { getEngineStats: async (since: number) => (engineCalls.push(since), editStats) }
    w.play = { getEngineStats: async (since: number) => (playCalls.push(since), playStats([rec(7)])) }
    t.after(() => Object.assign(w, old))
    const live = signal(false)
    const view = renderWithApp(<ProfilerPanel />, {
      store: { connected: signal(true), serverInfo: signal({ capabilities: ["engineStats"] }) as never },
      play: { live, state: signal({ status: "stopped", launch: 0, frame: 0, time: 0, message: null }) } as never,
    })
    await act(async () => {
      await turn()
    })
    assert.deepEqual(engineCalls, [0])
    assert.deepEqual(intervals, [{ ms: 250, cleared: false }])
    assert.ok(screen.getByText(/The edit host runs no game frames/))
    await act(() => {
      view.unmount()
    })
    assert.equal(intervals[0].cleared, true, "closed or hidden, the panel stops asking (the host turns its timers off 10 s later)")

    live.value = true
    renderWithApp(<ProfilerPanel />, {
      store: { connected: signal(true), serverInfo: signal({ capabilities: ["engineStats"] }) as never },
      play: { live, state: signal({ status: "playing", launch: 1, frame: 7, time: 0, message: null }) } as never,
    })
    await act(async () => {
      await turn()
    })
    assert.deepEqual(playCalls, [0])
    assert.deepEqual(engineCalls, [0])
    assert.ok(screen.getByText(/Play host, Playing, OpenGL/))
  })
})
