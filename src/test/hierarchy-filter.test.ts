import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { HierarchyNode } from "../protocol/protocol.generated"
import {
  buildTree,
  filterHierarchy,
  filteredRows,
  isQueryActive,
  nodeMatches,
  parseQuery,
} from "../renderer/hierarchy-tree"
import { HierarchyState } from "../renderer/hierarchy-state"
import { HierarchyFilterPref, attachHierarchyFilterPrefs } from "../renderer/hierarchy-filter-prefs"
import { KeyValueStore, PrefsStore, Schedule, prefStorageKey } from "../renderer/prefs"

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
 * Player            (tag "Hero", layer 2, Camera + Rigidbody)
 *   Arm
 *     Hand          (Collider)
 *   Leg
 * World
 *   Tree            (tag "Prop")
 *   Rock            (tag "Prop", Collider)
 * Sun               (DirectionalLight)
 */
const list: HierarchyNode[] = [
  node("Player", "", 0, { tag: "Hero", layer: 2, components: ["Camera", "Rigidbody"] }),
  node("Arm", "Player", 0),
  node("Hand", "Arm", 0, { components: ["Collider"] }),
  node("Leg", "Player", 1),
  node("World", "", 1),
  node("Tree", "World", 0, { tag: "Prop" }),
  node("Rock", "World", 1, { tag: "Prop", components: ["Collider"] }),
  node("Sun", "", 2, { components: ["DirectionalLight"] }),
]
const tree = buildTree(list)
const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id)

describe("parsing a search", () => {
  test("words are names, t: tag: layer: are the roadmap's three prefixes, everything lower-cased", () => {
    assert.deepEqual(parseQuery("  Foo  t:Collider TAG:Prop layer:3 bar "), {
      names: ["foo", "bar"],
      types: ["collider"],
      tags: ["prop"],
      layers: [3],
    })
  })

  test("a half-typed or malformed token is ignored, not an empty result", () => {
    assert.deepEqual(parseQuery("t: tag: layer: layer:x layer:-1"), { names: [], types: [], tags: [], layers: [] })
    assert.equal(isQueryActive(parseQuery("t:")), false)
    assert.equal(isQueryActive(parseQuery("")), false)
    assert.equal(isQueryActive(parseQuery("t:a")), true)
    // An unknown prefix is part of a name (a name may hold a colon)
    assert.deepEqual(parseQuery("npc:guard").names, ["npc:guard"])
    assert.deepEqual(parseQuery(":x").names, [":x"])
  })
})

describe("matching", () => {
  test("a name matches by part, ignoring case; every token has to hold", () => {
    assert.equal(nodeMatches(list[0], parseQuery("LAY")), true)
    assert.equal(nodeMatches(list[0], parseQuery("pl er")), true)
    assert.equal(nodeMatches(list[0], parseQuery("pl zz")), false)
  })

  test("t: matches a component type by part, tag: a tag by part, layer: exactly", () => {
    const player = list[0]
    assert.equal(nodeMatches(player, parseQuery("t:camera")), true)
    assert.equal(nodeMatches(player, parseQuery("t:body")), true)
    assert.equal(nodeMatches(player, parseQuery("t:camera t:rigid")), true)
    assert.equal(nodeMatches(player, parseQuery("t:camera t:collider")), false)
    assert.equal(nodeMatches(player, parseQuery("tag:her")), true)
    assert.equal(nodeMatches(player, parseQuery("layer:2")), true)
    assert.equal(nodeMatches(player, parseQuery("layer:1")), false)
    assert.equal(nodeMatches(player, parseQuery("layer:22")), false)
    assert.equal(nodeMatches(player, parseQuery("t:camera tag:hero layer:2 play")), true)
  })
})

