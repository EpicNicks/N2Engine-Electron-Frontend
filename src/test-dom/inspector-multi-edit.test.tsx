// FE11: the inspector with several objects selected, over a fake host that keeps an undo history with edit groups
// (an edit group is ONE step), so "one undo step" is checked the way the host counts it.
import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { screen, waitFor, within } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { signal } from "@preact/signals-core"
import type { ComponentSchema, EntityDetails, LocalTransform, Quat, Vec3 } from "../protocol/protocol.generated"
import type { JsonObject } from "../shared/api"
import { EditGroups } from "../renderer/edit-groups"
import { InspectorState } from "../renderer/inspector-state"
import { InspectorPanel } from "../renderer/inspector-panel"
import { MixedMark } from "../renderer/inspector-editors"
import type { Selection } from "../renderer/hierarchy-tree"
import { renderWithApp } from "./helpers"

const types: ComponentSchema[] = [
  {
    typeName: "Light",
    singleton: false,
    fields: [
      { name: "intensity", displayName: "Intensity", kind: "Float", typeName: "float", hidden: false, readOnly: false },
    ],
  },
  { typeName: "Rigidbody", singleton: false, fields: [] },
  { typeName: "AudioListener", singleton: true, fields: [] },
]

interface Component {
  type: string
  uuid: string
  values: JsonObject
}

interface FakeObject {
  name: string
  active: boolean
  tag: string
  layer: number
  transform: LocalTransform
  components: Component[]
}

const identity: Quat = { x: 0, y: 0, z: 0, w: 1 }

const light = (id: string, intensity: number): Component => ({
  type: "Light",
  uuid: `${id}-light`,
  values: { isActive: true, intensity },
})

function object(id: string, intensity: number, extra: Component[] = []): FakeObject {
  return {
    name: id.toUpperCase(),
    active: true,
    tag: "",
    layer: 0,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: identity, scale: { x: 1, y: 1, z: 1 } },
    components: [light(id, intensity), ...extra],
  }
}

/** A fake host with an undo history: every change is a step, except inside an edit group, which is one step */
function host(initial: Record<string, FakeObject>) {
  const objects = new Map(Object.entries(structuredClone(initial)))
  const calls: Array<[string, unknown[]]> = []
  const refuse = new Map<string, string>()
  const steps: Array<Array<() => void>> = []
  let open: Array<() => void> | null = null
  /** A promise a command waits for before it is answered (a slow host), by entity id */
  const holds = new Map<string, Promise<void>>()
  const record = (revert: () => void) => {
    if (open) open.push(revert)
    else steps.push([revert])
  }
  const find = (id: string) => {
    const found = objects.get(id)
    if (!found) throw new Error(`Entity not found: ${id}`)
    return found
  }
  const gate = async (id: string) => {
    await holds.get(id)
    const refusal = refuse.get(id)
    if (refusal) throw new Error(refusal)
  }
  const detailsOf = (id: string): EntityDetails => {
    const o = find(id)
    return {
      header: { id, parentId: "", index: 0, name: o.name, active: o.active, activeInHierarchy: o.active, layer: o.layer, tag: o.tag },
      transform: structuredClone(o.transform),
      components: structuredClone(o.components),
    }
  }
  const engine = {
    isConnected: () => true,
    getEntity: async (id: string) => ({ entity: detailsOf(id), worldMatrix: [] }),
    getComponentTypes: async () => types,
    getLuaFields: async (): Promise<ComponentSchema> => ({ typeName: "LuaComponent", singleton: false, fields: [] }),
    setEntityProperties: async (id: string, properties: JsonObject) => {
      calls.push(["setEntityProperties", [id, properties]])
      await gate(id)
      const o = find(id)
      const before = { active: o.active, tag: o.tag, layer: o.layer }
      Object.assign(o, properties)
      record(() => Object.assign(o, before))
    },
    setComponentFields: async (id: string, componentId: string, values: JsonObject) => {
      calls.push(["setComponentFields", [id, componentId, values]])
      await gate(id)
      const component = find(id).components.find((c) => c.uuid === componentId)!
      const before = structuredClone(component.values)
      Object.assign(component.values, values)
      record(() => (component.values = before))
      return component.values
    },
    setLocalTransform: async (id: string, position: Vec3, rotation: Quat, scale: Vec3) => {
      calls.push(["setLocalTransform", [id, position, rotation, scale]])
      await gate(id)
      const o = find(id)
      const before = o.transform
      o.transform = { position, rotation, scale }
      record(() => (o.transform = before))
    },
    addComponent: async (id: string, typeName: string) => {
      calls.push(["addComponent", [id, typeName]])
      await gate(id)
      const o = find(id)
      const component = { type: typeName, uuid: `${id}-${typeName}`, values: { isActive: true } }
      o.components = [...o.components, component]
      record(() => (o.components = o.components.filter((c) => c !== component)))
      return { componentId: component.uuid, values: component.values }
    },
    removeComponent: async (id: string, componentId: string) => {
      calls.push(["removeComponent", [id, componentId]])
      await gate(id)
      const o = find(id)
      const before = o.components
      o.components = o.components.filter((c) => c.uuid !== componentId)
      record(() => (o.components = before))
    },
    beginEditGroup: async (label: string) => {
      calls.push(["beginEditGroup", [label]])
      open = []
    },
    endEditGroup: async () => {
      calls.push(["endEditGroup", []])
      if (open && open.length > 0) steps.push(open)
      open = null
    },
  }
  const sent = (name: string) => calls.filter(([n]) => n === name)
  /** The host's Undo: the newest step, reverted */
  const undo = () => {
    const step = steps.pop()
    for (const revert of [...(step ?? [])].reverse()) revert()
  }
  return { engine, objects, calls, sent, refuse, holds, steps, undo, isGroupOpen: () => open !== null }
}

