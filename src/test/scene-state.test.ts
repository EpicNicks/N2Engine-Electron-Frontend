import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { SceneState, Transform } from "../renderer/scene-state"

const at = (x: number): Transform => ({
  position: { x, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
})

function setup() {
  const calls: string[] = []
  const files = new Map<string, string>()
  const engine = {
    getEntityTransform: async (_id: string) => at(1),
    setEntityTransform: async (..._args: unknown[]) => {
      calls.push("setEntityTransform")
      if (engine.failSet) throw new Error("No entity with id e1")
    },
    createScript: async (name: string) => `-- ${name}`,
    rescanAssets: async () => {
      calls.push("rescanAssets")
      if (engine.failRescan) throw new Error("Rescan failed")
    },
    failSet: false,
    failRescan: false,
  }
  const project = {
    listFiles: async () => [],
    readTextFile: async (p: string) => files.get(p) ?? "",
    writeTextFile: async (p: string, text: string) => {
      files.set(p, text)
    },
    createDirectory: async () => {},
    deleteFile: async (p: string) => {
      calls.push(`deleteFile ${p}`)
      files.delete(p)
    },
  }
  return { scene: new SceneState(engine, project), engine, files, calls }
}

describe("SceneState", () => {
  test("a transform the engine refuses is reverted in the inspector", async () => {
    const { scene, engine } = setup()
    await scene.select("e1")
    assert.deepEqual(scene.transform.value, at(1))
    engine.failSet = true
    await assert.rejects(scene.setTransform(at(5)), /No entity/)
    assert.deepEqual(scene.transform.value, at(1))
  })

  test("a transform the engine takes stays", async () => {
    const { scene } = setup()
    await scene.select("e1")
    await scene.setTransform(at(5))
    assert.deepEqual(scene.transform.value, at(5))
  })

  test("an object with no transform is selected without one, and without an error", async () => {
    const { scene, engine } = setup()
    engine.getEntityTransform = async () => {
      throw new Error("Entity has no transform")
    }
    await scene.select("e1")
    assert.equal(scene.selectedId.value, "e1")
    assert.equal(scene.transform.value, null)
    assert.equal(scene.noTransform.value, true)
    await scene.refreshTransform()
    assert.equal(scene.noTransform.value, true)
    // Another object has one again
    engine.getEntityTransform = async () => at(2)
    await scene.select("e2")
    assert.equal(scene.noTransform.value, false)
    assert.deepEqual(scene.transform.value, at(2))
  })

  test("a failed re-read keeps the transform shown", async () => {
    const { scene, engine } = setup()
    await scene.select("e1")
    engine.getEntityTransform = async () => {
      throw new Error("gone")
    }
    await scene.refreshTransform()
    assert.deepEqual(scene.transform.value, at(1))
    assert.equal(scene.noTransform.value, false)
  })

  test("a re-read waits out an edit on its way, and an edit made during a read wins", async () => {
    const { scene, engine } = setup()
    await scene.select("e1")
    let finishSet!: () => void
    engine.setEntityTransform = () => new Promise<void>((resolve) => (finishSet = resolve))
    const editing = scene.setTransform(at(5))
    let reads = 0
    engine.getEntityTransform = async () => {
      reads++
      return at(1)
    }
    await scene.refreshTransform()
    assert.equal(reads, 0, "not while the edit is pending")
    finishSet()
    await editing
    assert.deepEqual(scene.transform.value, at(5))

    // A read already under way when the edit starts is out of date when it answers
    let answer!: () => void
    engine.getEntityTransform = () => new Promise((resolve) => (answer = () => resolve(at(1))))
    const reading = scene.refreshTransform()
    engine.setEntityTransform = async () => {}
    await scene.setTransform(at(7))
    answer()
    await reading
    assert.deepEqual(scene.transform.value, at(7))
  })

  test("a script whose rescan fails is deleted again", async () => {
    const { scene, engine, files, calls } = setup()
    engine.failRescan = true
    await assert.rejects(scene.createScript("/p/assets", "Player"), /Rescan failed/)
    assert.ok(calls.includes("deleteFile /p/assets/scripts/Player.lua"))
    assert.equal(files.size, 0)
    assert.deepEqual(scene.scripts.value, [])
  })

  test("a script that is rescanned is kept and opened", async () => {
    const { scene, files } = setup()
    await scene.createScript("/p/assets/scripts", "Player")
    assert.equal(files.get("/p/assets/scripts/Player.lua"), "-- Player")
    assert.equal(scene.activeScript.value, "/p/assets/scripts/Player.lua")
  })
})
