// The viewport's maths: vectors, quaternions and 4x4 matrices in the protocol's conventions (a Mat4 is 16 numbers,
// column-major, element col * 4 + row, for column vectors; a camera looks down its local -Z with +Y up; clip =
// projection * view * (world point, 1)), and the projections the gizmo and the overlays need: world to screen
// pixels (top-left origin, as PickEntity's pixels are) and a screen pixel to a world ray. Pure functions, unit tested.
import type { Mat4, Quat, Vec3 } from "../protocol/protocol.generated"

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z })
export const ZeroVec3: Vec3 = { x: 0, y: 0, z: 0 }
export const IdentityQuat: Quat = { x: 0, y: 0, z: 0, w: 1 }

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s })
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
export const length = (a: Vec3): number => Math.sqrt(dot(a, a))
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b))
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a)
  return l > 0 ? scale(a, 1 / l) : { ...ZeroVec3 }
}
export const isFiniteVec3 = (a: Vec3): boolean => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)

// ==================== Quaternions ====================

export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

export function quatFromAxisAngle(axis: Vec3, radians: number): Quat {
  const n = normalize(axis)
  const s = Math.sin(radians / 2)
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(radians / 2) }
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w)
  return l > 0 ? { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l } : { ...IdentityQuat }
}

/** The vector rotated by the (unit) quaternion */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = { x: q.x, y: q.y, z: q.z }
  const t = scale(cross(u, v), 2)
  return add(add(v, scale(t, q.w)), cross(u, t))
}

// ==================== Matrices ====================

export const IdentityMat4: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** a * b: b is applied first (column vectors) */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k]
      out[col * 4 + row] = sum
    }
  }
  return out
}

/** The matrix of translate * rotate * scale: how an object's local transform becomes its local-to-parent matrix */
export function mat4Compose(position: Vec3, rotation: Quat, scaling: Vec3): Mat4 {
  const q = quatNormalize(rotation)
  const x = quatRotate(q, { x: 1, y: 0, z: 0 })
  const y = quatRotate(q, { x: 0, y: 1, z: 0 })
  const z = quatRotate(q, { x: 0, y: 0, z: 1 })
  return [
    x.x * scaling.x, x.y * scaling.x, x.z * scaling.x, 0,
    y.x * scaling.y, y.y * scaling.y, y.z * scaling.y, 0,
    z.x * scaling.z, z.y * scaling.z, z.z * scaling.z, 0,
    position.x, position.y, position.z, 1,
  ] // prettier-ignore
}

/** The inverse, or null for a matrix that has none (a zero scale) */
export function mat4Invert(m: Mat4): Mat4 | null {
  const inv = new Array<number>(16)
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10]
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10]
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9]
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9]
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10]
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10]
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9]
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9]
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6]
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6]
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5]
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5]
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6]
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6]
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5]
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5]
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12]
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  return inv.map((v) => v / det)
}

/** The translation (elements 12, 13, 14): an object's world position, from its world matrix */
export const mat4Translation = (m: Mat4): Vec3 => ({ x: m[12], y: m[13], z: m[14] })

/** The point transformed, with the perspective divide; null when it is at w = 0 */
export function mat4TransformPoint(m: Mat4, p: Vec3): { point: Vec3; w: number } | null {
  const x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]
  const y = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]
  const z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]
  const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15]
  if (w === 0 || !Number.isFinite(w)) return null
  return { point: { x: x / w, y: y / w, z: z / w }, w }
}

/** The direction transformed (no translation, no divide) */
export function mat4TransformDirection(m: Mat4, d: Vec3): Vec3 {
  return {
    x: m[0] * d.x + m[4] * d.y + m[8] * d.z,
    y: m[1] * d.x + m[5] * d.y + m[9] * d.z,
    z: m[2] * d.x + m[6] * d.y + m[10] * d.z,
  }
}

// ==================== Cameras ====================

