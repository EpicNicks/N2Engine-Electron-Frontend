// Prefab actions in the hierarchy state (protocol 1.19.0), against a host stand-in with a flat list of objects.
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { signal } from "@preact/signals-core"
import type { HierarchyNode, HierarchyResponse, Vec3 } from "../protocol/protocol.generated"
import { HierarchyState, PrefabOptions } from "../renderer/hierarchy-state"

const P1 = "11111111-1111-1111-1111-111111111111"
const P2 = "22222222-2222-2222-2222-222222222222"

interface Obj {
  id: string
  parentId: string
  prefab?: string
}

class Host {
  objects: Obj[]
  calls: string[] = []
  made = 0
  fail: string | null = null
  /** The prefab files on the host's disk */
  files: string[] = []
  constructor(...specs: Array<[string, string, string?]>) {
    this.objects = specs.map(([id, parentId, prefab]) => ({ id, parentId, prefab }))
  }
  engine = {
    isConnected: () => true,
    getHierarchy: async (): Promise<HierarchyResponse> => ({
      revision: 1,
      nodes: this.objects.map(
        (o, index): HierarchyNode => ({
          id: o.id,
          parentId: o.parentId,
          index,
          name: o.id,
          active: true,
          activeInHierarchy: true,
          layer: 0,
          tag: "",
          components: [],
          ...(o.prefab ? { prefab: o.prefab } : {}),
        })
      ),
    }),
    createEntityEx: async () => "",
    setEntityParent: async () => {},
    setEntityProperties: async () => {},
    duplicateEntity: async () => "",
    destroyEntity: async () => {},
    createPrefab: async (id: string, path: string, overwrite: boolean) => {
      this.calls.push(`createPrefab ${id}|${path}|${overwrite}`)
      if (this.fail) throw new Error(this.fail)
      // The host checks the disk, not the editor's listing (EditorServer.cpp: "<path> already exists")
      if (!overwrite && this.files.includes(path)) throw new Error(`${path} already exists`)
      const object = this.objects.find((o) => o.id === id)
      if (object) object.prefab = P1
      return { path, uuid: P1 }
    },
    instantiatePrefab: async (uuid: string, parentId: string, index: number, hasPosition: boolean, position: Vec3) => {
      this.calls.push(`instantiatePrefab ${uuid}|${parentId}|${index}|${hasPosition}|${position.x},${position.y},${position.z}`)
      if (this.fail) throw new Error(this.fail)
      const id = `inst${++this.made}`
      this.objects.push({ id, parentId, prefab: uuid })
      return id
    },
    applyPrefab: async (id: string) => {
      this.calls.push(`applyPrefab ${id}`)
      if (this.fail) throw new Error(this.fail)
    },
    unpackPrefab: async (id: string) => {
      this.calls.push(`unpackPrefab ${id}`)
      if (this.fail) throw new Error(this.fail)
      const object = this.objects.find((o) => o.id === id)
      if (object) delete object.prefab
    },
  }
}

function setup(
  host: Host,
  options: { enabled?: boolean; existing?: string[]; agree?: boolean; onDisk?: string[]; refreshable?: boolean } = {}
) {
  const enabled = signal(options.enabled ?? true)
  const events: string[] = []
  const asked: string[] = []
  const labels: string[] = []
  // What the listing has (existing), and what a fresh read of it would find (onDisk: files made since it was read)
  let listed = [...(options.existing ?? [])]
  const prefabs: PrefabOptions = {
    enabled,
    pathOf: (uuid) => (uuid === P1 ? "res://prefabs/One.prefab" : null),
    exists: (path) => listed.includes(path),
    changed: () => void events.push("changed"),
    ...(options.refreshable === false
      ? {}
      : {
          refreshListing: async () => {
            events.push("listed")
            listed = [...listed, ...(options.onDisk ?? [])]
          },
        }),
  }
  const groups = {
    within: async <T>(label: string, work: () => Promise<T>): Promise<T> => {
      labels.push(label)
      return work()
    },
  }
  const state = new HierarchyState(host.engine as never, {
    confirm: async (message) => {
      asked.push(message)
      return options.agree ?? true
    },
    prefabs,
    groups,
  })
  return { state, enabled, events, asked, labels }
}

