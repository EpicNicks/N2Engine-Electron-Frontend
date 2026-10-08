import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { HierarchyNode, HierarchyResponse } from "../protocol/protocol.generated"
import type { JsonObject } from "../shared/api"
import { EditGroups } from "../renderer/edit-groups"
import { HierarchyState, CreatePresets } from "../renderer/hierarchy-state"

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

interface Obj {
  id: string
  name: string
  active: boolean
  children: Obj[]
}

/** A host's scene: the objects, with the semantics of the engine's hierarchy commands (docs/editor.html) */
class FakeScene {
  roots: Obj[] = []
  revision = 1
  connected = true
  /** Commands received, as text */
  calls: string[] = []
  failNext: string | null = null
  private next = 1

  constructor(spec: string = "") {
    // "A(A1,A2(A2a)),B": a tree in text
    let pos = 0
    const parse = (): Obj[] => {
      const list: Obj[] = []
      while (pos < spec.length && spec[pos] !== ")") {
        let name = ""
        while (pos < spec.length && !"(),".includes(spec[pos])) name += spec[pos++]
        const obj: Obj = { id: "id-" + name, name, active: true, children: [] }
        if (spec[pos] === "(") {
          pos++
          obj.children = parse()
          pos++ // )
        }
        list.push(obj)
        if (spec[pos] === ",") pos++
      }
      return list
    }
    this.roots = parse()
  }

  find(id: string): { obj: Obj; siblings: Obj[]; parent: Obj | null } | null {
    const visit = (siblings: Obj[], parent: Obj | null): ReturnType<FakeScene["find"]> => {
      for (const obj of siblings) {
        if (obj.id === id) return { obj, siblings, parent }
        const inner = visit(obj.children, obj)
        if (inner) return inner
      }
      return null
    }
    return visit(this.roots, null)
  }

  /** The tree as text again: ids' names, depth-first */
  text(): string {
    const show = (list: Obj[]): string =>
      list.map((o) => o.name + (o.children.length ? `(${show(o.children)})` : "")).join(",")
    return show(this.roots)
  }

  private check(): void {
    if (this.failNext !== null) {
      const message = this.failNext
      this.failNext = null
      throw new Error(message)
    }
  }

  engine = {
    isConnected: () => this.connected,
    getHierarchy: async (): Promise<HierarchyResponse> => {
      this.calls.push("getHierarchy")
      const nodes: HierarchyNode[] = []
      const visit = (list: Obj[], parentId: string) =>
        list.forEach((o, index) => {
          nodes.push({
            id: o.id,
            parentId,
            index,
            name: o.name,
            active: o.active,
            activeInHierarchy: o.active,
            layer: 0,
            tag: "",
            components: [],
          })
          visit(o.children, o.id)
        })
      visit(this.roots, "")
      return { revision: this.revision, nodes }
    },
    createEntityEx: async (name: string, parentId: string, siblingIndex: number, preset: string) => {
      this.calls.push(`createEntityEx ${name}|${parentId}|${siblingIndex}|${preset}`)
      this.check()
      const obj: Obj = { id: "new-" + this.next, name: name || preset || "GameObject", active: true, children: [] }
      this.next++
      const list = parentId === "" ? this.roots : this.find(parentId)!.obj.children
      list.splice(siblingIndex < 0 ? list.length : Math.min(siblingIndex, list.length), 0, obj)
      this.revision++
      return obj.id
    },
    setEntityParent: async (entityId: string, parentId: string, siblingIndex: number, keepWorld: boolean) => {
      this.calls.push(`setEntityParent ${entityId}|${parentId}|${siblingIndex}|${keepWorld}`)
      this.check()
      const found = this.find(entityId)!
      if (
        parentId !== "" &&
        (parentId === entityId || this.find(parentId) === null || this.isUnder(found.obj, parentId))
      ) {
        throw new Error("Can't make it a child of itself or of its own descendant")
      }
      found.siblings.splice(found.siblings.indexOf(found.obj), 1)
      const list = parentId === "" ? this.roots : this.find(parentId)!.obj.children
      // The place it ends up at among its new siblings
      list.splice(siblingIndex < 0 ? list.length : Math.min(siblingIndex, list.length), 0, found.obj)
      this.revision++
    },
    setEntityProperties: async (entityId: string, properties: JsonObject) => {
      this.calls.push(`setEntityProperties ${entityId} ${JSON.stringify(properties)}`)
      this.check()
      const obj = this.find(entityId)!.obj
      if (typeof properties.name === "string") obj.name = properties.name
      if (typeof properties.active === "boolean") obj.active = properties.active
      this.revision++
    },
    duplicateEntity: async (entityId: string) => {
      this.calls.push(`duplicateEntity ${entityId}`)
      this.check()
      const found = this.find(entityId)!
      const copy = (o: Obj): Obj => ({
        ...o,
        id: "copy-" + this.next++,
        name: o.name + "'",
        children: o.children.map(copy),
      })
      const made = copy(found.obj)
      found.siblings.splice(found.siblings.indexOf(found.obj) + 1, 0, made)
      this.revision++
      return made.id
    },
    destroyEntity: async (entityId: string) => {
      this.calls.push(`destroyEntity ${entityId}`)
      this.check()
      const found = this.find(entityId)!
      found.siblings.splice(found.siblings.indexOf(found.obj), 1)
      this.revision++
    },
  }