describe("filtering the tree", () => {
  test("an empty or all-ignored query is not a filter", () => {
    assert.equal(filterHierarchy(tree, parseQuery("")).active, false)
    assert.equal(filterHierarchy(tree, parseQuery("t:")).active, false)
  })

  test("the matches and their ancestors are shown; a match's other relatives are not", () => {
    const filter = filterHierarchy(tree, parseQuery("t:collider"))
    assert.deepEqual([...filter.matches].sort(), ["Hand", "Rock"])
    assert.deepEqual([...filter.shown].sort(), ["Arm", "Hand", "Player", "Rock", "World"])
  })

  test("tree rows: ancestors open, depth kept, what is under a match is shown only when it matches", () => {
    const rows = filteredRows(tree, filterHierarchy(tree, parseQuery("t:collider")), "tree")
    assert.deepEqual(
      rows.map((row) => `${row.depth}:${row.id}${row.hasChildren ? "+" : ""}${row.expanded ? "o" : ""}`),
      ["0:Player+o", "1:Arm+o", "2:Hand", "0:World+o", "1:Rock"]
    )
    // Player matches by name, so its children are not pulled in
    const player = filteredRows(tree, filterHierarchy(tree, parseQuery("player")), "tree")
    assert.deepEqual(ids(player), ["Player"])
    assert.equal(player[0].hasChildren, false)
  })

  test("list rows: the matches only, in tree order, flat, each with its path", () => {
    const rows = filteredRows(tree, filterHierarchy(tree, parseQuery("a")), "list")
    assert.deepEqual(ids(rows), ["Player", "Arm", "Hand", "Leg"].filter((id) => /a/i.test(id)))
    const hand = filteredRows(tree, filterHierarchy(tree, parseQuery("hand")), "list")
    assert.deepEqual(hand, [{ id: "Hand", depth: 0, hasChildren: false, expanded: false, path: "Player / Arm / Hand" }])
    assert.ok(filteredRows(tree, filterHierarchy(tree, parseQuery("a")), "list").every((row) => row.depth === 0))
  })

  test("a query with no match gives no rows", () => {
    const filter = filterHierarchy(tree, parseQuery("nothing-like-this"))
    assert.equal(filter.active, true)
    assert.deepEqual(filteredRows(tree, filter, "tree"), [])
    assert.deepEqual(filteredRows(tree, filter, "list"), [])
  })

  test("a large scene is filtered in one pass (a wide and a deep tree)", () => {
    const many: HierarchyNode[] = []
    for (let i = 0; i < 20000; i++) many.push(node(`o${i}`, i % 200 === 0 ? "" : `o${i - (i % 200)}`, i, { tag: i % 7 === 0 ? "x" : "" }))
    const big = buildTree(many)
    const started = Date.now()
    const filter = filterHierarchy(big, parseQuery("tag:x"))
    const rows = filteredRows(big, filter, "tree")
    const elapsed = Date.now() - started
    assert.ok(filter.matches.size > 2000)
    assert.ok(rows.length >= filter.matches.size)
    assert.ok(elapsed < 1000, `took ${elapsed} ms`)

    // A chain 5000 deep: ancestors are walked once, not once per match
    const chain: HierarchyNode[] = []
    for (let i = 0; i < 5000; i++) chain.push(node(`c${i}`, i === 0 ? "" : `c${i - 1}`, 0))
    const deep = filterHierarchy(buildTree(chain), parseQuery("c"))
    assert.equal(deep.shown.size, 5000)
  })
})

// ==================== The state ====================

function stateOver(nodes: HierarchyNode[] = list) {
  const calls: string[] = []
  const engine = {
    isConnected: () => true,
    getHierarchy: async () => ({ revision: 1, nodes }),
    createEntityEx: async (name: string, parentId: string, index: number, preset: string) => {
      calls.push(`create ${name}|${parentId}|${index}|${preset}`)
      nodes = [...nodes, node("New", parentId, 0)]
      return "New"
    },
    setEntityParent: async (id: string, parentId: string) => void calls.push(`move ${id}|${parentId}`),
    setEntityProperties: async () => void calls.push("props"),
    duplicateEntity: async (id: string) => {
      calls.push(`duplicate ${id}`)
      return id
    },
    destroyEntity: async (id: string) => void calls.push(`destroy ${id}`),
  }
  const state = new HierarchyState(engine as never, { confirm: async () => true })
  return { state, calls, setNodes: (next: HierarchyNode[]) => void (nodes = next) }
}

