// Euler angles for the inspector's rotation row, and their conversion to the quaternion the engine stores. No DOM: unit
// tested in Node.
//
// Convention (the engine's, so a number typed here means what Quaternion::FromEulerAngles(x, y, z) means in the
// engine and in Lua, except that it is in DEGREES here and radians there):
//   x = rotation about X, y = about Y, z = about Z, applied in the order X, then Y, then Z about the fixed (parent)
//   axes, i.e. R = Rz * Ry * Rx (the quaternion q = qz * qy * qx). The engine's Quaternion(pitch, yaw, roll) constructor
//   and ToEulerAngles() are this convention, with pitch = x, yaw = y, roll = z.
// Ranges when an angle is read back from a quaternion: x and z in (-180, 180], y in [-90, 90]. y at +-90 degrees is the
// gimbal case, where x and z turn the same axis; it is read back with z = 0.
//
// The quaternion is what is stored and sent (SetLocalTransform): Euler angles have many answers for one rotation, and
// converting there and back on every edit drifts. So the panel keeps the triple that was last typed (or read) while it
// still means the stored rotation (stableEuler), and sends a quaternion only for the axis that was edited.
import type { Quat, Vec3 } from "../protocol/protocol.generated"

const DegToRad = Math.PI / 180
const RadToDeg = 180 / Math.PI

/** How far apart (per component, after aligning the sign) two quaternions can be and still be the same rotation: float32 noise is ~1e-7 */
export const QuatEpsilon = 1e-5

/** -0 as 0 (an angle that came out as -0 would show as "-0" or flip a comparison) */
const clean = (n: number): number => n + 0

export const quatIdentity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 })

export function normalizeQuat(q: Quat): Quat {
  const length = Math.hypot(q.x, q.y, q.z, q.w)
  if (!Number.isFinite(length) || length === 0) return quatIdentity()
  return { x: clean(q.x / length), y: clean(q.y / length), z: clean(q.z / length), w: clean(q.w / length) }
}

/** The quaternion for Euler angles in degrees (any size: 540 is 180), normalised */
export function eulerToQuat(degrees: Vec3): Quat {
  const hx = degrees.x * DegToRad * 0.5
  const hy = degrees.y * DegToRad * 0.5
  const hz = degrees.z * DegToRad * 0.5
  const cx = Math.cos(hx)
  const sx = Math.sin(hx)
  const cy = Math.cos(hy)
  const sy = Math.sin(hy)
  const cz = Math.cos(hz)
  const sz = Math.sin(hz)
  return normalizeQuat({
    w: cx * cy * cz + sx * sy * sz,
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
  })
}

/**
 * Closer than this to +-1, sin(y) is taken as the gimbal case (y within ~0.0001 degrees of +-90: setting z to 0 there
 * changes the rotation by less than the float32 noise of a stored one; the quaternion is normalised first, so a
 * float32 quaternion for exactly +-90 degrees lands here too)
 */
const GimbalLimit = 1 - 1e-12

/** The Euler angles in degrees of a quaternion (normalised first), in the ranges above; no -0 */
export function quatToEuler(quat: Quat): Vec3 {
  const q = normalizeQuat(quat)
  const sinY = 2 * (q.w * q.y - q.z * q.x)
  if (Math.abs(sinY) >= GimbalLimit) {
    // x and z turn the same axis: all of it goes in x (z = 0). R01 = 2(xy - wz), R11 = 1 - 2(x^2 + z^2)
    const r01 = 2 * (q.x * q.y - q.w * q.z)
    const r11 = 1 - 2 * (q.x * q.x + q.z * q.z)
    const up = sinY > 0
    const x = up ? Math.atan2(r01, r11) : Math.atan2(-r01, r11)
    return { x: clean(x * RadToDeg), y: up ? 90 : -90, z: 0 }
  }
  const x = Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y))
  const y = Math.asin(sinY)
  const z = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))
  return { x: clean(x * RadToDeg), y: clean(y * RadToDeg), z: clean(z * RadToDeg) }
}

/** Whether two quaternions are the same rotation (q and -q are) to within epsilon per component */
export function quatsEquivalent(a: Quat, b: Quat, epsilon: number = QuatEpsilon): boolean {
  const p = normalizeQuat(a)
  const q = normalizeQuat(b)
  const dot = p.x * q.x + p.y * q.y + p.z * q.z + p.w * q.w
  const sign = dot < 0 ? -1 : 1
  return (
    Math.abs(p.x - sign * q.x) <= epsilon &&
    Math.abs(p.y - sign * q.y) <= epsilon &&
    Math.abs(p.z - sign * q.z) <= epsilon &&
    Math.abs(p.w - sign * q.w) <= epsilon
  )
}

/**
 * The Euler angles to show for a stored rotation: the triple that is shown now when it still means that rotation (so
 * 180 doesn't turn into -180, 540 stays 540 and a typed 0.1 isn't redisplayed as 0.09999), else the canonical angles of
 * the quaternion (the rotation was changed by someone else: the gizmo, a script, an undo).
 */
export function stableEuler(shown: Vec3 | null, stored: Quat): Vec3 {
  if (shown && Number.isFinite(shown.x) && Number.isFinite(shown.y) && Number.isFinite(shown.z)) {
    if (quatsEquivalent(eulerToQuat(shown), stored)) return shown
  }
  return quatToEuler(stored)
}

export const vecEqual = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z