  private isUnder(obj: Obj, id: string): boolean {
    return obj.children.some((c) => c.id === id || this.isUnder(c, id))
  }
}

function setup(spec: string, answers: boolean[] = []) {
  const scene = new FakeScene(spec)
  const primaries: Array<string | null> = []
  const asked: string[] = []
  const state = new HierarchyState(scene.engine, {
    confirm: async (message, okLabel) => {
      asked.push(`${okLabel}: ${message}`)
      return answers.shift() ?? false
    },
    onPrimaryChange: (id) => primaries.push(id),
  })
  return { scene, state, primaries, asked }
}

const id = (name: string) => "id-" + name
const names = (state: HierarchyState) => state.rows.value.map((r) => state.tree.value.nodes.get(r.id)!.name)

describe("HierarchyState", () => {
  test("refresh reads the objects and shows the roots; expanding shows their children", async () => {
    const { state } = setup("A(A1,A2(A2a)),B")
    assert.deepEqual(names(state), [])
    await state.refresh()
    assert.deepEqual(names(state), ["A", "B"])
    state.toggleExpanded(id("A"))
    assert.deepEqual(names(state), ["A", "A1", "A2", "B"])
    state.toggleExpanded(id("A"))
    assert.deepEqual(names(state), ["A", "B"])
  })

  test("no scene empties it, but a read that failed otherwise keeps what is held", async () => {
    const { scene, state } = setup("A(A1)")
    await state.refresh()
    state.toggleExpanded(id("A"))
    state.click(id("A1"))
    const real = scene.engine.getHierarchy
    scene.connected = false
    await state.refresh()
    assert.equal(state.tree.value.order.length, 2, "not connected: reset() is what empties it")
    scene.connected = true
    scene.engine.getHierarchy = async () => {
      throw new Error("Connection closed")
    }
    await state.refresh()
    assert.equal(state.tree.value.order.length, 2)
    assert.equal(state.primaryId, id("A1"))
    assert.equal(state.expanded.value.has(id("A")), true)
    scene.engine.getHierarchy = async () => {
      throw new Error("No scene loaded")
    }
    await state.refresh()
    assert.equal(state.response.value, null)
    assert.equal(state.primaryId, null)
    scene.engine.getHierarchy = real
  })

  test("a slow older read can't replace a newer one", async () => {
    const { scene, state } = setup("A")
    const real = scene.engine.getHierarchy
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    scene.engine.getHierarchy = async () => {
      const answer = await real()
      await gate // the first read's answer comes late
      return answer
    }
    const slow = state.refresh()
    scene.engine.getHierarchy = real
    scene.roots.push({ id: id("B"), name: "B", active: true, children: [] })
    scene.revision++
    await state.refresh()
    assert.deepEqual(names(state), ["A", "B"])
    release()
    await slow
    assert.deepEqual(names(state), ["A", "B"])
    assert.equal(state.response.value?.revision, scene.revision)
  })

  test("reset forgets the objects, the selection and the expanded ones", async () => {
    const { state, primaries } = setup("A(A1)")
    await state.refresh()
    state.toggleExpanded(id("A"))
    state.click(id("A1"))
    state.reset()
    assert.equal(state.response.value, null)
    assert.equal(state.expanded.value.size, 0)
    assert.equal(state.selection.value.ids.size, 0)
    assert.deepEqual(primaries, [id("A1"), null])
  })

  describe("following the scene's changes", () => {
    test("a change reads the hierarchy again, unless it was read at that revision already", async () => {
      const { scene, state } = setup("A")
      await state.refresh()
      scene.calls.length = 0
      await state.applyChange({ full: false, entityIds: ["x"] }, scene.revision) // already current
      assert.deepEqual(scene.calls, [])
      scene.roots.push({ id: id("B"), name: "B", active: true, children: [] })
      scene.revision++
      await state.applyChange({ full: false, entityIds: [id("B")] }, scene.revision)
      assert.deepEqual(scene.calls, ["getHierarchy"])
      assert.deepEqual(names(state), ["A", "B"])
      // Unknown revision: read
      await state.applyChange({ full: false, entityIds: [] }, null)
      assert.equal(scene.calls.length, 2)
    })

    test("a full change always reads, and the selection and expanded objects that are gone are dropped", async () => {
      const { scene, state, primaries } = setup("A(A1),B")
      await state.refresh()
      state.toggleExpanded(id("A"))
      state.click(id("A1"))
      state.click(id("B"), { toggle: true })
      // Another scene: A is still an object (same id), A1 and B are gone
      scene.roots = [{ id: id("A"), name: "A", active: true, children: [] }]
      scene.revision++
      await state.applyChange({ full: true, entityIds: [] }, scene.revision)
      assert.deepEqual(names(state), ["A"])
      assert.equal(state.selection.value.ids.size, 0)
      assert.equal(state.selection.value.primary, null)
      assert.equal(primaries[primaries.length - 1], null)
    })

    test("an object destroyed elsewhere leaves the selection and ends its rename", async () => {
      const { scene, state } = setup("A,B")
      await state.refresh()
      state.click(id("A"))
      state.click(id("B"), { toggle: true })
      state.beginRename(id("B"))
      scene.roots = scene.roots.filter((o) => o.name !== "B")
      scene.revision++
      await state.applyChange({ full: false, entityIds: [id("B")] }, scene.revision)
      assert.deepEqual([...state.selection.value.ids], [id("A")])
      assert.equal(state.selection.value.primary, id("A"))
      assert.equal(state.renaming.value, null)
    })
  })

  describe("actions racing reads", () => {
    /** Makes the next getHierarchy answers wait for the test */
    function gated(scene: FakeScene) {
      const real = scene.engine.getHierarchy
      const releases: Array<() => void> = []
      scene.engine.getHierarchy = async () => {
        const answer = await real()
        await new Promise<void>((resolve) => releases.push(resolve))
        return answer
      }
      return { releases, restore: () => (scene.engine.getHierarchy = real) }
    }

    test("a create whose read an event's read overtook still selects and renames the new object", async () => {
      const { scene, state } = setup("A")
      await state.refresh()
      const gate = gated(scene)
      const creating = state.create("Cube")
      await settle()
      // create's own read is waiting; the event's read starts after it and finishes first
      const event = state.applyChange({ full: false, entityIds: ["new-1"] }, null)
      await settle()
      assert.equal(gate.releases.length, 2)
      gate.releases[1]()
      await settle()
      gate.releases[0]()
      const made = await creating
      await event
      assert.equal(state.primaryId, made)
      assert.equal(state.renaming.value, made)
      assert.deepEqual(names(state), ["A", "Cube"])
    })

    test("applyChange resolves only after the newest read is applied", async () => {
      const { scene, state } = setup("A")
      await state.refresh()
      const gate = gated(scene)
      let done = false
      const first = state.applyChange({ full: true, entityIds: [] }, null).then(() => (done = true))
      await settle()
      const second = state.refresh()
      await settle()
      gate.releases[0]() // the older read answers: not the newest
      await settle()
      assert.equal(done, false)
      gate.releases[1]()
      await Promise.all([first, second])
      assert.equal(done, true)
    })

    test("a second delete or duplicate while one runs is ignored", async () => {
      const { scene, state } = setup("A,B")
      await state.refresh()
      state.click(id("A"))
      const gate = gated(scene)
      const first = state.duplicateSelected()
      await settle()
      await state.duplicateSelected()
      assert.equal(await state.deleteSelected(), false)
      assert.equal(await state.move([id("A")], { parentId: id("B"), index: -1 }), false)
      gate.releases[0]()
      await first
      assert.equal(scene.calls.filter((c) => c.startsWith("duplicateEntity")).length, 1)
      assert.equal(scene.calls.filter((c) => c.startsWith("destroyEntity")).length, 0)
      assert.equal(scene.text(), "A,A',B")
    })

    test("renameSettled resolves when the rename has been sent and read back", async () => {
      const { scene, state } = setup("A")
      await state.refresh()
      state.beginRename(id("A"))
      const rename = state.commitRename(id("A"), "Hero")
      await state.renameSettled
      assert.equal(scene.text(), "Hero")
      await rename
    })
  })

  describe("collapsed objects", () => {
    test("collapsing an object selects it when what was selected is hidden by it", async () => {
      const { state } = setup("A(A1,A2),B")
      await state.refresh()
      state.toggleExpanded(id("A"))
      state.click(id("A1"))
      state.click(id("B"), { toggle: true })
      state.toggleExpanded(id("A"))
      assert.deepEqual([...state.selection.value.ids].sort(), [id("A"), id("B")])
      assert.equal(state.primaryId, id("B"))
    })

    test("F2 and the arrows ignore a primary that has no row", async () => {
      const { state } = setup("A(A1,A2),B")
      await state.refresh()
      state.toggleExpanded(id("A"))
      state.click(id("A2"))
      // Hidden without the selection following (a stale one)
      state.selection.value = { ids: new Set([id("A2")]), anchor: id("A2"), primary: id("A2") }
      state.expanded.value = new Set()
      state.beginRename()
      assert.equal(state.renaming.value, null)
      state.expandPrimary()
      state.collapsePrimary()
      assert.equal(state.primaryId, id("A2"))
      state.step(1)
      assert.equal(state.primaryId, id("A"), "from a row that isn't shown: the first row")
    })

    test("a read after another client reparented the selection under a collapsed object moves it to that object", async () => {
      const { scene, state } = setup("A,B")
      await state.refresh()
      state.click(id("B"))
      const b = scene.roots.pop()!
      scene.roots[0].children.push(b)
      scene.revision++
      await state.applyChange({ full: false, entityIds: [id("B")] }, scene.revision)
      assert.equal(state.primaryId, id("A"))
    })
  })

  describe("selection", () => {
    test("clicks select, ctrl toggles, shift ranges over the rows shown, and the primary is reported", async () => {
      const { state, primaries } = setup("A(A1),B,C")
      await state.refresh()
      state.click(id("A"))
      state.click(id("C"), { range: true })
      assert.deepEqual([...state.selection.value.ids], [id("A"), id("B"), id("C")], "A1 is hidden, so not in the range")
      state.click(id("B"), { toggle: true })
      assert.deepEqual([...state.selection.value.ids], [id("A"), id("C")])
      assert.deepEqual(primaries, [id("A"), id("C")])
      assert.equal(state.primaryId, id("C"))
    })

    test("the primary is reported only when it changes", async () => {
      const { state, primaries } = setup("A,B")
      await state.refresh()
      state.click(id("A"))
      state.click(id("A"))
      state.click(id("B"), { toggle: true })
      state.click(id("B"), { toggle: true })
      assert.deepEqual(primaries, [id("A"), id("B"), id("A")])
    })

    test("arrow keys move through the rows shown, open and close objects, and go to the parent", async () => {
      const { state } = setup("A(A1,A2),B")
      await state.refresh()
      state.step(1)
      assert.equal(state.primaryId, id("A"), "from nothing: the first row")
      state.expandPrimary()
      assert.deepEqual(names(state), ["A", "A1", "A2", "B"])
      state.expandPrimary() // open: into the first child
      assert.equal(state.primaryId, id("A1"))
      state.step(1)
      assert.equal(state.primaryId, id("A2"))
      state.step(1, true)
      assert.deepEqual([...state.selection.value.ids], [id("A2"), id("B")])
      state.click(id("A2"))
      state.collapsePrimary() // closed already: to the parent
      assert.equal(state.primaryId, id("A"))
      state.collapsePrimary()
      assert.deepEqual(names(state), ["A", "B"])
    })

    test("reveal expands the ancestors and selects", async () => {
      const { state } = setup("A(A2(A2a))")
      await state.refresh()
      state.reveal(id("A2a"))
      assert.deepEqual(names(state), ["A", "A2", "A2a"])
      assert.equal(state.primaryId, id("A2a"))
    })
  })

  describe("actions", () => {
    test("create makes the object under the parent as its last child, selects it and starts renaming", async () => {
      const { scene, state } = setup("A,B")
      await state.refresh()
      const made = await state.create("Cube", id("A"))
      assert.ok(scene.calls.includes(`createEntityEx |${id("A")}|-1|Cube`))
      assert.equal(scene.text(), "A(Cube),B")
      assert.deepEqual(names(state), ["A", "Cube", "B"], "A is expanded to show it")
      assert.equal(state.primaryId, made)
      assert.equal(state.renaming.value, made)
      await state.create("")
      assert.equal(scene.text(), "A(Cube),B,GameObject")
    })

    test("every preset is one CreateEntityEx knows", () => {
      assert.deepEqual(
        CreatePresets.map((p) => p.preset),
        ["", "Cube", "Sphere", "Quad", "DirectionalLight", "PointLight", "SpotLight"]
      )
    })

    test("rename sets the name; an empty or unchanged one sends nothing", async () => {
      const { scene, state } = setup("A")
      await state.refresh()
      state.beginRename(id("A"))
      assert.equal(state.renaming.value, id("A"))
      await state.commitRename(id("A"), "  Hero ")
      assert.equal(state.renaming.value, null)
      assert.equal(scene.text(), "Hero")
      assert.deepEqual(names(state), ["Hero"])
      scene.calls.length = 0
      await state.commitRename(id("A"), "Hero")
      await state.commitRename(id("A"), "   ")
      assert.deepEqual(scene.calls, [])
      state.beginRename(id("A"))
      state.cancelRename()
      assert.equal(state.renaming.value, null)
      state.beginRename("nope")
      assert.equal(state.renaming.value, null)
    })

    test("a refused rename is thrown and the name stays as the host has it", async () => {
      const { scene, state } = setup("A")
      await state.refresh()
      scene.failNext = "bad name"
      await assert.rejects(state.commitRename(id("A"), "B"), /bad name/)
      assert.deepEqual(names(state), ["A"])
    })

    test("the active toggle sets only active", async () => {
      const { scene, state } = setup("A")
      await state.refresh()
      await state.setActive(id("A"), false)
      assert.ok(scene.calls.includes(`setEntityProperties ${id("A")} {"active":false}`))
      assert.equal(state.tree.value.nodes.get(id("A"))?.active, false)
    })

    test("duplicate copies each selected top-level object and selects the copies", async () => {
      const { scene, state } = setup("A(A1),B,C")
      await state.refresh()
      state.toggleExpanded(id("A"))
      state.click(id("A"))
      state.click(id("A1"), { toggle: true })
      state.click(id("C"), { toggle: true })
      await state.duplicateSelected()
      assert.deepEqual(
        scene.calls.filter((c) => c.startsWith("duplicate")),
        [`duplicateEntity ${id("A")}`, `duplicateEntity ${id("C")}`],
        "A1 is under A, which is copied with it"
      )
      assert.equal(scene.text(), "A(A1),A'(A1'),B,C,C'")
      assert.equal(state.selection.value.ids.size, 2)
      assert.equal(state.tree.value.nodes.get(state.primaryId!)?.name, "C'")
    })

    test("duplicate with nothing selected does nothing", async () => {
      const { scene, state } = setup("A")
      await state.refresh()
      scene.calls.length = 0
      await state.duplicateSelected()
      assert.deepEqual(scene.calls, [])
    })

    test("delete destroys the selected objects, asking first for more than one", async () => {
      const { scene, state, asked } = setup("A(A1),B,C", [false, true])
      await state.refresh()
      state.click(id("C"))
      assert.equal(await state.deleteSelected(), true)
      assert.deepEqual(asked, [], "one object: no question")
      assert.equal(scene.text(), "A(A1),B")
      assert.equal(state.selection.value.ids.size, 0)

      state.click(id("A"))
      assert.equal(await state.deleteSelected(), false, "it has an object under it: asked, and the user said no")
      assert.match(asked[0], /^Delete: Delete 'A' and everything under it \(2 objects\)\?$/)
      assert.equal(scene.text(), "A(A1),B")
      assert.equal(await state.deleteSelected(), true)
      assert.equal(scene.text(), "B")

      state.click(id("B"))
      assert.equal(await state.deleteSelected(), true)
      assert.equal(scene.text(), "")
    })

    test("delete of several top-level objects destroys each once, and names them", async () => {
      const { scene, state, asked } = setup("A(A1),B,C", [true])
      await state.refresh()
      state.toggleExpanded(id("A"))
      state.click(id("A"))
      state.click(id("A1"), { toggle: true })
      state.click(id("B"), { toggle: true })
      await state.deleteSelected()
      assert.deepEqual(
        scene.calls.filter((c) => c.startsWith("destroy")),
        [`destroyEntity ${id("A")}`, `destroyEntity ${id("B")}`]
      )
      assert.match(asked[0], /'A', 'B' and everything under them \(3 objects\)/)
      assert.equal(scene.text(), "C")
    })

    test("a failure stops the action, is thrown, and the hierarchy is read again", async () => {
      const { scene, state } = setup("A,B", [true])
      await state.refresh()
      state.click(id("A"))
      state.click(id("B"), { toggle: true })
      scene.failNext = "gone"
      await assert.rejects(state.deleteSelected(), /gone/)
      assert.equal(scene.text(), "A,B")
    })
  })

  describe("drag and drop", () => {
    test("dragging an unselected object carries just it; a selected one carries the selection's top level", async () => {
      const { state } = setup("A(A1),B,C")
      await state.refresh()
      state.toggleExpanded(id("A"))
      assert.deepEqual(state.dragIds(id("B")), [id("B")])
      state.click(id("A"))
      state.click(id("A1"), { toggle: true })
      state.click(id("C"), { toggle: true })
      assert.deepEqual(state.dragIds(id("A1")), [id("A"), id("C")])
      assert.deepEqual(state.dragIds(id("B")), [id("B")])
    })

    test("a move reparents with the world transform kept, then reads the new order", async () => {
      const { scene, state } = setup("A(A1),B,C")
      await state.refresh()
      assert.equal(await state.move([id("C")], { parentId: id("A"), index: 0 }), true)
      assert.deepEqual(
        scene.calls.filter((c) => c.startsWith("setEntityParent")),
        [`setEntityParent ${id("C")}|${id("A")}|0|true`]
      )
      assert.equal(scene.text(), "A(C,A1),B")
      assert.deepEqual(names(state), ["A", "C", "A1", "B"], "A is expanded to show it")
    })

    test("a drop that changes nothing sends nothing, and a forbidden one is refused here", async () => {
      const { scene, state } = setup("A(A1),B")
      await state.refresh()
      scene.calls.length = 0
      assert.equal(await state.move([id("B")], { parentId: "", index: 2 }), false)
      assert.equal(await state.move([id("A")], { parentId: id("A1"), index: -1 }), false)
      assert.deepEqual(scene.calls, [])
    })

    test("moving several lands them in order at the drop", async () => {
      const { scene, state } = setup("A,B,C,D,E")
      await state.refresh()
      await state.move([id("A"), id("D")], { parentId: "", index: 2 })
      assert.equal(scene.text(), "B,A,D,C,E")
      await state.move([id("E"), id("B")], { parentId: id("C"), index: -1 })
      assert.equal(scene.text(), "A,D,C(B,E)")
    })

    test("reordering to the end and out to the roots", async () => {
      const { scene, state } = setup("A(A1,A2),B")
      await state.refresh()
      await state.move([id("A1")], { parentId: "", index: -1 })
      assert.equal(scene.text(), "A(A2),B,A1")
      await state.move([id("A1")], { parentId: "", index: 0 })
      assert.equal(scene.text(), "A1,A(A2),B")
    })

    test("a move the host refuses is thrown, with the hierarchy read again", async () => {
      const { scene, state } = setup("A,B")
      await state.refresh()
      scene.failNext = "No such parent"
      await assert.rejects(state.move([id("A")], { parentId: id("B"), index: -1 }), /No such parent/)
      assert.equal(scene.text(), "A,B")
    })
  })
})

