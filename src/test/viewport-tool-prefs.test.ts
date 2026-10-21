import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { KeyValueStore, PrefsStore, prefStorageKey } from "../renderer/prefs"
import {
  ViewportSnapPref,
  ViewportToolPref,
  attachViewportSnapPrefs,
  attachViewportToolPrefs,
  validateSnapSettings,
} from "../renderer/viewport-tool-prefs"
import { defaultSnapSettings } from "../renderer/viewport-snap"
import { rig } from "./viewport-rig"

class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>()
  broken = false
  get(key: string): string | null {
    if (this.broken) throw new Error("unavailable")
    return this.data.get(key) ?? null
  }
  set(key: string, value: string): void {
    if (this.broken) throw new Error("unavailable")
    this.data.set(key, value)
  }
  remove(key: string): void {
    if (this.broken) throw new Error("unavailable")
    this.data.delete(key)
  }
}
const P1 = "11111111-1111-4111-8111-111111111111"
const P2 = "22222222-2222-4222-8222-222222222222"

describe("the tool, space and pivot are kept per user", () => {
  test("round trip: attaching writes nothing, a change is saved, a new viewport starts with it", () => {
    const storage = new MemoryStore()
    const prefs = new PrefsStore(storage)
    const a = rig().controller
    const detach = attachViewportToolPrefs(a, prefs.user)
    prefs.flush()
    assert.equal(storage.data.size, 0, "nothing saved, nothing written")
    a.setMode("rotate")
    a.setSpace("local")
    a.setPivot("center")
    prefs.flush()
    const saved = JSON.parse(storage.data.get(prefStorageKey(ViewportToolPref))!).value
    assert.deepEqual(saved, { mode: "rotate", space: "local", pivot: "center" })
    detach()
    a.setMode("scale")
    prefs.flush()
    assert.equal(JSON.parse(storage.data.get(prefStorageKey(ViewportToolPref))!).value.mode, "rotate", "detached: no more writes")

    const b = rig().controller
    attachViewportToolPrefs(b, new PrefsStore(storage).user)
    assert.equal(b.mode.value, "rotate")
    assert.equal(b.space.value, "local")
    assert.equal(b.pivot.value, "center")
  })

  test("a damaged entry gives the defaults field by field; garbage gives them whole; unusable storage does not throw", () => {
    const storage = new MemoryStore()
    const key = prefStorageKey(ViewportToolPref)
    storage.data.set(key, JSON.stringify({ version: 1, value: { mode: "fly", space: "local", pivot: 3 } }))
    const a = rig().controller
    attachViewportToolPrefs(a, new PrefsStore(storage).user)
    assert.deepEqual([a.mode.value, a.space.value, a.pivot.value], ["translate", "local", "pivot"])
    for (const bad of ["{", "null", JSON.stringify({ version: 1, value: 5 })]) {
      storage.data.set(key, bad)
      const b = rig().controller
      attachViewportToolPrefs(b, new PrefsStore(storage).user)
      assert.deepEqual([b.mode.value, b.space.value, b.pivot.value], ["translate", "world", "pivot"])
    }
    storage.broken = true
    const c = rig().controller
    const prefs = new PrefsStore(storage)
    attachViewportToolPrefs(c, prefs.user)
    c.setMode("scale")
    assert.doesNotThrow(() => prefs.flush())
    assert.equal(c.mode.value, "scale")
  })
})

describe("the snap settings are kept per project", () => {
  test("round trip, and another project is untouched", () => {
    const storage = new MemoryStore()
    const prefs = new PrefsStore(storage)
    const a = rig().controller
    const detach = attachViewportSnapPrefs(a, prefs.project(P1))
    const next = defaultSnapSettings()
    next.translate = { enabled: true, step: 0.25, kind: "absolute" }
    next.rotate = { enabled: true, stepDegrees: 45 }
    next.scale = { enabled: false, step: 0.05 }
    a.setSnap(next)
    prefs.flush()
    const saved = JSON.parse(storage.data.get(prefStorageKey(ViewportSnapPref, P1))!).value
    assert.deepEqual(saved, next)
    detach()
    const b = rig().controller
    attachViewportSnapPrefs(b, new PrefsStore(storage).project(P1))
    assert.deepEqual(b.snap.value, next)
    const other = rig().controller
    attachViewportSnapPrefs(other, new PrefsStore(storage).project(P2))
    assert.deepEqual(other.snap.value, defaultSnapSettings())
  })

  test("validation: each field that is wrong, out of range or not finite takes its default", () => {
    const d = defaultSnapSettings()
    assert.equal(validateSnapSettings(5), undefined)
    assert.deepEqual(validateSnapSettings({}), d)
    const out = validateSnapSettings({
      translate: { enabled: "yes", step: 0, kind: "sideways" },
      rotate: { enabled: true, stepDegrees: 500 },
      scale: { enabled: true, step: -1 },
    })!
    assert.deepEqual(out.translate, d.translate)
    assert.deepEqual(out.rotate, { enabled: true, stepDegrees: d.rotate.stepDegrees })
    assert.deepEqual(out.scale, { enabled: true, step: d.scale.step })
    const odd = validateSnapSettings({ translate: { step: Number.NaN }, rotate: { stepDegrees: Infinity }, scale: { step: "0.1" } })!
    assert.deepEqual(odd, d)
    const part = validateSnapSettings({ translate: { enabled: true, step: 2, kind: "absolute" } })!
    assert.deepEqual(part.translate, { enabled: true, step: 2, kind: "absolute" })
    assert.deepEqual(part.rotate, d.rotate)
  })
})
