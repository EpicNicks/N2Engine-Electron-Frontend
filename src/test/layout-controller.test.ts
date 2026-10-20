import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { LayoutController, SaveDelayMilliseconds, Schedule } from "../renderer/layout/layout-controller"
import { defaultLayout } from "../renderer/layout/layout-model"
import {
  KeyValueStore,
  LayoutPersistence,
  UserLayoutKey,
  browserStore,
  projectLayoutKey,
} from "../renderer/layout/layout-storage"
import { fixtureRegistry, shape } from "./layout-fixture"

const registry = fixtureRegistry()
const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"

/** A store in memory; with `broken` every access throws, as a blocked localStorage does */
class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>()
  broken = false
  writes = 0
  get(key: string): string | null {
    if (this.broken) throw new Error("storage unavailable")
    return this.data.get(key) ?? null
  }
  set(key: string, value: string): void {
    if (this.broken) throw new Error("storage unavailable")
    this.writes++
    this.data.set(key, value)
  }
  remove(key: string): void {
    if (this.broken) throw new Error("storage unavailable")
    this.data.delete(key)
  }
}

/** A clock the test moves: callbacks run when time passes their delay */
class ManualClock {
  private now = 0
  private pending: { at: number; callback: () => void; cancelled: boolean }[] = []
  readonly schedule: Schedule = (callback, ms) => {
    const entry = { at: this.now + ms, callback, cancelled: false }
    this.pending.push(entry)
    return () => {
      entry.cancelled = true
    }
  }
  get waiting(): number {
    return this.pending.filter((p) => !p.cancelled).length
  }
  advance(ms: number): void {
    this.now += ms
    for (const entry of this.pending.filter((p) => !p.cancelled && p.at <= this.now)) {
      entry.cancelled = true
      entry.callback()
    }
  }
}

function setup(store = new MemoryStore()) {
  const clock = new ManualClock()
  const persistence = new LayoutPersistence(store, registry)
  const controller = new LayoutController(registry, persistence, clock.schedule)
  return { store, clock, persistence, controller }
}

const savedShape = (store: MemoryStore, id: string) => {
  const text = store.data.get(projectLayoutKey(id))
  return text === undefined ? null : shape(JSON.parse(text))
}