describe("HierarchyState and edit groups", () => {
  /** A state whose host records the group commands among the scene's: the order is what is tested */
  function grouped(spec: string, answers: boolean[] = [true]) {
    const scene = new FakeScene(spec)
    const groups = new EditGroups({
      isConnected: () => true,
      beginEditGroup: async (label: string) => void scene.calls.push(`begin ${label}`),
      endEditGroup: async () => void scene.calls.push("end"),
    })
    const state = new HierarchyState(scene.engine, {
      confirm: async () => answers.shift() ?? false,
      groups,
    })
    return { scene, state, groups }
  }
  const commands = (scene: FakeScene) => scene.calls.filter((c) => c !== "getHierarchy")

  test("deleting several objects is one group, ended after the last", async () => {
    const { scene, state, groups } = grouped("A,B,C")
    await state.refresh()
    state.click(id("A"))
    state.click(id("C"), { toggle: true })
    await state.deleteSelected()
    assert.deepEqual(commands(scene), ["begin Delete 2 objects", `destroyEntity ${id("A")}`, `destroyEntity ${id("C")}`, "end"])
    assert.equal(groups.depth, 0)
  })

  test("moving several objects, and duplicating several, are one group each", async () => {
    const { scene, state } = grouped("A,B,C,D")
    await state.refresh()
    await state.move([id("A"), id("B")], { parentId: id("D"), index: -1 })
    const moves = commands(scene)
    assert.equal(moves[0], "begin Move 2 objects")
    assert.equal(moves[moves.length - 1], "end")
    assert.equal(moves.filter((c) => c.startsWith("setEntityParent")).length, 2)

    scene.calls.length = 0
    state.click(id("C"))
    state.click(id("D"), { toggle: true })
    await state.duplicateSelected()
    assert.deepEqual(commands(scene), [
      "begin Duplicate 2 objects",
      `duplicateEntity ${id("C")}`,
      `duplicateEntity ${id("D")}`,
      "end",
    ])
  })

  test("one object is one step already: no group", async () => {
    const { scene, state } = grouped("A,B")
    await state.refresh()
    state.click(id("A"))
    await state.duplicateSelected()
    await state.deleteSelected()
    await state.move([id("B")], { parentId: "", index: 0 })
    assert.ok(!scene.calls.some((c) => c.startsWith("begin") || c === "end"))
  })

  test("the group is ended when a command fails, and the failure is thrown", async () => {
    const { scene, state, groups } = grouped("A,B,C")
    await state.refresh()
    state.click(id("A"))
    state.click(id("B"), { toggle: true })
    scene.failNext = "gone"
    await assert.rejects(state.deleteSelected(), /gone/)
    const sent = commands(scene)
    assert.equal(sent[0], "begin Delete 2 objects")
    assert.equal(sent[sent.length - 1], "end")
    assert.equal(groups.depth, 0)
  })

  test("actionSettled is the action that is running: Undo waits for a multi-delete to finish inside its group", async () => {
    const { scene, state, groups } = grouped("A,B,C")
    await state.refresh()
    state.click(id("A"))
    state.click(id("B"), { toggle: true })
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const destroy = scene.engine.destroyEntity
    scene.engine.destroyEntity = async (entityId: string) => {
      await gate
      return destroy(entityId)
    }
    const deleting = state.deleteSelected()
    await settle()
    let done = false
    const settled = state.actionSettled.then(() => (done = true))
    const closing = groups.closeAll()
    await settle()
    assert.equal(done, false)
    assert.equal(groups.depth, 1, "the group is open while the action runs")
    release()
    await deleting
    await settled
    await closing
    assert.equal(groups.depth, 0)
    assert.equal(commands(scene).filter((c) => c === "end").length, 1, "ended once, by the action")
    assert.equal(scene.text(), "C")
  })
})

