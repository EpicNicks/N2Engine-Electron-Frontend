// The prefab override tools (protocol 1.33.0 and 1.34.0) against the fake host: n2_get_prefab_overrides lists an
// instance's changes with the targets and levels the other two take, n2_revert_prefab_overrides is one undo step, and
// n2_apply_prefab_overrides asks the person first and sends nothing when they say no.
import { test, describe, after } from "node:test"
import * as assert from "node:assert/strict"
import { installWrites } from "./write-host"
import { closeAllHarnesses, startHarness, textOf, type Harness } from "./harness"

after(closeAllHarnesses)

const LID = "11111111-0000-0000-0000-000000000002"
const NEST = "55555555-0000-0000-0000-000000000001"
const CRATE = "55555555-0000-0000-0000-000000000002"

const info = () => ({
  rootId: "11111111-0000-0000-0000-000000000001",
  prefab: NEST,
  path: "res://props/Nest.prefab",
  overrides: [{ source: "aaaaaaaa-0000-0000-0000-000000000001/bbbbbbbb-0000-0000-0000-000000000002", path: "name", value: "Open lid", objectId: LID }],
  removedObjects: [],
  removedComponents: ["aaaaaaaa-0000-0000-0000-000000000001/cccccccc-0000-0000-0000-000000000003"],
  addedComponents: [],
  addedChildren: [],
  linkPath: [
    { rootId: "11111111-0000-0000-0000-000000000001", prefab: NEST, path: "res://props/Nest.prefab" },
    { rootId: "11111111-0000-0000-0000-000000000003", prefab: CRATE, path: "res://props/Crate.prefab" },
  ],
  applyTo: {
    overrides: [
      [
        { level: 0, prefab: NEST, path: "res://props/Nest.prefab" },
        { level: 1, prefab: CRATE, path: "res://props/Crate.prefab" },
      ],
    ],
    removedObjects: [],
    removedComponents: [[{ level: 0, prefab: NEST, path: "res://props/Nest.prefab" }]],
    addedComponents: [],
    addedChildren: [],
  },
})

async function setup(answer?: NonNullable<Parameters<typeof startHarness>[0]>["answer"]): Promise<{ h: Harness; calls: string[] }> {
  const h = await startHarness({ elicit: "form", answer, host: { role: "editor" } })
  const world = installWrites(h.host, "editor")
  const calls: string[] = []
  h.host.on("GetPrefabOverrides", () => ({ info: info() }))
  h.host.on("RevertPrefabOverrides", (r) =>
    world.mutate("RevertPrefabOverrides", "Revert Nest 1", () => void calls.push(`revert ${r.entityId} ${JSON.stringify(r.targets)}`))
  )
  h.host.on("ApplyPrefabOverrides", (r) =>
    world.mutate("ApplyPrefabOverrides", "Update instance Nest 1", () =>
      void calls.push(`apply ${r.entityId} ${JSON.stringify(r.targets)} ${r.level}`)
    )
  )
  return { h, calls }
}

const data = (r: { structuredContent?: any }): any => r.structuredContent.data

describe("the prefab override tools", () => {
  test("n2_get_prefab_overrides gives each change its target, value and levels, and the link path", async () => {
    const { h } = await setup()
    const r = await h.call("n2_get_prefab_overrides", { entityId: LID })
    assert.ok(!r.isError, textOf(r))
    const d = data(r)
    assert.equal(d.overrides.length, 2)
    assert.deepEqual(d.overrides[0].target, { source: info().overrides[0].source, path: "name" })
    assert.equal(d.overrides[0].value, "Open lid")
    assert.equal(d.overrides[0].objectId, LID)
    assert.deepEqual(d.overrides[0].applyTo.map((l: { level: number }) => l.level), [0, 1])
    assert.deepEqual(d.overrides[1].target, { removedComponent: info().removedComponents[0] })
    assert.deepEqual(d.linkPath.map((l: { path: string }) => l.path), ["res://props/Nest.prefab", "res://props/Crate.prefab"])
    await h.close()
  })

  test("n2_revert_prefab_overrides sends the targets as given, as one undo step", async () => {
    const { h, calls } = await setup()
    const target = { source: info().overrides[0].source, path: "name" }
    const r = await h.call("n2_revert_prefab_overrides", { entityId: LID, targets: [target] })
    assert.ok(!r.isError, textOf(r))
    assert.deepEqual(calls, [`revert ${LID} ${JSON.stringify([target])}`])
    assert.equal(data(r).edit.stepAdded, true)
    assert.equal(h.asked.length, 0, "a revert is undoable: nobody is asked")
    await h.close()
  })

  test("n2_apply_prefab_overrides asks first, naming the prefab, and sends the level", async () => {
    const { h, calls } = await setup()
    const r = await h.call("n2_apply_prefab_overrides", { entityId: LID, targets: [{ all: true }], level: 1 })
    assert.ok(!r.isError, textOf(r))
    assert.equal(h.asked.length, 1)
    assert.match(h.asked[0], /every change of the prefab instance into "res:\/\/props\/Crate\.prefab"/)
    assert.deepEqual(calls, [`apply ${LID} [{"all":true}] 1`])
    await h.close()
  })

  test("when the person says no, nothing is applied", async () => {
    const { h, calls } = await setup({ action: "decline" })
    const r = await h.call("n2_apply_prefab_overrides", { entityId: LID, targets: [{ all: true }] })
    assert.equal(r.isError, true)
    assert.deepEqual(calls, [])
    assert.equal(h.host.count("ApplyPrefabOverrides"), 0)
    await h.close()
  })
})
