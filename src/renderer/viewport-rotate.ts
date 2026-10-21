// The rotate gizmo (roadmap candidate 1, FE3): three rings, one per WORLD axis, drawn on the overlay canvas around the
// pivot at a constant size on screen. The half of a ring that faces the camera is the one that can be grabbed (the
// far half is drawn faint, as on a sphere); the nearest ring within the pick distance wins. A drag measures the angle
// the pointer has turned about the ring's axis, in the ring's plane (the pointer's ray against the plane through the
// pivot), so the grabbed point stays under the cursor; when that plane is edge-on to the ray the angle would explode,
// and the drag follows the pointer along the ring's on-screen tangent instead (decided when the drag begins, so it
// never switches half way). Every selected object (the topmost) turns about the shared pivot, the primary's origin:
// world position p' = pivot + R (p - pivot), world rotation q' = R q, each turned into a local transform through the
// object's own parent the way the engine composes transforms. Pure functions and a drag class that sends through
// TransformDrag (one undo step, Escape restores), unit tested in Node.
import type { Mat4, Quat, Vec3 } from "../protocol/protocol.generated"
import { GizmoDragDeps, GizmoTarget, TransformDrag, TransformResult } from "./viewport-drag"
import {
  Axis,
  Axes,
  AxisDirections,
  GizmoPickPixels,
  cameraPositionOf,
  gizmoFrame,
  localPositionAfterMove,
  rayPlane,
  snapTo,
} from "./viewport-gizmo"
import {
  Pixel,
  add,
  distanceToSegment,
  dot,
  isFiniteVec3,
  length,
  mat4Translation,
  normalize,
  quatConjugate,
  quatFromAxes,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  quatRotate,
  scale,
  screenRay,
  sub,
  vec3,
  wrapAngle,
  worldToScreen,
} from "./viewport-math"

/** A ring's radius in handle lengths (a little inside the translate handles, so the tools look alike in size) */
export const RingRadius = 0.85
/** How many segments a ring is drawn and picked as */
export const RingSegments = 72
/** A pointer ray more edge-on to the ring's plane than this (|cos| to its normal, about 12 degrees) is followed along the tangent */
export const RingMinRayFacing = 0.2
/** Ctrl rounds the angle to a multiple of this (U4's default; the settings are FE4's) */
export const RotateSnapRadians = (15 * Math.PI) / 180

/** The two world axes a ring runs in, so that the first turned toward the second is a positive turn about the ring's axis */
export const RingBasis: Readonly<Record<Axis, readonly [Vec3, Vec3]>> = {
  x: [AxisDirections.y, AxisDirections.z],
  y: [AxisDirections.z, AxisDirections.x],
  z: [AxisDirections.x, AxisDirections.y],
}

/** A point on a ring about the axis at the angle (radians from the first basis axis toward the second) */
export function ringPoint(axis: Axis, origin: Vec3, radius: number, angle: number): Vec3 {
  const [e1, e2] = RingBasis[axis]
  return add(origin, add(scale(e1, radius * Math.cos(angle)), scale(e2, radius * Math.sin(angle))))
}

/** One piece of a ring on screen, in the direction of increasing angle */
export interface RingSegment {
  from: Pixel
  to: Pixel
  /** On the half of the ring that faces the camera: drawn strong, and the only part that can be grabbed */
  front: boolean
}

export interface RingHandle {
  axis: Axis
  segments: RingSegment[]
}

export interface RotateLayout {
  origin: Pixel
  /** The world length of a handle (the translate gizmo's size) */
  worldLength: number
  /** The rings' radius in the world and, at the pivot, on screen */
  radiusWorld: number
  radiusPixels: number
  rings: RingHandle[]
}

/**
 * Where the rings are on a width x height viewport for a gizmo at origin; null when the origin is behind the camera.
 * A segment with an end behind the camera is left out.
 */