describe("selecting what the viewport picked", () => {
  test("a plain pick selects just that object and shows it (its ancestors are expanded)", async () => {
    const { state } = setup("A(A1(A1a)),B")
    await state.refresh()
    state.click(id("B"))
    state.pick(id("A1a"))
    assert.deepEqual([...state.selection.value.ids], [id("A1a")])
    assert.equal(state.selection.value.primary, id("A1a"))
    assert.ok(state.rows.value.some((row) => row.id === id("A1a")), "its row is shown")
  })

  test("Ctrl toggles it, as a click on its row does", async () => {
    const { state } = setup("A,B,C")
    await state.refresh()
    state.pick(id("A"))
    state.pick(id("C"), { toggle: true })
    assert.deepEqual([...state.selection.value.ids].sort(), [id("A"), id("C")])
    assert.equal(state.selection.value.primary, id("C"))
    state.pick(id("A"), { toggle: true })
    assert.deepEqual([...state.selection.value.ids], [id("C")])
  })

  test("Shift is a toggle too (no hierarchy range between the anchor and the picked object), as in Unity's scene view", async () => {
    const { state } = setup("A,B,C,D")
    await state.refresh()
    state.pick(id("A"))
    state.pick(id("C"), { range: true })
    assert.deepEqual([...state.selection.value.ids].sort(), [id("A"), id("C")], "B is not between them")
    assert.equal(state.selection.value.primary, id("C"))
    state.pick(id("A"), { range: true })
    assert.deepEqual([...state.selection.value.ids], [id("C")])
  })

  test("it gives the same selection as the equivalent click on the row (for what a viewport click can do)", async () => {
    const a = setup("A,B,C,D")
    const b = setup("A,B,C,D")
    await a.state.refresh()
    await b.state.refresh()
    for (const [name, modifiers] of [["B", {}], ["D", { toggle: true }], ["A", { toggle: true }], ["C", { toggle: true }], ["C", {}]] as const) {
      a.state.pick(id(name), modifiers)
      b.state.click(id(name), modifiers)
      assert.deepEqual([...a.state.selection.value.ids].sort(), [...b.state.selection.value.ids].sort())
      assert.equal(a.state.selection.value.primary, b.state.selection.value.primary)
    }
  })

  test("empty space clears the selection; with Ctrl or Shift held it keeps it", async () => {
    const { state, primaries } = setup("A,B")
    await state.refresh()
    state.pick(id("A"))
    state.pick(null, { toggle: true })
    state.pick(null, { range: true })
    assert.deepEqual([...state.selection.value.ids], [id("A")])
    state.pick(null)
    assert.equal(state.selection.value.ids.size, 0)
    assert.equal(state.selection.value.primary, null)
    assert.deepEqual(primaries, [id("A"), null])
  })
})

