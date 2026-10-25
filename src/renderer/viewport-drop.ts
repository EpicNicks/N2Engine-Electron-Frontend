// Where a prefab dropped on the viewport is put (protocol 1.19.0: InstantiatePrefab with a world position). PickEntity
// answers the object under the pixel but not the point on it, so the point is where the ray through the pixel enters that
// object's box (GetEntityBounds), else the ray at the depth of the box's centre, and on a miss a point in front of the
// camera on that ray. No DOM: unit tested in Node.
import type { Bounds } from "./viewport-camera"
import { Ray, add, dot, isFiniteVec3, scale, sub } from "./viewport-math"
import type { Vec3 } from "../protocol/protocol.generated"

/** How far in front of the camera a prefab dropped on empty space is put, in world units */
export const DefaultDropDistance = 10

/** The distance along the ray (unit direction) at which it enters the box; null when it misses or the box is behind it */
export function rayBoxEntry(ray: Ray, box: Bounds): number | null {
  let near = -Infinity
  let far = Infinity
  for (const axis of ["x", "y", "z"] as const) {
    const origin = ray.origin[axis]
    const direction = ray.direction[axis]
    if (Math.abs(direction) < 1e-9) {
      if (origin < box.min[axis] || origin > box.max[axis]) return null
      continue
    }
    let t0 = (box.min[axis] - origin) / direction
    let t1 = (box.max[axis] - origin) / direction
    if (t0 > t1) [t0, t1] = [t1, t0]
    near = Math.max(near, t0)
    far = Math.min(far, t1)
    if (near > far) return null
  }
  if (far < 0) return null
  return Math.max(near, 0)
}

/**
 * The world point for a drop. ray: through the pixel (null when the matrices can't be inverted); camera: its position and
 * forward direction; hit: the box of the object under the pixel, null for a miss.
 */
export function prefabDropPoint(ray: Ray | null, camera: { position: Vec3; forward: Vec3 }, hit: Bounds | null): Vec3 {
  if (!ray) return add(camera.position, scale(camera.forward, DefaultDropDistance))
  if (hit) {
    const entry = rayBoxEntry(ray, hit)
    if (entry !== null) return add(ray.origin, scale(ray.direction, entry))
    // The pixel is over the object but its box is not on the ray (a box is looser than a mesh near its corners)
    const centre = scale(add(hit.min, hit.max), 0.5)
    const depth = dot(sub(centre, ray.origin), ray.direction)
    if (depth > 0) return add(ray.origin, scale(ray.direction, depth))
  }
  // An orthographic ray starts at the near plane; the point is that far from the camera along it either way
  const point = add(ray.origin, scale(ray.direction, DefaultDropDistance))
  return isFiniteVec3(point) ? point : add(camera.position, scale(camera.forward, DefaultDropDistance))
}
