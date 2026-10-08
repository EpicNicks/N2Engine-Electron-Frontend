import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { InputForwarder, engineButtonOf, engineKeyOf, scrollLines } from "../renderer/play-input"
import { MaxInputEventsPerBatch, PlayInputEvent } from "../shared/api"

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function setup(options: { failSend?: boolean } = {}) {
  const batches: PlayInputEvent[][] = []
  const errors: unknown[] = []
  const callbacks: Array<() => void> = []
  let release: (() => void) | null = null
  let hold = false
  const forwarder = new InputForwarder({
    send: async (events) => {
      batches.push(events.map((e) => ({ ...e })))
      if (options.failSend) throw new Error("refused")
      if (hold) await new Promise<void>((resolve) => (release = resolve))
    },
    schedule: (callback) => {
      callbacks.push(callback)
      return () => {
        const i = callbacks.indexOf(callback)
        if (i >= 0) callbacks.splice(i, 1)
      }
    },
    onError: (e) => errors.push(e),
  })
  /** The animation frame: the queued events go out */
  const frame = async (): Promise<void> => {
    callbacks.shift()?.()
    await turn()
  }
  return {
    forwarder,
    batches,
    errors,
    callbacks,
    frame,
    holdSends: () => (hold = true),
    answer: async () => {
      release?.()
      release = null
      await turn()
    },
  }
}

describe("key and button names", () => {
  test("DOM codes become the engine's Key names", () => {
    assert.equal(engineKeyOf("KeyW"), "W")
    assert.equal(engineKeyOf("Digit1"), "Key1")
    assert.equal(engineKeyOf("Numpad7"), "Kp7")
    assert.equal(engineKeyOf("Space"), "Space")
    assert.equal(engineKeyOf("ArrowLeft"), "Left")
    assert.equal(engineKeyOf("ShiftLeft"), "LeftShift")
    assert.equal(engineKeyOf("ControlRight"), "RightControl")
    assert.equal(engineKeyOf("MetaLeft"), "LeftSuper")
    assert.equal(engineKeyOf("F12"), "F12")
    assert.equal(engineKeyOf("BracketLeft"), "LeftBracket")
    assert.equal(engineKeyOf("Backquote"), "GraveAccent")
    assert.equal(engineKeyOf("NumpadEnter"), "KpEnter")
    assert.equal(engineKeyOf("MediaPlayPause"), null)
    assert.equal(engineKeyOf("constructor"), null)
    assert.equal(engineKeyOf(""), null)
  })

  test("every name is one the engine's enum has: letters and digits only", () => {
    for (const code of ["KeyA", "Digit0", "F1", "Numpad0", "Quote", "Enter", "Tab", "ContextMenu"]) {
      assert.match(engineKeyOf(code) ?? "", /^[A-Za-z0-9]+$/)
    }
  })

  test("mouse buttons", () => {
    assert.deepEqual([0, 1, 2, 3, 4].map(engineButtonOf), ["Left", "Middle", "Right", "Button4", "Button5"])
    assert.equal(engineButtonOf(5), null)
    assert.equal(engineButtonOf(-1), null)
    assert.equal(engineButtonOf(0.5), null)
  })

  test("the wheel is in lines, positive away from the user", () => {
    assert.deepEqual(scrollLines(0, -100, 0), { x: 0, y: 1 })
    assert.deepEqual(scrollLines(50, 200, 0), { x: 0.5, y: -2 })
    assert.deepEqual(scrollLines(0, 3, 1), { x: 0, y: -1 })
    assert.deepEqual(scrollLines(NaN, Infinity, 0), { x: 0, y: 0 })
  })
})

