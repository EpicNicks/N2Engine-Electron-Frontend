// The collision matrix model of the Layers section: the pair keys, the matrix as the engine reads it (Layers.cpp
// Deserialize), and the patch Apply sends (32 unsigned row masks, bit b of row a, symmetric).
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import {
  AllLayersMask,
  LayerCount,
  applyMergePatch,
  buildLayersPatch,
  collisionMatrixOf,
  isRowMask,
  pairKey,
  pairText,
  parsePairKey,
  rowsCollide,
  setRowsPair,
  type Json,
  type JsonObject,
} from "../renderer/project-settings-schema"
import { LayersLogic } from "../renderer/project-settings-logic"
import type { ProjectInfoResponse } from "../protocol/protocol.generated"

const allRows = (): number[] => new Array<number>(LayerCount).fill(AllLayersMask)

/** The engine's own check of a row (Layers.cpp: an integer in 0..0xFFFFFFFF) and of the pair rule */
function assertEngineValid(rows: unknown): asserts rows is number[] {
  assert.ok(Array.isArray(rows))
  assert.equal(rows.length, LayerCount)
  for (const row of rows) assert.ok(isRowMask(row), `row ${String(row)} is not a 32-bit mask`)
  for (let a = 0; a < LayerCount; a++) {
    for (let b = 0; b < LayerCount; b++) assert.equal(rowsCollide(rows, a, b), rowsCollide(rows, b, a), `(${a}, ${b}) is not symmetric`)
  }
}

describe("pair keys", () => {
  test("(a, b) and (b, a) are one key", () => {
    assert.equal(pairKey(3, 7), "pair.3.7")
    assert.equal(pairKey(7, 3), "pair.3.7")
    assert.equal(pairKey(5, 5), "pair.5.5")
  })

  test("parsing keeps to 0..31 and the lower layer first", () => {
    assert.deepEqual(parsePairKey("pair.0.31"), [0, 31])
    assert.deepEqual(parsePairKey("pair.31.31"), [31, 31])
    assert.equal(parsePairKey("pair.0.32"), null)
    assert.equal(parsePairKey("pair.32.32"), null)
    assert.equal(parsePairKey("pair.5.3"), null)
    assert.equal(parsePairKey("pair.-1.3"), null)
    assert.equal(parsePairKey("layer.3"), null)
  })
})

describe("the matrix as the engine reads it", () => {
  test("no matrix: every layer collides with every layer", () => {
    const m = collisionMatrixOf({})
    assert.deepEqual(m.rows, allRows())
    assert.equal(m.problem, null)
    assert.deepEqual(collisionMatrixOf({ layers: { layers: ["Default"] } }).rows, allRows())
  })

  test("a matrix that is not 32 masks is not used, and says so", () => {
    const bad: Json[] = [
      [1, 2, 3],
      new Array<number>(33).fill(0),
      [...new Array<number>(31).fill(0), -1],
      [...new Array<number>(31).fill(0), 4294967296],
      [...new Array<number>(31).fill(0), 1.5],
      [...new Array<number>(31).fill(0), "7"],
      "all",
    ]
    for (const collisionMatrix of bad) {
      const m = collisionMatrixOf({ layers: { collisionMatrix } })
      assert.deepEqual(m.rows, allRows())
      assert.match(m.problem ?? "", /not 32 masks/)
    }
  })

  test("a pair collides only when both rows say so (the engine's rule)", () => {
    const written = allRows()
    written[2] = (written[2] & ~(1 << 9)) >>> 0 // row 2 says no to 9, row 9 still says yes to 2
    const m = collisionMatrixOf({ layers: { collisionMatrix: written } })
    assert.equal(m.problem, null)
    assert.equal(rowsCollide(m.rows, 2, 9), false)
    assert.equal(rowsCollide(m.rows, 9, 2), false)
    assert.equal(rowsCollide(m.rows, 2, 8), true)
  })

  test("bit 31 is read and written unsigned", () => {
    const rows = new Array<number>(LayerCount).fill(0)
    setRowsPair(rows, 0, 31, true)
    assert.equal(rows[0], 0x80000000)
    assert.equal(rows[31], 1)
    setRowsPair(rows, 31, 31, true)
    assert.equal(rows[31], 0x80000001)
    assert.ok(rowsCollide(rows, 31, 31))
    setRowsPair(rows, 31, 0, false)
    assert.equal(rows[0], 0)
    assert.equal(rows[31], 0x80000000)
    assert.ok(isRowMask(AllLayersMask))
    assert.equal(isRowMask(AllLayersMask + 1), false)
  })
})