export function rotateLayout(
  view: Mat4,
  viewProjection: Mat4,
  origin: Vec3,
  width: number,
  height: number,
  pixelRatio: number = 1
): RotateLayout | null {
  const frame = gizmoFrame(view, viewProjection, origin, width, height, pixelRatio)
  if (!frame) return null
  const radiusWorld = frame.worldLength * RingRadius
  const toCamera = normalize(sub(cameraPositionOf(view), origin))
  const rings: RingHandle[] = []
  for (const axis of Axes) {
    const points: Array<Pixel | null> = []
    for (let i = 0; i <= RingSegments; i++) {
      const p = worldToScreen(viewProjection, ringPoint(axis, origin, radiusWorld, (i / RingSegments) * Math.PI * 2), width, height)
      points.push(p ? { x: p.x, y: p.y } : null)
    }
    const segments: RingSegment[] = []
    for (let i = 0; i < RingSegments; i++) {
      const from = points[i]
      const to = points[i + 1]
      if (!from || !to) continue
      // Which half the segment is on: its middle against the plane through the pivot facing the camera
      const middle = ringPoint(axis, origin, radiusWorld, ((i + 0.5) / RingSegments) * Math.PI * 2)
      segments.push({ from, to, front: dot(sub(middle, origin), toCamera) >= 0 })
    }
    rings.push({ axis, segments })
  }
  return { origin: frame.center, worldLength: frame.worldLength, radiusWorld, radiusPixels: radiusWorld * frame.pixelsPerUnit, rings }
}

/** The nearest front segment of a ring to a pixel, and how far */
function nearestFront(ring: RingHandle, pixel: Pixel): { segment: RingSegment; distance: number } | null {
  let best: { segment: RingSegment; distance: number } | null = null
  for (const segment of ring.segments) {
    if (!segment.front) continue
    const d = distanceToSegment(pixel, segment.from, segment.to)
    if (best === null || d < best.distance) best = { segment, distance: d }
  }
  return best
}

/** The ring under the pixel: the nearest within tolerance (CSS pixels times the ratio), by its front half; null for none */
export function hitTestRotate(
  layout: RotateLayout,
  pixel: Pixel,
  pixelRatio: number = 1,
  tolerance: number = GizmoPickPixels * pixelRatio
): Axis | null {
  let best: { axis: Axis; distance: number } | null = null
  for (const ring of layout.rings) {
    const near = nearestFront(ring, pixel)
    if (near && near.distance <= tolerance && (best === null || near.distance < best.distance)) {
      best = { axis: ring.axis, distance: near.distance }
    }
  }
  return best?.axis ?? null
}

/**
 * The on-screen unit direction in which the ring turns positively, where the pixel is nearest to the ring's front
 * half; null when the ring has no front segment of any length on screen.
 */
export function ringTangentAt(layout: RotateLayout, axis: Axis, pixel: Pixel): Pixel | null {
  const ring = layout.rings.find((r) => r.axis === axis)
  const near = ring ? nearestFront(ring, pixel) : null
  if (!near) return null
  const dx = near.segment.to.x - near.segment.from.x
  const dy = near.segment.to.y - near.segment.from.y
  const l = Math.hypot(dx, dy)
  return l > 1e-9 ? { x: dx / l, y: dy / l } : null
}

/**
 * The angle a ring drag has turned so far, in radians, positive about the axis by the right-hand rule and not wrapped
 * (a drag that goes round twice has turned 4 pi). In the ring's plane the angle is the pointer ray's hit point's angle
 * about the pivot against where it began; edge-on, it is the pointer's motion along the tangent over the ring's
 * on-screen radius.
 */
export class RotateDrag {
  private total = 0
  private previous: number

  private constructor(
    readonly axis: Axis,
    readonly mode: "plane" | "tangent",
    private readonly origin: Vec3,
    private readonly viewProjection: Mat4,
    private readonly width: number,
    private readonly height: number,
    private readonly farPlane: number,
    /** Plane mode: the angle of the first hit. Tangent mode: unused */
    start: number,
    private readonly start2d: Pixel,
    private readonly tangent: Pixel | null,
    private readonly radiusPixels: number
  ) {
    this.previous = start
  }

