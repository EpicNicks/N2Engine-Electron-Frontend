import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { LayoutController, Schedule } from "../renderer/layout/layout-controller"
import {
  Layout,
  closePanel,
  defaultLayout,
  movePanel,
  nextStackId,
  openPanel,
  parseLayout,
  serializeLayout,
} from "../renderer/layout/layout-model"
import {
  KeyValueStore,
  LayoutPersistence,
  ProjectLayoutPref,
  UserLayoutKey,
  UserLayoutPref,
  projectLayoutKey,
} from "../renderer/layout/layout-storage"
import { PrefsStore, prefStorageKey } from "../renderer/prefs"
import { RegionIds } from "../renderer/layout/panel-registry"
import { fixtureRegistry, shape } from "./layout-fixture"

const registry = fixtureRegistry()
const A = "11111111-1111-4111-8111-111111111111"

class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>()
  get(key: string): string | null {
    return this.data.get(key) ?? null
  }
  set(key: string, value: string): void {
    this.data.set(key, value)
  }
  remove(key: string): void {
    this.data.delete(key)
  }
}

const noSchedule: Schedule = () => () => {}

const idsOf = (layout: Layout): string[] => RegionIds.flatMap((r) => layout.regions[r].groups.map((g) => g.id))

/** What release F1 saved: a layout whose stacks have no ids */
function f1Layout(): Record<string, unknown> {
  const layout = serializeLayout(defaultLayout(registry))
  const json = JSON.parse(JSON.stringify(layout))
  for (const region of Object.values<{ groups: Record<string, unknown>[] }>(json.regions)) {
    for (const group of region.groups) delete group.id
  }
  return json
}

describe("stack ids", () => {
  test("the default layout gives every stack its own id", () => {
    const ids = idsOf(defaultLayout(registry))
    assert.equal(ids.length, 6)
    assert.equal(new Set(ids).size, ids.length)
    for (const id of ids) assert.match(id, /^s\d+$/)
    assert.deepEqual(idsOf(defaultLayout(registry)), ids, "the same every time")
  })

  test("ids are saved with the layout and read back as they were", () => {
    const layout = movePanel(defaultLayout(registry), registry, "assets", { region: "right" })
    const json = JSON.parse(JSON.stringify(serializeLayout(layout)))
    const back = parseLayout(json, registry)!
    assert.deepEqual(idsOf(back), idsOf(layout))
  })

  test("a layout saved before stacks had ids is given ids, the same ones every time it is read, and keeps its shape", () => {
    const old = f1Layout()
    const first = parseLayout(old, registry)!
    const second = parseLayout(old, registry)!
    assert.deepEqual(idsOf(first), idsOf(second))
    assert.equal(new Set(idsOf(first)).size, idsOf(first).length)
    assert.deepEqual(shape(first), shape(defaultLayout(registry)))
    assert.equal(first.regions.right.groups.length, 3)
  })

  test("ids that are missing, malformed or used twice are replaced; the good ones stay", () => {
    const json = JSON.parse(JSON.stringify(serializeLayout(defaultLayout(registry))))
    const right = json.regions.right.groups
    const keep = right[0].id
    right[1].id = keep // twice
    right[2].id = "bad id!" // malformed
    json.regions.left.groups[0].id = 7 // not text
    const layout = parseLayout(json, registry)!
    const ids = idsOf(layout)
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(layout.regions.right.groups[0].id, keep)
    for (const id of ids) assert.match(id, /^[0-9a-zA-Z-]{1,32}$/)
  })

  test("closing a panel keeps the other stacks' ids; reopening it makes a stack with a new id", () => {
    const start = defaultLayout(registry)
    const before = Object.fromEntries(start.regions.right.groups.map((g) => [g.tabs[0], g.id]))
    const closed = closePanel(start, registry, "inspector")
    assert.deepEqual(
      closed.regions.right.groups.map((g) => [g.tabs[0], g.id]),
      [
        ["hierarchy", before.hierarchy],
        ["engine", before.engine],
      ]
    )
    const reopened = openPanel(closed, registry, "inspector")
    const ids = idsOf(reopened)
    assert.equal(new Set(ids).size, ids.length, "no id is used twice")
    const byPanel = Object.fromEntries(reopened.regions.right.groups.map((g) => [g.tabs[0], g.id]))
    assert.equal(byPanel.hierarchy, before.hierarchy)
    assert.equal(byPanel.engine, before.engine)
    assert.notEqual(byPanel.inspector, before.hierarchy)
    assert.notEqual(byPanel.inspector, before.engine)
  })

  test("a stack made by a move gets a fresh id, and one that empties takes its id with it", () => {
    const start = defaultLayout(registry)
    const moved = movePanel(start, registry, "assets", { region: "right", group: 1 })
    assert.equal(moved.regions.left.groups.length, 0)
    assert.deepEqual(
      idsOf(moved),
      idsOf(start).filter((id) => id !== start.regions.left.groups[0].id)
    )
    const back = movePanel(moved, registry, "assets", { region: "left" })
    assert.equal(back.regions.left.groups.length, 1)
    assert.equal(new Set(idsOf(back)).size, idsOf(back).length)
  })

  test("nextStackId is one past the biggest number", () => {
    const layout = defaultLayout(registry)
    assert.equal(nextStackId(layout), "s7")
    layout.regions.left.groups[0].id = "s40"
    assert.equal(nextStackId(layout), "s41")
  })
})

