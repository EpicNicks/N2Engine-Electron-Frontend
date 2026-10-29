import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { Multiplexer, MuxError } from "../main/agent-mux"

/** A promise the test settles itself */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms))

function make(overrides: Partial<ConstructorParameters<typeof Multiplexer>[0]> = {}) {
  const log: string[] = []
  const mux = new Multiplexer({
    prepare: async () => {
      log.push("prepare")
    },
    expire: async () => {
      log.push("expire")
    },
    released: () => log.push("released"),
    ...overrides,
  })
  return { mux, log }
}

describe("the person's requests", () => {
  test("run at once when no agent job is running, side by side as they always did", async () => {
    const { mux } = make()
    const a = deferred()
    const b = deferred()
    const order: string[] = []
    const pa = mux.human(async () => (order.push("a"), a.promise))
    const pb = mux.human(async () => (order.push("b"), b.promise))
    assert.deepEqual(order, ["a", "b"])
    a.resolve()
    b.resolve()
    await Promise.all([pa, pb])
  })

  test("wait while an agent job runs, and run (all of them, in order) as soon as it is done", async () => {
    const { mux, log } = make()
    const gate = deferred()
    const agent = mux.agent(async () => {
      log.push("agent start")
      await gate.promise
      log.push("agent end")
    })
    await tick()
    const order: string[] = []
    const h1 = mux.human(async () => void order.push("h1"))
    const h2 = mux.human(async () => void order.push("h2"))
    await tick()
    assert.deepEqual(order, [], "the person's requests are held while the agent's call runs")
    assert.deepEqual(mux.waiting, { human: 2, agent: 0 })
    gate.resolve()
    await Promise.all([agent, h1, h2])
    assert.deepEqual(order, ["h1", "h2"])
    assert.deepEqual(log.filter((l) => l.startsWith("agent")), ["agent start", "agent end"])
  })

  test("the queue is bounded", async () => {
    const { mux } = make({ maxHumanQueue: 2 })
    const gate = deferred()
    const agent = mux.agent(() => gate.promise)
    await tick()
    const kept = [mux.human(async () => 1), mux.human(async () => 2)]
    await assert.rejects(mux.human(async () => 3), (e) => e instanceof MuxError && e.code === "queueFull")
    gate.resolve()
    await agent
    assert.deepEqual(await Promise.all(kept), [1, 2])
  })

  test("a request that throws, or rejects, does not stop the others", async () => {
    const { mux } = make()
    await assert.rejects(
      mux.human(() => {
        throw new Error("sync")
      }),
      /sync/
    )
    await assert.rejects(mux.human(() => Promise.reject(new Error("async"))), /async/)
    assert.equal(await mux.human(async () => 7), 7)
  })
})

