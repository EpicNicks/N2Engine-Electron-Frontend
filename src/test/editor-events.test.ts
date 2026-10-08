import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { EditorEvent } from "../protocol/protocol.generated"
import { hasUnsavedChanges, parseStateEvent } from "../protocol/editor-events"

describe("parseStateEvent", () => {
  test("sceneChanged carries the revisions and the scene's path", () => {
    const event: EditorEvent = {
      seq: 1,
      kind: "sceneChanged",
      revision: 4,
      savedRevision: 3,
      path: "res://assets/scenes/a.scene",
    }
    assert.deepEqual(parseStateEvent(event), {
      kind: "sceneChanged",
      revision: 4,
      savedRevision: 3,
      path: "res://assets/scenes/a.scene",
    })
  })

  test("assetsChanged lists the added, removed and modified assets", () => {
    assert.deepEqual(
      parseStateEvent({ seq: 2, kind: "assetsChanged", added: ["a"], removed: [], modified: ["b", "c"] }),
      { kind: "assetsChanged", added: ["a"], removed: [], modified: ["b", "c"] }
    )
  })

  test("projectChanged has no fields", () => {
    assert.deepEqual(parseStateEvent({ seq: 3, kind: "projectChanged" }), { kind: "projectChanged" })
  })

  test("missing or mistyped fields take defaults, and unknown keys are ignored", () => {
    const odd = { seq: 4, kind: "sceneChanged", revision: "x", path: 5, extra: true } as unknown as EditorEvent
    assert.deepEqual(parseStateEvent(odd), { kind: "sceneChanged", revision: 0, savedRevision: 0, path: "" })
    const assets = { seq: 5, kind: "assetsChanged", added: "nope", removed: [1, "r"] } as unknown as EditorEvent
    assert.deepEqual(parseStateEvent(assets), { kind: "assetsChanged", added: [], removed: ["r"], modified: [] })
  })

  test("log events and unknown kinds are not state events", () => {
    assert.equal(parseStateEvent({ seq: 6, kind: "log", level: "info", message: "x", time: 1 }), null)
    assert.equal(parseStateEvent({ seq: 7, kind: "somethingNew" }), null)
  })
})

test("a scene has unsaved changes exactly when its revisions differ", () => {
  assert.equal(hasUnsavedChanges({ revision: 3, savedRevision: 3 }), false)
  assert.equal(hasUnsavedChanges({ revision: 4, savedRevision: 3 }), true)
})