describe("LayoutController saving", () => {
  test("starts with the default layout and saves nothing until a project is known", () => {
    const { controller, clock, store } = setup()
    assert.deepEqual(controller.layout.value, defaultLayout(registry))
    controller.move("assets", { region: "right" })
    clock.advance(10_000)
    assert.equal(store.writes, 0)
  })

  test("saves a change once, after the delay, under the project's id", () => {
    const { controller, clock, store } = setup()
    controller.setProject(A)
    controller.move("assets", { region: "right" })
    controller.setSize("right", 410)
    assert.equal(store.writes, 0, "nothing is written before the delay")
    clock.advance(SaveDelayMilliseconds - 1)
    assert.equal(store.writes, 0)
    clock.advance(1)
    assert.equal(store.writes, 1, "a burst of changes is one write")
    assert.deepEqual(savedShape(store, A)!.right, [["hierarchy", "assets"], ["inspector"], ["engine"]])
    assert.equal(JSON.parse(store.data.get(projectLayoutKey(A))!).regions.right.size, 410)
  })

  test("a change that keeps being made keeps the save waiting", () => {
    const { controller, clock, store } = setup()
    controller.setProject(A)
    for (let size = 320; size <= 400; size += 20) {
      controller.setSize("left", size)
      clock.advance(SaveDelayMilliseconds - 100)
    }
    assert.equal(store.writes, 0)
    clock.advance(200)
    assert.equal(store.writes, 1)
  })

  test("a layout restored from storage is not written back, and is the same after another load", () => {
    const first = setup()
    first.controller.setProject(A)
    first.controller.close("engine")
    first.clock.advance(SaveDelayMilliseconds)
    const second = setup(first.store)
    const writes = first.store.writes
    second.controller.setProject(A)
    second.clock.advance(10_000)
    assert.equal(first.store.writes, writes)
    assert.deepEqual(shape(second.controller.layout.value).right, [["hierarchy"], ["inspector"]])
    assert.deepEqual(second.controller.layout.value.closed, ["engine"])
  })

  test("flush and dispose save what is waiting at once", () => {
    const { controller, clock, store } = setup()
    controller.setProject(A)
    controller.close("console")
    controller.flush()
    assert.equal(store.writes, 1)
    assert.equal(clock.waiting, 0)
    controller.close("assets")
    controller.dispose()
    assert.equal(store.writes, 2)
    controller.close("engine")
    assert.equal(clock.waiting, 0, "nothing is scheduled after dispose")
  })

  test("a change that is only a text file does not write anything", () => {
    const { controller, clock, store } = setup()
    controller.setProject(A)
    controller.setDynamicTabs(["text:res://a.lua"])
    controller.showDynamic("text:res://a.lua")
    clock.advance(10_000)
    assert.equal(store.writes, 0)
    assert.deepEqual(shape(controller.layout.value).bottom, [["console", "text:res://a.lua"]])
  })

  test("a layout arranged before the project's id arrived becomes the project's", () => {
    const { controller, clock, store } = setup()
    controller.move("assets", { region: "right" })
    controller.setProject(A)
    clock.advance(SaveDelayMilliseconds)
    assert.deepEqual(savedShape(store, A)!.right[0], ["hierarchy", "assets"])
  })

  test("another project does not inherit the last one's layout, and a pending save goes to the first", () => {
    const { controller, clock, store } = setup()
    controller.setProject(A)
    controller.move("assets", { region: "right" })
    controller.setProject(B)
    assert.deepEqual(savedShape(store, A)!.right[0], ["hierarchy", "assets"], "A's change was saved before B was shown")
    assert.deepEqual(shape(controller.layout.value), shape(defaultLayout(registry)))
    clock.advance(10_000)
    assert.equal(savedShape(store, B), null)
  })

  test("each project keeps its own", () => {
    const first = setup()
    first.controller.setProject(A)
    first.controller.close("assets")
    first.controller.flush()
    first.controller.setProject(B)
    first.controller.close("console")
    first.controller.flush()
    const next = setup(first.store)
    next.controller.setProject(A)
    assert.deepEqual(shape(next.controller.layout.value).left, [])
    assert.deepEqual(shape(next.controller.layout.value).bottom, [["console"]])
    next.controller.setProject(B)
    assert.deepEqual(shape(next.controller.layout.value).left, [["assets"]])
    assert.deepEqual(shape(next.controller.layout.value).bottom, [])
  })
})

describe("LayoutController reset and the user default", () => {
  test("reset clears the project's layout and shows the default", () => {
    const { controller, store } = setup()
    controller.setProject(A)
    controller.close("assets")
    controller.flush()
    assert.ok(store.data.has(projectLayoutKey(A)))
    controller.reset()
    assert.equal(store.data.has(projectLayoutKey(A)), false)
    assert.deepEqual(shape(controller.layout.value), shape(defaultLayout(registry)))
    assert.deepEqual(controller.layout.value.closed, [])
  })

  test("reset drops a save that was waiting", () => {
    const { controller, clock, store } = setup()
    controller.setProject(A)
    controller.close("assets")
    controller.reset()
    clock.advance(10_000)
    assert.equal(store.data.has(projectLayoutKey(A)), false)
  })

  test("reset keeps the open text files", () => {
    const { controller } = setup()
    controller.setProject(A)
    controller.setDynamicTabs(["text:x"])
    controller.close("console")
    controller.reset()
    assert.deepEqual(shape(controller.layout.value).bottom, [["console", "text:x"]])
  })

  test("a saved user default is what new projects and Reset start from", () => {
    const first = setup()
    first.controller.close("engine")
    first.controller.saveAsUserDefault()
    assert.equal(first.controller.hasUserDefault.value, true)
    assert.ok(first.store.data.has(UserLayoutKey))
    const second = setup(first.store)
    assert.equal(second.controller.hasUserDefault.value, true)
    second.controller.setProject(B)
    assert.deepEqual(shape(second.controller.layout.value).right, [["hierarchy"], ["inspector"]])
    second.controller.close("assets")
    second.controller.reset()
    assert.deepEqual(shape(second.controller.layout.value).left, [["assets"]])
    assert.deepEqual(shape(second.controller.layout.value).right, [["hierarchy"], ["inspector"]])
    second.controller.forgetUserDefault()
    assert.equal(second.controller.hasUserDefault.value, false)
    second.controller.reset()
    assert.deepEqual(shape(second.controller.layout.value), shape(defaultLayout(registry)))
  })
})

