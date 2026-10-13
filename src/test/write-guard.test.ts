import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { signal } from "@preact/signals-core"
import { followWriteGuard } from "../renderer/write-guard"

class Panel {
  reasons: Array<string | null> = []
  setReadOnly(reason: string | null): void {
    this.reasons.push(reason)
  }
}

describe("followWriteGuard", () => {
  test("the inspector and the hierarchy always hold the store's reason, from the first moment", () => {
    const readOnlyReason = signal<string | null>("the host is read-only")
    const inspector = new Panel()
    const hierarchy = new Panel()
    const stop = followWriteGuard({ readOnlyReason }, { inspector, hierarchy })
    assert.deepEqual(inspector.reasons, ["the host is read-only"])
    assert.deepEqual(hierarchy.reasons, ["the host is read-only"])

    readOnlyReason.value = "the game is running"
    readOnlyReason.value = null
    assert.deepEqual(inspector.reasons, ["the host is read-only", "the game is running", null])
    assert.deepEqual(hierarchy.reasons, ["the host is read-only", "the game is running", null])

    stop()
    readOnlyReason.value = "again"
    assert.equal(inspector.reasons.length, 3, "stopped")
  })
})