describe("InputForwarder", () => {
  test("events of a frame go out as one batch, in order", async () => {
    const t = setup()
    t.forwarder.pointer(10, 20)
    assert.equal(t.forwarder.key("KeyW", true), true)
    t.forwarder.mouseButton(0, true)
    await t.frame()
    assert.deepEqual(t.batches, [
      [
        { type: "pointer", x: 10, y: 20 },
        { type: "key", key: "W", down: true },
        { type: "mouseButton", button: "Left", down: true },
      ],
    ])
    assert.equal(t.callbacks.length, 0)
  })

  test("nothing is sent when nothing happened", async () => {
    const t = setup()
    await t.frame()
    assert.deepEqual(t.batches, [])
  })

  test("a run of pointer moves is only its last position", async () => {
    const t = setup()
    for (let i = 0; i < 100; i++) t.forwarder.pointer(i, i)
    await t.frame()
    assert.deepEqual(t.batches, [[{ type: "pointer", x: 99, y: 99 }]])
  })

  test("a press between pointer moves keeps its place in the order", async () => {
    const t = setup()
    t.forwarder.pointer(1, 1)
    t.forwarder.mouseButton(0, true)
    t.forwarder.pointer(5, 5)
    t.forwarder.pointer(6, 6)
    await t.frame()
    assert.deepEqual(t.batches[0], [
      { type: "pointer", x: 1, y: 1 },
      { type: "mouseButton", button: "Left", down: true },
      { type: "pointer", x: 6, y: 6 },
    ])
  })

  test("a key's repeats are one press, and a release of a key that isn't down says nothing", async () => {
    const t = setup()
    t.forwarder.key("KeyA", true)
    t.forwarder.key("KeyA", true)
    t.forwarder.key("KeyA", true)
    t.forwarder.key("KeyB", false)
    t.forwarder.key("KeyA", false)
    await t.frame()
    assert.deepEqual(t.batches[0], [
      { type: "key", key: "A", down: true },
      { type: "key", key: "A", down: false },
    ])
  })

  test("a key the engine has no name for isn't taken", async () => {
    const t = setup()
    assert.equal(t.forwarder.key("MediaTrackNext", true), false)
    await t.frame()
    assert.deepEqual(t.batches, [])
  })

  test("wheel notches in a frame add up", async () => {
    const t = setup()
    t.forwarder.scroll(0, 1)
    t.forwarder.scroll(0, 1)
    t.forwarder.scroll(0, 0)
    await t.frame()
    assert.deepEqual(t.batches, [[{ type: "scroll", x: 0, y: 2 }]])
  })

  test("non-finite pointer positions are dropped", async () => {
    const t = setup()
    t.forwarder.pointer(NaN, 1)
    t.forwarder.pointer(1, Infinity)
    await t.frame()
    assert.deepEqual(t.batches, [])
  })

  test("releaseAll goes out at once, in place of what was queued, and clears what is held", async () => {
    const t = setup()
    t.forwarder.key("KeyW", true)
    await t.frame()
    t.forwarder.key("KeyD", true)
    t.forwarder.pointer(3, 3)
    t.forwarder.releaseAll()
    await turn()
    assert.deepEqual(t.batches[1], [{ type: "releaseAll" }])
    assert.equal(t.forwarder.anyHeld, false)
    // The key can go down again: it is no longer remembered as held
    t.forwarder.key("KeyW", true)
    await t.frame()
    assert.deepEqual(t.batches[2], [{ type: "key", key: "W", down: true }])
  })

  test("releaseAll with nothing held and nothing queued sends nothing", async () => {
    const t = setup()
    t.forwarder.releaseAll()
    await turn()
    assert.deepEqual(t.batches, [])
  })

  test("only one send is in flight: what comes meanwhile waits and goes out when it is answered", async () => {
    const t = setup()
    t.holdSends()
    t.forwarder.key("KeyW", true)
    await t.frame()
    assert.equal(t.batches.length, 1)
    t.forwarder.key("KeyW", false)
    t.forwarder.pointer(4, 4)
    await t.frame()
    assert.equal(t.batches.length, 1, "still waiting for the first answer")
    await t.answer()
    assert.equal(t.batches.length, 2)
    assert.deepEqual(t.batches[1], [
      { type: "key", key: "W", down: false },
      { type: "pointer", x: 4, y: 4 },
    ])
    await t.answer()
  })

  test("a batch is at most 1024 events; the rest follows", async () => {
    const t = setup()
    for (let i = 0; i < MaxInputEventsPerBatch + 5; i++) {
      t.forwarder.mouseButton(0, i % 2 === 0)
      t.forwarder.scroll(0, 1)
    }
    await t.frame()
    await turn()
    await turn()
    assert.ok(t.batches.every((b) => b.length <= MaxInputEventsPerBatch))
    assert.ok(t.batches.length >= 2)
  })

  test("a failed send is reported, and later events still go out", async () => {
    const t = setup({ failSend: true })
    t.forwarder.key("KeyW", true)
    await t.frame()
    assert.equal(t.errors.length, 1)
    t.forwarder.key("KeyW", false)
    await t.frame()
    assert.equal(t.batches.length, 2)
  })

  test("reset forgets what is queued and held without sending; dispose stops everything", async () => {
    const t = setup()
    t.forwarder.key("KeyW", true)
    t.forwarder.reset()
    assert.equal(t.forwarder.anyHeld, false)
    await t.frame()
    assert.deepEqual(t.batches, [])
    t.forwarder.dispose()
    t.forwarder.key("KeyQ", true)
    await t.frame()
    assert.deepEqual(t.batches, [])
  })
})
