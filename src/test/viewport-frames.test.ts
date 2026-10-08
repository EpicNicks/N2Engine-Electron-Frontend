import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { FrameUpdateResponse } from "../protocol/protocol.generated"
import { FrameScheduler, LatestWinsSender } from "../renderer/viewport-frames"

const frame = (revision: number, modified: boolean): FrameUpdateResponse => ({
  revision,
  modified,
  width: 2,
  height: 1,
  pixels: modified ? new Uint8Array(8) : new Uint8Array(0),
})

/** A deferred answer */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A scheduler on a hand-run clock: animation frames happen when the test says */
function setup(answers: Array<FrameUpdateResponse | Error> = []) {
  const asked: number[] = []
  const shown: FrameUpdateResponse[] = []
  const errors: unknown[] = []
  const callbacks: Array<() => void> = []
  let connected = true
  const scheduler = new FrameScheduler({
    request: async (since) => {
      asked.push(since)
      const answer = answers.shift() ?? frame(since, false)
      if (answer instanceof Error) throw answer
      return answer
    },
    present: (f) => shown.push(f),
    schedule: (callback) => {
      callbacks.push(callback)
      return () => {
        const i = callbacks.indexOf(callback)
        if (i >= 0) callbacks.splice(i, 1)
      }
    },
    onError: (e) => errors.push(e),
    isConnected: () => connected,
  })
  /** Runs the animation frame that is waiting, if any, and lets the answer arrive */
  const animationFrame = async (): Promise<void> => {
    const callback = callbacks.shift()
    callback?.()
    await turn()
  }
  return { scheduler, asked, shown, errors, callbacks, animationFrame, disconnect: () => (connected = false) }
}

describe("FrameScheduler", () => {
  test("starting asks once with no revision, and shows the frame", async () => {
    const { scheduler, asked, shown, animationFrame } = setup([frame(40, true)])
    scheduler.start()
    await animationFrame()
    assert.deepEqual(asked, [0])
    assert.equal(shown.length, 1)
    assert.equal(scheduler.revision, 40)
  })

  test("an idle viewport asks for nothing more: no timer, no polling", async () => {
    const { scheduler, asked, callbacks, animationFrame } = setup([frame(40, true)])
    scheduler.start()
    await animationFrame()
    for (let i = 0; i < 20; i++) await turn()
    assert.equal(callbacks.length, 0, "nothing is waiting for an animation frame")
    assert.deepEqual(asked, [0])
  })

  test("an invalidation asks with the revision held; not modified shows nothing new", async () => {
    const { scheduler, asked, shown, animationFrame } = setup([frame(40, true), frame(40, false), frame(41, true)])
    scheduler.start()
    await animationFrame()
    scheduler.invalidate()
    await animationFrame()
    assert.deepEqual(asked, [0, 40])
    assert.equal(shown.length, 1)
    scheduler.invalidate()
    await animationFrame()
    assert.deepEqual(asked, [0, 40, 40])
    assert.equal(shown.length, 2)
    assert.equal(scheduler.revision, 41)
  })

  test("invalidations before the animation frame are one request", async () => {
    const { scheduler, asked, callbacks, animationFrame } = setup([frame(1, true)])
    scheduler.start()
    await animationFrame()
    for (let i = 0; i < 50; i++) scheduler.invalidate()
    assert.equal(callbacks.length, 1)
    await animationFrame()
    assert.equal(asked.length, 2)
  })

  test("a change while a request is in flight is asked for after it, never in parallel", async () => {
    const first = deferred<FrameUpdateResponse>()
    let inFlight = 0
    let peak = 0
    const asked: number[] = []
    const callbacks: Array<() => void> = []
    const scheduler = new FrameScheduler({
      request: async (since) => {
        asked.push(since)
        inFlight++
        peak = Math.max(peak, inFlight)
        try {
          return asked.length === 1 ? await first.promise : frame(since + 1, true)
        } finally {
          inFlight--
        }
      },
      present: () => {},
      schedule: (callback) => {
        callbacks.push(callback)
        return () => {}
      },
      onError: () => {},
      isConnected: () => true,
    })
    scheduler.start()
    callbacks.shift()!()
    await turn()
    scheduler.invalidate() // while the first is out
    assert.equal(callbacks.length, 0, "it waits for the answer")
    first.resolve(frame(5, true))
    await turn()
    assert.equal(callbacks.length, 1, "and is then asked for on the next animation frame")
    callbacks.shift()!()
    await turn()
    assert.deepEqual(asked, [0, 5])
    assert.equal(peak, 1)
  })

  test("a failed request stops the scheduler and reports once", async () => {
    const { scheduler, errors, callbacks, animationFrame } = setup([new Error("lost")])
    scheduler.start()
    await animationFrame()
    assert.equal(errors.length, 1)
    assert.equal(scheduler.isRunning, false)
    scheduler.invalidate() // stopped: ignored
    assert.equal(callbacks.length, 0)
  })

  test("a disconnected host stops it without asking", async () => {
    const { scheduler, asked, errors, animationFrame, disconnect } = setup()
    scheduler.start()
    disconnect()
    await animationFrame()
    assert.deepEqual(asked, [])
    assert.equal(scheduler.isRunning, false)
    assert.deepEqual(errors, [])
  })

  test("stop then start forgets the revision (another host's numbers mean nothing), and drops a stale answer", async () => {
    const slow = deferred<FrameUpdateResponse>()
    const asked: number[] = []
    const shown: FrameUpdateResponse[] = []
    const callbacks: Array<() => void> = []
    const scheduler = new FrameScheduler({
      request: (since) => {
        asked.push(since)
        return asked.length === 1 ? slow.promise : Promise.resolve(frame(900, true))
      },
      present: (f) => shown.push(f),
      schedule: (callback) => {
        callbacks.push(callback)
        return () => {}
      },
      onError: () => {},
      isConnected: () => true,
    })
    scheduler.start()
    callbacks.shift()!()
    await turn()
    scheduler.stop()
    scheduler.start()
    callbacks.shift()!()
    await turn()
    slow.resolve(frame(7, true)) // the first host's late answer
    await turn()
    assert.deepEqual(asked, [0, 0])
    assert.deepEqual(
      shown.map((f) => f.revision),
      [900]
    )
    assert.equal(scheduler.revision, 900)
  })

  test("forget makes the next ask take whatever the host has", async () => {
    const { scheduler, asked, animationFrame } = setup([frame(40, true), frame(40, true)])
    scheduler.start()
    await animationFrame()
    scheduler.forget()
    await animationFrame()
    assert.deepEqual(asked, [0, 0])
  })
})

