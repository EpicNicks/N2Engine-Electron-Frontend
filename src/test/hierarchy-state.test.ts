import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { HierarchyNode, HierarchyResponse } from "../protocol/protocol.generated"
import type { JsonObject } from "../shared/api"
import { HierarchyState, CreatePresets } from "../renderer/hierarchy-state"

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

  test("no scene (an error answer) or a dropped connection leaves it empty", async () => {
    const { scene, state } = setup("A")
    await state.refresh()
    assert.equal(state.tree.value.order.length, 1)
    scene.connected = false
    await state.refresh()
    assert.equal(state.response.value, null)
    assert.equal(state.tree.value.order.length, 0)
    scene.connected = true
    scene.engine.getHierarchy = async () => {
      throw new Error("No scene loaded")
    }
    await state.refresh()
    assert.equal(state.response.value, null)
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
