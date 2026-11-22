// EditorStore.requestPanel (#381 item 8): a request is shown once and consumed once
import { test } from "node:test"
import * as assert from "node:assert/strict"
import { EditorStore } from "../renderer/store"
import { FakeApi, FakeTimers } from "./fake-store-api"

function makeStore() {
  return new EditorStore(new FakeApi(), { timers: new FakeTimers(), now: () => 0 })
}

test("a request is marked opened once, and cleared by its own seq only", () => {
  const store = makeStore()
  store.requestPanel("projectSettings", "network")
  assert.deepEqual(store.panelRequest.value, { id: "projectSettings", section: "network", seq: 1, opened: false })
  store.markPanelRequestOpened(1)
  assert.equal(store.panelRequest.value?.opened, true, "a later mount of the editor does not open it again")
  store.requestPanel("projectSettings", "network")
  assert.deepEqual(store.panelRequest.value, { id: "projectSettings", section: "network", seq: 2, opened: false })
  store.clearPanelRequest(1)
  assert.equal(store.panelRequest.value?.seq, 2, "an older seq does not clear a newer request")
  store.clearPanelRequest(2)
  assert.equal(store.panelRequest.value, null)
  store.requestPanel("console")
  assert.deepEqual(store.panelRequest.value, { id: "console", seq: 1, opened: false })
  store.clearPanelRequest()
  assert.equal(store.panelRequest.value, null)
})