describe("the layout on the preferences store", () => {
  test("a layout saved by release F1 (the old keys, no stack ids) still loads, for the project and as the user default", () => {
    const storage = new MemoryStore()
    const layout = parseLayout(f1Layout(), registry)!
    const moved = movePanel(layout, registry, "console", { region: "right" })
    storage.data.set(projectLayoutKey(A), JSON.stringify(f1Of(moved)))
    storage.data.set(UserLayoutKey, JSON.stringify(f1Of(moved)))
    const persistence = new LayoutPersistence(storage, registry)
    assert.deepEqual(shape(persistence.loadProject(A)!), shape(moved))
    assert.deepEqual(shape(persistence.loadUserDefault()!), shape(moved))
  })

  test("reading the old keys writes nothing; the first change is written under the new key, and the old entry stays as it was", () => {
    const storage = new MemoryStore()
    const moved = movePanel(defaultLayout(registry), registry, "console", { region: "right" })
    const oldText = JSON.stringify(f1Of(moved))
    storage.data.set(projectLayoutKey(A), oldText)
    const before = new Map(storage.data)
    const controller = new LayoutController(registry, new LayoutPersistence(storage, registry), noSchedule)
    controller.setProject(A)
    assert.deepEqual(shape(controller.layout.value), shape(moved))
    controller.flush()
    assert.deepEqual([...storage.data], [...before], "nothing was written for a layout that was only loaded")
    controller.setSize("left", 410)
    controller.flush()
    assert.equal(storage.data.get(projectLayoutKey(A)), oldText, "the old entry is not touched")
    const saved = JSON.parse(storage.data.get(prefStorageKey(ProjectLayoutPref, A))!)
    assert.equal(saved.version, 1)
    assert.equal(saved.value.regions.left.size, 410)
    assert.deepEqual(shape(saved.value), shape(moved))
    // And a new window over the same storage reads the new entry, not the old one
    const again = new LayoutPersistence(storage, registry).loadProject(A)!
    assert.equal(again.regions.left.size, 410)
  })

  test("the stored layout is the layout model's own JSON, unchanged by the preferences store", () => {
    const storage = new MemoryStore()
    const persistence = new LayoutPersistence(storage, registry)
    const layout = movePanel(defaultLayout(registry), registry, "assets", { region: "bottom" })
    persistence.saveProject(A, layout)
    const stored = JSON.parse(storage.data.get(prefStorageKey(ProjectLayoutPref, A))!)
    assert.deepEqual(stored.value, JSON.parse(JSON.stringify(serializeLayout(layout))))
    assert.deepEqual(Object.keys(stored.value).sort(), ["closed", "regions", "version"])
    persistence.saveUserDefault(layout)
    assert.ok(storage.data.has(prefStorageKey(UserLayoutPref)))
  })

  test("reset and forgetting the default remove the old entries too, or the old layout would come back", () => {
    const storage = new MemoryStore()
    const moved = movePanel(defaultLayout(registry), registry, "console", { region: "right" })
    storage.data.set(projectLayoutKey(A), JSON.stringify(f1Of(moved)))
    storage.data.set(UserLayoutKey, JSON.stringify(f1Of(moved)))
    const controller = new LayoutController(registry, new LayoutPersistence(storage, registry), noSchedule)
    controller.setProject(A)
    controller.reset()
    controller.forgetUserDefault()
    assert.equal(storage.data.has(projectLayoutKey(A)), false)
    assert.equal(storage.data.has(UserLayoutKey), false)
    const fresh = new LayoutController(registry, new LayoutPersistence(storage, registry), noSchedule)
    fresh.setProject(A)
    assert.deepEqual(shape(fresh.layout.value), shape(defaultLayout(registry)))
  })

  test("a corrupt new entry falls back to the old one; a corrupt old one gives the default", () => {
    const storage = new MemoryStore()
    const moved = movePanel(defaultLayout(registry), registry, "console", { region: "right" })
    storage.data.set(prefStorageKey(ProjectLayoutPref, A), "{oops")
    storage.data.set(projectLayoutKey(A), JSON.stringify(f1Of(moved)))
    assert.deepEqual(shape(new LayoutPersistence(storage, registry).loadProject(A)!), shape(moved))
    const broken = new MemoryStore()
    broken.data.set(projectLayoutKey(A), "{oops")
    assert.equal(new LayoutPersistence(broken, registry).loadProject(A), null)
  })

  test("the controller and the page can share one PrefsStore with other keys", () => {
    const storage = new MemoryStore()
    const prefs = new PrefsStore(storage, noSchedule)
    const persistence = new LayoutPersistence(prefs, registry)
    persistence.saveUserDefault(defaultLayout(registry))
    assert.ok(storage.data.has(prefStorageKey(UserLayoutPref)))
    assert.notEqual(persistence.loadUserDefault(), null)
  })
})

/** A layout as release F1 wrote it: the model's JSON without stack ids */
function f1Of(layout: Layout): Record<string, unknown> {
  const json = JSON.parse(JSON.stringify(serializeLayout(layout)))
  for (const region of Object.values<{ groups: Record<string, unknown>[] }>(json.regions)) {
    for (const group of region.groups) delete group.id
  }
  return json
}