describe("the agent's jobs", () => {
  test("run one at a time, in the order they came, each after the page has settled", async () => {
    const { mux, log } = make()
    const order: string[] = []
    const g1 = deferred()
    const j1 = mux.agent(async () => {
      order.push("1 start")
      await g1.promise
      order.push("1 end")
    })
    const j2 = mux.agent(async () => void order.push("2"))
    const j3 = mux.agent(async () => void order.push("3"))
    await tick()
    assert.deepEqual(order, ["1 start"], "the second does not start while the first runs")
    g1.resolve()
    await Promise.all([j1, j2, j3])
    assert.deepEqual(order, ["1 start", "1 end", "2", "3"])
    assert.equal(log.filter((l) => l === "prepare").length, 3, "a job with no lease settles the page first")
  })

  test("settle before the agent's call: the page is asked first, and the call runs only after it answered", async () => {
    const settle = deferred()
    const { mux, log } = make({
      prepare: async () => {
        log.push("settle begins")
        await settle.promise
        log.push("settle ends")
      },
    })
    const job = mux.agent(async () => void log.push("call"))
    await tick()
    assert.deepEqual(log, ["settle begins"])
    settle.resolve()
    await job
    assert.deepEqual(log.slice(0, 3), ["settle begins", "settle ends", "call"])
  })

  test("while the page settles its edits (which are the person's own requests) they pass; the call waits for them", async () => {
    const order: string[] = []
    let mux!: Multiplexer
    const sent = deferred()
    mux = new Multiplexer({
      // What settling does: the inspector's pending edit is sent through the person's path
      prepare: async () => {
        const edit = mux.human(async () => {
          order.push("inspector edit sent")
          await sent.promise
          order.push("inspector edit answered")
        })
        await tick()
        sent.resolve()
        await edit
      },
      expire: async () => undefined,
    })
    await mux.agent(async () => void order.push("agent call"))
    assert.deepEqual(order, ["inspector edit sent", "inspector edit answered", "agent call"], "an edit in progress never interleaves with the call")
  })

  test("an in-flight request of the person finishes before the call starts, and the person's later ones go after it", async () => {
    const { mux } = make()
    const order: string[] = []
    const slow = deferred()
    const h = mux.human(async () => {
      order.push("human start")
      await slow.promise
      order.push("human end")
    })
    const agent = mux.agent(async () => void order.push("agent"))
    await tick()
    assert.deepEqual(order, ["human start"], "the agent waits for the person's request in flight")
    const later = mux.human(async () => void order.push("later human"))
    slow.resolve()
    await Promise.all([h, agent, later])
    // The agent's call has not started, so the person's later request is not held: it goes straight through
    assert.deepEqual(order, ["human start", "later human", "human end", "agent"])
  })

  test("the person goes first between two calls of the agent", async () => {
    const { mux } = make()
    const order: string[] = []
    const g = deferred()
    const j1 = mux.agent(async () => {
      order.push("agent 1")
      await g.promise
    })
    const j2 = mux.agent(async () => void order.push("agent 2"))
    await tick()
    const h = mux.human(async () => void order.push("human"))
    g.resolve()
    await Promise.all([j1, j2, h])
    assert.deepEqual(order, ["agent 1", "human", "agent 2"])
  })

  test("the queue is bounded, and a job that cannot start in time fails busy", async () => {
    const { mux } = make({ maxAgentQueue: 1, waitMs: 30 })
    const hold = deferred()
    const running = mux.agent(() => hold.promise)
    await tick()
    const waiting = mux.agent(async () => 1)
    await assert.rejects(mux.agent(async () => 2), (e) => e instanceof MuxError && e.code === "queueFull")
    await assert.rejects(waiting, (e) => e instanceof MuxError && e.code === "busy")
    hold.resolve()
    await running
  })

  test("a page that cannot settle fails the call, which never runs", async () => {
    let ran = false
    const { mux } = make({
      prepare: async () => {
        throw new Error("window closed")
      },
    })
    await assert.rejects(
      mux.agent(async () => {
        ran = true
      }),
      (e) => e instanceof MuxError && e.code === "prepareFailed" && /window closed/.test(e.message)
    )
    assert.equal(ran, false)
    // and the person is not left waiting
    assert.equal(await mux.human(async () => 1), 1)
  })
})

describe("the lease", () => {
  test("holds the lane between the agent's jobs: the person waits, and the next job needs no new settling", async () => {
    const { mux, log } = make()
    await mux.agent(async (lease) => lease.hold())
    assert.equal(mux.leased, true)
    let humanRan = false
    const h = mux.human(async () => {
      humanRan = true
    })
    await tick()
    assert.equal(humanRan, false)
    await mux.agent(async () => undefined)
    assert.equal(log.filter((l) => l === "prepare").length, 1, "settled once, at the start of the turn")
    assert.equal(humanRan, false)
    await mux.agent(async (lease) => lease.release())
    await h
    assert.equal(humanRan, true)
    assert.equal(mux.leased, false)
  })

  test("a lease the agent leaves idle is ended by expire, then the person's requests run", async () => {
    const { mux, log } = make({ leaseIdleMs: 20 })
    await mux.agent(async (lease) => lease.hold())
    const h = mux.human(async () => void log.push("human"))
    await h
    assert.deepEqual(log.filter((l) => l === "expire" || l === "human"), ["expire", "human"])
    assert.equal(mux.leased, false)
  })

  test("close() ends a held lease and fails what waits, and the agent can come back after open()", async () => {
    const { mux, log } = make()
    await mux.agent(async (lease) => lease.hold())
    const hold = deferred()
    const running = mux.agent(() => hold.promise)
    const waiting = mux.agent(async () => 1)
    await tick()
    const closing = mux.close()
    await assert.rejects(waiting, (e) => e instanceof MuxError && e.code === "closed")
    hold.resolve()
    await running
    await closing
    assert.ok(log.includes("expire"))
    assert.equal(mux.leased, false)
    await assert.rejects(mux.agent(async () => 1), (e) => e instanceof MuxError && e.code === "closed")
    mux.open()
    assert.equal(await mux.agent(async () => 2), 2)
  })

  test("released is called when the lane goes back to the person after agent work", async () => {
    const { mux, log } = make()
    await mux.agent(async () => undefined)
    assert.ok(log.includes("released"))
  })
})