describe("the hierarchy state under a search", () => {
  test("rows follow the query and the mode; clearing restores the expanded tree", async () => {
    const { state } = stateOver()
    await state.refresh()
    assert.deepEqual(ids(state.rows.value), ["Player", "World", "Sun"])
    state.setQuery("hand")
    assert.deepEqual(ids(state.rows.value), ["Player", "Arm", "Hand"])
    state.setFilterMode("list")
    assert.deepEqual(ids(state.rows.value), ["Hand"])
    state.setQuery("")
    assert.deepEqual(ids(state.rows.value), ["Player", "World", "Sun"])
    assert.equal(state.filtering, false)
  })

  test("selection and the arrow keys work on the filtered rows", async () => {
    const { state } = stateOver()
    await state.refresh()
    state.setQuery("t:collider")
    // Player, Arm, Hand, World, Rock are shown
    state.click("Hand")
    state.step(1)
    assert.equal(state.primaryId, "World")
    state.step(1)
    assert.equal(state.primaryId, "Rock")
    state.step(1)
    assert.equal(state.primaryId, "Rock", "the last shown row: no further")
    state.step(-1, true)
    assert.deepEqual([...state.selection.value.ids].sort(), ["Rock", "World"])
    // Shift+click ranges over the shown rows only
    state.click("Player")
    state.click("World", { range: true })
    assert.deepEqual([...state.selection.value.ids].sort(), ["Arm", "Hand", "Player", "World"])
  })

  test("Right goes to the first shown child, Left to a shown parent, and nothing opens or closes", async () => {
    const { state } = stateOver()
    await state.refresh()
    state.setQuery("t:collider")
    state.click("Player")
    state.expandPrimary()
    assert.equal(state.primaryId, "Arm")
    state.collapsePrimary()
    assert.equal(state.primaryId, "Player")
    state.collapsePrimary() // a root: nothing
    assert.equal(state.primaryId, "Player")
    assert.equal(state.expanded.value.size, 0, "the expanded set is the user's, untouched by a search")
    // A leaf match does nothing on Right; in list mode there is no parent row to go to
    state.click("Hand")
    state.expandPrimary()
    assert.equal(state.primaryId, "Hand")
    state.setFilterMode("list")
    state.collapsePrimary()
    assert.equal(state.primaryId, "Hand")
    state.click("Hand")
    state.expandPrimary()
    assert.equal(state.primaryId, "Hand")
  })

  test("delete and duplicate act on the selected objects that are shown, never on a hidden one", async () => {
    const { state, calls } = stateOver()
    await state.refresh()
    state.setSelection({ ids: new Set(["Sun", "Hand"]), anchor: "Sun", primary: "Hand" })
    state.setQuery("sun")
    await state.deleteSelected()
    assert.deepEqual(calls, ["destroy Sun"], "Hand is hidden by the search: not deleted")
    calls.length = 0
    state.setSelection({ ids: new Set(["Sun", "Hand"]), anchor: "Sun", primary: "Hand" })
    await state.duplicateSelected()
    assert.deepEqual(calls, ["duplicate Sun"])
    assert.deepEqual(state.dragIds("Sun"), ["Sun"])
  })

  test("a move is refused while a search narrows the rows, and works again after", async () => {
    const { state, calls } = stateOver()
    await state.refresh()
    state.setQuery("sun")
    assert.equal(await state.move(["Sun"], { parentId: "World", index: -1 }), false)
    assert.deepEqual(calls, [])
    state.setQuery("")
    assert.equal(await state.move(["Sun"], { parentId: "World", index: -1 }), true)
    assert.deepEqual(calls, ["move Sun|World"])
  })

  test("a rename in progress ends when the query changes; creating an object ends the search so it is shown", async () => {
    const { state } = stateOver()
    await state.refresh()
    state.click("Sun")
    state.beginRename()
    assert.equal(state.renaming.value, "Sun")
    state.setQuery("sun")
    assert.equal(state.renaming.value, null)
    await state.create("Cube", "")
    assert.equal(state.query.value, "")
    assert.equal(state.renaming.value, "New")
    assert.ok(ids(state.rows.value).includes("New"))
  })

  test("a changed scene is filtered again (the filter follows the tree)", async () => {
    const { state, setNodes } = stateOver()
    state.setQuery("rock")
    await state.refresh()
    assert.deepEqual(ids(state.rows.value), ["World", "Rock"])
    setNodes(list.filter((n) => n.id !== "Rock"))
    await state.refresh()
    assert.deepEqual(ids(state.rows.value), [])
    setNodes([...list, node("Rock2", "Sun", 0)])
    await state.refresh()
    assert.deepEqual(ids(state.rows.value), ["World", "Rock", "Sun", "Rock2"])
  })
})

