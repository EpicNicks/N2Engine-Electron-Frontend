import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { signal } from "@preact/signals-core"
import type { HierarchyResponse } from "../protocol/protocol.generated"
import type { AssetsChangedEvent, SceneChange } from "../protocol/editor-events"
import { HierarchyState } from "../renderer/hierarchy-state"
import { FollowDeps, followScene } from "../renderer/scene-follow"
import { AssetDragEffect, EntityDragEffect, FieldDropEffect, effectAllows } from "../renderer/drag-types"

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("followScene", () => {
  /** A hierarchy that answers each read with a new object, as a host's answers are */
  function setup() {
    const reads = { hierarchy: 0 }
    const engine = {
      isConnected: () => true,
      getHierarchy: async (): Promise<HierarchyResponse> => {
        reads.hierarchy++
        await tick() // an answer takes a turn of the event loop, as a host's does: a loop of reads can't starve the test
        return {
          revision: 1,
          nodes: [
            { id: "e1", parentId: "", index: 0, name: "A", active: true, activeInHierarchy: true, layer: 0, tag: "", components: [] },
          ],
        }
      },
      createEntityEx: async () => "x",
      setEntityParent: async () => {},
      setEntityProperties: async () => {},
      duplicateEntity: async () => "x",
      destroyEntity: async () => {},
    }
    const hierarchy = new HierarchyState(engine, { confirm: async () => true })
    const connected = signal(true)
    const sceneChangeCount = signal(1)
    const lastSceneChange = signal<SceneChange | null>({ full: true, entityIds: [] })
    const assetsChangeCount = signal(0)
    const lastAssetsChange = signal<AssetsChangedEvent | null>(null)
    const assetsLog: Array<AssetsChangedEvent | null | "reset" | "refresh"> = []
    const selectedId = signal<string | null>(null)
    const log: string[] = []
    const errors: unknown[] = []
    const deps: FollowDeps = {
      store: {
        connected,
        sceneChangeCount,
        lastSceneChange,
        assetsChangeCount,
        lastAssetsChange,
        newestSceneRevision: null,
        reportError: (_what, e) => void errors.push(e),
      },
      scene: {
        selectedId,
        reset: () => void log.push("scene.reset"),
        refreshTransform: async () => void log.push("refreshTransform"),
      },
      hierarchy,
      assets: {
        reset: () => void assetsLog.push("reset"),
        refresh: async () => void assetsLog.push("refresh"),
        onAssetsChanged: async (event) => void assetsLog.push(event),
      },
      inspector: {
        reset: () => void log.push("inspector.reset"),
        loadTypes: async () => void log.push("loadTypes"),
        loadAssets: async () => void log.push("loadAssets"),
        select: async (id) => void log.push("select " + id),
        applyChange: async () => void log.push("applyChange"),
        refreshLuaFields: async () => void log.push("refreshLua"),
      },
    }
    return {
      deps,
      reads,
      log,
      errors,
      connected,
      sceneChangeCount,
      lastSceneChange,
      assetsChangeCount,
      lastAssetsChange,
      assetsLog,
      selectedId,
    }
  }

  test("a change is read once: the hierarchy's own answer doesn't start another read (it once did, for ever)", async () => {
    const { deps, reads, errors } = setup()
    const stop = followScene(deps)
    for (let i = 0; i < 20; i++) await tick()
    assert.equal(reads.hierarchy, 1)
    assert.deepEqual(errors, [])
    stop()
  })

  test("each change is read once, and the hierarchy stays quiet in between", async () => {
    const { deps, reads, sceneChangeCount, lastSceneChange, log } = setup()
    const stop = followScene(deps)
    for (let i = 0; i < 5; i++) await tick()
    lastSceneChange.value = { full: false, entityIds: ["e1"] }
    sceneChangeCount.value++
    for (let i = 0; i < 20; i++) await tick()
    // A change that listed objects refetches the hierarchy only when its revision moved past what is held
    assert.ok(reads.hierarchy <= 2, `${reads.hierarchy} reads`)
    assert.equal(log.filter((l) => l === "applyChange").length, 2)
    stop()
  })

  test("the inspector follows the selection, the connection and the assets", async () => {
    const { deps, log, selectedId, connected, assetsChangeCount } = setup()
    const stop = followScene(deps)
    await tick()
    assert.ok(log.includes("loadTypes") && log.includes("loadAssets"))
    log.length = 0
    selectedId.value = "e1"
    await tick()
    assert.deepEqual(log, ["select e1"])
    log.length = 0
    assetsChangeCount.value++
    await tick()
    assert.deepEqual(log, ["loadAssets", "refreshLua"])
    log.length = 0
    connected.value = false
    await tick()
    assert.deepEqual(log, ["scene.reset", "inspector.reset"])
    stop()
  })

  test("the assets panel lists on connecting, follows each event, and is told when events were missed", async () => {
    const { deps, assetsLog, connected, assetsChangeCount, lastAssetsChange } = setup()
    const stop = followScene(deps)
    await tick()
    assert.deepEqual(assetsLog, ["refresh"])
    assetsLog.length = 0

    const event: AssetsChangedEvent = { kind: "assetsChanged", added: [], removed: [], modified: ["res://a.lua"] }
    lastAssetsChange.value = event
    assetsChangeCount.value++
    await tick()
    assert.deepEqual(assetsLog, [event])
    assetsLog.length = 0

    // The count moved with no new event: events were missed, so the panel is told to look at everything
    assetsChangeCount.value++
    await tick()
    assert.deepEqual(assetsLog, [null])
    assetsLog.length = 0

    connected.value = false
    await tick()
    assert.deepEqual(assetsLog, ["reset"])
    stop()
  })
})

describe("drag effects", () => {
  test("what a hierarchy row allows is what a field's drop asks for (a 'move'-only drag never dropped on a field)", () => {
    assert.equal(effectAllows(EntityDragEffect, FieldDropEffect), true)
    assert.equal(effectAllows(EntityDragEffect, "move"), true) // the hierarchy's own reordering
    assert.equal(effectAllows(AssetDragEffect, FieldDropEffect), true)
    assert.equal(effectAllows("move", FieldDropEffect), false)
  })

  test("the HTML rules: all and uninitialized allow everything, none nothing", () => {
    for (const effect of ["copy", "move", "link"] as const) {
      assert.equal(effectAllows("all", effect), true)
      assert.equal(effectAllows("uninitialized", effect), true)
      assert.equal(effectAllows("none", effect), false)
    }
    assert.equal(effectAllows("copyLink", "link"), true)
    assert.equal(effectAllows("linkMove", "copy"), false)
  })
})