describe("storage that fails or holds rubbish", () => {
  test("unavailable storage: the layout works for the session and nothing throws", () => {
    const store = new MemoryStore()
    store.broken = true
    const { controller, clock } = setup(store)
    controller.setProject(A)
    controller.move("assets", { region: "right" })
    clock.advance(SaveDelayMilliseconds)
    controller.saveAsUserDefault()
    controller.forgetUserDefault()
    controller.reset()
    controller.dispose()
    assert.deepEqual(shape(controller.layout.value), shape(defaultLayout(registry)))
  })

  test("corrupt, truncated or newer stored layouts give the default", () => {
    for (const text of ["", "{", "null", "[1,2]", '{"version":99,"regions":{}}', '{"version":1,"regions":7}', "\u0000"]) {
      const store = new MemoryStore()
      store.data.set(projectLayoutKey(A), text)
      store.data.set(UserLayoutKey, text)
      const { controller } = setup(store)
      controller.setProject(A)
      assert.deepEqual(shape(controller.layout.value), shape(defaultLayout(registry)), text)
    }
  })

  test("a stored layout naming panels that no longer exist is repaired", () => {
    const store = new MemoryStore()
    store.data.set(
      projectLayoutKey(A),
      JSON.stringify({
        version: 1,
        closed: [],
        regions: {
          left: { size: 300, groups: [{ tabs: ["ghost"], active: "ghost" }] },
          center: { groups: [] },
          bottom: { groups: [{ tabs: ["console"], active: "console" }], size: 220 },
          right: { groups: [], size: 300 },
        },
      })
    )
    const { controller } = setup(store)
    controller.setProject(A)
    const layout = shape(controller.layout.value)
    assert.deepEqual(layout.center, [["viewport"]], "the viewport can never be hidden")
    assert.deepEqual(layout.left, [["assets"]])
    assert.deepEqual(layout.right, [["hierarchy"], ["inspector"], ["engine"]])
  })

  test("what is stored holds only the layout: no token, path or text of any file", () => {
    const { controller, store } = setup()
    controller.setProject(A)
    controller.setDynamicTabs(["text:res://secret/token.lua"])
    controller.move("assets", { region: "right" })
    controller.flush()
    const text = store.data.get(projectLayoutKey(A))!
    assert.equal(text.includes("secret"), false)
    assert.equal(text.includes("token"), false)
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["closed", "regions", "version"])
  })

  test("browserStore is guarded: with no localStorage, or one that throws, reads give null and writes do nothing", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    try {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked") } })
      const store = browserStore()
      assert.equal(store.get("k"), null)
      store.set("k", "v")
      store.remove("k")
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined })
      assert.equal(browserStore().get("k"), null)
      const throwing = {
        getItem: () => { throw new Error("quota") },
        setItem: () => { throw new Error("quota") },
        removeItem: () => { throw new Error("quota") },
      }
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: throwing })
      const guarded = browserStore()
      assert.equal(guarded.get("k"), null)
      guarded.set("k", "v")
      guarded.remove("k")
    } finally {
      if (saved) Object.defineProperty(globalThis, "localStorage", saved)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
  })
})
