import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import {
  KeyValueStore,
  PrefDef,
  PrefsStore,
  Schedule,
  WriteDelayMilliseconds,
  definePref,
  definedPrefKeys,
  isScopeId,
  prefStorageKey,
  v,
} from "../renderer/prefs"

const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"

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

/** A scheduler the test runs by hand */
class ManualClock {
  private now = 0
  private next = 1
  private readonly timers = new Map<number, { at: number; callback: () => void }>()
  readonly schedule: Schedule = (callback, milliseconds) => {
    const id = this.next++
    this.timers.set(id, { at: this.now + milliseconds, callback })
    return () => void this.timers.delete(id)
  }
  get pending(): number {
    return this.timers.size
  }
  advance(milliseconds: number): void {
    this.now += milliseconds
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.now) {
        this.timers.delete(id)
        timer.callback()
      }
    }
  }
}

// Keys used by these tests (each key name is defined once per scope in the process)
const Volume = definePref({ key: "testVolume", scope: "user", default: 5, validate: v.number(0, 10) })
const Mode = definePref({ key: "testMode", scope: "user", default: "a" as "a" | "b", validate: v.oneOf(["a", "b"] as const) })
const Names = definePref({ key: "testNames", scope: "project", default: [] as string[], validate: v.arrayOf(v.string(10), 3) })
const Legacy = definePref({
  key: "testLegacy",
  scope: "project",
  default: null as Record<string, unknown> | null,
  validate: v.object,
  legacyKey: (id) => `old.project.${id}`,
})
const LegacyUser = definePref({
  key: "testLegacyUser",
  scope: "user",
  default: null as Record<string, unknown> | null,
  validate: v.object,
  legacyKey: () => "old.user",
})

function setup(store = new MemoryStore()) {
  const clock = new ManualClock()
  const prefs = new PrefsStore(store, clock.schedule)
  return { store, clock, prefs }
}

describe("PrefsStore reading and writing", () => {
  test("a key that was never set gives its default", () => {
    const { prefs } = setup()
    assert.equal(prefs.user.get(Volume), 5)
    assert.deepEqual(prefs.project(A).get(Names), [])
  })

  test("a set value is read back at once and written after the delay as a versioned entry", () => {
    const { prefs, store, clock } = setup()
    assert.equal(prefs.user.set(Volume, 7), true)
    assert.equal(prefs.user.get(Volume), 7)
    assert.equal(store.writes, 0, "not written yet")
    clock.advance(WriteDelayMilliseconds - 1)
    assert.equal(store.writes, 0)
    clock.advance(1)
    assert.equal(store.writes, 1)
    assert.deepEqual(JSON.parse(store.data.get("n2.prefs.user.testVolume")!), { version: 1, value: 7 })
    assert.equal(prefStorageKey(Volume), "n2.prefs.user.testVolume")
  })

  test("a burst of changes is one write (the delay restarts), of the last value", () => {
    const { prefs, store, clock } = setup()
    for (const n of [1, 2, 3, 4]) {
      prefs.user.set(Volume, n)
      clock.advance(WriteDelayMilliseconds - 10)
    }
    assert.equal(store.writes, 0)
    clock.advance(10)
    assert.equal(store.writes, 1)
    assert.equal(JSON.parse(store.data.get("n2.prefs.user.testVolume")!).value, 4)
  })

  test("immediate writes at once, and flush writes what waits (all keys)", () => {
    const { prefs, store, clock } = setup()
    prefs.user.set(Volume, 3, { immediate: true })
    assert.equal(store.writes, 1)
    prefs.user.set(Mode, "b")
    prefs.project(A).set(Names, ["x"])
    assert.equal(store.writes, 1)
    prefs.flush()
    assert.equal(store.writes, 3)
    assert.equal(clock.pending, 0, "the waiting write is cancelled")
    clock.advance(10_000)
    assert.equal(store.writes, 3)
  })

  test("the window going away flushes (pagehide and beforeunload), and the detach stops it", () => {
    const { prefs, store } = setup()
    const target = new EventTarget()
    const detach = prefs.flushOnUnload(target)
    prefs.user.set(Volume, 9)
    target.dispatchEvent(new Event("pagehide"))
    assert.equal(store.writes, 1)
    prefs.user.set(Volume, 8)
    target.dispatchEvent(new Event("beforeunload"))
    assert.equal(store.writes, 2)
    detach()
    prefs.user.set(Volume, 7)
    target.dispatchEvent(new Event("pagehide"))
    assert.equal(store.writes, 2)
  })

  test("a value that is not valid for the key is refused and changes nothing", () => {
    const { prefs, store, clock } = setup()
    assert.equal(prefs.user.set(Volume, 11), false)
    assert.equal(prefs.user.set(Volume, Number.NaN), false)
    assert.equal(prefs.user.set(Mode, "c" as "a"), false)
    assert.equal(prefs.user.get(Volume), 5)
    clock.advance(10_000)
    assert.equal(store.writes, 0)
  })

  test("remove gives the default again and removes the entry", () => {
    const { prefs, store } = setup()
    prefs.user.set(Volume, 2, { immediate: true })
    assert.ok(store.data.has("n2.prefs.user.testVolume"))
    prefs.user.remove(Volume, { immediate: true })
    assert.equal(prefs.user.get(Volume), 5)
    assert.equal(store.data.has("n2.prefs.user.testVolume"), false)
  })

  test("stored values survive a new store over the same storage", () => {
    const first = setup()
    first.prefs.user.set(Mode, "b", { immediate: true })
    first.prefs.project(A).set(Names, ["p", "q"], { immediate: true })
    const second = setup(first.store)
    assert.equal(second.prefs.user.get(Mode), "b")
    assert.deepEqual(second.prefs.project(A).get(Names), ["p", "q"])
  })
})

