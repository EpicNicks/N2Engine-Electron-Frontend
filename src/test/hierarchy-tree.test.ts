import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { HierarchyNode } from "../protocol/protocol.generated"
import {
  RootId,
  buildTree,
  canDrop,
  clickSelect,
  contextSelect,
  emptySelection,
  isDescendant,
  planMoves,
  pruneSelection,
  resolveDrop,
  selectOnly,
  showSelection,
  stepRow,
  topLevel,
  visibleRows,
} from "../renderer/hierarchy-tree"

const node = (id: string, parentId: string, index: number, extra: Partial<HierarchyNode> = {}): HierarchyNode => ({
  id,
  parentId,
  index,
  name: id,
  active: true,
  activeInHierarchy: true,
  layer: 0,
  tag: "",
  components: [],
  ...extra,
})

/**
 * A
 *   A1
 *   A2
 *     A2a
 * B
 * C
 */
const sample = [
  node("A", "", 0),
  node("A1", "A", 0),
  node("A2", "A", 1),
  node("A2a", "A2", 0),
  node("B", "", 1),
  node("C", "", 2),
]
const tree = buildTree(sample)

describe("buildTree", () => {
  test("groups children under their parents, in order", () => {
    assert.deepEqual(tree.children.get(RootId), ["A", "B", "C"])
    assert.deepEqual(tree.children.get("A"), ["A1", "A2"])
    assert.deepEqual(tree.children.get("A2"), ["A2a"])
    assert.deepEqual(tree.order, ["A", "A1", "A2", "A2a", "B", "C"])
    assert.equal(tree.parents.get("A2a"), "A2")
    assert.equal(tree.parents.get("A"), RootId)
  })

  test("siblings follow their index, whatever order the list has them in", () => {
    const shuffled = buildTree([
      node("x", "", 2),
      node("y", "", 0),
      node("z", "", 1),
      node("y1", "y", 1),
      node("y0", "y", 0),
    ])
    assert.deepEqual(shuffled.order, ["y", "y0", "y1", "z", "x"])
  })

  test("an object whose parent isn't listed is a root, a repeated id is ignored, and cycles are left out", () => {
    const odd = buildTree([
      node("a", "gone", 0),
      node("a", "", 5, { name: "again" }),
      node("c1", "c2", 0),
      node("c2", "c1", 0),
    ])
    assert.deepEqual(odd.children.get(RootId), ["a"])
    assert.equal(odd.nodes.get("a")?.name, "a")
    assert.deepEqual(odd.order, ["a"])
    assert.equal(isDescendant(odd, "c1", "c2"), true) // terminates
    assert.equal(buildTree([]).order.length, 0)
  })

  test("isDescendant", () => {
    assert.equal(isDescendant(tree, "A2a", "A"), true)
    assert.equal(isDescendant(tree, "A2a", "A2"), true)
    assert.equal(isDescendant(tree, "A", "A"), false)
    assert.equal(isDescendant(tree, "A", "A2a"), false)
    assert.equal(isDescendant(tree, "B", "A"), false)
  })
})

describe("visibleRows", () => {
  test("shows children only of expanded objects", () => {
    assert.deepEqual(
      visibleRows(tree, new Set()).map((r) => r.id),
      ["A", "B", "C"]
    )
    const rows = visibleRows(tree, new Set(["A", "A2"]))
    assert.deepEqual(
      rows.map((r) => [r.id, r.depth, r.hasChildren, r.expanded]),
      [
        ["A", 0, true, true],
        ["A1", 1, false, false],
        ["A2", 1, true, true],
        ["A2a", 2, false, false],
        ["B", 0, false, false],
        ["C", 0, false, false],
      ]
    )
  })

  test("an expanded object inside a collapsed one stays hidden", () => {
    assert.deepEqual(
      visibleRows(tree, new Set(["A2"])).map((r) => r.id),
      ["A", "B", "C"]
    )
  })
})