const select = (state: HierarchyState, ...ids: string[]) =>
  state.setSelection({ ids: new Set(ids), anchor: ids[0] ?? null, primary: ids[ids.length - 1] ?? null })

describe("instantiating prefabs", () => {
  test("a drop names the parent and the place; the new root is selected and its parent opened", async () => {
    const host = new Host(["A", ""], ["B", ""])
    const t = setup(host)
    await t.state.refresh()
    assert.equal(await t.state.instantiatePrefabs([P1], { parentId: "A", index: -1 }), true)
    assert.deepEqual(host.calls, [`instantiatePrefab ${P1}|A|-1|false|0,0,0`])
    assert.deepEqual([...t.state.selection.value.ids], ["inst1"])
    assert.ok(t.state.expanded.value.has("A"))
    assert.equal(t.state.prefabOf("inst1"), P1)
    assert.deepEqual(t.labels, []) // one prefab is one undo step already
  })

  test("several prefabs go one after another and are one edit group", async () => {
    const host = new Host(["A", ""], ["B", ""])
    const t = setup(host)
    await t.state.refresh()
    await t.state.instantiatePrefabs([P1, P2, P1], { parentId: "", index: 1 })
    assert.deepEqual(host.calls.map((c) => c.split("|").slice(0, 3).join("|")), [
      `instantiatePrefab ${P1}||1`,
      `instantiatePrefab ${P2}||2`,
      `instantiatePrefab ${P1}||3`,
    ])
    assert.deepEqual(t.labels, ["Instantiate 3 objects"])
    assert.equal(t.state.selection.value.ids.size, 3)
  })

  test("last place stays last for every prefab", async () => {
    const host = new Host(["A", ""])
    const t = setup(host)
    await t.state.refresh()
    await t.state.instantiatePrefabs([P1, P2], { parentId: "", index: -1 })
    assert.deepEqual(host.calls.map((c) => c.split("|")[2]), ["-1", "-1"])
  })

  test("a position (a drop on the viewport) is sent as a world position", async () => {
    const host = new Host(["A", ""])
    const t = setup(host)
    await t.state.refresh()
    await t.state.instantiatePrefabs([P1], { parentId: "", index: -1 }, { x: 1, y: 2, z: 3 })
    assert.deepEqual(host.calls, [`instantiatePrefab ${P1}||-1|true|1,2,3`])
  })

  test("nothing is made while read-only, without the capability, for an unknown parent or no prefab", async () => {
    const host = new Host(["A", ""])
    const t = setup(host)
    await t.state.refresh()
    t.state.setReadOnly("a game is running")
    await assert.rejects(t.state.instantiatePrefabs([P1], { parentId: "", index: -1 }), /can't be changed while a game is running/)
    t.state.setReadOnly(null)
    assert.equal(await t.state.instantiatePrefabs([P1], { parentId: "gone", index: -1 }), false)
    assert.equal(await t.state.instantiatePrefabs([], { parentId: "", index: -1 }), false)
    t.enabled.value = false
    assert.equal(t.state.canPrefabs, false)
    await assert.rejects(t.state.instantiatePrefabs([P1], { parentId: "", index: -1 }), /needs protocol 1.19.0/)
    assert.deepEqual(host.calls, [])
  })

  test("a search blocks a drop on a place but not the end of the scene", async () => {
    const host = new Host(["A", ""], ["B", ""])
    const t = setup(host)
    await t.state.refresh()
    t.state.setQuery("A")
    assert.equal(await t.state.instantiatePrefabs([P1], { parentId: "A", index: -1 }), false)
    assert.equal(await t.state.instantiatePrefabs([P1], { parentId: "", index: -1 }), true)
    assert.equal(host.calls.length, 1)
  })

  test("a refusal is thrown; the objects made before it are kept and the hierarchy is read again", async () => {
    const host = new Host(["A", ""])
    const t = setup(host)
    await t.state.refresh()
    const original = host.engine.instantiatePrefab
    host.engine.instantiatePrefab = async (...args) => {
      if (host.made === 1) throw new Error("The prefab file is damaged")
      return original(...args)
    }
    await assert.rejects(t.state.instantiatePrefabs([P1, P2], { parentId: "", index: -1 }), /damaged/)
    assert.ok(t.state.tree.value.nodes.has("inst1"))
    assert.deepEqual([...t.state.selection.value.ids], ["inst1"])
  })
})

describe("create prefab", () => {
  test("writes the file without overwrite when nothing is there, then reads the hierarchy and the assets again", async () => {
    const host = new Host(["A", ""])
    const t = setup(host)
    await t.state.refresh()
    const made = await t.state.createPrefab("A", "prefabs/A")
    assert.deepEqual(made, { path: "res://prefabs/A.prefab", uuid: P1 })
    assert.deepEqual(host.calls, ["createPrefab A|res://prefabs/A.prefab|false"])
    assert.deepEqual(t.asked, [])
    // The listing is read again before deciding, and after the file is made
    assert.deepEqual(t.events, ["listed", "changed"])
    assert.equal(t.state.prefabOf("A"), P1) // the object is linked now
  })

  test("a file made since the listing was read is found by reading it again, and replaced only after the user agrees", async () => {
    const host = new Host(["A", ""])
    host.files = ["res://prefabs/A.prefab"]
    const t = setup(host, { existing: [], onDisk: ["res://prefabs/A.prefab"] })
    await t.state.refresh()
    const made = await t.state.createPrefab("A", "res://prefabs/A.prefab")
    assert.deepEqual(made, { path: "res://prefabs/A.prefab", uuid: P1 })
    assert.equal(t.asked.length, 1)
    assert.match(t.asked[0], /Replace res:\/\/prefabs\/A.prefab/)
    assert.deepEqual(host.calls, ["createPrefab A|res://prefabs/A.prefab|true"])

    const hostNo = new Host(["A", ""])
    hostNo.files = ["res://prefabs/A.prefab"]
    const no = setup(hostNo, { existing: [], onDisk: ["res://prefabs/A.prefab"], agree: false })
    await no.state.refresh()
    assert.equal(await no.state.createPrefab("A", "res://prefabs/A.prefab"), null)
    assert.deepEqual(hostNo.calls, [])
  })

  test("when the listing still lacks the file, the host's refusal asks the user, and a yes sends it again as a replace", async () => {
    const host = new Host(["A", ""])
    host.files = ["res://prefabs/A.prefab"]
    const t = setup(host, { refreshable: false })
    await t.state.refresh()
    const made = await t.state.createPrefab("A", "res://prefabs/A.prefab")
    assert.deepEqual(made, { path: "res://prefabs/A.prefab", uuid: P1 })
    assert.equal(t.asked.length, 1)
    assert.match(t.asked[0], /Replace res:\/\/prefabs\/A.prefab/)
    assert.deepEqual(host.calls, ["createPrefab A|res://prefabs/A.prefab|false", "createPrefab A|res://prefabs/A.prefab|true"])
    assert.deepEqual(t.events, ["changed"])

    const hostNo = new Host(["A", ""])
    hostNo.files = ["res://prefabs/A.prefab"]
    const no = setup(hostNo, { refreshable: false, agree: false })
    await no.state.refresh()
    assert.equal(await no.state.createPrefab("A", "res://prefabs/A.prefab"), null)
    assert.deepEqual(hostNo.calls, ["createPrefab A|res://prefabs/A.prefab|false"])
    assert.equal(no.state.prefabOf("A"), null)
  })

  test("a refusal of a replace the user agreed to is not asked about again", async () => {
    const host = new Host(["A", ""])
    host.fail = "res://prefabs/A.prefab already exists"
    const t = setup(host, { existing: ["res://prefabs/A.prefab"] })
    await t.state.refresh()
    await assert.rejects(t.state.createPrefab("A", "res://prefabs/A.prefab"), /already exists/)
    assert.equal(t.asked.length, 1)
    assert.deepEqual(host.calls, ["createPrefab A|res://prefabs/A.prefab|true"])
  })

  test("a file already listed is replaced only after the user agrees", async () => {
    const host = new Host(["A", ""])
    const yes = setup(host, { existing: ["res://prefabs/A.prefab"] })
    await yes.state.refresh()
    await yes.state.createPrefab("A", "res://prefabs/A.prefab")
    assert.match(yes.asked[0], /Replace res:\/\/prefabs\/A.prefab/)
    assert.deepEqual(host.calls, ["createPrefab A|res://prefabs/A.prefab|true"])

    const hostNo = new Host(["A", ""])
    const no = setup(hostNo, { existing: ["res://prefabs/A.prefab"], agree: false })
    await no.state.refresh()
    assert.equal(await no.state.createPrefab("A", "res://prefabs/A.prefab"), null)
    assert.deepEqual(hostNo.calls, [])
  })

  test("a bad path is refused before anything is sent; read-only and a play host's refusal are errors", async () => {
    const host = new Host(["A", ""])
    const t = setup(host)
    await t.state.refresh()
    await assert.rejects(t.state.createPrefab("A", "res://a/../b"), /\.\./)
    t.state.setReadOnly("a game is running")
    await assert.rejects(t.state.createPrefab("A", "res://a.prefab"), /can't be changed while a game is running/)
    t.state.setReadOnly(null)
    host.fail = "CreatePrefab is not allowed in a play session"
    await assert.rejects(t.state.createPrefab("A", "res://a.prefab"), /not allowed in a play session/)
    assert.deepEqual(host.calls, ["createPrefab A|res://a.prefab|false"])
    assert.deepEqual(t.asked, [])
  })
})

describe("apply and unpack", () => {
  test("apply asks first, naming the file, and says instances are not updated", async () => {
    const host = new Host(["A", "", P1])
    const t = setup(host)
    await t.state.refresh()
    assert.equal(await t.state.applyPrefab("A"), true)
    assert.match(t.asked[0], /Overwrite res:\/\/prefabs\/One.prefab with 'A'/)
    assert.match(t.asked[0], /not updated/)
    assert.deepEqual(host.calls, ["applyPrefab A"])
    assert.deepEqual(t.events, ["changed"])
  })

  test("apply does nothing when the user says no or the object is not linked", async () => {
    const host = new Host(["A", "", P1], ["B", ""])
    const no = setup(host, { agree: false })
    await no.state.refresh()
    assert.equal(await no.state.applyPrefab("A"), false)
    assert.equal(await no.state.applyPrefab("B"), false)
    assert.deepEqual(host.calls, [])
  })

  test("apply is refused while read-only (the play host refuses it too)", async () => {
    const host = new Host(["A", "", P1])
    const t = setup(host)
    await t.state.refresh()
    t.state.setReadOnly("a game is running")
    await assert.rejects(t.state.applyPrefab("A"), /a game is running/)
    assert.deepEqual(host.calls, [])
  })

  test("unpack clears the link and reads the hierarchy again; an unlinked object sends nothing", async () => {
    const host = new Host(["A", "", P2], ["B", ""])
    const t = setup(host)
    await t.state.refresh()
    assert.equal(await t.state.unpackPrefab("A"), true)
    assert.equal(t.state.prefabOf("A"), null)
    assert.equal(await t.state.unpackPrefab("B"), false)
    assert.deepEqual(host.calls, ["unpackPrefab A"])
  })

  test("a refusal of apply is thrown to the caller", async () => {
    const host = new Host(["A", "", P1])
    const t = setup(host)
    await t.state.refresh()
    host.fail = "The prefab file is gone"
    await assert.rejects(t.state.applyPrefab("A"), /gone/)
    select(t.state, "A")
  })
})
