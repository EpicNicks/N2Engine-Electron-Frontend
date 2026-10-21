// The scale gizmo (roadmap candidate 1, FE3): three axis handles with a cube at the end, along the primary object's own
// (local) axes, and a uniform handle at the centre, at a constant size on screen. Scale is always local, as the
// roadmap decided (as in Unity): the handles point along the primary's world rotation (its world matrix's columns,
// scale stripped) because the local scale it changes is along those. A drag is a RATIO: an axis handle's is where the
// pointer's ray meets the axis now over where it met it when the drag began; the centre handle's is the pointer's
// distance from the pivot on screen over where it began. The ratio is clamped away from zero (a drag through zero
// stops at a small positive ratio instead of flipping or making a degenerate matrix), and every selected object's
// local scale is multiplied by it along the handle's axis (all three for the centre handle, which also scales the
// objects' offsets from the shared pivot). An object that is already mirrored (a negative scale) stays so: it is
// multiplied, never set. Pure functions and a drag class that sends through TransformDrag, unit tested in Node.
import type { Mat4, Vec3 } from "../protocol/protocol.generated"
import { GizmoDragDeps, GizmoTarget, TransformDrag, TransformResult } from "./viewport-drag"
import {
  Axis,
  Axes,
  AxisDirections,
  GizmoPickPixels,
  GizmoSizePixels,
  MinHandlePixels,
  gizmoFrame,
  localPositionAfterMove,
  snapTo,
} from "./viewport-gizmo"
import {
  Pixel,
  add,
  closestOnLine,
  distanceToSegment,
  isFiniteVec3,
  length,
  mat4Translation,
  normalize,
  scale,
  screenRay,
  sub,
  vec3,
  worldToScreen,
} from "./viewport-math"

export type ScaleHandleId = Axis | "uniform"

/** The smallest ratio a drag gives: dragging through zero stops here, never flips the sign or makes a degenerate matrix */
export const MinScaleRatio = 0.001
/** The largest (a ray near the axis's vanishing point meets it far away) */
export const MaxScaleRatio = 1000
/** Ctrl rounds the ratio to a multiple of this (and not below it) (U4's default; the settings are FE4's) */
export const ScaleSnapStep = 0.1
/**
 * A drag that begins closer to the pivot than this many handle lengths (an axis) changes the scale by the distance moved
 * over this, not over the distance it began at (which would make a grab near the pivot jump)
 */
export const ScaleMinReference = 0.3
/** The centre handle's reach, half its side, in CSS pixels; the end cubes' half side */
export const ScaleCenterPixels = 9
export const ScaleCubePixels = 5

export interface ScaleHandle {
  axis: Axis
  from: Pixel
  to: Pixel
}

export interface ScaleLayout {
  origin: Pixel
  worldLength: number
  /** The handles' directions in the world (the primary's axes) */
  directions: Readonly<Record<Axis, Vec3>>
  handles: ScaleHandle[]
}

/** An object's world axes from its world matrix: the columns normalised (scale stripped); a column with no length is the world axis */
export function worldAxesOf(m: Mat4): Record<Axis, Vec3> {
  const column = (a: number, fallback: Vec3): Vec3 => {
    const c = vec3(m[a], m[a + 1], m[a + 2])
    return length(c) > 1e-9 ? normalize(c) : fallback
  }
  return { x: column(0, AxisDirections.x), y: column(4, AxisDirections.y), z: column(8, AxisDirections.z) }
}

/** Where the handles are for a gizmo at origin with the axes; null when the origin is behind the camera. A handle pointing at the camera is left out. */
export function scaleLayout(
  view: Mat4,
  viewProjection: Mat4,
  origin: Vec3,
  directions: Readonly<Record<Axis, Vec3>>,
  width: number,
  height: number,
  pixelRatio: number = 1
): ScaleLayout | null {
  const frame = gizmoFrame(view, viewProjection, origin, width, height, pixelRatio)
  if (!frame) return null
  const handles: ScaleHandle[] = []
  for (const axis of Axes) {
    const end = worldToScreen(viewProjection, add(origin, scale(directions[axis], frame.worldLength)), width, height)
    if (!end || Math.hypot(end.x - frame.center.x, end.y - frame.center.y) < MinHandlePixels * pixelRatio) continue
    handles.push({ axis, from: { ...frame.center }, to: { x: end.x, y: end.y } })
  }
  return { origin: frame.center, worldLength: frame.worldLength, directions, handles }
}

/**
 * The handle under the pixel: the centre (a square) first, then the nearest axis handle (its line and cube) within
 * tolerance; null for none.
 */
export function hitTestScale(
  layout: ScaleLayout,
  pixel: Pixel,
  pixelRatio: number = 1,
  tolerance: number = GizmoPickPixels * pixelRatio
): ScaleHandleId | null {
  const reach = ScaleCenterPixels * pixelRatio
  if (Math.abs(pixel.x - layout.origin.x) <= reach && Math.abs(pixel.y - layout.origin.y) <= reach) return "uniform"
  let best: { axis: Axis; distance: number } | null = null
  for (const handle of layout.handles) {
    const d = distanceToSegment(pixel, handle.from, handle.to)
    if (d <= tolerance && (best === null || d < best.distance)) best = { axis: handle.axis, distance: d }
  }
  return best?.axis ?? null
}

/** A ratio of the change over its reference, kept within the clamp */
function clampRatio(ratio: number): number {
  return Math.max(MinScaleRatio, Math.min(MaxScaleRatio, ratio))
}