describe("selection", () => {
  const visible = ["A", "A1", "A2", "B", "C"]

  test("a click selects just that object", () => {
    const s = clickSelect(selectOnly("A"), visible, "B")
    assert.deepEqual([...s.ids], ["B"])
    assert.equal(s.primary, "B")
    assert.equal(s.anchor, "B")
  })

  test("ctrl toggles, and the primary is the last one added", () => {
    let s = clickSelect(emptySelection, visible, "A", {})
    s = clickSelect(s, visible, "B", { toggle: true })
    s = clickSelect(s, visible, "C", { toggle: true })
    assert.deepEqual([...s.ids], ["A", "B", "C"])
    assert.equal(s.primary, "C")
    s = clickSelect(s, visible, "C", { toggle: true })
    assert.deepEqual([...s.ids], ["A", "B"])
    assert.equal(s.primary, "B", "removing the primary falls back to another")
    s = clickSelect(s, visible, "A", { toggle: true })
    s = clickSelect(s, visible, "B", { toggle: true })
    assert.equal(s.ids.size, 0)
    assert.equal(s.primary, null)
  })

  test("shift selects the rows between the anchor and the click, either way", () => {
    let s = clickSelect(emptySelection, visible, "A1")
    s = clickSelect(s, visible, "B", { range: true })
    assert.deepEqual([...s.ids], ["A1", "A2", "B"])
    assert.equal(s.primary, "B")
    assert.equal(s.anchor, "A1", "the anchor stays")
    s = clickSelect(s, visible, "A", { range: true })
    assert.deepEqual([...s.ids], ["A", "A1"])
  })

  test("shift without an anchor (or with a hidden one) selects just the click", () => {
    assert.deepEqual([...clickSelect(emptySelection, visible, "B", { range: true }).ids], ["B"])
    assert.deepEqual([...clickSelect(selectOnly("hidden"), visible, "B", { range: true }).ids], ["B"])
  })

  test("a right-click keeps a selection that holds the object, else replaces it", () => {
    const s = clickSelect(clickSelect(emptySelection, visible, "A"), visible, "B", { toggle: true })
    assert.equal(contextSelect(s, "A"), s)
    assert.deepEqual([...contextSelect(s, "C").ids], ["C"])
  })

  test("pruning drops what the tree no longer has, and is the same object when nothing went", () => {
    const s = clickSelect(clickSelect(emptySelection, visible, "A"), visible, "B", { toggle: true })
    assert.equal(pruneSelection(s, tree), s)
    const smaller = buildTree(sample.filter((n) => n.id !== "B"))
    const pruned = pruneSelection(s, smaller)
    assert.deepEqual([...pruned.ids], ["A"])
    assert.equal(pruned.primary, "A")
    assert.equal(pruned.anchor, null)
    assert.equal(pruneSelection(s, buildTree([])).primary, null)
  })

  test("topLevel leaves out what has a selected ancestor, in tree order", () => {
    assert.deepEqual(topLevel(tree, new Set(["C", "A2a", "A", "A2"])), ["A", "C"])
    assert.deepEqual(topLevel(tree, new Set(["A2a", "A1"])), ["A1", "A2a"])
  })

  test("stepRow moves one row, stays at the ends, and starts at an end", () => {
    assert.equal(stepRow(visible, "A1", 1), "A2")
    assert.equal(stepRow(visible, "A1", -1), "A")
    assert.equal(stepRow(visible, "A", -1), "A")
    assert.equal(stepRow(visible, "C", 1), "C")
    assert.equal(stepRow(visible, null, 1), "A")
    assert.equal(stepRow(visible, null, -1), "C")
    assert.equal(stepRow(visible, "hidden", 1), "A")
    assert.equal(stepRow([], "A", 1), null)
  })
})

