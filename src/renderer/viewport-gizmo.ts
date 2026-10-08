// The translate gizmo (engine #6 decision: gizmos are drawn and hit-tested on the client, from the camera's matrices
// and the selected object's world matrix, and a drag sends SetLocalTransform inside an edit group). Three axis
// handles, in world axes, at a constant size on screen. The geometry, the hit test and the drag's maths are pure
// functions; GizmoDrag runs one drag against the engine and the edit groups (fakes in tests, so it is unit tested).
//
// The drag moves the object along one world axis: the pointer's ray is intersected (nearest point) with the axis line
// through the object as it was when the drag began, and the object follows the change of that point along the line, so
// it stays under the cursor. The world move is turned into a LOCAL position change through the parent's world matrix
// (the object's world matrix and local transform give the parent's), so a rotated or scaled parent is right.
import type { Mat4, Quat, Vec3 } from "../protocol/protocol.generated"
import type { EditGroups, GroupHandle } from "./edit-groups"
import { LatestWinsSender } from "./viewport-frames"
import {
  Pixel,
  add,
  distanceToSegment,
  closestOnLine,
  dot,
  isFiniteVec3,
  length,
  mat4Translation,
  quatRotate,
  scale,
  screenRay,
  vec3,
  worldToScreen,
} from "./viewport-math"

export type Axis = "x" | "y" | "z"
export const Axes: readonly Axis[] = ["x", "y", "z"]
export const AxisDirections: Readonly<Record<Axis, Vec3>> = {
  x: vec3(1, 0, 0),
  y: vec3(0, 1, 0),
  z: vec3(0, 0, 1),
}

/** How long the handles are on screen, in CSS pixels (times devicePixelRatio in frame pixels) */
export const GizmoSizePixels = 96
/** How close (pixels) the pointer has to be to a handle to take it */
export const GizmoPickPixels = 8
/** A handle that points at the camera, shorter than this on screen, can't be grabbed or drawn */
export const MinHandlePixels = 12

export interface GizmoHandle {
  axis: Axis
  from: Pixel
  to: Pixel
}

export interface GizmoLayout {
  origin: Pixel
  /** The world length of a handle: the gizmo's size in pixels, whatever the distance */
  worldLength: number
  handles: GizmoHandle[]
}

/**
 * Where the gizmo is on a width x height viewport, for an object at origin: its handles' ends, sized to GizmoSizePixels
 * on screen. Null when the object is behind the camera. The camera's right (for the world size of a pixel) is read
 * from the view matrix's first row.
 */
export function gizmoLayout(
  view: Mat4,
  viewProjection: Mat4,
  origin: Vec3,
  width: number,
  height: number,
  pixelRatio: number = 1
): GizmoLayout | null {
  const sizePixels = GizmoSizePixels * pixelRatio
  const center = worldToScreen(viewProjection, origin, width, height)
  if (!center) return null
  const right = vec3(view[0], view[4], view[8])
  const beside = worldToScreen(viewProjection, add(origin, right), width, height)
  const pixelsPerUnit = beside ? Math.hypot(beside.x - center.x, beside.y - center.y) : 0
  if (!(pixelsPerUnit > 1e-6)) return null
  const worldLength = sizePixels / pixelsPerUnit

  const handles: GizmoHandle[] = []
  for (const axis of Axes) {
    const end = worldToScreen(viewProjection, add(origin, scale(AxisDirections[axis], worldLength)), width, height)
    if (!end || Math.hypot(end.x - center.x, end.y - center.y) < MinHandlePixels * pixelRatio) continue
    handles.push({ axis, from: { x: center.x, y: center.y }, to: { x: end.x, y: end.y } })
  }
  return { origin: { x: center.x, y: center.y }, worldLength, handles }
}

/** The handle under the pixel, the nearest within tolerance; null for none */
export function hitTestGizmo(
  layout: GizmoLayout,
  pixel: Pixel,
  pixelRatio: number = 1,
  tolerance: number = GizmoPickPixels * pixelRatio
): Axis | null {
  let best: { axis: Axis; distance: number } | null = null
  for (const handle of layout.handles) {
    const d = distanceToSegment(pixel, handle.from, handle.to)
    if (d <= tolerance && (best === null || d < best.distance)) best = { axis: handle.axis, distance: d }
  }
  return best?.axis ?? null
}

/** The selected object as the gizmo needs it: GetEntity's local transform and world matrix */
export interface GizmoTarget {
  id: string
  name: string
  localPosition: Vec3
  localRotation: Quat
  localScale: Vec3
  worldMatrix: Mat4
}