describe("HierarchyState while a game runs", () => {
  const playing = "the game is running"

  test("what changes objects is refused, and nothing reaches the host", async () => {
    const { scene, state } = setup("A,B")
    await state.refresh()
    state.pick(id("A"))
    state.setReadOnly(playing)
    assert.equal(state.readOnly.value, true)
    await assert.rejects(state.create("Cube"), /can't be changed while the game is running/)
    await assert.rejects(state.setActive(id("A"), false), /can't be changed/)
    await assert.rejects(state.duplicateSelected(), /can't be changed/)
    await assert.rejects(state.deleteSelected(), /can't be changed/)
    await assert.rejects(state.move([id("A")], { parentId: id("B"), index: 0 }), /can't be changed/)
    assert.deepEqual(scene.calls.filter((c) => !c.startsWith("getHierarchy")), [])
  })

  test("selecting and expanding still work; renaming doesn't start, and one in progress ends", async () => {
    const { state } = setup("A(A1),B")
    await state.refresh()
    state.beginRename(id("A"))
    assert.equal(state.renaming.value, id("A"))
    state.setReadOnly(playing)
    assert.equal(state.renaming.value, null)
    state.beginRename(id("A"))
    assert.equal(state.renaming.value, null)
    state.click(id("B"))
    assert.equal(state.primaryId, id("B"))
    state.toggleExpanded(id("A"))
    assert.deepEqual(names(state), ["A", "A1", "B"])
  })

  test("a rename typed when the game started is dropped quietly", async () => {
    const { scene, state } = setup("A")
    await state.refresh()
    state.setReadOnly(playing)
    await state.commitRename(id("A"), "Renamed")
    assert.equal(scene.calls.some((c) => c.startsWith("setEntityProperties")), false)
  })

  test("editing works again once the game ends", async () => {
    const { scene, state } = setup("A")
    await state.refresh()
    state.setReadOnly(playing)
    state.setReadOnly(null)
    assert.equal(state.readOnly.value, false)
    await state.setActive(id("A"), false)
    assert.equal(scene.calls.some((c) => c.startsWith("setEntityProperties")), true)
  })
})