describe("drops", () => {
  const open = new Set(["A", "A2"])

  test("resolveDrop: before, after and inside a row, and the empty space", () => {
    assert.deepEqual(resolveDrop(tree, "B", "before", open), { parentId: "", index: 1 })
    assert.deepEqual(resolveDrop(tree, "B", "after", open), { parentId: "", index: 2 })
    assert.deepEqual(resolveDrop(tree, "A1", "before", open), { parentId: "A", index: 0 })
    assert.deepEqual(resolveDrop(tree, "A1", "after", open), { parentId: "A", index: 1 })
    assert.deepEqual(resolveDrop(tree, "B", "inside", open), { parentId: "B", index: -1 })
    assert.deepEqual(resolveDrop(tree, null, "inside", open), { parentId: "", index: -1 })
    assert.equal(resolveDrop(tree, "nope", "before", open), null)
  })

  test("below an open object with children is before its first child, as the line is drawn", () => {
    assert.deepEqual(resolveDrop(tree, "A", "after", open), { parentId: "A", index: 0 })
    assert.deepEqual(resolveDrop(tree, "A", "after", new Set()), { parentId: "", index: 1 })
    assert.deepEqual(
      resolveDrop(tree, "B", "after", new Set(["B"])),
      { parentId: "", index: 2 },
      "no children: a sibling"
    )
  })

  test("canDrop refuses an object's own place and anywhere under it, and accepts the rest", () => {
    assert.equal(canDrop(tree, ["A"], { parentId: "A", index: -1 }), false)
    assert.equal(canDrop(tree, ["A"], { parentId: "A2a", index: -1 }), false)
    assert.equal(canDrop(tree, ["A2"], { parentId: "A2a", index: 0 }), false)
    assert.equal(canDrop(tree, ["B", "A"], { parentId: "A2", index: 0 }), false, "one of several")
    assert.equal(canDrop(tree, ["A2a"], { parentId: "A", index: 0 }), true)
    assert.equal(canDrop(tree, ["A"], { parentId: "", index: 0 }), true)
    assert.equal(canDrop(tree, ["A"], { parentId: "B", index: -1 }), true)
    assert.equal(canDrop(tree, ["A"], { parentId: "gone", index: -1 }), false)
    assert.equal(canDrop(tree, [], { parentId: "", index: 0 }), false)
    assert.equal(canDrop(tree, ["gone"], { parentId: "", index: 0 }), false)
  })

  test("planMoves: a move under another object, at the end or at a place", () => {
    assert.deepEqual(planMoves(tree, ["C"], { parentId: "A", index: -1 }), [
      { entityId: "C", parentId: "A", siblingIndex: -1 },
    ])
    assert.deepEqual(planMoves(tree, ["C"], { parentId: "A", index: 1 }), [
      { entityId: "C", parentId: "A", siblingIndex: 1 },
    ])
    assert.deepEqual(planMoves(tree, ["A2a"], { parentId: "", index: 0 }), [
      { entityId: "A2a", parentId: "", siblingIndex: 0 },
    ])
  })

  test("planMoves: reordering inside a parent gives the place it ends up at", () => {
    // Drag A before C (index 2 of the roots): the roots become B, A, C, so A ends at 1
    assert.deepEqual(planMoves(tree, ["A"], { parentId: "", index: 2 }), [
      { entityId: "A", parentId: "", siblingIndex: 1 },
    ])
    // Drag C before A: C ends at 0
    assert.deepEqual(planMoves(tree, ["C"], { parentId: "", index: 0 }), [
      { entityId: "C", parentId: "", siblingIndex: 0 },
    ])
    // To the end
    assert.deepEqual(planMoves(tree, ["A"], { parentId: "", index: -1 }), [
      { entityId: "A", parentId: "", siblingIndex: -1 },
    ])
  })

  test("planMoves: a drop that changes nothing is no moves, and a forbidden one is null", () => {
    assert.deepEqual(planMoves(tree, ["B"], { parentId: "", index: 1 }), [], "before itself")
    assert.deepEqual(planMoves(tree, ["B"], { parentId: "", index: 2 }), [], "after itself")
    assert.deepEqual(planMoves(tree, ["C"], { parentId: "", index: -1 }), [], "already last")
    assert.equal(planMoves(tree, ["A"], { parentId: "A2a", index: 0 }), null)
  })

  test("planMoves: several objects land together, in tree order, before the first sibling that isn't moving", () => {
    // B and C into A before A2, in tree order: A1 B C A2
    const plan = planMoves(tree, ["C", "B"], { parentId: "A", index: 1 })!
    assert.deepEqual(plan, [
      { entityId: "B", parentId: "A", siblingIndex: 1 },
      { entityId: "C", parentId: "A", siblingIndex: 2 },
    ])
  })

  test("planMoves: several objects in one parent, with the drop between two of them", () => {
    // Roots A B C D E; move A and D before C: B, A, D, C, E
    const roots = buildTree(["A", "B", "C", "D", "E"].map((id, i) => node(id, "", i)))
    const plan = planMoves(roots, ["A", "D"], { parentId: "", index: 2 })!
    // The engine takes each in turn: A to before C: B A C D E (A at 1); then D before C: B A D C E (D at 2)
    assert.deepEqual(plan, [
      { entityId: "A", parentId: "", siblingIndex: 1 },
      { entityId: "D", parentId: "", siblingIndex: 2 },
    ])
    // Dropped before D, which is moving too: they go before the next one that isn't, E (B C A D E)
    assert.deepEqual(planMoves(roots, ["A", "D"], { parentId: "", index: 3 }), [
      { entityId: "A", parentId: "", siblingIndex: 3 },
      { entityId: "D", parentId: "", siblingIndex: 3 },
    ])
  })

  test("planMoves: moving an object and what is under it moves just the object", () => {
    assert.deepEqual(planMoves(tree, ["A", "A2"], { parentId: "B", index: -1 }), [
      { entityId: "A", parentId: "B", siblingIndex: -1 },
    ])
  })

  test("the engine's own rules applied to the plans give the order the user dropped at", () => {
    // Simulates SetEntityParent's siblingIndex (the place the object ends up at) on the roots
    const roots = ["A", "B", "C", "D", "E"]
    const flat = buildTree(roots.map((id, i) => node(id, "", i)))
    for (const dragged of [["A"], ["E"], ["B", "D"], ["A", "C", "E"]]) {
      for (let index = -1; index <= roots.length; index++) {
        const plan = planMoves(flat, dragged, { parentId: "", index })!
        let list = [...roots]
        for (const move of plan) {
          list = list.filter((id) => id !== move.entityId)
          list.splice(move.siblingIndex < 0 ? list.length : Math.min(move.siblingIndex, list.length), 0, move.entityId)
        }
        // What the user expects: the moved objects, in tree order, placed before the first non-moved one at/after index
        const rest = roots.filter((id) => !dragged.includes(id))
        const at = index < 0 ? roots.length : index
        const before = roots.slice(at).find((id) => !dragged.includes(id))
        const position = before === undefined ? rest.length : rest.indexOf(before)
        const expected = [
          ...rest.slice(0, position),
          ...roots.filter((id) => dragged.includes(id)),
          ...rest.slice(position),
        ]
        assert.deepEqual(list, expected, `dragging ${dragged} to ${index}`)
      }
    }
  })
})

describe("showSelection and pruneSelection", () => {
  const tree2 = buildTree(sample)
  test("a selected object under a collapsed one becomes that one", () => {
    const shown = new Set(["A", "B", "C"])
    const s = {
      ids: new Set(["A2a", "C", "A1"]),
      anchor: "A1",
      primary: "A2a",
    }
    const lifted = showSelection(s, tree2, shown)
    assert.deepEqual([...lifted.ids].sort(), ["A", "C"])
    assert.equal(lifted.anchor, "A")
    assert.equal(lifted.primary, "A")
  })

  test("it is the same object when every selected row is shown", () => {
    const s = selectOnly("B")
    assert.equal(showSelection(s, tree2, new Set(["A", "B", "C"])), s)
    assert.equal(showSelection(emptySelection, tree2, new Set()), emptySelection)
  })

  test("pruning picks the new primary in tree order, not selection order", () => {
    const s = { ids: new Set(["C", "A", "gone"]), anchor: null, primary: "gone" }
    assert.equal(pruneSelection(s, tree2).primary, "C")
    const t = { ids: new Set(["A", "C", "gone"]), anchor: null, primary: "gone" }
    assert.equal(pruneSelection(t, tree2).primary, "C")
  })
})
