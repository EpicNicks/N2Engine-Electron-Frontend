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
  closestParamOnLine,
  distanceToSegment,
  mat4Compose,
  mat4Invert,
  mat4Multiply,
  mat4Translation,
  mat4TransformDirection,
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

/** How long the handles are on screen, in pixels */
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
  sizePixels: number = GizmoSizePixels
): GizmoLayout | null {
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
    if (!end || Math.hypot(end.x - center.x, end.y - center.y) < MinHandlePixels) continue
    handles.push({ axis, from: { x: center.x, y: center.y }, to: { x: end.x, y: end.y } })
  }
  return { origin: { x: center.x, y: center.y }, worldLength, handles }
}

/** The handle under the pixel, the nearest within tolerance; null for none */
export function hitTestGizmo(layout: GizmoLayout, pixel: Pixel, tolerance: number = GizmoPickPixels): Axis | null {
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

/** The object's parent's world matrix: world = parentWorld * local, so parentWorld = world * local^-1; null when singular */
export function parentWorldMatrix(target: GizmoTarget): Mat4 | null {
  const inverse = mat4Invert(mat4Compose(target.localPosition, target.localRotation, target.localScale))
  return inverse ? mat4Multiply(target.worldMatrix, inverse) : null
}

/**
 * The local position after moving the object by deltaWorld in the world: the parent's inverse turns the move into
 * the parent's space, where the local position lives. Null when the parent can't be inverted (a zero scale).
 */
export function localPositionAfterMove(target: GizmoTarget, deltaWorld: Vec3): Vec3 | null {
  const parent = parentWorldMatrix(target)
  const inverse = parent ? mat4Invert(parent) : null
  if (!inverse) return null
  return add(target.localPosition, mat4TransformDirection(inverse, deltaWorld))
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

  private constructor(
    readonly axis: Axis,
    private readonly origin: Vec3,
    private readonly viewProjection: Mat4,
    private readonly width: number,
    private readonly height: number,
    startParam: number
  ) {
    this.startParam = startParam
  }

  /** Null when the drag can't start (the pointer's ray can't be made, or runs along the axis) */
  static begin(
    axis: Axis,
    origin: Vec3,
    viewProjection: Mat4,
    pixel: Pixel,
    width: number,
    height: number
  ): AxisDrag | null {
    const ray = screenRay(viewProjection, pixel.x, pixel.y, width, height)
    const t = ray ? closestParamOnLine(ray, origin, AxisDirections[axis]) : null
    return t === null ? null : new AxisDrag(axis, origin, viewProjection, width, height, t)
  }

  /** The world move for the pointer now (the last one's answer is kept by the caller when this is null) */
  moveAt(pixel: Pixel): number | null {
    const ray = screenRay(this.viewProjection, pixel.x, pixel.y, this.width, this.height)
    const t = ray ? closestParamOnLine(ray, this.origin, AxisDirections[this.axis]) : null
    return t === null ? null : t - this.startParam
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

  /** Escape: the object goes back to where it was, and the group ends with nothing in it (so no undo step) */
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
