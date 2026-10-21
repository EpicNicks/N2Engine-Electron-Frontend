import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { ExtensionTrustState } from "../shared/api"
import { EditorStore } from "../renderer/store"
import { FakeApi, FakeTimers } from "./fake-store-api"

function makeStore() {
  const api = new FakeApi()
  const timers = new FakeTimers()
  const store = new EditorStore(api, { timers, now: () => 0 })
  return { api, store }
}

const trust = (over: Partial<ExtensionTrustState> = {}): ExtensionTrustState => ({
  files: ["Align.lua"],
  more: 0,
  trusted: false,
  enabled: false,
  ...over,
})

describe("EditorStore and editor extensions", () => {
  test("extensionTrust follows the host's state: absent, then what the main process pushed, then absent again", async () => {
    const { api, store } = makeStore()
    const current = () => store.extensionTrust.value
    assert.equal(current(), null)
    api.pushHost({ status: "starting", launch: 1, projectPath: "C:\\P", extensionTrust: trust() })
    assert.deepEqual(current(), trust())
    api.pushHost({ extensionTrust: trust({ trusted: true, enabled: true }) })
    assert.equal(current()?.enabled, true)
    api.pushHost({ extensionTrust: undefined })
    assert.equal(current(), null)
  })

  test("enableExtensions asks the main process (which shows its own dialog) and answers true when the host restarted", async () => {
    const { api, store } = makeStore()
    assert.equal(await store.enableExtensions(), true)
    assert.deepEqual(api.calls.filter((c) => c === "enableExtensions"), ["enableExtensions"])
    assert.equal(store.busy.value, null)
    assert.equal(store.error.value, null)
  })

  test("Not now in the main process's dialog: false, nothing else changes", async () => {
    const { api, store } = makeStore()
    api.extensionsTrusted = false
    assert.equal(await store.enableExtensions(), false)
    assert.equal(store.error.value, null)
  })

  test("unsaved scene changes are asked about first (the restart discards them); a No stops before the main process is asked", async () => {
    const { api, store } = makeStore()
    await store.connectRemote({ target: "dev@box", hostPort: 7777 }, "t")
    api.openScene = { path: "res://a.scene", name: "a", uuid: "u", revision: 5, savedRevision: 1 }
    api.unsavedAnswers = ["cancel"]
    api.calls.length = 0
    assert.equal(await store.enableExtensions(), false)
    assert.ok(api.asked.some((q) => q.startsWith("unsaved Discard and restart the host with extensions")))
    assert.ok(!api.calls.includes("enableExtensions"), "the main process was not asked")
  })

  test("a failure of the main process is shown as the error, and is not thrown", async () => {
    const { api, store } = makeStore()
    api.project.enableExtensions = async () => {
      throw new Error("Editor extensions of a remote host are enabled by its operator")
    }
    assert.equal(await store.enableExtensions(), false)
    assert.match(store.error.value ?? "", /enabled by its operator/)
  })

  test("forgetExtensionTrust asks the main process and restarts nothing", async () => {
    const { api, store } = makeStore()
    await store.forgetExtensionTrust()
    assert.deepEqual(api.calls, ["forgetExtensionTrust"])
    assert.equal(store.busy.value, null)
  })
})
