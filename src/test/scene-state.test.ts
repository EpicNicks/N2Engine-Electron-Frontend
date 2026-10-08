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
    isConnected: () => true,
    getCurrentScene: async () => null,
    loadScene: async () => {},
    createScene: async () => ({ sceneJson: "{}" }),
    getAllEntities: async () => [{ id: "e1", name: "Cube" }],
    createEntity: async () => "e1",
    destroyEntity: async () => {},
    getEntityTransform: async () => at(1),
    setEntityTransform: async () => {
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