/** The view matrix of a camera at position with rotation (world to camera space; it looks down -Z) */
export function viewMatrix(position: Vec3, rotation: Quat): Mat4 {
  // The inverse of a rigid transform: the transposed rotation, then the rotated, negated position
  const q = quatNormalize(rotation)
  const x = quatRotate(q, { x: 1, y: 0, z: 0 })
  const y = quatRotate(q, { x: 0, y: 1, z: 0 })
  const z = quatRotate(q, { x: 0, y: 0, z: 1 })
  return [
    x.x, y.x, z.x, 0,
    x.y, y.y, z.y, 0,
    x.z, y.z, z.z, 0,
    -dot(x, position), -dot(y, position), -dot(z, position), 1,
  ] // prettier-ignore
}

export interface ProjectionSettings {
  /** The vertical field of view, in degrees */
  fovY: number
  orthographic: boolean
  /** An orthographic camera's half height in world units */
  orthoSize: number
  nearPlane: number
  farPlane: number
}

/** An OpenGL-style projection (camera space to clip space, depth -1 to 1) for a viewport's aspect ratio (width / height) */
export function projectionMatrix(settings: ProjectionSettings, aspect: number): Mat4 {
  const { nearPlane: n, farPlane: f } = settings
  if (settings.orthographic) {
    const top = settings.orthoSize
    const right = top * aspect
    return [1 / right, 0, 0, 0, 0, 1 / top, 0, 0, 0, 0, -2 / (f - n), 0, 0, 0, -(f + n) / (f - n), 1]
  }
  const t = 1 / Math.tan((settings.fovY * Math.PI) / 360)
  return [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, -(f + n) / (f - n), -1, 0, 0, (-2 * f * n) / (f - n), 0]
}

export interface Pixel {
  x: number
  y: number
}

/**
 * Where a world point is on a viewport of width x height pixels (top-left origin), or null when it is behind the
 * camera (or on its plane): the gizmo and the overlays draw only what is in front. depth is NDC z.
 */
export function worldToScreen(
  viewProjection: Mat4,
  point: Vec3,
  width: number,
  height: number
): (Pixel & { depth: number }) | null {
  const clip = mat4TransformPoint(viewProjection, point)
  if (!clip || clip.w <= 0) return null
  return { x: (clip.point.x * 0.5 + 0.5) * width, y: (1 - (clip.point.y * 0.5 + 0.5)) * height, depth: clip.point.z }
}

export interface Ray {
  origin: Vec3
  direction: Vec3
}

/** The world ray through a pixel (top-left origin); null when the matrices can't be inverted */
export function screenRay(viewProjection: Mat4, x: number, y: number, width: number, height: number): Ray | null {
  const inverse = mat4Invert(viewProjection)
  if (!inverse || !(width > 0 && height > 0)) return null
  const ndcX = (x / width) * 2 - 1
  const ndcY = 1 - (y / height) * 2
  // Points on the line through the pixel at both ends of the depth range (any depth convention puts them on it)
  const near = mat4TransformPoint(inverse, { x: ndcX, y: ndcY, z: -1 })
  const far = mat4TransformPoint(inverse, { x: ndcX, y: ndcY, z: 1 })
  if (!near || !far) return null
  const direction = normalize(sub(far.point, near.point))
  if (length(direction) === 0) return null
  return { origin: near.point, direction }
}

/**
 * The parameter along the line (point + t * axis, axis a unit vector) nearest to the ray, or null when the ray is
 * (nearly) parallel to the line, where the answer is meaningless.
 */
export function closestParamOnLine(ray: Ray, point: Vec3, axis: Vec3): number | null {
  return closestOnLine(ray, point, axis)?.t ?? null
}

/** As closestParamOnLine, with s too: the distance along the ray (from its origin) of the nearest point on it */
export function closestOnLine(ray: Ray, point: Vec3, axis: Vec3): { t: number; s: number } | null {
  const w0 = sub(point, ray.origin)
  const b = dot(axis, ray.direction)
  const denominator = 1 - b * b // a = c = 1: both are unit vectors
  if (denominator < 1e-6) return null
  const d = dot(axis, w0)
  const e = dot(ray.direction, w0)
  return { t: (b * e - d) / denominator, s: (e - b * d) / denominator }
}

/** The distance from a pixel to a segment */
export function distanceToSegment(p: Pixel, a: Pixel, b: Pixel): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const lengthSquared = abx * abx + aby * aby
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSquared))
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby))
}