/**
 * The local position after moving the object by deltaWorld in the world. The engine does not compose
 * world = parentWorld * local: Transform::Combine gives position = pPos + pRot * (pScale * lPos), rotation =
 * pRot * lRot and scale = pScale * lScale (per component), and the world matrix is T * R * S, so there is no skew. The
 * world matrix gives gRot (its normalised columns) and gScale (their lengths), hence pRot = gRot * lRot^-1 and
 * pScale = gScale / lScale, and the local change is S(pScale)^-1 * R(pRot)^-1 * deltaWorld, with
 * R(pRot)^-1 = R(lRot) * R(gRot)^-1. Null when a scale is zero (nothing can be divided by it).
 */
export function localPositionAfterMove(target: GizmoTarget, deltaWorld: Vec3): Vec3 | null {
  const m = target.worldMatrix
  const c0 = vec3(m[0], m[1], m[2])
  const c1 = vec3(m[4], m[5], m[6])
  const c2 = vec3(m[8], m[9], m[10])
  const gScale = vec3(length(c0), length(c1), length(c2))
  const l = target.localScale
  if (!(gScale.x > 1e-9 && gScale.y > 1e-9 && gScale.z > 1e-9) || l.x === 0 || l.y === 0 || l.z === 0) return null
  // R(gRot)^-1 * delta: the columns are the rotation's axes (times the scale), so the inverse takes dot products with them
  const inGlobalFrame = vec3(
    dot(deltaWorld, c0) / gScale.x,
    dot(deltaWorld, c1) / gScale.y,
    dot(deltaWorld, c2) / gScale.z
  )
  const rotated = quatRotate(target.localRotation, inGlobalFrame)
  const pScale = vec3(gScale.x / Math.abs(l.x), gScale.y / Math.abs(l.y), gScale.z / Math.abs(l.z))
  const local = vec3(rotated.x / pScale.x, rotated.y / pScale.y, rotated.z / pScale.z)
  if (!isFiniteVec3(local)) return null
  return add(target.localPosition, local)
}

/** The drag's move rounded to a multiple of step (ctrl held) */
export function snapTo(value: number, step: number): number {
  return step > 0 ? Math.round(value / step) * step : value
}

export const SnapStep = 0.5

/**
 * The move along an axis a drag has made so far: the world distance between where the pointer's ray met the axis line
 * when the drag began and where it meets it now. Null while the ray runs along the axis (the answer would explode).
 */
export class AxisDrag {
  private readonly startParam: number
  /** The last move accepted: a jump from it of more than maxStep is cut to maxStep */
  private last = 0

  private constructor(
    readonly axis: Axis,
    private readonly origin: Vec3,
    private readonly viewProjection: Mat4,
    private readonly width: number,
    private readonly height: number,
    startParam: number,
    private readonly farPlane: number,
    private readonly maxStep: number
  ) {
    this.startParam = startParam
  }

  /**
   * Null when the drag can't start (the pointer's ray can't be made, or runs along the axis). farPlane is how far the
   * pointer's ray may meet the axis, and maxStep how far one update may move the object: near the axis's vanishing
   * point the nearest point runs off to infinity, and neither a point behind the camera nor a jump to it is followed.
   */
  static begin(
    axis: Axis,
    origin: Vec3,
    viewProjection: Mat4,
    pixel: Pixel,
    width: number,
    height: number,
    farPlane: number = Infinity,
    maxStep: number = Infinity
  ): AxisDrag | null {
    const ray = screenRay(viewProjection, pixel.x, pixel.y, width, height)
    const hit = ray ? closestOnLine(ray, origin, AxisDirections[axis]) : null
    return hit === null ? null : new AxisDrag(axis, origin, viewProjection, width, height, hit.t, farPlane, maxStep)
  }

  /**
   * The world move for the pointer now. Null (keep the last one) while the ray runs along the axis, or meets it behind
   * the camera or beyond the far plane; otherwise cut to maxStep from the last move.
   */
  moveAt(pixel: Pixel): number | null {
    const ray = screenRay(this.viewProjection, pixel.x, pixel.y, this.width, this.height)
    const hit = ray ? closestOnLine(ray, this.origin, AxisDirections[this.axis]) : null
    if (!hit || !(hit.s > 0) || hit.s > this.farPlane) return null
    const move = hit.t - this.startParam
    if (!Number.isFinite(move)) return null
    this.last = Math.max(this.last - this.maxStep, Math.min(this.last + this.maxStep, move))
    return this.last
  }
}

/** What GizmoDrag needs of the engine and of the edit groups */
export interface GizmoDragDeps {
  engine: { setLocalTransform(entityId: string, position: Vec3, rotation: Quat, scale: Vec3): Promise<void> }
  groups: Pick<EditGroups, "begin" | "end">
  /** A refused or failed move, once it has been reported the drag goes on */
  onError(what: string, error: unknown): void
  /** The object's position changed on the host's side (after each move is sent): the frame is asked for again */
  onMoved?(): void
}

