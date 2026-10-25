// The physics backend picker's rules without a DOM (protocol 1.20.0): the answer's shape check, the block reasons and the
// state's guards.
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { signal } from "@preact/signals-core"
import { backendBlockReason, determinismLabel, validatePhysicsBackendsInfo } from "../protocol/physics-backends"
import type { PhysicsBackendsInfo } from "../protocol/protocol.generated"
import { PhysicsBackendsModel, UnsupportedReason } from "../renderer/physics-backends-state"
import { DefaultBackends, fakeBackend } from "./fake-backends"
import { ipcError } from "../shared/api"

const info = (over: Partial<PhysicsBackendsInfo> = {}): PhysicsBackendsInfo => ({
  current: "physx",
  configured: false,
  active: "physx",
  restartRequired: false,
  networkPreset: "",
  backends: DefaultBackends,
  ...over,
})

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function modelOf(options: { supported?: boolean; readOnly?: string | null; answer?: PhysicsBackendsInfo; refuse?: string } = {}) {
  const connected = signal(true)
  const supported = signal(options.supported !== false)
  const readOnlyReason = signal<string | null>(options.readOnly ?? null)
  const sent: string[] = []
  let reads = 0
  const model = new PhysicsBackendsModel({
    getPhysicsBackends: async () => (reads++, options.answer ?? info()),
    setPhysicsBackend: async (id) => {
      sent.push(id)
      if (options.refuse) throw ipcError({ error: options.refuse })
      return info({ current: id, configured: true, restartRequired: id !== "physx" })
    },
    connected,
    supported,
    readOnlyReason,
  })
  return { model, connected, supported, readOnlyReason, sent, reads: () => reads }
}

describe("validatePhysicsBackendsInfo", () => {
  test("accepts the documented shape, with and without a note", () => {
    assert.deepEqual(validatePhysicsBackendsInfo(info()), info())
  })
  test("rejects a missing or mistyped field", () => {
    assert.throws(() => validatePhysicsBackendsInfo(null), /object/)
    assert.throws(() => validatePhysicsBackendsInfo({ ...info(), current: 1 }), /strings/)
    assert.throws(() => validatePhysicsBackendsInfo({ ...info(), configured: "yes" }), /booleans/)
    assert.throws(() => validatePhysicsBackendsInfo({ ...info(), backends: {} }), /list/)
    assert.throws(() => validatePhysicsBackendsInfo({ ...info(), backends: [{ ...DefaultBackends[0], missingFeatures: [1] }] }), /list/)
    assert.throws(() => validatePhysicsBackendsInfo({ ...info(), backends: [{ ...DefaultBackends[0], note: 3 }] }), /list/)
  })
})

describe("words and block reasons", () => {
  test("determinism levels", () => {
    assert.match(determinismLabel("CrossPlatform"), /^Cross-platform/)
    assert.match(determinismLabel("SameBinary"), /^Same binary/)
    assert.match(determinismLabel("None"), /^None/)
    assert.equal(determinismLabel("Odd"), "Odd")
  })
  test("a backend that is not compiled in, and the Deterministic preset", () => {
    const jolt = fakeBackend({ id: "jolt", displayName: "Jolt", compiledIn: false })
    assert.match(backendBlockReason(jolt, "")!, /not compiled/)
    const physx = fakeBackend({ id: "physx", displayName: "PhysX", deterministicSelectable: false })
    assert.equal(backendBlockReason(physx, ""), null)
    assert.equal(backendBlockReason(physx, "lockstep"), null)
    assert.match(backendBlockReason(physx, "deterministic")!, /Deterministic/)
    assert.equal(backendBlockReason({ ...physx, deterministicSelectable: true }, "Deterministic"), null)
  })
})

describe("PhysicsBackendsModel", () => {
  test("reads, and chooses through the host, keeping the answer", async () => {
    const h = modelOf()
    await h.model.refresh()
    assert.equal(h.model.info.value?.current, "physx")
    assert.equal(await h.model.choose("jolt"), true)
    assert.deepEqual(h.sent, ["jolt"])
    assert.equal(h.model.info.value?.current, "jolt")
    assert.equal(h.model.info.value?.restartRequired, true)
    assert.equal(h.model.lastChosen.value, "jolt")
  })
  test("without the capability nothing is read or sent", async () => {
    const h = modelOf({ supported: false })
    await h.model.refresh()
    assert.equal(h.reads(), 0)
    assert.equal(h.model.info.value, null)
    assert.equal(h.model.disabledReason, UnsupportedReason)
    assert.equal(await h.model.choose("jolt"), false)
    assert.deepEqual(h.sent, [])
  })
  test("read-only (a play session, a read-only host, a viewer) sends nothing", async () => {
    const h = modelOf({ readOnly: "a game is running" })
    await h.model.refresh()
    assert.equal(h.model.disabledReason, "Read-only: a game is running")
    assert.equal(await h.model.choose("jolt"), false)
    assert.deepEqual(h.sent, [])
  })
  test("the Deterministic preset blocks a backend that is not selectable, without sending", async () => {
    const h = modelOf({ answer: info({ networkPreset: "deterministic" }) })
    await h.model.refresh()
    assert.equal(await h.model.choose("jolt"), false)
    assert.deepEqual(h.sent, [])
  })
  test("a refusal is kept as the host said it", async () => {
    const h = modelOf({ refuse: "Not available in a play host" })
    await h.model.refresh()
    assert.equal(await h.model.choose("jolt"), false)
    assert.match(h.model.error.value!, /play host/)
    assert.equal(h.model.lastChosen.value, null)
    assert.equal(h.model.info.value?.current, "physx")
  })
  test("an unknown id is not sent, and disconnecting clears the answer", async () => {
    const h = modelOf()
    await h.model.refresh()
    assert.equal(await h.model.choose("havok"), false)
    assert.deepEqual(h.sent, [])
    h.connected.value = false
    await h.model.refresh()
    assert.equal(h.model.info.value, null)
    await settle()
  })
})
