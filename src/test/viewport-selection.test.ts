import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { signal } from "@preact/signals-core"
import type { HierarchyNode } from "../protocol/protocol.generated"
import type { SceneChange } from "../protocol/editor-events"
import { HierarchyTree, Selection, buildTree } from "../renderer/hierarchy-tree"
import { followViewportSelection, moveIdsOf, selectionKeyOf } from "../renderer/viewport-selection"

const node = (id: string, parentId: string, index = 0): HierarchyNode => ({
  id,
  parentId,
  index,
  name: id,
  active: true,
  activeInHierarchy: true,
  layer: 0,
  tag: "",
  components: [],
})

const select = (primary: string | null, ...ids: string[]): Selection => ({
  ids: new Set(ids.length ? ids : primary ? [primary] : []),
  anchor: primary,
  primary,
})

// a { b { c }, d }, e
const tree = (): HierarchyTree =>
  buildTree([node("a", ""), node("b", "a"), node("c", "b"), node("d", "a", 1), node("e", "", 1)])

describe("moveIdsOf", () => {
  test("an object under a selected one is left out, at any depth, in tree order", () => {
    assert.deepEqual(moveIdsOf(tree(), select("c", "c", "a")), ["a"])
    assert.deepEqual(moveIdsOf(tree(), select("c", "c", "b")), ["b"])
    assert.deepEqual(moveIdsOf(tree(), select("e", "e", "d", "c")), ["c", "d", "e"])
    assert.deepEqual(moveIdsOf(tree(), select("a", "a", "b", "c", "d", "e")), ["a", "e"])
    assert.deepEqual(moveIdsOf(tree(), select(null)), [])
  })

  test("the key tells the primary from the movers", () => {
    assert.notEqual(selectionKeyOf("a", ["a"]), selectionKeyOf("b", ["a"]))
    assert.notEqual(selectionKeyOf("a", ["a", "b"]), selectionKeyOf("a", ["a"]))
    assert.equal(selectionKeyOf(null, []), "|")
  })
})

describe("followViewportSelection", () => {
  function setup() {
    const connected = signal(true)
    const sceneChangeCount = signal(0)
    const lastSceneChange = signal<SceneChange | null>(null)
    const sceneReplacedCount = signal(0)
    const selection = signal<Selection>(select("a"))
    const hierarchyTree = signal<HierarchyTree>(tree())
    const loads: Array<string | null> = []
    const changes: Array<{ ids: readonly string[]; full: boolean; replaced: boolean }> = []
    const follow = followViewportSelection({
      store: { connected, sceneChangeCount, lastSceneChange, sceneReplacedCount },
      hierarchy: { selection, tree: hierarchyTree },
      viewport: {
        loadTarget: async (id) => void loads.push(id),
        objectsChanged: (ids, full, replaced) => changes.push({ ids, full, replaced }),
      },
    })
    const sceneChanged = (change: SceneChange, replaced = false) => {
      lastSceneChange.value = change
      if (replaced) sceneReplacedCount.value++
      sceneChangeCount.value++
    }
    return { connected, selection, hierarchyTree, loads, changes, follow, sceneChanged }
  }

  test("reads the selection once, then again only when its primary object or its movers change", () => {
    const s = setup()
    assert.deepEqual(s.loads, ["a"])
    // The tree was refreshed (a new object, say) and nothing about the selection changed
    s.hierarchyTree.value = buildTree([node("a", ""), node("b", "a"), node("c", "b"), node("d", "a", 1), node("e", "", 1), node("f", "")])
    assert.deepEqual(s.loads, ["a"])
    // A selection of the same objects
    s.selection.value = select("a")
    assert.deepEqual(s.loads, ["a"])
    // Another primary, or one more object
    s.selection.value = select("e")
    assert.deepEqual(s.loads, ["a", "e"])
    s.selection.value = select("e", "e", "d")
    assert.deepEqual(s.loads, ["a", "e", "e"])
    s.follow.stop()
  })

  test("an object that moves out from under a selected one becomes a mover; one moved under it stops being one", () => {
    const s = setup()
    s.selection.value = select("c", "a", "c")
    assert.deepEqual(s.loads, ["a", "c"]) // movers: a only (c is under it)
    // c is reparented to the root: it moves by itself now, and the tree says so
    s.hierarchyTree.value = buildTree([node("a", ""), node("b", "a"), node("c", ""), node("d", "a", 1), node("e", "", 1)])
    assert.deepEqual(s.loads, ["a", "c", "c"])
    // and back under a
    s.hierarchyTree.value = tree()
    assert.equal(s.loads.length, 4)
    s.follow.stop()
  })

  test("not connected: the gizmo has no targets; forget makes the next read happen", () => {
    const s = setup()
    s.connected.value = false
    s.selection.value = select("e")
    assert.deepEqual(s.loads, ["a", null])
    s.connected.value = true
    s.follow.forget()
    s.hierarchyTree.value = tree() // anything that makes the effect run
    assert.deepEqual(s.loads, ["a", null, "e"])
    s.follow.stop()
  })

  test("scene changes reach the viewport; 'replaced' only when the host flagged a replacement", () => {
    const s = setup()
    s.sceneChanged({ full: false, entityIds: ["a"] })
    s.sceneChanged({ full: true, entityIds: [] }) // too many ids: full, but not a replacement
    s.sceneChanged({ full: true, entityIds: [] }, true) // another scene was loaded
    s.sceneChanged({ full: false, entityIds: ["b"] })
    assert.deepEqual(s.changes, [
      { ids: ["a"], full: false, replaced: false },
      { ids: [], full: true, replaced: false },
      { ids: [], full: true, replaced: true },
      { ids: ["b"], full: false, replaced: false },
    ])
    s.follow.stop()
  })

  test("a disconnected viewport hears nothing; a replacement counted meanwhile is not held against the next change", () => {
    const s = setup()
    s.connected.value = false
    s.sceneChanged({ full: true, entityIds: [] }, true)
    assert.deepEqual(s.changes, [])
    s.connected.value = true
    s.sceneChanged({ full: false, entityIds: ["a"] })
    assert.deepEqual(s.changes, [{ ids: ["a"], full: false, replaced: false }])
    s.follow.stop()
  })

  test("stopped, it follows nothing", () => {
    const s = setup()
    s.follow.stop()
    s.selection.value = select("e")
    s.sceneChanged({ full: false, entityIds: ["a"] })
    assert.deepEqual(s.loads, ["a"])
    assert.deepEqual(s.changes, [])
  })
})