/**
 * One translate drag, from the press on a handle to the release: BeginEditGroup first, then at most one
 * SetLocalTransform in flight (the latest position wins), then EndEditGroup, so the drag is one undo step however
 * many moves it sent; releasing without having moved changes nothing (the host records no step for an empty group).
 */
export class GizmoDrag {
  /** Where the object is now (local), as the drag has set it */
  position: Vec3
  private readonly sender: LatestWinsSender<Vec3>
  private readonly began: Promise<GroupHandle | null>
  private finished: Promise<void> | null = null
  /** Whether a position was ever pushed */
  moved = false
  /** The move in the world the drag has made (the snapped distance along its axis) */
  worldDelta: Vec3 = vec3(0, 0, 0)

  constructor(
    private readonly deps: GizmoDragDeps,
    private readonly target: GizmoTarget,
    private readonly drag: AxisDrag,
    private readonly snap: boolean = false
  ) {
    this.position = target.localPosition
    this.began = deps.groups.begin(`Move ${target.name}`)
    this.sender = new LatestWinsSender<Vec3>(
      async (position) => {
        // The group is open before the first edit goes
        await this.began
        await deps.engine.setLocalTransform(target.id, position, target.localRotation, target.localScale)
        deps.onMoved?.()
      },
      (e) => deps.onError("Failed to move the object", e)
    )
  }

  /** The pointer moved: the object goes where the handle's axis says (null from the maths keeps the last position) */
  update(pixel: Pixel, snap: boolean = this.snap): Vec3 | null {
    if (this.finished) return null
    let along = this.drag.moveAt(pixel)
    if (along === null || !Number.isFinite(along)) return null
    if (snap) along = snapTo(along, SnapStep)
    const local = localPositionAfterMove(this.target, scale(AxisDirections[this.drag.axis], along))
    if (!local) return null
    this.position = local
    this.worldDelta = scale(AxisDirections[this.drag.axis], along)
    this.moved = true
    this.sender.push(local)
    return local
  }

  /** The pointer was released: the last position is sent, and the group ends */
  end(): Promise<void> {
    this.finished ??= this.finish()
    return this.finished
  }

  /**
   * The connection went or the scene was replaced: what is waiting to be sent is dropped (it is for objects that are
   * gone), and the group ends. A move already on its way can't be recalled.
   */
  abandon(): Promise<void> {
    if (!this.finished) {
      this.sender.discard()
      this.finished = this.finish()
    }
    return this.finished
  }

  /**
   * Escape: the object goes back to where it was, and the group ends. The group still holds the move and the move
   * back, so the host records a "Move" step that changes nothing (its FinishGroup skips only a group with no
   * edits): it marks the scene as changed and clears redo. Escape is kept as it is until the host skips such groups.
   */
  cancel(): Promise<void> {
    if (!this.finished) {
      if (this.moved) {
        this.position = this.target.localPosition
        this.worldDelta = vec3(0, 0, 0)
        this.sender.push(this.target.localPosition)
      }
      this.finished = this.finish()
    }
    return this.finished
  }

  private async finish(): Promise<void> {
    const handle = await this.began
    await this.sender.flush()
    await this.deps.groups.end(handle)
  }
}

/** The 12 edges of a box, as pairs of corner indexes into boxCorners' result */
export const BoxEdges: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 3], [3, 2], [2, 0],
  [4, 5], [5, 7], [7, 6], [6, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
] // prettier-ignore

/** The corners of an axis-aligned box (the index's bits are x, y, z: 1 takes max) */
export function boxCorners(min: Vec3, max: Vec3): Vec3[] {
  const corners: Vec3[] = []
  for (let i = 0; i < 8; i++) {
    corners.push(vec3(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z))
  }
  return corners
}

/**
 * The selection box's edges on screen (the box is the host's world AABB from GetEntityBounds, when the host has one):
 * the edges whose both ends are in front of the camera, as pixel pairs
 */
export function projectBox(
  viewProjection: Mat4,
  min: Vec3,
  max: Vec3,
  width: number,
  height: number
): Array<[Pixel, Pixel]> {
  const corners = boxCorners(min, max).map((c) => worldToScreen(viewProjection, c, width, height))
  const edges: Array<[Pixel, Pixel]> = []
  for (const [a, b] of BoxEdges) {
    const from = corners[a]
    const to = corners[b]
    if (from && to) edges.push([{ x: from.x, y: from.y }, { x: to.x, y: to.y }])
  }
  return edges
}

/** The object's world position, from its world matrix */
export const worldPosition = mat4Translation
