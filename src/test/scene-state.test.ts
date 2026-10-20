import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { SceneState } from "../renderer/scene-state"

describe("SceneState", () => {
  test("selecting sets the selected object, and reset clears it", async () => {
    const scene = new SceneState()
    assert.equal(scene.selectedId.value, null)
    await scene.select("e1")
    assert.equal(scene.selectedId.value, "e1")
    await scene.select(null)
    assert.equal(scene.selectedId.value, null)
    await scene.select("e2")
    scene.reset()
    assert.equal(scene.selectedId.value, null)
    await scene.select("e3")
    scene.resetProject()
    assert.equal(scene.selectedId.value, null)
  })
})
