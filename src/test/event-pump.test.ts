import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import {
  EventBatch,
  EventCursor,
  EventPump,
  EventPumpHandlers,
  Timers,
  isNewNumbering,
} from "../protocol/event-pump"

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

/**
 * A fake PollEvents over a list of events with seqs 1..n, keeping the last `capacity` (like the server's ring), with
 * the server's epoch rule: an afterSeq from another epoch, or past the newest seq, is read as 0
 */
class FakeServer {
  epoch = 0x5eed
  events: Array<{ seq: number; text: string }> = []
  capacity = Infinity
  /** [afterSeq, maxEvents] of each poll */
  calls: Array<[number, number]> = []
  epochs: number[] = []
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

  /** Another host process: a new epoch, and seqs from 1 again */
  restart(...texts: string[]): void {
    this.epoch++
    this.events = []
    this.add(...texts)
  }

  poll = async (epoch: number, afterSeq: number, maxEvents: number): Promise<EventBatch<string>> => {
    this.calls.push([afterSeq, maxEvents])
    this.epochs.push(epoch)
    if (this.hold) await new Promise<void>((resolve) => this.held.push(resolve))
    if (this.failNext) {
      const error = this.failNext
      this.failNext = null
      throw error
    }
    if ((epoch !== 0 && epoch !== this.epoch) || afterSeq > this.events.length) afterSeq = 0
    const oldest = Math.max(1, this.events.length - this.capacity + 1)
    const dropped = Math.max(0, oldest - (afterSeq + 1))
    const available = this.events.filter((e) => e.seq > afterSeq && e.seq >= oldest).slice(0, maxEvents)
    const nextSeq =
      available.length > 0
        ? available[available.length - 1].seq
        : Math.min(Math.max(afterSeq, oldest - 1), this.events.length)
    return { epoch: this.epoch, nextSeq, dropped, events: available.map((e) => e.text) }
  }
}

function makePump(server: FakeServer, options: { maxEvents?: number } = {}) {
  const timers = new FakeTimers()
  const received: string[][] = []
  const dropped: number[] = []
  const errors: unknown[] = []
  const resets: Array<[EventCursor, EventCursor]> = []
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
    assert.deepEqual(server.epochs, [0], "the first poll has no epoch yet")
    assert.deepEqual(received, [["a", "b"]])
    assert.equal(pump.nextSeq, 2)
    assert.deepEqual(pump.position, { epoch: server.epoch, seq: 2 })

    // Nothing new: no onEvents call, and the next poll waits the interval
    assert.equal(timers.delay, 100)
    await timers.fire()
    assert.deepEqual(server.calls[1], [2, 256])
    assert.equal(server.epochs[1], server.epoch, "later polls send the response's epoch")
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

  test("starting again from its position (a reconnect to the same host) misses and repeats nothing", async () => {
    const server = new FakeServer()
    server.add("1", "2")
    const first = makePump(server)
    first.pump.start()
    await first.timers.fire()
    first.pump.stop()
    server.add("3")

    const second = makePump(server)
    second.pump.start(first.pump.position)
    await second.timers.fire()
    assert.deepEqual(server.epochs[server.epochs.length - 1], server.epoch)
    assert.deepEqual(second.received, [["3"]])
    assert.deepEqual(second.resets, [])
  })

  test("a new epoch (another host process) is reported as a reset, and its events come from its start", async () => {
    const server = new FakeServer()
    server.add("1", "2", "3", "4")
    const { pump, timers, received, resets } = makePump(server)

    pump.start()
    await timers.fire()
    const before = pump.position
    server.restart("new 1", "new 2")
    await timers.fire()
    assert.deepEqual(resets, [[before, { epoch: server.epoch, seq: 2 }]])
    assert.deepEqual(received, [["1", "2", "3", "4"], ["new 1", "new 2"]])
    assert.deepEqual(pump.position, { epoch: server.epoch, seq: 2 })
  })

  test("seqs going backwards within an epoch (afterSeq past the newest) are a reset too", async () => {
    const server = new FakeServer()
    server.add("1", "2", "3")
    const { pump, timers, resets } = makePump(server)

    pump.start()
    await timers.fire()
    server.events = []
    await timers.fire()
    assert.deepEqual(resets, [[{ epoch: server.epoch, seq: 3 }, { epoch: server.epoch, seq: 0 }]])
    assert.equal(pump.nextSeq, 0)
  })

  test("isNewNumbering: never from the start, otherwise another epoch or a seq going backwards", () => {
    assert.equal(isNewNumbering({ epoch: 0, seq: 0 }, { epoch: 7, nextSeq: 3 }), false)
    assert.equal(isNewNumbering({ epoch: 0, seq: 5 }, { epoch: 7, nextSeq: 3 }), false)
    assert.equal(isNewNumbering({ epoch: 7, seq: 3 }, { epoch: 7, nextSeq: 3 }), false)
    assert.equal(isNewNumbering({ epoch: 7, seq: 3 }, { epoch: 7, nextSeq: 9 }), false)
    assert.equal(isNewNumbering({ epoch: 7, seq: 3 }, { epoch: 8, nextSeq: 9 }), true)
    assert.equal(isNewNumbering({ epoch: 7, seq: 3 }, { epoch: 7, nextSeq: 2 }), true)
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

  test("a handler that throws loses that batch, is reported, and doesn't stop the pump", async () => {
    const server = new FakeServer()
    server.add("1", "2")
    const timers = new FakeTimers()
    const received: string[][] = []
    const errors: unknown[] = []
    let fail = true
    const pump = new EventPump(
      server.poll,
      {
        onEvents: (events) => {
          if (fail) {
            fail = false
            throw new Error("handler failed")
          }
          received.push(events)
        },
        onError: (e) => errors.push(e),
      },
      { intervalMs: 100, errorRetryMs: 1000, timers }
    )

    pump.start()
    await timers.fire()
    assert.equal(errors.length, 1)
    assert.equal(pump.nextSeq, 2, "the cursor moved past the lost batch")
    assert.equal(timers.delay, 100, "the normal interval, not the error retry")
    server.add("3")
    await timers.fire()
    assert.deepEqual(received, [["3"]])
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