  /** The angle of a world point about the pivot in the ring's plane, null at the pivot itself */
  private static planeAngle(axis: Axis, origin: Vec3, point: Vec3): number | null {
    const [e1, e2] = RingBasis[axis]
    const v = sub(point, origin)
    if (!(length(v) > 1e-9)) return null
    return Math.atan2(dot(v, e2), dot(v, e1))
  }

  /**
   * Null when the drag can't begin: no ray can be made, or the ring is edge-on to the ray and has no front segment to
   * follow. farPlane is how far the pointer's ray may meet the ring's plane.
   */
  static begin(
    axis: Axis,
    layout: RotateLayout,
    origin: Vec3,
    viewProjection: Mat4,
    pixel: Pixel,
    width: number,
    height: number,
    farPlane: number = Infinity
  ): RotateDrag | null {
    const ray = screenRay(viewProjection, pixel.x, pixel.y, width, height)
    if (!ray) return null
    const hit = rayPlane(ray, origin, AxisDirections[axis], RingMinRayFacing)
    if (hit && hit.s <= farPlane) {
      const start = RotateDrag.planeAngle(axis, origin, hit.point)
      if (start !== null) {
        return new RotateDrag(axis, "plane", origin, viewProjection, width, height, farPlane, start, pixel, null, layout.radiusPixels)
      }
    }
    const tangent = ringTangentAt(layout, axis, pixel)
    if (!tangent || !(layout.radiusPixels > 1e-6)) return null
    return new RotateDrag(axis, "tangent", origin, viewProjection, width, height, farPlane, 0, pixel, tangent, layout.radiusPixels)
  }

  /** The angle turned so far for the pointer now; null (keep the last) when the pointer's ray can't be followed */
  angleAt(pixel: Pixel): number | null {
    if (this.mode === "tangent") {
      const t = this.tangent!
      const angle = ((pixel.x - this.start2d.x) * t.x + (pixel.y - this.start2d.y) * t.y) / this.radiusPixels
      if (!Number.isFinite(angle)) return null
      this.total = angle
      return this.total
    }
    const ray = screenRay(this.viewProjection, pixel.x, pixel.y, this.width, this.height)
    const hit = ray ? rayPlane(ray, this.origin, AxisDirections[this.axis], RingMinRayFacing) : null
    if (!hit || hit.s > this.farPlane) return null
    const angle = RotateDrag.planeAngle(this.axis, this.origin, hit.point)
    if (angle === null) return null
    // Each step is the shortest turn from the last, so the total goes past half a turn and stays continuous
    this.total += wrapAngle(angle - this.previous)
    this.previous = angle
    return this.total
  }
}

/**
 * The world rotation of an object's parent: from the parent's world matrix (its columns divided by their lengths) when
 * the editor read it, else derived from the object's own world matrix and local rotation, taking each column's sign
 * from the object's own local scale. Null when it can't be known: a scale of zero, or a mirror (an odd number of negative
 * scales in the parent chain makes the columns a left-handed set; which axis is mirrored can't be told from a matrix).
 * A parent with two negative scales reads as its rotation turned half a turn, which is the same world matrix; see the
 * README.
 */
export function parentRotationOf(target: GizmoTarget): Quat | null {
  const columns = (m: Mat4): [Vec3, Vec3, Vec3] => [
    vec3(m[0], m[1], m[2]),
    vec3(m[4], m[5], m[6]),
    vec3(m[8], m[9], m[10]),
  ]
  if (target.parentWorld) {
    const [c0, c1, c2] = columns(target.parentWorld)
    const lengths = [length(c0), length(c1), length(c2)]
    if (!lengths.every((l) => l > 1e-9)) return null
    return quatFromAxes(scale(c0, 1 / lengths[0]), scale(c1, 1 / lengths[1]), scale(c2, 1 / lengths[2]))
  }
  const [c0, c1, c2] = columns(target.worldMatrix)
  const l = target.localScale
  const lengths = [length(c0), length(c1), length(c2)]
  if (!lengths.every((len) => len > 1e-9) || l.x === 0 || l.y === 0 || l.z === 0) return null
  const world = quatFromAxes(
    scale(c0, 1 / (lengths[0] * Math.sign(l.x))),
    scale(c1, 1 / (lengths[1] * Math.sign(l.y))),
    scale(c2, 1 / (lengths[2] * Math.sign(l.z)))
  )
  // world = parent * local
  return world ? quatNormalize(quatMultiply(world, quatConjugate(target.localRotation))) : null
}

