import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { BoundsResponse, PickResultResponse } from "../protocol/protocol.generated"
import { createPickBackend, translateBounds, unionBounds, validBounds } from "../renderer/viewport-picking"
import { vec3 } from "../renderer/viewport-math"

const box = (min: [number, number, number], max: [number, number, number]) => ({
  min: vec3(...min),
  max: vec3(...max),
})

describe("unionBounds", () => {
  test("is the box around all of them; none is null; one is itself", () => {
    assert.equal(unionBounds([]), null)
    assert.deepEqual(unionBounds([box([1, 2, 3], [4, 5, 6])]), box([1, 2, 3], [4, 5, 6]))
    assert.deepEqual(
      unionBounds([box([0, 0, 0], [1, 1, 1]), box([-2, 3, 0.5], [0, 4, 9]), box([0.2, 0.2, 0.2], [0.3, 0.3, 0.3])]),
      box([-2, 0, 0], [1, 4, 9])
    )
  })

  test("does not alias its input", () => {
    const a = box([0, 0, 0], [1, 1, 1])
    const u = unionBounds([a])!
    u.min.x = 99
    assert.equal(a.min.x, 0)
  })

  test("translateBounds moves both corners", () => {
    assert.deepEqual(translateBounds(box([0, 0, 0], [1, 2, 3]), vec3(1, -1, 0.5)), box([1, -1, 0.5], [2, 1, 3.5]))
  })
})

describe("validBounds", () => {
  test("drops a box that isn't finite or whose min is above its max", () => {
    assert.deepEqual(validBounds({ id: "a", ...box([0, 0, 0], [1, 1, 1]) }), box([0, 0, 0], [1, 1, 1]))
    assert.equal(validBounds({ id: "a", ...box([0, 0, 0], [NaN, 1, 1]) }), null)
    assert.equal(validBounds({ id: "a", ...box([0, 0, 0], [Infinity, 1, 1]) }), null)
    assert.equal(validBounds({ id: "a", ...box([2, 0, 0], [1, 1, 1]) }), null)
    assert.deepEqual(validBounds({ id: "a", ...box([1, 1, 1], [1, 1, 1]) }), box([1, 1, 1], [1, 1, 1])) // a point is a box
  })
})

describe("createPickBackend", () => {
  function fake(answers: { pick?: PickResultResponse; bounds?: (ids: string[]) => BoundsResponse } = {}) {
    const picks: Array<[number, number, boolean]> = []
    const bounds: string[][] = []
    const engine = {
      pickEntity: async (x: number, y: number, includeInactive: boolean) => {
        picks.push([x, y, includeInactive])
        return answers.pick ?? { entityId: "", point: vec3(0, 0, 0), distance: 0 }
      },
      getEntityBounds: async (ids: string[]) => {
        bounds.push(ids)
        return answers.bounds ? answers.bounds(ids) : { bounds: [] }
      },
    }
    return { engine, picks, bounds }
  }

  test("pick: a miss ('') is null, a hit is the object's id; the arguments go through", async () => {
    const miss = fake()
    assert.equal(await createPickBackend(miss.engine).pick(1.5, 2.5, false), null)
    assert.deepEqual(miss.picks, [[1.5, 2.5, false]])
    const hit = fake({ pick: { entityId: "graphic-1", point: vec3(1, 2, 3), distance: 4 } })
    assert.equal(await createPickBackend(hit.engine).pick(0, 0, true), "graphic-1") // a UI graphic's own object, as the host says
    assert.deepEqual(hit.picks, [[0, 0, true]])
  })

  test("bounds: one call for the selection, repeated ids once, only entries for what was asked and well-formed", async () => {
    const f = fake({
      bounds: () => ({
        bounds: [
          { id: "a", ...box([0, 0, 0], [1, 1, 1]) },
          { id: "stranger", ...box([0, 0, 0], [1, 1, 1]) },
          { id: "b", ...box([3, 0, 0], [1, 1, 1]) }, // min above max
        ],
      }),
    })
    const result = await createPickBackend(f.engine).bounds(["a", "b", "a", "gone"])
    assert.deepEqual(f.bounds, [["a", "b", "gone"]])
    assert.deepEqual([...result!.keys()], ["a"])
  })

  test("bounds: an id the host leaves out has no entry", async () => {
    const f = fake()
    assert.equal((await createPickBackend(f.engine).bounds(["x"]))!.size, 0)
  })

  test("bounds: more than 4096 ids go in batches of at most 4096", async () => {
    const f = fake({ bounds: (ids) => ({ bounds: ids.map((id) => ({ id, ...box([0, 0, 0], [1, 1, 1]) })) }) })
    const ids = Array.from({ length: 4097 }, (_, i) => `id-${i}`)
    const result = await createPickBackend(f.engine).bounds(ids)
    assert.deepEqual(f.bounds.map((b) => b.length), [4096, 1])
    assert.equal(result!.size, 4097)
  })

  test("an error from the host propagates (the controller decides what to show)", async () => {
    const engine = {
      pickEntity: async (): Promise<PickResultResponse> => {
        throw new Error("No scene")
      },
      getEntityBounds: async (): Promise<BoundsResponse> => {
        throw new Error("No scene")
      },
    }
    await assert.rejects(createPickBackend(engine).pick(0, 0, false), /No scene/)
    await assert.rejects(createPickBackend(engine).bounds(["a"]), /No scene/)
  })
})
