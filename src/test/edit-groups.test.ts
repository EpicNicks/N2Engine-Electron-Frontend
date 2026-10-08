import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { EditGroups, ListenerTarget, endWhenReleased } from "../renderer/edit-groups"

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A host's group commands: what it was sent, in order, and what it can be made to answer */
class FakeHost {
  connected = true
  sent: string[] = []
  /** Errors for the next begins and ends */
  beginErrors: string[] = []
  endErrors: string[] = []
  /** While set, an answer waits for it */
  gate: Promise<void> | null = null

  engine = {
    isConnected: () => this.connected,
    beginEditGroup: async (label: string): Promise<void> => {
      this.sent.push(`begin ${label}`)
      if (this.gate) await this.gate
      const error = this.beginErrors.shift()
      if (error) throw new Error(error)
    },
    endEditGroup: async (): Promise<void> => {
      this.sent.push("end")
      if (this.gate) await this.gate
      const error = this.endErrors.shift()
      if (error) throw new Error(error)
    },
  }
}

function setup() {
  const host = new FakeHost()
  const errors: string[] = []
  const groups = new EditGroups(host.engine, (what, e) => errors.push(`${what}: ${(e as Error).message}`))
  return { host, groups, errors }
}

describe("EditGroups", () => {
  test("within begins, runs the work and ends, and answers the work's result", async () => {
    const { host, groups } = setup()
    const result = await groups.within("Move 2 objects", async () => {
      host.sent.push("work")
      assert.equal(groups.depth, 1)
      return 42
    })
    assert.equal(result, 42)
    assert.deepEqual(host.sent, ["begin Move 2 objects", "work", "end"])
    assert.equal(groups.depth, 0)
  })

  test("the group is ended when the work throws, and the work's error is the one thrown", async () => {
    const { host, groups } = setup()
    await assert.rejects(
      groups.within("Delete 3 objects", async () => {
        throw new Error("gone")
      }),
      /gone/
    )
    assert.deepEqual(host.sent, ["begin Delete 3 objects", "end"])
    assert.equal(groups.depth, 0)
  })

  test("a host that refuses the group still gets the work, ungrouped, and no end", async () => {
    const { host, groups } = setup()
    host.beginErrors = ["Too many nested edit groups"]
    const result = await groups.within("x", async () => "done")
    assert.equal(result, "done")
    assert.deepEqual(host.sent, ["begin x"])
    assert.equal(groups.depth, 0)
  })

  test("without a connection nothing is sent, and the work runs", async () => {
    const { host, groups } = setup()
    host.connected = false
    assert.equal(await groups.within("x", async () => 1), 1)
    assert.deepEqual(host.sent, [])
  })

  test("nested groups end innermost first; end with none open sends nothing", async () => {
    const { host, groups } = setup()
    await groups.end()
    assert.deepEqual(host.sent, [])
    await groups.within("outer", () => groups.within("inner", async () => host.sent.push("work")))
    assert.deepEqual(host.sent, ["begin outer", "begin inner", "work", "end", "end"])
  })

  test("an end asked for right after a begin waits for the begin's answer", async () => {
    const { host, groups } = setup()
    let release!: () => void
    host.gate = new Promise<void>((resolve) => (release = resolve))
    const began = groups.begin("drag")
    const ended = groups.end() // the pointer was released before the host answered
    await settle()
    assert.deepEqual(host.sent, ["begin drag"], "the end has not overtaken the begin")
    release()
    assert.equal(await began, true)
    await ended
    assert.deepEqual(host.sent, ["begin drag", "end"])
    assert.equal(groups.depth, 0)
  })

  test("an end the host refuses as 'no group is open' counts as ended; any other failure is reported and kept", async () => {
    const { host, groups, errors } = setup()
    await groups.begin("a")
    host.endErrors = ["No edit group is open"]
    await groups.end()
    assert.equal(groups.depth, 0)
    assert.deepEqual(errors, [])

    await groups.begin("b")
    host.endErrors = ["Something else"]
    await groups.end()
    assert.equal(groups.depth, 1, "still counted: it may be open")
    assert.deepEqual(errors, ["Failed to end the edit group: Something else"])
    // closeAll tries it again, and it goes this time
    await groups.closeAll()
    assert.equal(groups.depth, 0)
    assert.equal(host.sent.filter((c) => c === "end").length, 3)
  })

  test("closeAll ends every open group, and gives up on one that can't be ended", async () => {
    const { host, groups, errors } = setup()
    await groups.begin("a")
    await groups.begin("b")
    await groups.closeAll()
    assert.equal(groups.depth, 0)
    assert.deepEqual(host.sent, ["begin a", "begin b", "end", "end"])

    await groups.begin("c")
    host.endErrors = ["stuck", "stuck"]
    await groups.closeAll()
    assert.equal(groups.depth, 1)
    assert.equal(errors.length, 1, "reported once, not retried in a loop")
  })

  test("closeAll waits for a begin that is on its way", async () => {
    const { host, groups } = setup()
    let release!: () => void
    host.gate = new Promise<void>((resolve) => (release = resolve))
    void groups.begin("drag")
    const closing = groups.closeAll()
    release()
    await closing
    assert.deepEqual(host.sent, ["begin drag", "end"])
    assert.equal(groups.depth, 0)
  })

  test("reset forgets the groups (the host ended them with the connection), and a begin still on its way is dropped", async () => {
    const { host, groups } = setup()
    await groups.begin("a")
    groups.reset()
    assert.equal(groups.depth, 0)
    await groups.end()
    assert.deepEqual(host.sent, ["begin a"], "no end for a group of the old connection")

    let release!: () => void
    host.gate = new Promise<void>((resolve) => (release = resolve))
    const began = groups.begin("b")
    await settle()
    groups.reset() // the connection ended while the host was answering
    release()
    assert.equal(await began, false)
    assert.equal(groups.depth, 0)
  })
})

describe("endWhenReleased", () => {
  class FakeTarget implements ListenerTarget {
    listeners = new Map<string, Set<() => void>>()
    addEventListener(type: string, listener: () => void): void {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type)!.add(listener)
    }
    removeEventListener(type: string, listener: () => void): void {
      this.listeners.get(type)?.delete(listener)
    }
    fire(type: string): void {
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
    }
    get count(): number {
      return [...this.listeners.values()].reduce((n, set) => n + set.size, 0)
    }
  }

  for (const [target, type] of [
    ["doc", "pointerup"],
    ["doc", "pointercancel"],
    ["win", "blur"],
  ] as const) {
    test(`${type} ends it once, and every listener is removed`, () => {
      const doc = new FakeTarget()
      const win = new FakeTarget()
      let ended = 0
      endWhenReleased(doc, win, () => ended++)
      assert.equal(doc.count + win.count, 3)
      ;(target === "doc" ? doc : win).fire(type)
      assert.equal(ended, 1)
      assert.equal(doc.count + win.count, 0)
      doc.fire("pointerup")
      win.fire("blur")
      assert.equal(ended, 1)
    })
  }
})