// ==================== Persistence ====================

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
/** Runs a scheduled write when told */
function manual() {
  const pending: Array<() => void> = []
  const schedule: Schedule = (callback) => {
    pending.push(callback)
    return () => void pending.splice(pending.indexOf(callback) >>> 0, 1)
  }
  return { schedule, run: () => pending.splice(0).forEach((callback) => callback()), pending }
}

describe("the hierarchy search is kept per project", () => {
  test("round trip: a typed search is written (debounced) and read back by the next session", async () => {
    const storage = new MemoryStore()
    const clock = manual()
    const prefs = new PrefsStore(storage, clock.schedule)
    const { state } = stateOver()
    const detach = attachHierarchyFilterPrefs(state, prefs.project(P1))
    assert.equal(storage.data.size, 0, "attaching with nothing saved writes nothing")
    state.setQuery("t:collider")
    state.setQuery("t:collider arm")
    state.setFilterMode("list")
    assert.equal(storage.data.size, 0, "debounced: not written yet")
    clock.run()
    const key = prefStorageKey(HierarchyFilterPref, P1)
    assert.deepEqual(JSON.parse(storage.data.get(key)!).value, { query: "t:collider arm", mode: "list" })
    detach()

    const next = stateOver()
    attachHierarchyFilterPrefs(next.state, new PrefsStore(storage, clock.schedule).project(P1))
    assert.equal(next.state.query.value, "t:collider arm")
    assert.equal(next.state.filterMode.value, "list")
  })

  test("another project has its own search; clearing removes the entry", async () => {
    const storage = new MemoryStore()
    const clock = manual()
    const prefs = new PrefsStore(storage, clock.schedule)
    const one = stateOver().state
    attachHierarchyFilterPrefs(one, prefs.project(P1))
    one.setQuery("abc")
    clock.run()
    const two = stateOver().state
    attachHierarchyFilterPrefs(two, prefs.project(P2))
    assert.equal(two.query.value, "", "project 2 has no search")
    one.setQuery("")
    clock.run()
    assert.equal(storage.data.has(prefStorageKey(HierarchyFilterPref, P1)), false)
  })

  test("a corrupt, wrong-typed or oversized entry is ignored; blocked storage does not throw", () => {
    const storage = new MemoryStore()
    const key = prefStorageKey(HierarchyFilterPref, P1)
    for (const bad of ["not json", JSON.stringify({ version: 1, value: { query: 5, mode: "tree" } }), JSON.stringify({ version: 1, value: { query: "x".repeat(500), mode: "tree" } }), JSON.stringify({ version: 1, value: { query: "x", mode: "grid" } })]) {
      storage.data.set(key, bad)
      const { state } = stateOver()
      attachHierarchyFilterPrefs(state, new PrefsStore(storage).project(P1))
      assert.equal(state.query.value, "")
      assert.equal(state.filterMode.value, "tree")
    }
    storage.broken = true
    const { state } = stateOver()
    const detach = attachHierarchyFilterPrefs(state, new PrefsStore(storage, manual().schedule).project(P1))
    state.setQuery("still works")
    assert.equal(state.query.value, "still works")
    detach()
  })

  test("a scope without a project remembers nothing", () => {
    const storage = new MemoryStore()
    const clock = manual()
    const { state } = stateOver()
    attachHierarchyFilterPrefs(state, new PrefsStore(storage, clock.schedule).project("../bad"))
    state.setQuery("x")
    clock.run()
    assert.equal(storage.data.size, 0)
  })
})
