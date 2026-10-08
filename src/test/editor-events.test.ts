import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { EditorEvent } from "../protocol/protocol.generated"
import {
  MaxMergedEntityIds,
  SceneChangedEvent,
  hasUnsavedChanges,
  mergeSceneChange,
  parseStateEvent,
  sceneChangeOf,
} from "../protocol/editor-events"

describe("parseStateEvent", () => {
  test("frameChanged carries the revision the next frame will have", () => {
    assert.deepEqual(parseStateEvent({ seq: 3, kind: "frameChanged", revision: 12 }), { kind: "frameChanged", revision: 12 })
    // A missing or mistyped revision takes the default, as the other events' fields do
    assert.deepEqual(parseStateEvent({ seq: 4, kind: "frameChanged", revision: "x" } as unknown as EditorEvent), { kind: "frameChanged", revision: 0 })
  })

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
      entityIds: null,
      full: false,
    })
  })

  test("sceneChanged since 1.4.0 lists the entities it touched, or says another scene was loaded", () => {
    const touched: EditorEvent = {
      seq: 1,
      kind: "sceneChanged",
      revision: 5,
      savedRevision: 3,
      path: "res://a.scene",
      entityIds: ["u1", "u2"],
    }
    assert.deepEqual(parseStateEvent(touched), {
      kind: "sceneChanged",
      revision: 5,
      savedRevision: 3,
      path: "res://a.scene",
      entityIds: ["u1", "u2"],
      full: false,
    })
    const loaded = { seq: 2, kind: "sceneChanged", revision: 0, savedRevision: 0, path: "res://b.scene", full: true }
    assert.equal((parseStateEvent(loaded) as SceneChangedEvent).full, true)
    // An empty list is not the same as none: nothing was touched, versus anything may have been
    const empty = { ...touched, entityIds: [] as string[] }
    assert.deepEqual((parseStateEvent(empty) as SceneChangedEvent).entityIds, [])
  })

  test("entityIds and full of the wrong type are none and false", () => {
    const odd = { seq: 3, kind: "sceneChanged", entityIds: "u1", full: "yes" } as unknown as EditorEvent
    const parsed = parseStateEvent(odd) as SceneChangedEvent
    assert.equal(parsed.entityIds, null)
    assert.equal(parsed.full, false)
    const mixed = { seq: 4, kind: "sceneChanged", entityIds: ["u1", 7, null, "u2"] } as unknown as EditorEvent
    assert.deepEqual((parseStateEvent(mixed) as SceneChangedEvent).entityIds, ["u1", "u2"])
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
    assert.deepEqual(parseStateEvent(odd), {
      kind: "sceneChanged",
      revision: 0,
      savedRevision: 0,
      path: "",
      entityIds: null,
      full: false,
    })
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

const sceneEvent = (fields: Partial<SceneChangedEvent>): SceneChangedEvent => ({
  kind: "sceneChanged",
  revision: 5,
  savedRevision: 3,
  path: "res://a.scene",
  entityIds: null,
  full: false,
  ...fields,
})

describe("sceneChangeOf", () => {
  test("full means everything, whatever else the event says", () => {
    assert.deepEqual(sceneChangeOf(sceneEvent({ full: true, entityIds: ["u1"] }), 9), { full: true, entityIds: [] })
  })

  test("listed entities are the change", () => {
    assert.deepEqual(sceneChangeOf(sceneEvent({ entityIds: ["u1", "u2"] }), 4), { full: false, entityIds: ["u1", "u2"] })
    // Even when the revision isn't newer than the known one: the list is the truth about what moved
    assert.deepEqual(sceneChangeOf(sceneEvent({ entityIds: ["u1"], revision: 4 }), 6), { full: false, entityIds: ["u1"] })
  })

  test("neither is a save when the revision didn't move, else a change too big to list", () => {
    assert.equal(sceneChangeOf(sceneEvent({ revision: 5, savedRevision: 5 }), 5), null)
    assert.equal(sceneChangeOf(sceneEvent({ revision: 4 }), 5), null) // older than what is known
    assert.deepEqual(sceneChangeOf(sceneEvent({ revision: 6 }), 5), { full: true, entityIds: [] })
    // Nothing known to compare with: anything may have changed
    assert.deepEqual(sceneChangeOf(sceneEvent({ revision: 5 }), null), { full: true, entityIds: [] })
  })
})

describe("mergeSceneChange", () => {
  test("unions the ids without repeats, and everything absorbs the rest", () => {
    assert.deepEqual(mergeSceneChange(null, { full: false, entityIds: ["a"] }), { full: false, entityIds: ["a"] })
    assert.deepEqual(mergeSceneChange({ full: false, entityIds: ["a", "b"] }, { full: false, entityIds: ["b", "c"] }), {
      full: false,
      entityIds: ["a", "b", "c"],
    })
    assert.deepEqual(mergeSceneChange({ full: true, entityIds: [] }, { full: false, entityIds: ["a"] }), {
      full: true,
      entityIds: [],
    })
    assert.deepEqual(mergeSceneChange({ full: false, entityIds: ["a"] }, { full: true, entityIds: [] }), {
      full: true,
      entityIds: [],
    })
  })

  test("too many ids become everything, even from one event", () => {
    const many = Array.from({ length: MaxMergedEntityIds + 1 }, (_, i) => "u" + i)
    assert.deepEqual(mergeSceneChange(null, { full: false, entityIds: many }), { full: true, entityIds: [] })
    const ids = (from: number, n: number): string[] => Array.from({ length: n }, (_, i) => "u" + (from + i))
    const half = MaxMergedEntityIds / 2
    assert.equal(mergeSceneChange({ full: false, entityIds: ids(0, half) }, { full: false, entityIds: ids(half, half) }).full, false)
    assert.equal(mergeSceneChange({ full: false, entityIds: ids(0, half) }, { full: false, entityIds: ids(half, half + 1) }).full, true)
  })
})