describe("the patch of the matrix", () => {
  test("one pair: only the matrix is sent, all 32 rows, with the pair cleared in both rows", () => {
    const built = buildLayersPatch({}, { [pairKey(6, 0)]: pairText(false) })
    assert.deepEqual(built.changed, ["pair.0.6"])
    assert.deepEqual(built.errors, {})
    const block = (built.patch as { layers: JsonObject }).layers
    assert.deepEqual(Object.keys(block), ["collisionMatrix"])
    const rows = block.collisionMatrix
    assertEngineValid(rows)
    const expected = allRows()
    expected[0] = (AllLayersMask & ~(1 << 6)) >>> 0 // 0xFFFFFFBF
    expected[6] = (AllLayersMask & ~1) >>> 0 // 0xFFFFFFFE
    assert.deepEqual(rows, expected)
    assert.equal(rows[0], 4294967231)
    assert.equal(rows[6], 4294967294)
  })

  test("an edit back to the host's value is no change", () => {
    const built = buildLayersPatch({}, { "pair.1.2": "1" })
    assert.equal(built.patch, null)
    assert.deepEqual(built.changed, [])
  })

  test("the edits are on top of the host's matrix, which is kept", () => {
    const host = new Array<number>(LayerCount).fill(0)
    setRowsPair(host, 3, 4, true)
    const built = buildLayersPatch({ layers: { collisionMatrix: host } }, { "pair.31.31": "1", "pair.0.0": "0" })
    assert.deepEqual(built.changed, ["pair.31.31"])
    const rows = (built.patch as { layers: { collisionMatrix: number[] } }).layers.collisionMatrix
    assertEngineValid(rows)
    assert.ok(rowsCollide(rows, 3, 4))
    assert.ok(rowsCollide(rows, 31, 31))
    assert.equal(rows.filter((r) => r !== 0).length, 3)
  })

  test("a name and a pair together: both arrays go in one patch", () => {
    const built = buildLayersPatch({}, { "layer.6": "Enemies", "pair.5.6": "0" })
    assert.deepEqual(built.changed, ["layer.6", "pair.5.6"])
    const block = (built.patch as { layers: { layers: string[]; collisionMatrix: number[] } }).layers
    assert.equal(block.layers[6], "Enemies")
    assertEngineValid(block.collisionMatrix)
    assert.equal(rowsCollide(block.collisionMatrix, 5, 6), false)
  })

  test("a bad name holds the matrix back too (the section applies as one)", () => {
    const built = buildLayersPatch({}, { "layer.6": "Water", "pair.5.6": "0" })
    assert.equal(built.patch, null)
    assert.ok(built.errors["layer.6"])
  })

  test("an invalid matrix in the project is replaced by a valid one", () => {
    const built = buildLayersPatch({ layers: { collisionMatrix: [1, 2] } }, { "pair.0.1": "0" })
    assertEngineValid((built.patch as { layers: { collisionMatrix: number[] } }).layers.collisionMatrix)
  })

  test("merged into the settings, the names stay and the engine sees the edit", () => {
    const settings: JsonObject = { layers: { layers: ["Default", "TransparentFX", "Ignore Raycast", "Props"] } }
    const built = buildLayersPatch(settings, { "pair.3.4": "0" })
    const after = applyMergePatch(settings, built.patch as Json) as JsonObject
    assert.deepEqual((after.layers as JsonObject).layers, (settings.layers as JsonObject).layers)
    const m = collisionMatrixOf(after)
    assert.equal(m.problem, null)
    assert.equal(rowsCollide(m.rows, 4, 3), false)
  })

  test("the section's text of a pair key follows the host's matrix", () => {
    const host = allRows()
    setRowsPair(host, 2, 7, false)
    const ctx = { settings: { layers: { collisionMatrix: host } } as JsonObject, info: {} as ProjectInfoResponse }
    assert.equal(LayersLogic.textOf?.(ctx, "pair.2.7"), "0")
    assert.equal(LayersLogic.textOf?.(ctx, "pair.2.8"), "1")
    assert.equal(LayersLogic.textOf?.(ctx, "layer.0"), "Default")
  })
})

describe("a no-op Apply on an invalid stored matrix", () => {
  test("a pair edit equal to the value shown still writes a valid matrix", () => {
    const built = buildLayersPatch({ layers: { collisionMatrix: [1, 2] } }, { "pair.1.2": "1" })
    assert.deepEqual(built.changed, ["pair.1.2"])
    assertEngineValid((built.patch as { layers: { collisionMatrix: number[] } }).layers.collisionMatrix)
  })

  test("a valid stored matrix with the same edit stays no change", () => {
    const built = buildLayersPatch({ layers: { collisionMatrix: allRows() } }, { "pair.1.2": "1" })
    assert.equal(built.patch, null)
  })
})
