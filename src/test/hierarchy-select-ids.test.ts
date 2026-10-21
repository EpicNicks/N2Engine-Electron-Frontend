import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { HierarchyNode } from "../protocol/protocol.generated"
import { HierarchyState } from "../renderer/hierarchy-state"
import { checkArg } from "../main/engine-ipc"
import { EngineCommandArgs, EngineCommandNames, MaxEntityBoundsIds } from "../shared/api"
import { MaxInvokeSelection } from "../protocol/extensions"
import { Uuid } from "./fake-extensions"

const node = (id: string, parentId = "", index = 0): HierarchyNode => ({
  id,
  parentId,
  index,
  name: id,
  active: true,
  activeInHierarchy: true,
  layer: 0,
  tag: "",
  components: ["Transform"],
})

async function stateOf(nodes: HierarchyNode[]) {
  const primaries: Array<string | null> = []
  const state = new HierarchyState(
    {
      isConnected: () => true,
      getHierarchy: async () => ({ revision: 1, nodes }),
    } as never,
    { confirm: async () => true, onPrimaryChange: (id) => primaries.push(id) }
  )
  await state.refresh()
  return { state, primaries }
}

describe("HierarchyState.selectIds (an extension asked for a selection)", () => {
  test("selects the objects the tree has, with the last one as the primary, and opens the way to them", async () => {
    const { state, primaries } = await stateOf([node("a"), node("a1", "a"), node("a2", "a", 1), node("b", "", 1)])
    state.selectIds(["a2", "b", "a1"])
    assert.deepEqual([...state.selection.value.ids], ["a2", "b", "a1"])
    assert.equal(state.selection.value.primary, "a1")
    assert.equal(state.expanded.value.has("a"), true, "a is open so the selected children have rows")
    assert.deepEqual(primaries, ["a1"])
  })

  test("ids that are not in the scene are left out; none of them changes nothing", async () => {
    const { state, primaries } = await stateOf([node("a"), node("b", "", 1)])
    state.selectIds(["a"])
    state.selectIds(["gone", "also-gone"])
    assert.deepEqual([...state.selection.value.ids], ["a"], "the selection was kept")
    state.selectIds(["gone", "b", "b"])
    assert.deepEqual([...state.selection.value.ids], ["b"], "each id once")
    assert.deepEqual(primaries, ["a", "b"])
  })
})

describe("the forwarded extension commands", () => {
  test("are in the page's command list with their argument kinds", () => {
    for (const name of ["listEditorExtensions", "getEditorUi", "reloadEditorExtensions", "invokeMenuItem", "invokeInspectorAction"] as const) {
      assert.ok(EngineCommandNames.includes(name), name)
    }
    assert.deepEqual(EngineCommandArgs.invokeMenuItem, ["string", "stringArray", "jsonObject", "uint32"])
    assert.deepEqual(EngineCommandArgs.invokeInspectorAction, ["string", "string", "jsonObject", "uint32"])
    assert.deepEqual(EngineCommandArgs.listEditorExtensions, [])
  })

  test("the selection is at most as long as the host takes", () => {
    assert.equal(MaxEntityBoundsIds, MaxInvokeSelection)
    const ok = Array.from({ length: MaxInvokeSelection }, (_, i) => Uuid(i))
    assert.equal((checkArg("stringArray", ok, "selection") as string[]).length, MaxInvokeSelection)
    assert.throws(() => checkArg("stringArray", [...ok, Uuid(1)], "selection"), /at most 4096 strings/)
  })

  test("the main process refuses what the page may not send: a non-string item, a bad revision, params that are not plain JSON", () => {
    assert.throws(() => checkArg("stringArray", [Uuid(1), 7], "selection"), /must be an array of at most 4096 strings/)
    assert.throws(() => checkArg("uint32", -1, "uiRevision"), /unsigned 32-bit integer/)
    assert.throws(() => checkArg("uint32", 1.5, "uiRevision"), /unsigned 32-bit integer/)
    assert.throws(() => checkArg("jsonObject", [1], "params"), /a JSON object/)
    assert.throws(() => checkArg("jsonObject", { f: () => 1 }, "params"), /a JSON object/)
    assert.deepEqual(checkArg("jsonObject", { grid: 2, at: { x: 1 } }, "params"), { grid: 2, at: { x: 1 } })
  })
})
