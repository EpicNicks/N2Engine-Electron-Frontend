import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { SectionRegistry } from "../renderer/project-settings-registry"
import { fieldsLogic } from "../renderer/project-settings-logic"
import { PhysicsFields } from "../renderer/project-settings-schema"
import { fakeProjectHost, settleTasks } from "./fake-project-host"

async function started(options: Parameters<typeof fakeProjectHost>[0] = {}) {
  const h = fakeProjectHost(options)
  const stop = h.model.start()
  await settleTasks()
  return { h, stop }
}

describe("ProjectSettingsModel", () => {
  test("reads the project when started, and again after a projectChanged event", async () => {
    const { h, stop } = await started()
    assert.equal(h.model.info.value?.project.name, "Demo")
    h.project.settings = { physics: { fixedTimestep: 0.05 } }
    h.projectChangeCount.value++
    await settleTasks()
    assert.equal(h.model.textOf("physics", "physics.fixedTimestep"), "0.05")
    stop()
  })

  test("a draft survives a refresh, and a clean field follows the host", async () => {
    const { h, stop } = await started()
    h.model.setEdit("physics", "physics.fixedTimestep", "0.01")
    h.project.settings = { physics: { fixedTimestep: 0.05, backend: "jolt" } }
    h.projectChangeCount.value++
    await settleTasks()
    assert.equal(h.model.textOf("physics", "physics.fixedTimestep"), "0.01")
    assert.equal(h.model.textOf("physics", "physics.backend"), "jolt")
    stop()
  })

  test("Apply sends only the changed keys, then the host's answer replaces the form and the drafts go", async () => {
    const { h, stop } = await started()
    h.model.setEdit("physics", "physics.fixedTimestep", "0.01")
    h.model.setEdit("physics", "physics.backend", "")
    assert.ok(h.model.isDirty("physics"))
    assert.equal(await h.model.apply("physics"), true)
    assert.deepEqual(h.patches, [{ physics: { fixedTimestep: 0.01 } }])
    assert.equal(h.model.isDirty("physics"), false)
    assert.equal(h.model.textOf("physics", "physics.fixedTimestep"), "0.01")
    assert.deepEqual(h.settings(), { physics: { fixedTimestep: 0.01 }, window: { width: 800 } })
    stop()
  })

  test("an invalid draft is never sent", async () => {
    const { h, stop } = await started()
    h.model.setEdit("physics", "physics.fixedTimestep", "-1")
    assert.equal(await h.model.apply("physics"), false)
    assert.deepEqual(h.patches, [])
    assert.ok(h.model.built("physics").errors["physics.fixedTimestep"])
    stop()
  })

  test("the host's refusal is kept under the section and the edits stay; a retry can succeed", async () => {
    const { h, stop } = await started()
    h.model.setEdit("physics", "physics.gpu", "on")
    h.refuseNext("Project settings refused: physics.gpu: not supported here")
    assert.equal(await h.model.apply("physics"), false)
    assert.match(h.model.errors.value.physics, /not supported here/)
    assert.equal(h.model.textOf("physics", "physics.gpu"), "on")
    assert.ok(h.model.isDirty("physics"))
    assert.equal(await h.model.apply("physics"), true)
    assert.equal(h.model.errors.value.physics, undefined)
    stop()
  })

  test("a restart-needed field applied is noted until the connection ends", async () => {
    const { h, stop } = await started()
    h.model.setEdit("physics", "physics.gpu", "auto")
    h.model.setEdit("physics", "physics.fixedTimestep", "0.01")
    await h.model.apply("physics")
    assert.deepEqual(h.model.restartPending.value.physics, ["physics.gpu"])
    h.connected.value = false
    await settleTasks()
    assert.deepEqual(h.model.restartPending.value, {})
    stop()
  })

  test("a live field alone is no restart note", async () => {
    const { h, stop } = await started()
    h.model.setEdit("rendering", "rendering.colorSpace", "linear")
    await h.model.apply("rendering")
    assert.deepEqual(h.model.restartPending.value, {})
    stop()
  })

  test("Restore previous values loads the values from before the last Apply as edits", async () => {
    const { h, stop } = await started()
    h.model.setEdit("physics", "physics.fixedTimestep", "0.01")
    await h.model.apply("physics")
    assert.ok(h.model.hasPrevious("physics"))
    h.model.restorePrevious("physics")
    assert.equal(h.model.textOf("physics", "physics.fixedTimestep"), "0.02")
    assert.ok(h.model.isDirty("physics"))
    await h.model.apply("physics")
    assert.deepEqual(h.patches[1], { physics: { fixedTimestep: 0.02 } })
    stop()
  })

  test("Revert drops the edits and the error", async () => {
    const { h, stop } = await started()
    h.model.setEdit("physics", "physics.fixedTimestep", "0.01")
    h.refuseNext("nope")
    await h.model.apply("physics")
    h.model.revert("physics")
    assert.equal(h.model.isDirty("physics"), false)
    assert.equal(h.model.errors.value.physics, undefined)
    stop()
  })

  test("the startup scene goes through SetStartupScene, not a patch", async () => {
    const { h, stop } = await started()
    h.model.setEdit("general", "startupScene", "res://scenes/two.scene")
    await h.model.apply("general")
    assert.deepEqual(h.startups, ["res://scenes/two.scene"])
    assert.deepEqual(h.patches, [])
    assert.equal(h.model.info.value?.project.startupScene, "res://scenes/two.scene")
    // clearing it is the empty path
    h.model.setEdit("general", "startupScene", "")
    await h.model.apply("general")
    assert.deepEqual(h.startups, ["res://scenes/two.scene", ""])
    stop()
  })

  test("nothing is sent while read-only, a play session or not connected", async () => {
    const { h, stop } = await started()
    h.model.setEdit("physics", "physics.fixedTimestep", "0.01")
    h.readOnlyReason.value = "a play session is running"
    assert.match(h.model.disabledReason("physics") ?? "", /play session/)
    assert.equal(await h.model.apply("physics"), false)
    h.readOnlyReason.value = null
    h.connected.value = false
    assert.equal(await h.model.apply("physics"), false)
    assert.deepEqual(h.patches, [])
    stop()
  })

  describe("the determinism block is an admin's alone", () => {
    test("an editor can't change it: the section says why and nothing is sent, from any section", async () => {
      const { h, stop } = await started({ role: "editor" })
      assert.match(h.model.disabledReason("determinism") ?? "", /admin/)
      assert.equal(h.model.disabledReason("physics"), null)
      h.model.setEdit("determinism", "determinism.luaSeed", "7")
      assert.equal(await h.model.apply("determinism"), false)
      // Raw JSON naming it is refused before sending, too
      h.model.setEdit("raw", "json", JSON.stringify({ ...h.settings(), determinism: { luaSeed: 1 } }))
      assert.ok(h.model.built("raw").errors.json)
      assert.equal(await h.model.apply("raw"), false)
      assert.deepEqual(h.patches, [])
      stop()
    })

    test("an editor's other changes in Raw JSON are sent, without the block", async () => {
      const { h, stop } = await started({ role: "editor" })
      h.model.setEdit("raw", "json", JSON.stringify({ ...h.settings(), window: { width: 1 } }))
      assert.equal(await h.model.apply("raw"), true)
      assert.deepEqual(h.patches, [{ window: { width: 1 } }])
      stop()
    })

    test("an admin can, and the seed is noted as needing a restart", async () => {
      const { h, stop } = await started({ role: "admin" })
      assert.equal(h.model.disabledReason("determinism"), null)
      h.model.setEdit("determinism", "determinism.luaSeed", "7")
      assert.equal(await h.model.apply("determinism"), true)
      assert.deepEqual(h.patches, [{ determinism: { luaSeed: 7 } }])
      assert.deepEqual(h.model.restartPending.value.determinism, ["determinism.luaSeed"])
      stop()
    })

    test("a host without roles counts as admin", async () => {
      const { h, stop } = await started({ role: "admin" })
      assert.equal(h.model.isAdmin.value, true)
      stop()
    })

    test("a viewer sees every section read-only", async () => {
      const { h, stop } = await started({ role: "viewer" })
      assert.match(h.model.disabledReason("determinism") ?? "", /admin/)
      h.readOnlyReason.value = "you are signed in as a viewer"
      assert.match(h.model.disabledReason("physics") ?? "", /viewer/)
      stop()
    })

    test("a forbidden answer to it disables the section, keeps the edits and shows the host's message", async () => {
      // The role said admin (a stale ServerInfo), the host says otherwise
      const { h, stop } = await started({ role: "admin" })
      h.model.setEdit("determinism", "determinism.luaSeed", "7")
      h.refuseNext("forbidden: role editor is not allowed to change the project's 'determinism' settings", "forbidden")
      assert.equal(await h.model.apply("determinism"), false)
      assert.match(h.model.errors.value.determinism, /forbidden/)
      assert.equal(h.model.determinismDenied.value, true)
      assert.match(h.model.disabledReason("determinism") ?? "", /refused/)
      assert.equal(h.model.textOf("determinism", "determinism.luaSeed"), "7")
      // the other sections are untouched
      assert.equal(h.model.disabledReason("physics"), null)
      stop()
    })
  })

  describe("Raw JSON", () => {
    test("asks before it writes, and a no sends nothing", async () => {
      const { h, stop } = await started()
      h.model.setEdit("raw", "json", JSON.stringify({ ...h.settings(), extra: { a: 1 } }))
      h.answerConfirm(false)
      assert.equal(await h.model.apply("raw"), false)
      assert.equal(h.confirms.length, 1)
      assert.deepEqual(h.patches, [])
      h.answerConfirm(true)
      assert.equal(await h.model.apply("raw"), true)
      assert.deepEqual(h.patches, [{ extra: { a: 1 } }])
      stop()
    })

    test("the other sections do not ask", async () => {
      const { h, stop } = await started()
      h.model.setEdit("physics", "physics.fixedTimestep", "0.01")
      await h.model.apply("physics")
      assert.equal(h.confirms.length, 0)
      stop()
    })
  })

  test("another project's drafts are dropped", async () => {
    const { h, stop } = await started()
    h.model.setEdit("physics", "physics.fixedTimestep", "0.01")
    h.project.projectId = "22222222-2222-2222-2222-222222222222"
    h.projectChangeCount.value++
    await settleTasks()
    assert.equal(h.model.isDirty("physics"), false)
    stop()
  })

  test("a section registered later works through the same guards, with no change to the model", async () => {
    const registry = new SectionRegistry<unknown>()
    registry.register({
      id: "network",
      title: "Network",
      order: 70,
      component: null,
      logic: fieldsLogic(PhysicsFields.filter((f) => f.id === "physics.backend")),
    })
    assert.throws(() => registry.register({ id: "network", title: "Again", order: 1, component: null }), /already registered/)
    const h = fakeProjectHost({ registry })
    const stop = h.model.start()
    await settleTasks()
    h.model.setEdit("network", "physics.backend", "jolt")
    assert.equal(await h.model.apply("network"), true)
    assert.deepEqual(h.patches, [{ physics: { backend: "jolt" } }])
    stop()
  })

  test("the registry lists in order", () => {
    const registry = new SectionRegistry<unknown>()
    registry.register({ id: "b", title: "B", order: 20, component: null })
    registry.register({ id: "a", title: "A", order: 10, component: null })
    registry.register({ id: "c", title: "C", order: 20, component: null })
    assert.deepEqual(
      registry.list().map((d) => d.id),
      ["a", "b", "c"]
    )
  })
})