describe("scopes", () => {
  test("each project has its own values, and the user scope is separate from them", () => {
    const { prefs, store } = setup()
    prefs.project(A).set(Names, ["a"], { immediate: true })
    prefs.project(B).set(Names, ["b"], { immediate: true })
    assert.deepEqual(prefs.project(A).get(Names), ["a"])
    assert.deepEqual(prefs.project(B).get(Names), ["b"])
    assert.ok(store.data.has(`n2.prefs.project.${A}.testNames`))
    assert.ok(store.data.has(`n2.prefs.project.${B}.testNames`))
    prefs.user.set(Volume, 1, { immediate: true })
    assert.deepEqual(
      [...store.data.keys()].filter((k) => k.startsWith("n2.prefs.user.")),
      ["n2.prefs.user.testVolume"]
    )
  })

  test("a project id that is not one gives a scope that remembers nothing", () => {
    const { prefs, store } = setup()
    for (const id of ["", "../etc", "a b", "x".repeat(65), "a.b"]) {
      assert.equal(isScopeId(id), false, id)
      const view = prefs.project(id)
      assert.equal(view.set(Names, ["x"], { immediate: true }), false)
      assert.deepEqual(view.get(Names), [])
      view.remove(Names, { immediate: true })
      view.subscribe(Names, () => {})()
    }
    assert.equal(store.data.size, 0)
    assert.equal(isScopeId(A), true)
  })
})

describe("corrupt and foreign storage", () => {
  test("rubbish, a wrong type, a bad version or a value that fails the validator gives the default, and the entry is dropped", () => {
    const cases: Record<string, string> = {
      "not json": "{oops",
      "not an object": "5",
      "no version": JSON.stringify({ value: 3 }),
      "version zero": JSON.stringify({ version: 0, value: 3 }),
      "fractional version": JSON.stringify({ version: 1.5, value: 3 }),
      "wrong type": JSON.stringify({ version: 1, value: "loud" }),
      "out of range": JSON.stringify({ version: 1, value: 99 }),
    }
    for (const [label, text] of Object.entries(cases)) {
      const { prefs, store } = setup()
      store.data.set("n2.prefs.user.testVolume", text)
      assert.equal(prefs.user.get(Volume), 5, label)
      assert.equal(store.data.has("n2.prefs.user.testVolume"), false, `${label}: dropped`)
    }
  })

  test("an entry a newer editor wrote is not used and not overwritten", () => {
    const { prefs, store } = setup()
    const newer = JSON.stringify({ version: 2, value: { x: 1 } })
    store.data.set("n2.prefs.user.testVolume", newer)
    assert.equal(prefs.user.get(Volume), 5)
    prefs.user.set(Volume, 6, { immediate: true })
    assert.equal(prefs.user.get(Volume), 6, "it applies for the session")
    assert.equal(store.data.get("n2.prefs.user.testVolume"), newer, "the newer entry is kept as it was")
  })

  test("storage that throws on every access never makes a call throw, and values still apply for the session", () => {
    const store = new MemoryStore()
    store.broken = true
    const { prefs } = setup(store)
    assert.equal(prefs.user.get(Volume), 5)
    assert.equal(prefs.user.set(Volume, 8, { immediate: true }), true)
    assert.equal(prefs.user.get(Volume), 8)
    prefs.user.remove(Mode, { immediate: true })
    prefs.project(A).set(Names, ["z"])
    prefs.flush()
    assert.deepEqual(prefs.project(A).get(Names), ["z"])
  })

  test("an array with one bad item is invalid as a whole (and a too long one)", () => {
    const { prefs, store } = setup()
    store.data.set(`n2.prefs.project.${A}.testNames`, JSON.stringify({ version: 1, value: ["ok", 3] }))
    assert.deepEqual(prefs.project(A).get(Names), [])
    store.data.set(`n2.prefs.project.${B}.testNames`, JSON.stringify({ version: 1, value: ["a", "b", "c", "d"] }))
    assert.deepEqual(prefs.project(B).get(Names), [])
  })
})

