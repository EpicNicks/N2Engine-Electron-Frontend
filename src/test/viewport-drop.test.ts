// Where a prefab dropped on the viewport is put (protocol 1.19.0): the ray's entry into the picked object's box, else a
// point in front of the camera.
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { DefaultDropDistance, prefabDropPoint, rayBoxEntry } from "../renderer/viewport-drop"
import { vec3 } from "../renderer/viewport-math"
import { rig, settle } from "./viewport-rig"

const box = { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) }
const camera = { position: vec3(0, 0, 10), forward: vec3(0, 0, -1) }
const close = (a: number, b: number, message = "") => assert.ok(Math.abs(a - b) < 1e-6, `${message} ${a} vs ${b}`)

describe("rayBoxEntry", () => {
  test("a ray into the box enters its near face; inside it, at once; away from it, never", () => {
    close(rayBoxEntry({ origin: vec3(0, 0, 10), direction: vec3(0, 0, -1) }, box)!, 9)
    close(rayBoxEntry({ origin: vec3(0, 0, 0), direction: vec3(0, 0, -1) }, box)!, 0)
    assert.equal(rayBoxEntry({ origin: vec3(0, 0, 10), direction: vec3(0, 0, 1) }, box), null)
    assert.equal(rayBoxEntry({ origin: vec3(5, 0, 10), direction: vec3(0, 0, -1) }, box), null)
  })
})

describe("prefabDropPoint", () => {
  const ray = { origin: vec3(0, 0, 9.9), direction: vec3(0, 0, -1) }

  test("over an object it is where the ray enters the object's box", () => {
    const p = prefabDropPoint(ray, camera, box)
    close(p.z, 1)
    close(p.x, 0)
  })

  test("over an object whose box the ray misses it is the ray at the box centre's depth", () => {
    const off = { min: vec3(2, -1, -1), max: vec3(4, 1, 1) } // centre (3, 0, 0); the ray runs along x = 0
    const p = prefabDropPoint(ray, camera, off)
    close(p.z, 0)
    close(p.x, 0)
  })

  test("over empty space it is a point in front of the camera on the ray", () => {
    const p = prefabDropPoint(ray, camera, null)
    close(p.z, 9.9 - DefaultDropDistance)
  })

  test("with no ray it is in front of the camera", () => {
    assert.deepEqual(prefabDropPoint(null, camera, null), vec3(0, 0, 10 - DefaultDropDistance))
  })
})

describe("ViewportController.prefabDropPosition", () => {
  test("asks the host what is under the pixel and its box, and puts the prefab on the object's face", async () => {
    const asked: string[] = []
    const r = rig({
      picking: {
        pick: async (x, y) => {
          asked.push(`pick ${x},${y}`)
          return "a"
        },
        bounds: async (ids) => {
          asked.push(`bounds ${ids.join(",")}`)
          return new Map([["a", box]])
        },
      },
    })
    await r.ready()
    asked.length = 0 // what loading the selection's box asked is not the drop's
    const p = await r.controller.prefabDropPosition({ x: 400, y: 300 })
    assert.deepEqual(asked, ["pick 400,300", "bounds a"])
    close(p.z, 1, "z")
    assert.ok(Math.abs(p.x) < 1e-3 && Math.abs(p.y) < 1e-3)
  })

  test("a miss, a failing pick and a host without picking all put it in front of the camera", async () => {
    for (const picking of [
      { pick: async () => null, bounds: async () => null },
      {
        pick: async () => {
          throw new Error("denied")
        },
        bounds: async () => null,
      },
      undefined,
    ]) {
      const r = rig({ picking })
      await r.ready()
      await settle()
      const p = await r.controller.prefabDropPosition({ x: 400, y: 300 })
      // The camera is at z = 10 looking down -z: about DefaultDropDistance in front of it
      assert.ok(Math.abs(p.z - (10 - DefaultDropDistance)) < 0.5, `z ${p.z}`)
      assert.ok(Math.abs(p.x) < 1e-3 && Math.abs(p.y) < 1e-3)
    }
  })
})