/**
 * One object turned by `angle` about the world axis through the pivot: its new local position and rotation (scale as it
 * was), or why it can't be (a string). The world rotation becomes R * q, so the local one is
 * parent^-1 * R * parent * local (the engine composes world = parent * local for rotations), and the world position
 * becomes pivot + R (p - pivot), moved as localPositionAfterMove moves it. An object at the pivot keeps its position
 * exactly (no arithmetic on it).
 */
export function rotatedTransform(
  target: GizmoTarget,
  index: number,
  pivot: Vec3,
  axis: Vec3,
  angle: number
): TransformResult {
  const turn = quatFromAxisAngle(axis, angle)
  const parent = parentRotationOf(target)
  if (!parent) return "can't be rotated: its parent is mirrored or has a scale of zero"
  let rotation = quatNormalize(quatMultiply(quatConjugate(parent), quatMultiply(turn, quatMultiply(parent, target.localRotation))))
  // q and -q are one rotation: keep the one near the old, so nothing flips sign for no reason
  const d = rotation.x * target.localRotation.x + rotation.y * target.localRotation.y + rotation.z * target.localRotation.z + rotation.w * target.localRotation.w
  if (d < 0) rotation = { x: -rotation.x, y: -rotation.y, z: -rotation.z, w: -rotation.w }
  let position = target.localPosition
  const offset = sub(mat4Translation(target.worldMatrix), pivot)
  if (length(offset) > 1e-9) {
    const moved = localPositionAfterMove(target, sub(quatRotate(turn, offset), offset))
    if (!moved) return "can't be moved: a scale of zero"
    position = moved
  }
  if (!isFiniteVec3(position) || ![rotation.x, rotation.y, rotation.z, rotation.w].every(Number.isFinite)) {
    return "can't be rotated: the result is not a number"
  }
  return { index, position, rotation, scale: target.localScale }
}

/** One rotate drag of one or several objects (the group, the batches and the ending are TransformDrag's) */
export class RotateGizmoDrag extends TransformDrag {
  /** The angle turned (radians, snapped when snapping), as the drag has set it */
  angle = 0

  constructor(
    deps: GizmoDragDeps,
    target: GizmoTarget | readonly GizmoTarget[],
    private readonly source: RotateDrag,
    /** The point every object turns about: the primary's world position when the drag began */
    private readonly pivot: Vec3,
    private readonly snap: boolean = false
  ) {
    super(deps, target, { step: "Rotate", failed: "Failed to rotate the object" })
  }

  /** The axis the ring turns about */
  get axis(): Axis {
    return this.source.axis
  }

  /** The pointer moved: the objects turn to the angle it says (null when the maths keeps the last ones) */
  update(pixel: Pixel, snap: boolean = this.snap): number | null {
    if (this.isFinished) return null
    let angle = this.source.angleAt(pixel)
    if (angle === null || !Number.isFinite(angle)) return null
    if (snap) angle = snapTo(angle, RotateSnapRadians)
    const axis = AxisDirections[this.source.axis]
    if (!this.submit(this.targets.map((t, index) => rotatedTransform(t, index, this.pivot, axis, angle!)))) return null
    this.angle = angle
    return angle
  }

  cancel(): Promise<void> {
    this.angle = 0
    return super.cancel()
  }
}

/** The angle as shown while dragging: "+37.5 deg" */
export function formatAngle(radians: number): string {
  const degrees = (radians * 180) / Math.PI
  const rounded = Math.round(degrees * 10) / 10
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)} deg`
}