describe("LatestWinsSender", () => {
  test("sends the first at once, then only the newest of those that arrived meanwhile", async () => {
    const gate = deferred<void>()
    const sent: number[] = []
    const sender = new LatestWinsSender<number>(async (value) => {
      sent.push(value)
      if (value === 1) await gate.promise
    })
    sender.push(1)
    sender.push(2)
    sender.push(3)
    sender.push(4)
    await turn()
    assert.deepEqual(sent, [1])
    gate.resolve()
    await sender.flush()
    assert.deepEqual(sent, [1, 4])
  })

  test("flush resolves at once when nothing was sent, and after the last send otherwise", async () => {
    const sender = new LatestWinsSender<number>(async () => {})
    await sender.flush()
    const sent: number[] = []
    const slow = new LatestWinsSender<number>(async (v) => {
      await turn()
      sent.push(v)
    })
    slow.push(1)
    await slow.flush()
    assert.deepEqual(sent, [1])
  })

  test("a failed send is reported, and the next value is still sent", async () => {
    const errors: unknown[] = []
    const sent: number[] = []
    const gate = deferred<void>()
    const sender = new LatestWinsSender<number>(
      async (v) => {
        sent.push(v)
        if (v === 1) {
          await gate.promise
          throw new Error("refused")
        }
      },
      (e) => errors.push(e)
    )
    sender.push(1)
    sender.push(2)
    gate.resolve()
    await sender.flush()
    assert.deepEqual(sent, [1, 2])
    assert.equal(errors.length, 1)
  })

  test("pushes after a flush start a new run", async () => {
    const sent: number[] = []
    const sender = new LatestWinsSender<number>(async (v) => void sent.push(v))
    sender.push(1)
    await sender.flush()
    sender.push(2)
    await sender.flush()
    assert.deepEqual(sent, [1, 2])
  })
})