describe("legacy entries", () => {
  test("an older release's entry is read when ours is absent, and never written back", () => {
    const { prefs, store, clock } = setup()
    store.data.set(`old.project.${A}`, JSON.stringify({ version: 1, layout: true }))
    store.data.set("old.user", JSON.stringify({ version: 1, user: true }))
    assert.deepEqual(prefs.project(A).get(Legacy), { version: 1, layout: true })
    assert.deepEqual(prefs.user.get(LegacyUser), { version: 1, user: true })
    prefs.flush()
    clock.advance(10_000)
    assert.equal(store.writes, 0, "reading wrote nothing")
    assert.equal(store.data.has(`n2.prefs.project.${A}.testLegacy`), false)
  })

  test("our entry wins over the legacy one, and a set value is written under ours only", () => {
    const { prefs, store } = setup()
    store.data.set(`old.project.${A}`, JSON.stringify({ from: "old" }))
    prefs.project(A).set(Legacy, { from: "new" }, { immediate: true })
    assert.equal(store.data.get(`old.project.${A}`), JSON.stringify({ from: "old" }), "the old entry is untouched")
    const again = setup(store)
    assert.deepEqual(again.prefs.project(A).get(Legacy), { from: "new" })
  })

  test("remove forgets the legacy entry too, or it would come back", () => {
    const { prefs, store } = setup()
    store.data.set(`old.project.${A}`, JSON.stringify({ from: "old" }))
    store.data.set("old.user", JSON.stringify({ from: "old" }))
    assert.ok(prefs.project(A).get(Legacy))
    prefs.project(A).remove(Legacy, { immediate: true })
    prefs.user.remove(LegacyUser, { immediate: true })
    assert.equal(store.data.has(`old.project.${A}`), false)
    assert.equal(store.data.has("old.user"), false)
    const again = setup(store)
    assert.equal(again.prefs.project(A).get(Legacy), null)
    assert.equal(again.prefs.user.get(LegacyUser), null)
  })

  test("a corrupt legacy entry, or a corrupt entry of ours with a good legacy one, falls back sensibly", () => {
    const a = setup()
    a.store.data.set(`old.project.${A}`, "{oops")
    assert.equal(a.prefs.project(A).get(Legacy), null)
    const b = setup()
    b.store.data.set(`n2.prefs.project.${A}.testLegacy`, "{oops")
    b.store.data.set(`old.project.${A}`, JSON.stringify({ from: "old" }))
    assert.deepEqual(b.prefs.project(A).get(Legacy), { from: "old" })
  })
})

describe("subscribe", () => {
  test("hears every change of its key (a remove too), not other keys, and stops after unsubscribe", () => {
    const { prefs } = setup()
    const heard: number[] = []
    const stop = prefs.user.subscribe(Volume, (value) => heard.push(value))
    prefs.user.set(Volume, 1)
    prefs.user.set(Mode, "b")
    prefs.user.set(Volume, 2)
    prefs.user.remove(Volume)
    assert.deepEqual(heard, [1, 2, 5])
    stop()
    prefs.user.set(Volume, 3)
    assert.deepEqual(heard, [1, 2, 5])
  })

  test("a refused value is not announced, and a listener that throws does not stop the others or the write", () => {
    const { prefs, store } = setup()
    const heard: number[] = []
    prefs.user.subscribe(Volume, () => {
      throw new Error("listener bug")
    })
    prefs.user.subscribe(Volume, (value) => heard.push(value))
    prefs.user.set(Volume, 99)
    assert.deepEqual(heard, [])
    prefs.user.set(Volume, 4, { immediate: true })
    assert.deepEqual(heard, [4])
    assert.equal(JSON.parse(store.data.get("n2.prefs.user.testVolume")!).value, 4)
  })

  test("project subscriptions are per project", () => {
    const { prefs } = setup()
    const a: string[][] = []
    prefs.project(A).subscribe(Names, (value) => a.push(value))
    prefs.project(B).set(Names, ["other"])
    prefs.project(A).set(Names, ["mine"])
    assert.deepEqual(a, [["mine"]])
  })
})

describe("no secrets", () => {
  test("a key whose name looks like a secret cannot be defined", () => {
    const names = [
      "authToken",
      "host.token",
      "password",
      "apiKey",
      "sshPassphrase",
      "clientSecret",
      "tls.credential",
      "sessionId",
      "bearer",
      "privateKey",
    ]
    for (const key of names) {
      const define = (): PrefDef<string> => definePref({ key, scope: "user", default: "", validate: v.string() })
      assert.throws(define, /secret/, key)
    }
  })

  test("a malformed or duplicate key is refused", () => {
    assert.throws(() => definePref({ key: "Bad Key", scope: "user", default: 0, validate: v.number() }), /dotted/)
    assert.throws(() => definePref({ key: "testVolume", scope: "user", default: 0, validate: v.number() }), /twice/)
    // The same name in the other scope is a different key
    assert.doesNotThrow(() => definePref({ key: "testVolume", scope: "project", default: 0, validate: v.number() }))
  })

  test("no key defined anywhere in the process looks like a secret, and the stored entries hold no such text", () => {
    for (const id of definedPrefKeys()) {
      assert.equal(/token|secret|passw|credential|api[-_.]?key|auth|bearer/i.test(id), false, id)
    }
    const { prefs, store } = setup()
    prefs.user.set(Volume, 3, { immediate: true })
    prefs.project(A).set(Names, ["x"], { immediate: true })
    for (const [key, value] of store.data) {
      assert.equal(/token|secret|passw|credential/i.test(key + value), false, key)
    }
  })
})
