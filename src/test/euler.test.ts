import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { Quat, Vec3 } from "../protocol/protocol.generated"
import { eulerToQuat, normalizeQuat, quatToEuler, quatsEquivalent, stableEuler } from "../renderer/euler"

const rad = (deg: number) => (deg * Math.PI) / 180
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`)
const nearVec = (a: Vec3, b: Vec3, eps = 1e-9) => {
  near(a.x, b.x, eps)
  near(a.y, b.y, eps)
  near(a.z, b.z, eps)
}

// Plain rotation matrices about the axes, to say what the convention means without using the code under test
const rx = (v: Vec3, deg: number): Vec3 => {
  const c = Math.cos(rad(deg))
  const s = Math.sin(rad(deg))
  return { x: v.x, y: c * v.y - s * v.z, z: s * v.y + c * v.z }
}
const ry = (v: Vec3, deg: number): Vec3 => {
  const c = Math.cos(rad(deg))
  const s = Math.sin(rad(deg))
  return { x: c * v.x + s * v.z, y: v.y, z: -s * v.x + c * v.z }
}
const rz = (v: Vec3, deg: number): Vec3 => {
  const c = Math.cos(rad(deg))
  const s = Math.sin(rad(deg))
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y, z: v.z }
}
/** v rotated by q (v + 2 * (w * (u x v) + u x (u x v)) with u = (x, y, z)) */
function rotate(q: Quat, v: Vec3): Vec3 {
  const cross = (a: Vec3, b: Vec3): Vec3 => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  })
  const u = { x: q.x, y: q.y, z: q.z }
  const uv = cross(u, v)
  const uuv = cross(u, uv)
  return { x: v.x + 2 * (q.w * uv.x + uuv.x), y: v.y + 2 * (q.w * uv.y + uuv.y), z: v.z + 2 * (q.w * uv.z + uuv.z) }
}

const grid = (values: number[]) =>
  values.flatMap((x) => values.flatMap((y) => values.map((z): Vec3 => ({ x, y, z }))))

describe("eulerToQuat: the convention", () => {
  test("zero is the identity", () => {
    assert.deepEqual(eulerToQuat({ x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: 0, w: 1 })
  })

  test("a single axis is a rotation about that axis, in degrees", () => {
    const q = eulerToQuat({ x: 0, y: 0, z: 90 })
    near(q.z, Math.sin(rad(45)))
    near(q.w, Math.cos(rad(45)))
    nearVec(rotate(eulerToQuat({ x: 90, y: 0, z: 0 }), { x: 0, y: 1, z: 0 }), { x: 0, y: 0, z: 1 })
    nearVec(rotate(eulerToQuat({ x: 0, y: 90, z: 0 }), { x: 0, y: 0, z: 1 }), { x: 1, y: 0, z: 0 })
    nearVec(rotate(q, { x: 1, y: 0, z: 0 }), { x: 0, y: 1, z: 0 })
  })

  test("the order is X, then Y, then Z, about the fixed axes (R = Rz * Ry * Rx)", () => {
    const v = { x: 0.3, y: -1.2, z: 2 }
    for (const e of [
      { x: 30, y: 40, z: 50 },
      { x: -120, y: 15, z: 170 },
      { x: 10, y: -80, z: -35 },
    ]) {
      nearVec(rotate(eulerToQuat(e), v), rz(ry(rx(v, e.x), e.y), e.z))
    }
  })

  test("the result is a unit quaternion", () => {
    for (const e of grid([-200, -37, 0, 91, 400])) {
      const q = eulerToQuat(e)
      near(Math.hypot(q.x, q.y, q.z, q.w), 1)
    }
  })
})

describe("quatToEuler", () => {
  test("round trips: the angles of a rotation make that rotation again", () => {
    for (const e of grid([-170, -90, -35, 0, 12, 90, 179])) {
      const q = eulerToQuat(e)
      assert.ok(quatsEquivalent(eulerToQuat(quatToEuler(q)), q, 1e-6), JSON.stringify(e))
    }
  })

  test("the angles come back in range: x and z within a half turn, y within a quarter", () => {
    for (const e of grid([-400, -170, 0, 123, 359, 700])) {
      const back = quatToEuler(eulerToQuat(e))
      assert.ok(back.x > -180 - 1e-9 && back.x <= 180 + 1e-9, `x ${back.x}`)
      assert.ok(Math.abs(back.y) <= 90 + 1e-9, `y ${back.y}`)
      assert.ok(back.z > -180 - 1e-9 && back.z <= 180 + 1e-9, `z ${back.z}`)
    }
  })

  test("ordinary angles come back as typed", () => {
    nearVec(quatToEuler(eulerToQuat({ x: 10, y: 20, z: 30 })), { x: 10, y: 20, z: 30 }, 1e-9)
    nearVec(quatToEuler(eulerToQuat({ x: -45, y: -60, z: 170 })), { x: -45, y: -60, z: 170 }, 1e-9)
  })

  test("gimbal: y at +-90 puts the whole turn in x (z is 0) and is the same rotation", () => {
    for (const y of [90, -90]) {
      for (const e of [
        { x: 0, y, z: 0 },
        { x: 30, y, z: 0 },
        { x: 0, y, z: 40 },
        { x: -70, y, z: 25 },
        { x: 170, y, z: -100 },
      ]) {
        const q = eulerToQuat(e)
        const back = quatToEuler(q)
        assert.equal(back.y, y)
        assert.equal(back.z, 0)
        assert.ok(Number.isFinite(back.x))
        assert.ok(quatsEquivalent(eulerToQuat(back), q, 1e-6), JSON.stringify(e))
      }
    }
  })

  test("next to the gimbal case the angles are finite and the rotation is kept", () => {
    for (const y of [89.9, 89.9999, 90.0001, -89.9999, -90.0001]) {
      const q = eulerToQuat({ x: 20, y, z: 50 })
      const back = quatToEuler(q)
      assert.ok(Number.isFinite(back.x) && Number.isFinite(back.y) && Number.isFinite(back.z))
      assert.ok(quatsEquivalent(eulerToQuat(back), q, 1e-5), `y ${y}`)
    }
  })

  test("no negative zero comes out (it would show as -0)", () => {
    for (const q of [
      { x: 0, y: 0, z: 0, w: 1 },
      { x: -0, y: -0, z: -0, w: 1 },
      eulerToQuat({ x: -0, y: -0, z: -0 }),
      eulerToQuat({ x: 180, y: 0, z: 0 }),
    ]) {
      const e = quatToEuler(q)
      for (const n of [e.x, e.y, e.z]) assert.ok(!Object.is(n, -0), JSON.stringify(q))
    }
    const unit = eulerToQuat({ x: -0, y: -0, z: -0 })
    for (const n of [unit.x, unit.y, unit.z, unit.w]) assert.ok(!Object.is(n, -0))
  })

  test("a quaternion that isn't unit length is normalised first; a degenerate one is the identity", () => {
    nearVec(quatToEuler({ x: 0, y: 0, z: 2 * Math.sin(rad(45)), w: 2 * Math.cos(rad(45)) }), { x: 0, y: 0, z: 90 })
    assert.deepEqual(normalizeQuat({ x: 0, y: 0, z: 0, w: 0 }), { x: 0, y: 0, z: 0, w: 1 })
    assert.deepEqual(normalizeQuat({ x: NaN, y: 0, z: 0, w: 1 }), { x: 0, y: 0, z: 0, w: 1 })
  })
})

describe("large angles and wrapping", () => {
  test("whole turns are the same rotation", () => {
    const base = eulerToQuat({ x: 25, y: -40, z: 70 })
    for (const e of [
      { x: 385, y: -40, z: 70 },
      { x: 25, y: -40, z: -290 },
      { x: -335, y: -40, z: 430 },
      { x: 25 + 720, y: -40, z: 70 - 1080 },
    ]) {
      assert.ok(quatsEquivalent(eulerToQuat(e), base, 1e-9), JSON.stringify(e))
    }
  })

  test("180 and -180 are the same rotation", () => {
    assert.ok(quatsEquivalent(eulerToQuat({ x: 180, y: 0, z: 0 }), eulerToQuat({ x: -180, y: 0, z: 0 }), 1e-12))
  })

  test("q and -q are the same rotation; different rotations are not", () => {
    const q = eulerToQuat({ x: 10, y: 20, z: 30 })
    assert.ok(quatsEquivalent(q, { x: -q.x, y: -q.y, z: -q.z, w: -q.w }))
    assert.ok(!quatsEquivalent(q, eulerToQuat({ x: 10, y: 20, z: 30.01 })))
  })
})

describe("stableEuler: the triple shown stays while it means the stored rotation", () => {
  test("180 does not flip to -180, and 540 stays 540", () => {
    const q = eulerToQuat({ x: 180, y: 0, z: 0 })
    assert.deepEqual(stableEuler({ x: 180, y: 0, z: 0 }, q), { x: 180, y: 0, z: 0 })
    assert.deepEqual(stableEuler({ x: -180, y: 0, z: 0 }, q), { x: -180, y: 0, z: 0 })
    const turns = eulerToQuat({ x: 540, y: 0, z: 0 })
    assert.deepEqual(stableEuler({ x: 540, y: 0, z: 0 }, turns), { x: 540, y: 0, z: 0 })
  })

  test("a different answer for the same rotation is kept (the gimbal case with z typed)", () => {
    const shown = { x: 0, y: 90, z: 40 }
    assert.deepEqual(stableEuler(shown, eulerToQuat(shown)), shown)
  })

  test("a different rotation (the gizmo, an undo) shows the canonical angles; none shown yet too", () => {
    const moved = eulerToQuat({ x: 0, y: 0, z: 45 })
    nearVec(stableEuler({ x: 180, y: 0, z: 0 }, moved), { x: 0, y: 0, z: 45 })
    nearVec(stableEuler(null, moved), { x: 0, y: 0, z: 45 })
    nearVec(stableEuler({ x: NaN, y: 0, z: 0 }, moved), { x: 0, y: 0, z: 45 })
  })

  test("the host's float32 noise doesn't change what is shown", () => {
    const shown = { x: 33.3333, y: -12.5, z: 101.1 }
    const q = eulerToQuat(shown)
    const noisy = { x: q.x + 4e-8, y: q.y - 6e-8, z: q.z + 3e-8, w: q.w - 5e-8 }
    assert.deepEqual(stableEuler(shown, noisy), shown)
  })

  test("no drift: reading and showing again many times keeps the same triple, and the quaternion it makes", () => {
    let shown: Vec3 = { x: 12.3456, y: 78.9, z: -170.25 }
    const q = eulerToQuat(shown)
    for (let i = 0; i < 1000; i++) shown = stableEuler(shown, q)
    assert.deepEqual(shown, { x: 12.3456, y: 78.9, z: -170.25 })
    // Even the canonical angles are a fixed point after the first conversion
    let canonical = quatToEuler(q)
    for (let i = 0; i < 1000; i++) canonical = quatToEuler(eulerToQuat(canonical))
    nearVec(canonical, quatToEuler(q), 1e-9)
  })
})