async function render(initial: Record<string, FakeObject>, ids: string[], readOnly: string | null = null) {
  const fake = host(initial)
  const groups = new EditGroups(fake.engine)
  const asked: string[] = []
  const inspector = new InspectorState(
    fake.engine,
    { listAssets: async () => [] },
    {
      confirm: async (message: string) => {
        asked.push(message)
        return true
      },
      groups,
    }
  )
  await inspector.loadTypes()
  await inspector.select(ids[0])
  await inspector.multi.select(ids)
  if (readOnly) inspector.setReadOnly(readOnly)
  const selection = signal<Selection>({ ids: new Set(ids), anchor: ids[0], primary: ids[0] })
  const selectedId = signal<string | null>(ids[0])
  const reported: string[] = []
  const view = renderWithApp(<InspectorPanel />, {
    store: { connected: signal(true), reportError: (what: string, e: unknown) => void reported.push(`${what}: ${e}`) } as never,
    scene: { selectedId },
    hierarchy: { selection, deleteSelected: async () => {} } as never,
    inspector,
  })
  /** What the hierarchy does when the selection changes (scene-follow.ts): the multi inspector follows */
  const reselect = (next: string[]) => {
    selection.value = { ids: new Set(next), anchor: next[0], primary: next[0] }
    selectedId.value = next[0]
    return inspector.multi.select(next)
  }
  return { ...fake, groups, inspector, asked, reported, view, reselect, user: userEvent.setup() }
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement

async function typeInto(user: ReturnType<typeof userEvent.setup>, label: string, text: string) {
  const box = input(label)
  await user.clear(box)
  await user.type(box, `${text}{Enter}`)
}

const three = () => ({ e1: object("e1", 1), e2: object("e2", 2), e3: object("e3", 1) })

describe("FE11 multi-edit: mixed display", () => {
  test("a shared component's field shows a dash where the objects differ, and a value where they agree", async () => {
    await render({ e1: object("e1", 3), e2: object("e2", 3), e3: object("e3", 5) }, ["e1", "e2"])
    assert.ok(screen.getByText("2 objects"))
    assert.equal(input("Intensity").value, "3")
    assert.notEqual(input("Intensity").placeholder, MixedMark)
  })

  test("three objects with one that differs: the dash", async () => {
    await render(three(), ["e1", "e2", "e3"])
    assert.ok(screen.getByText("3 objects"))
    assert.equal(input("Intensity").value, "")
    assert.equal(input("Intensity").placeholder, MixedMark)
  })

  test("a component type only some of the objects have is not shown", async () => {
    await render({ e1: object("e1", 1, [{ type: "Rigidbody", uuid: "rb", values: {} }]), e2: object("e2", 1) }, [
      "e1",
      "e2",
    ])
    assert.ok(screen.getByLabelText("Remove Light"))
    assert.equal(screen.queryByLabelText("Remove Rigidbody"), null)
  })
})

describe("FE11 multi-edit: one undo step", () => {
  test("an edit of three objects is ONE host step named 'Edit 3 objects'; one Undo puts all three back", async () => {
    const t = await render(three(), ["e1", "e2", "e3"])
    await typeInto(t.user, "Intensity", "7")
    await waitFor(() => assert.equal(t.sent("endEditGroup").length, 1))
    assert.deepEqual(t.sent("beginEditGroup")[0][1], ["Edit 3 objects"])
    assert.equal(t.sent("setComponentFields").length, 3)
    assert.equal(t.steps.length, 1)
    assert.equal(t.isGroupOpen(), false)
    await waitFor(() => assert.equal(input("Intensity").value, "7"))
    // One Undo: every object is back, and the dash with it
    t.undo()
    assert.equal(t.steps.length, 0)
    await t.inspector.multi.refresh()
    await waitFor(() => assert.equal(input("Intensity").placeholder, MixedMark))
    assert.deepEqual(
      [...t.objects.values()].map((o) => o.components[0].values.intensity),
      [1, 2, 1]
    )
  })

  test("a header edit (tag) is one step too", async () => {
    const t = await render(three(), ["e1", "e2", "e3"])
    const tag = input("Tag")
    await t.user.clear(tag)
    // A text box commits when it is left
    await t.user.type(tag, "Enemy")
    await t.user.tab()
    await waitFor(() => assert.equal(t.sent("endEditGroup").length, 1))
    assert.equal(t.sent("setEntityProperties").length, 3)
    assert.equal(t.steps.length, 1)
  })
})

describe("FE11 multi-edit: partial failure", () => {
  test("a refusal stops the edit: the rest are not sent, the group ends, the panel says what happened", async () => {
    const t = await render(three(), ["e1", "e2", "e3"])
    t.refuse.set("e2", "E2 is locked")
    await typeInto(t.user, "Intensity", "9")
    await waitFor(() => assert.match(document.body.textContent ?? "", /1 of 3 changes applied/))
    assert.match(document.body.textContent ?? "", /1 not sent/)
    assert.match(document.body.textContent ?? "", /E2: Error: E2 is locked|E2: E2 is locked/)
    // e3 never got it; e1 did, as one step that Undo takes back
    assert.deepEqual(
      t.sent("setComponentFields").map(([, a]) => a[0]),
      ["e1", "e2"]
    )
    assert.equal(t.sent("endEditGroup").length, 1)
    assert.equal(t.isGroupOpen(), false)
    assert.equal(t.groups.depth, 0)
    assert.equal(t.steps.length, 1)
    // What is shown is what the host has: e1 took 9, the others didn't, so a dash
    await waitFor(() => assert.equal(input("Intensity").placeholder, MixedMark))
  })
})

describe("FE11 multi-edit: the selection changes while an edit is on its way", () => {
  test("the edit finishes on the objects it was made on, its group ends, and the new selection is shown clean", async () => {
    const t = await render({ ...three(), e4: object("e4", 4) }, ["e1", "e2"])
    let release!: () => void
    t.holds.set("e1", new Promise<void>((resolve) => (release = resolve)))
    t.refuse.set("e2", "E2 is locked")
    await typeInto(t.user, "Intensity", "6")
    await waitFor(() => assert.equal(t.sent("setComponentFields").length, 1))
    // The user selects other objects while the host is still answering
    const moved = t.reselect(["e3", "e4"])
    release()
    await moved
    await waitFor(() => assert.equal(t.sent("endEditGroup").length, 1))
    await t.inspector.multi.settled
    // Sent to the objects the edit was made on, and stopped at the refusal; never to the new ones
    assert.deepEqual(
      t.sent("setComponentFields").map(([, a]) => a[0]),
      ["e1", "e2"]
    )
    assert.equal(t.isGroupOpen(), false)
    assert.equal(t.groups.depth, 0)
    // The new selection: its own values, and no word about the old edit's failure
    await waitFor(() => assert.equal(input("Intensity").placeholder, MixedMark))
    assert.doesNotMatch(document.body.textContent ?? "", /changes applied/)
    assert.deepEqual(t.inspector.multi.ids.value, ["e3", "e4"])
  })
})

describe("FE11 multi-edit: Add Component and Remove for all", () => {
  test("Add Component adds the type to every selected object as one step", async () => {
    const t = await render(three(), ["e1", "e2", "e3"])
    await t.user.click(screen.getByText("Add Component"))
    await t.user.click(within(screen.getByRole("listbox")).getByText("Rigidbody"))
    await waitFor(() => assert.equal(t.sent("endEditGroup").length, 1))
    assert.deepEqual(
      t.sent("addComponent").map(([, a]) => a),
      [
        ["e1", "Rigidbody"],
        ["e2", "Rigidbody"],
        ["e3", "Rigidbody"],
      ]
    )
    assert.equal(t.steps.length, 1)
    // Read back: now shared, so it has a card
    await waitFor(() => assert.ok(screen.getByLabelText("Remove Rigidbody")))
  })

  test("a singleton type one of them has is listed but can't be picked", async () => {
    await render(
      { e1: object("e1", 1, [{ type: "AudioListener", uuid: "al", values: {} }]), e2: object("e2", 1) },
      ["e1", "e2"]
    )
    const user = userEvent.setup()
    await user.click(screen.getByText("Add Component"))
    const option = within(screen.getByRole("listbox")).getByText("Audio Listener").closest("[role=option]")!
    assert.equal(option.getAttribute("aria-disabled"), "true")
  })

  test("Remove asks once, then removes the component from every object as one step", async () => {
    const t = await render(three(), ["e1", "e2", "e3"])
    await t.user.click(screen.getByLabelText("Remove Light"))
    await waitFor(() => assert.equal(t.sent("endEditGroup").length, 1))
    assert.deepEqual(t.asked, ["Remove Light from 3 objects?"])
    assert.equal(t.sent("removeComponent").length, 3)
    assert.equal(t.steps.length, 1)
    await waitFor(() => assert.equal(screen.queryByLabelText("Remove Light"), null))
    // One Undo brings all three back
    t.undo()
    await t.inspector.multi.refresh()
    await waitFor(() => assert.ok(screen.getByLabelText("Remove Light")))
  })
})

describe("FE11 multi-edit: read-only and roles", () => {
  test("read-only (a viewer, a play session): Add Component and Remove are disabled and nothing is sent", async () => {
    const t = await render(three(), ["e1", "e2", "e3"], "you are a viewer")
    assert.equal((screen.getByText("Add Component") as HTMLButtonElement).disabled, true)
    assert.equal((screen.getByLabelText("Remove Light") as HTMLButtonElement).disabled, true)
    assert.equal(input("Intensity").disabled, true)
    assert.equal(input("Tag").disabled, true)
    await t.user.click(screen.getByLabelText("Remove Light"))
    assert.deepEqual(t.calls, [])
  })
})
