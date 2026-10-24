// Copy, cut and paste in the hierarchy state (protocol 1.18.0), against a host stand-in that keeps a flat list of objects.
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { ClipboardPayload, HierarchyNode, HierarchyResponse } from "../protocol/protocol.generated"
import { clipboardText } from "../protocol/entity-clipboard"
import { HierarchyState } from "../renderer/hierarchy-state"

interface Obj {
  id: string
  parentId: string
}

/** Objects given as [id, parentId] pairs ("" is the scene), listed parents first */
class Host {
  objects: Obj[]
  calls: string[] = []
  made = 0
  fail: string | null = null
  constructor(...specs: Array<[string, string]>) {
    this.objects = specs.map(([id, parentId]) => ({ id, parentId }))
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
        })
      ),
    }),
    createEntityEx: async () => "",
    setEntityParent: async () => {},
    setEntityProperties: async () => {},
    duplicateEntity: async () => "",
    destroyEntity: async (id: string) => {
      this.calls.push(`destroy ${id}`)
      this.objects = this.objects.filter((o) => o.id !== id && o.parentId !== id)
    },
    serializeEntities: async (ids: string[]): Promise<ClipboardPayload> => {
      this.calls.push(`serialize ${ids.join(",")}`)
      if (this.fail) throw new Error(this.fail)
      return { format: "n2engine.entities", version: 1, objectCount: ids.length, entities: ids.map((id) => ({ uuid: id })) }
    },
    instantiateEntities: async (clipboard: string, parentId: string, siblingIndex: number, keep: boolean) => {
      this.calls.push(`instantiate ${parentId}|${siblingIndex}|${keep}`)
      if (this.fail) throw new Error(this.fail)
      const roots = (JSON.parse(clipboard) as ClipboardPayload).entities as Array<{ uuid: string }>
      const ids = roots.map((r) => `${r.uuid}-copy${++this.made}`)
      for (const id of ids) this.objects.push({ id, parentId })
      return ids
    },
  }
}

const system = (initial = "") => {
  const box = { text: initial, refuse: false }
  return {
    box,
    api: {
      readText: async () => {
        if (box.refuse) throw new Error("denied")
        return box.text
      },
      writeText: async (text: string) => {
        if (box.refuse) throw new Error("denied")
        box.text = text
      },
    },
  }
}

async function setup(host: Host, clip = system()) {
  const state = new HierarchyState(host.engine as never, { confirm: async () => true, clipboard: clip.api })
  await state.refresh()
  return { state, clip }
}

const select = (state: HierarchyState, ...ids: string[]) =>
  state.setSelection({ ids: new Set(ids), anchor: ids[0] ?? null, primary: ids[ids.length - 1] ?? null })

describe("hierarchy copy, cut and paste", () => {
  test("copy asks for the topmost selected objects and puts the text on the system clipboard", async () => {
    const host = new Host(["A", ""], ["A1", "A"], ["B", ""])
    const { state, clip } = await setup(host)
    select(state, "A", "A1")
    assert.equal(await state.copySelected(), true)
    assert.deepEqual(host.calls, ["serialize A"])
    assert.match(clip.box.text, /^N2Engine entities v1\n/)
  })

  test("copy with nothing selected does nothing", async () => {
    const host = new Host(["A", ""])
    const { state } = await setup(host)
    assert.equal(await state.copySelected(), false)
    assert.deepEqual(host.calls, [])
  })

  test("paste puts the objects right after the selected one under its parent and selects them", async () => {
    const host = new Host(["A", ""], ["A1", "A"], ["A2", "A"], ["B", ""])
    const { state } = await setup(host)
    select(state, "A1")
    await state.copySelected()
    host.calls.length = 0
    assert.equal(await state.pasteCopied(), true)
    assert.deepEqual(host.calls, ["instantiate A|1|true"])
    assert.deepEqual([...state.selection.value.ids], ["A1-copy1"])
  })

  test("paste with nothing selected goes last in the scene", async () => {
    const host = new Host(["A", ""], ["B", ""])
    const { state } = await setup(host)
    select(state, "A")
    await state.copySelected()
    select(state)
    host.calls.length = 0
    await state.pasteCopied()
    assert.deepEqual(host.calls, ["instantiate |-1|true"])
  })

  test("text on the system clipboard that is not ours pastes nothing, even with an earlier copy", async () => {
    const host = new Host(["A", ""])
    const { state, clip } = await setup(host)
    select(state, "A")
    await state.copySelected()
    clip.box.text = "some other text"
    host.calls.length = 0
    assert.equal(await state.pasteCopied(), false)
    assert.deepEqual(host.calls, [])
  })

  test("a paste from another window: the system clipboard's text is what is sent", async () => {
    const host = new Host(["A", ""])
    const text = clipboardText({ format: "n2engine.entities", version: 1, objectCount: 1, entities: [{ uuid: "X" }] })
    const { state } = await setup(host, system(text))
    assert.equal(await state.pasteCopied(), true)
    assert.ok(host.objects.some((o) => o.id === "X-copy1"))
  })

  test("a system clipboard that refuses falls back to the editor's own copy", async () => {
    const host = new Host(["A", ""])
    const { state, clip } = await setup(host)
    clip.box.refuse = true
    select(state, "A")
    assert.equal(await state.copySelected(), true)
    assert.equal(await state.pasteCopied(), true)
  })

  test("cut copies first, then destroys the topmost objects; a refused copy destroys nothing", async () => {
    const host = new Host(["A", ""], ["A1", "A"], ["B", ""])
    const { state } = await setup(host)
    select(state, "A", "A1")
    host.fail = "refused"
    await assert.rejects(state.cutSelected(), /refused/)
    assert.deepEqual(host.calls, ["serialize A"])
    host.fail = null
    host.calls.length = 0
    assert.equal(await state.cutSelected(), true)
    assert.deepEqual(host.calls, ["serialize A", "destroy A"])
    assert.deepEqual(host.objects.map((o) => o.id), ["B"])
  })

  test("a failed paste is thrown", async () => {
    const host = new Host(["A", ""])
    const { state } = await setup(host)
    select(state, "A")
    await state.copySelected()
    host.fail = "payload refused"
    await assert.rejects(state.pasteCopied(), /payload refused/)
  })

  test("while a game runs copy works and cut and paste are refused", async () => {
    const host = new Host(["A", ""])
    const { state } = await setup(host)
    select(state, "A")
    state.readOnlyReason.value = "a game is running"
    assert.equal(await state.copySelected(), true)
    await assert.rejects(state.cutSelected(), /can't be changed/)
    await assert.rejects(state.pasteCopied(), /can't be changed/)
  })

  test("a host without the commands says so, and canCopyPaste is false", async () => {
    const host = new Host(["A", ""])
    const { serializeEntities, instantiateEntities, ...old } = host.engine
    void serializeEntities
    void instantiateEntities
    const state = new HierarchyState(old as never, { confirm: async () => true })
    await state.refresh()
    select(state, "A")
    assert.equal(state.canCopyPaste, false)
    await assert.rejects(state.copySelected(), /protocol 1\.18\.0/)
  })
})
