import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { IpcMain } from "electron"
import { checkPlayCall, registerPlayIpc } from "../main/play-ipc"
import type { PlaySession } from "../main/play-session"
import { checkInputEvent, checkInputEvents } from "../protocol/input-events"
import { Channels, InitialPlayState, IpcResult, MaxInputEventsPerBatch } from "../shared/api"

type Handler = (event: unknown, ...args: unknown[]) => Promise<IpcResult<unknown>>

class FakeIpcMain {
  handlers = new Map<string, Handler>()
  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler)
  }
  invoke(channel: string, sender: { mainFrame: unknown }, ...args: unknown[]): Promise<IpcResult<unknown>> {
    return this.handlers.get(channel)!({ sender, senderFrame: sender.mainFrame }, ...args)
  }
}

describe("input events", () => {
  test("each kind is copied as a fresh plain event", () => {
    const events = [
      { type: "key", key: "W", down: true, extra: 1 },
      { type: "mouseButton", button: "Left", down: false },
      { type: "pointer", x: 1.5, y: 2 },
      { type: "scroll", x: 0, y: -1 },
      { type: "releaseAll" },
    ]
    const checked = checkInputEvents(events, "events")
    assert.deepEqual(checked, [
      { type: "key", key: "W", down: true },
      { type: "mouseButton", button: "Left", down: false },
      { type: "pointer", x: 1.5, y: 2 },
      { type: "scroll", x: 0, y: -1 },
      { type: "releaseAll" },
    ])
    assert.notEqual(checked[0], events[0])
  })

  test("anything else is refused, naming the event", () => {
    assert.throws(() => checkInputEvents("W", "events"), /must be an array/)
    assert.throws(() => checkInputEvents([null], "events"), /events\[0\] must be an object/)
    assert.throws(() => checkInputEvents([{ type: "key", key: "W" }], "events"), /events\[0\]\.down/)
    assert.throws(() => checkInputEvents([{ type: "key", key: "W; DROP", down: true }], "events"), /key name/)
    assert.throws(() => checkInputEvents([{ type: "key", key: 5, down: true }], "events"), /key name/)
    assert.throws(() => checkInputEvents([{ type: "pointer", x: NaN, y: 0 }], "events"), /finite/)
    assert.throws(() => checkInputEvents([{ type: "pointer", x: 1 }], "events"), /finite/)
    assert.throws(() => checkInputEvent({ type: "gamepad" }, "e"), /e\.type/)
    assert.throws(() => checkInputEvents([{ type: "mouseButton", button: "", down: true }], "events"), /button name/)
    // A sparse array's holes are refused, not skipped
    const sparse: unknown[] = [{ type: "releaseAll" }]
    sparse[2] = { type: "releaseAll" }
    assert.throws(() => checkInputEvents(sparse, "events"), /events\[1\]/)
  })

  test("a batch is at most 1024 events", () => {
    const ok = Array.from({ length: MaxInputEventsPerBatch }, () => ({ type: "releaseAll" }))
    assert.equal(checkInputEvents(ok, "events").length, MaxInputEventsPerBatch)
    assert.throws(() => checkInputEvents([...ok, { type: "releaseAll" }], "events"), /at most 1024/)
  })
})

describe("play commands", () => {
  test("only the declared commands, with the declared arguments", () => {
    assert.deepEqual(checkPlayCall("setViewportSize", [800, 600]), { name: "setViewportSize", args: [800, 600] })
    assert.deepEqual(checkPlayCall("renderFrame", []), { name: "renderFrame", args: [] })
    assert.throws(() => checkPlayCall("openScene", ["res://a.scene"]), /Unknown play command/)
    assert.throws(() => checkPlayCall("toString", []), /Unknown play command/)
    assert.throws(() => checkPlayCall("setViewportSize", [800]), /takes 2 arguments/)
    assert.throws(() => checkPlayCall("setViewportSize", ["800", 600]), /must be a 32-bit integer/)
    assert.throws(() => checkPlayCall("pollEvents", "x"), /must be an array/)
    assert.throws(() => checkPlayCall("sendInput", [[{ type: "nope" }]]), /sendInput argument 1\[0\]/)
  })
})

describe("registerPlayIpc", () => {
  const page = { url: "file:///page.html" }

  function setup() {
    const ipc = new FakeIpcMain()
    const calls: string[] = []
    const sent: unknown[] = []
    const client = {
      async renderFrame() {
        calls.push("renderFrame")
        return { width: 1, height: 1, pixels: new Uint8Array(4) }
      },
      async sendInput(events: unknown) {
        sent.push(events)
      },
    }
    let live = true
    const session = {
      state: InitialPlayState,
      get client() {
        if (!live) throw new Error("No game is running")
        return client
      },
      start: async (scene: string) => void calls.push(`start ${JSON.stringify(scene)}`),
      stop: async () => void calls.push("stop"),
      setPaused: async (p: boolean) => void calls.push(`setPaused ${p}`),
      step: async (n: number) => void calls.push(`step ${n}`),
      refresh: async () => InitialPlayState,
    } as unknown as PlaySession
    // The page's own frame, showing the editor's page
    const sender = { mainFrame: { url: "file:///page.html" } }
    const ipc2 = ipc
    registerPlayIpc(ipc2 as unknown as IpcMain, { page: { ...page, getEditor: () => sender as never }, session })
    return { ipc: ipc2, sender, calls, sent, kill: () => (live = false) }
  }

  test("start plays the open scene; stop, pause and step are forwarded", async () => {
    const t = setup()
    assert.deepEqual(await t.ipc.invoke(Channels.playStart, t.sender), { ok: true, value: undefined })
    await t.ipc.invoke(Channels.playSetPaused, t.sender, true)
    await t.ipc.invoke(Channels.playStep, t.sender, 3)
    await t.ipc.invoke(Channels.playStop, t.sender)
    assert.deepEqual(t.calls, ['start ""', "setPaused true", "step 3", "stop"])
  })

  test("pause and step arguments are checked", async () => {
    const t = setup()
    const paused = await t.ipc.invoke(Channels.playSetPaused, t.sender, "yes")
    assert.equal(paused.ok, false)
    const step = await t.ipc.invoke(Channels.playStep, t.sender, "1")
    assert.equal(step.ok, false)
    assert.deepEqual(t.calls, [])
  })

  test("a command is forwarded to the child's connection with checked arguments", async () => {
    const t = setup()
    const result = await t.ipc.invoke(Channels.playCall, t.sender, "renderFrame", [])
    assert.equal(result.ok, true)
    await t.ipc.invoke(Channels.playCall, t.sender, "sendInput", [[{ type: "key", key: "W", down: true }]])
    assert.deepEqual(t.sent, [[{ type: "key", key: "W", down: true }]])
    const bad = await t.ipc.invoke(Channels.playCall, t.sender, "openScene", ["x"])
    assert.deepEqual(bad, { ok: false, error: "Unknown play command openScene" })
  })

  test("with no game running a command is an error the page can read", async () => {
    const t = setup()
    t.kill()
    assert.deepEqual(await t.ipc.invoke(Channels.playCall, t.sender, "renderFrame", []), {
      ok: false,
      error: "No game is running",
    })
  })

  test("calls from another frame are refused", async () => {
    const t = setup()
    const result = await t.ipc.invoke(Channels.playStart, { mainFrame: { url: "https://example.com" } })
    assert.equal(result.ok, false)
    assert.deepEqual(t.calls, [])
  })
})