/**
 * The ratio a scale drag has made so far: 1 when it began. For an axis handle, 1 + (t - t0) / max(t0, reference) where
 * t is the pointer's ray's nearest point along the axis (from the pivot) now and t0 when it began, which is t / t0
 * unless the drag began near the pivot. For the centre handle, the same with the pointer's distance from the pivot on
 * screen. Null when the pointer's ray can't be followed.
 */
export class ScaleDrag {
  private constructor(
    readonly handle: ScaleHandleId,
    private readonly origin: Vec3,
    private readonly direction: Vec3,
    private readonly viewProjection: Mat4,
    private readonly width: number,
    private readonly height: number,
    private readonly farPlane: number,
    private readonly start: number,
    private readonly reference: number,
    private readonly centre: Pixel
  ) {}

  /** Null when the drag can't begin (no ray, or a ray along the axis) */
  static begin(
    handle: ScaleHandleId,
    layout: ScaleLayout,
    origin: Vec3,
    viewProjection: Mat4,
    pixel: Pixel,
    width: number,
    height: number,
    pixelRatio: number = 1,
    farPlane: number = Infinity
  ): ScaleDrag | null {
    if (handle === "uniform") {
      // Signed: motion up and to the right grows, down and to the left shrinks, so the ratio can fall to the clamp
      const reference = 0.5 * GizmoSizePixels * pixelRatio
      return new ScaleDrag(handle, origin, vec3(0, 0, 0), viewProjection, width, height, farPlane, 0, reference, pixel)
    }
    const direction = layout.directions[handle]
    const ray = screenRay(viewProjection, pixel.x, pixel.y, width, height)
    const hit = ray ? closestOnLine(ray, origin, direction) : null
    if (!hit || !(hit.s > 0) || hit.s > farPlane) return null
    const reference = Math.max(hit.t, ScaleMinReference * layout.worldLength)
    return new ScaleDrag(handle, origin, direction, viewProjection, width, height, farPlane, hit.t, reference, layout.origin)
  }

  ratioAt(pixel: Pixel): number | null {
    if (this.handle === "uniform") {
      const along = (pixel.x - this.centre.x - (pixel.y - this.centre.y)) * Math.SQRT1_2
      return clampRatio(1 + along / this.reference)
    }
    const ray = screenRay(this.viewProjection, pixel.x, pixel.y, this.width, this.height)
    const hit = ray ? closestOnLine(ray, this.origin, this.direction) : null
    // Behind the camera or beyond the far plane the nearest point runs off to infinity: not followed
    if (!hit || !(hit.s > 0) || hit.s > this.farPlane) return null
    const ratio = 1 + (hit.t - this.start) / this.reference
    return Number.isFinite(ratio) ? clampRatio(ratio) : null
  }
}

/** The ratio snapped (Ctrl): a multiple of the step, and never below one step (zero is not a scale to snap to) */
export function snapRatio(ratio: number, step: number = ScaleSnapStep): number {
  return Math.max(snapTo(ratio, step), step)
}

/**
 * One object scaled by the ratio: along its local axis (the handle's index) or, for the centre handle, along all three,
 * its offset from the pivot scaling with it (an object at the pivot keeps its position exactly). The local scale is
 * multiplied, so a negative scale stays negative and a zero one stays zero. Rotation as it was. A string says why not.
 */
export function scaledTransform(
  target: GizmoTarget,
  index: number,
  pivot: Vec3,
  handle: ScaleHandleId,
  ratio: number
): TransformResult {
  const s = target.localScale
  const scaled =
    handle === "uniform"
      ? vec3(s.x * ratio, s.y * ratio, s.z * ratio)
      : vec3(handle === "x" ? s.x * ratio : s.x, handle === "y" ? s.y * ratio : s.y, handle === "z" ? s.z * ratio : s.z)
  let position = target.localPosition
  if (handle === "uniform") {
    const offset = sub(mat4Translation(target.worldMatrix), pivot)
    if (length(offset) > 1e-9) {
      const moved = localPositionAfterMove(target, scale(offset, ratio - 1))
      if (!moved) return "can't be moved: a scale of zero"
      position = moved
    }
  }
  if (!isFiniteVec3(scaled) || !isFiniteVec3(position)) return "can't be scaled: the result is not a number"
  return { index, position, rotation: target.localRotation, scale: scaled }
}

/** One scale drag of one or several objects (the group, the batches and the ending are TransformDrag's) */
export class ScaleGizmoDrag extends TransformDrag {
  /** The ratio (snapped when snapping), as the drag has set it */
  ratio = 1

  constructor(
    deps: GizmoDragDeps,
    target: GizmoTarget | readonly GizmoTarget[],
    private readonly source: ScaleDrag,
    /** The point the centre handle scales the objects' offsets about: the primary's world position when the drag began */
    private readonly pivot: Vec3,
    private readonly snap: boolean = false
  ) {
    super(deps, target, { step: "Scale", failed: "Failed to scale the object" })
  }

  /** The handle being dragged */
  get handle(): ScaleHandleId {
    return this.source.handle
  }

  /** The pointer moved: the objects scale to the ratio it says (null when the maths keeps the last ones) */
  update(pixel: Pixel, snap: boolean = this.snap): number | null {
    if (this.isFinished) return null
    let ratio = this.source.ratioAt(pixel)
    if (ratio === null) return null
    if (snap) ratio = snapRatio(ratio)
    const handle = this.source.handle
    if (!this.submit(this.targets.map((t, index) => scaledTransform(t, index, this.pivot, handle, ratio!)))) return null
    this.ratio = ratio
    return ratio
  }

  cancel(): Promise<void> {
    this.ratio = 1
    return super.cancel()
  }
}

/** The ratio as shown while dragging: "x1.25" */
export function formatRatio(ratio: number): string {
  return `x${ratio.toFixed(2)}`
}
