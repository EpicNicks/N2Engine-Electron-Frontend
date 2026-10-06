import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { EventBatch, EventPump, EventPumpHandlers, Timers } from "../protocol/event-pump"

/** Timers that fire only when the test says so */
class FakeTimers implements Timers {
  private next = 1
  pending = new Map<number, { callback: () => void; ms: number }>()

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.next++
    this.pending.set(handle, { callback, ms })
    return handle
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number)
  }

  /** The delay of the only pending timer */
  get delay(): number | undefined {
    assert.ok(this.pending.size <= 1, "at most one timer pending")
    return [...this.pending.values()][0]?.ms
  }

  /** Fires the pending timer and lets the poll it starts settle */
  async fire(): Promise<void> {
    const [handle, entry] = [...this.pending.entries()][0]
    this.pending.delete(handle)
    entry.callback()
    await settle()
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A fake PollEvents over a list of events with seqs 1..n, keeping the last `capacity` (like the server's ring) */
class FakeServer {
  events: Array<{ seq: number; text: string }> = []
  capacity = Infinity
  calls: Array<[number, number]> = []
  failNext: Error | null = null
  /** Resolves pending polls on demand when set */
  hold = false
  private held: Array<() => void> = []

  add(...texts: string[]): void {
    for (const text of texts) {
      this.events.push({ seq: this.events.length + 1, text })
    }
  }

  release(): void {
    this.held.splice(0).forEach((resolve) => resolve())
  }

  poll = async (afterSeq: number, maxEvents: number): Promise<EventBatch<string>> => {
    this.calls.push([afterSeq, maxEvents])
    if (this.hold) await new Promise<void>((resolve) => this.held.push(resolve))
    if (this.failNext) {
      const error = this.failNext
      this.failNext = null
      throw error
    }
    const oldest = Math.max(1, this.events.length - this.capacity + 1)
    const dropped = Math.max(0, oldest - (afterSeq + 1))
    const available = this.events.filter((e) => e.seq > afterSeq && e.seq >= oldest).slice(0, maxEvents)
    const nextSeq =
      available.length > 0
        ? available[available.length - 1].seq
        : Math.min(Math.max(afterSeq, oldest - 1), this.events.length)
    return { nextSeq, dropped, events: available.map((e) => e.text) }
  }
}

function makePump(server: FakeServer, options: { maxEvents?: number } = {}) {
  const timers = new FakeTimers()
  const received: string[][] = []
  const dropped: number[] = []
  const errors: unknown[] = []
  const resets: Array<[number, number]> = []
  const handlers: EventPumpHandlers<string> = {
    onEvents: (events) => received.push(events),
    onDropped: (count) => dropped.push(count),
    onError: (e) => errors.push(e),
    onReset: (prev, next) => resets.push([prev, next]),
  }
  const pump = new EventPump(server.poll, handlers, {
    intervalMs: 100,
    errorRetryMs: 1000,
    maxEvents: options.maxEvents ?? 256,
    timers,
  })
  return { pump, timers, received, dropped, errors, resets }
}

describe("EventPump", () => {
  test("the first poll asks for everything after seq 0 and the cursor follows nextSeq", async () => {
    const server = new FakeServer()
    server.add("a", "b")
    const { pump, timers, received } = makePump(server)

    pump.start()
    assert.equal(timers.delay, 0)
    await timers.fire()
    assert.deepEqual(server.calls, [[0, 256]])
    assert.deepEqual(received, [["a", "b"]])
    assert.equal(pump.nextSeq, 2)

    // Nothing new: no onEvents call, and the next poll waits the interval
    assert.equal(timers.delay, 100)
    await timers.fire()
    assert.deepEqual(server.calls[1], [2, 256])
    assert.equal(received.length, 1)

    server.add("c")
    await timers.fire()
    assert.deepEqual(received, [["a", "b"], ["c"]])
    assert.equal(pump.nextSeq, 3)
  })

  test("a full batch is followed by another poll straight away", async () => {
    const server = new FakeServer()
    server.add("1", "2", "3", "4", "5")
    const { pump, timers, received } = makePump(server, { maxEvents: 2 })

    pump.start()
    await timers.fire()
    assert.equal(timers.delay, 0)
    await timers.fire()
    assert.equal(timers.delay, 0)
    await timers.fire()
    assert.equal(timers.delay, 100)
    assert.deepEqual(received, [["1", "2"], ["3", "4"], ["5"]])
  })

  test("dropped events are reported", async () => {
    const server = new FakeServer()
    server.capacity = 3
    server.add("1", "2", "3", "4", "5")
    const { pump, timers, received, dropped } = makePump(server)

    pump.start()
    await timers.fire()
    assert.deepEqual(dropped, [2])
    assert.deepEqual(received, [["3", "4", "5"]])
    assert.equal(pump.nextSeq, 5)
  })

  test("starting from a later seq skips what was already seen", async () => {
    const server = new FakeServer()
    server.add("1", "2", "3")
    const { pump, timers, received } = makePump(server)

    pump.start(2)
    await timers.fire()
    assert.deepEqual(received, [["3"]])
  })

  test("a cursor that goes backwards (the server restarted) is reported as a reset", async () => {
    const server = new FakeServer()
    server.add("1", "2", "3")
    const { pump, timers, resets } = makePump(server)

    pump.start()
    await timers.fire()
    server.events = []
    await timers.fire()
    assert.deepEqual(resets, [[3, 0]])
    assert.equal(pump.nextSeq, 0)
  })

  test("a failed poll is reported and retried after the error delay, keeping the cursor", async () => {
    const server = new FakeServer()
    server.add("1")
    const { pump, timers, received, errors } = makePump(server)

    pump.start()
    await timers.fire()
    server.failNext = new Error("Connection closed")
    server.add("2")
    await timers.fire()
    assert.equal(errors.length, 1)
    assert.equal(timers.delay, 1000)
    await timers.fire()
    assert.deepEqual(server.calls.map((c) => c[0]), [0, 1, 1])
    assert.deepEqual(received, [["1"], ["2"]])
  })

  test("pollNow polls immediately and never overlaps a poll in flight", async () => {
    const server = new FakeServer()
    server.add("1")
    const { pump, timers, received } = makePump(server)

    pump.start()
    server.hold = true
    const first = pump.pollNow()
    const second = pump.pollNow()
    assert.equal(first, second)
    assert.equal(timers.pending.size, 0, "the scheduled poll was replaced")
    await settle()
    assert.equal(server.calls.length, 1)
    server.release()
    await first
    assert.deepEqual(received, [["1"]])
    assert.equal(timers.delay, 100)
  })

  test("stop cancels the timer and ignores a poll still in flight", async () => {
    const server = new FakeServer()
    server.add("1")
    const { pump, timers, received } = makePump(server)

    pump.start()
    server.hold = true
    const polling = pump.pollNow()
    await settle()
    pump.stop()
    server.release()
    await polling
    assert.deepEqual(received, [])
    assert.equal(timers.pending.size, 0)
    assert.equal(pump.isRunning, false)
    await pump.pollNow() // a no-op when stopped
    assert.equal(server.calls.length, 1)
  })
})
