// The translate gizmo (engine #6 decision: gizmos are drawn and hit-tested on the client, from the camera's matrices
// and the selected objects' world matrices, and a drag sends SetLocalTransform inside an edit group). Three axis
// handles and three plane handles (small squares between the axes, on the side facing the camera), in world axes, at a
// constant size on screen. The geometry, the hit test and the drag's maths are pure functions; GizmoDrag runs one drag
// of one or several objects against the engine and the edit groups (fakes in tests, so it is unit tested).
//
// An axis drag moves along one world axis: the pointer's ray is intersected (nearest point) with the axis line through
// the gizmo as it was when the drag began, and the objects follow the change of that point along the line. A plane drag
// intersects the ray with the plane through the gizmo and follows the change of the hit point in the plane. Either way
// the pointer stays on the handle. Every selected object moves by the same WORLD delta, each turned into a LOCAL
// position change through its own parent chain the way the engine composes transforms (localPositionAfterMove).
import type { Mat4, Quat, Vec3 } from "../protocol/protocol.generated"
import type { EditGroups, GroupHandle } from "./edit-groups"
import { LatestWinsSender } from "./viewport-frames"
import {
  Pixel,
  add,
  distanceToSegment,
  closestOnLine,
  dot,
  normalize,
  sub,
  isFiniteVec3,
  length,
  mat4Invert,
  mat4TransformDirection,
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

export type Plane = "xy" | "xz" | "yz"
export const Planes: readonly Plane[] = ["xy", "xz", "yz"]
/** A handle of the gizmo: an axis, or a plane (named by the two axes it moves along) */
export type HandleId = Axis | Plane
export const isPlane = (handle: HandleId): handle is Plane => handle.length === 2
/** The two axes a plane moves along, and the axis it is perpendicular to */
export const PlaneAxes: Readonly<Record<Plane, { a: Axis; b: Axis; normal: Axis }>> = {
  xy: { a: "x", b: "y", normal: "z" },
  xz: { a: "x", b: "z", normal: "y" },
  yz: { a: "y", b: "z", normal: "x" },
}

/** How long the handles are on screen, in CSS pixels (times devicePixelRatio in frame pixels) */
export const GizmoSizePixels = 96
/** How close (pixels) the pointer has to be to a handle to take it */
export const GizmoPickPixels = 8
/** A handle that points at the camera, shorter than this on screen, can't be grabbed or drawn */
export const MinHandlePixels = 12
/** A plane handle is a square from PlaneNear to PlaneFar handle lengths along both of its axes */
export const PlaneNear = 0.3
export const PlaneFar = 0.65
/**
 * How much a plane faces the camera: |cos| of the angle between its normal and the direction to the camera. Below
 * PlaneMinFacing the plane is nearly edge-on and its handle is hidden (and can't be grabbed); it fades in up to
 * PlaneFullFacing.
 */
export const PlaneMinFacing = 0.12
export const PlaneFullFacing = 0.3
/** A pointer ray more edge-on to the plane than this (|cos| to its normal) meets it too far away to follow */
export const PlaneMinRayFacing = 0.05

export interface GizmoHandle {
  axis: Axis
  from: Pixel
  to: Pixel
}

export interface PlaneHandle {
  plane: Plane
  /** The square's corners on screen, in order around it */
  corners: [Pixel, Pixel, Pixel, Pixel]
  /** 0 to 1: how far the plane faces the camera (the handle fades as it turns edge-on) */
  alpha: number
}

export interface GizmoLayout {
  origin: Pixel
  /** The world length of a handle: the gizmo's size in pixels, whatever the distance */
  worldLength: number
  handles: GizmoHandle[]
  planes: PlaneHandle[]
}

/** The camera's world position, from its view matrix (the inverse of a rigid transform) */
export function cameraPositionOf(view: Mat4): Vec3 {
  return vec3(
    -(view[0] * view[12] + view[1] * view[13] + view[2] * view[14]),
    -(view[4] * view[12] + view[5] * view[13] + view[6] * view[14]),
    -(view[8] * view[12] + view[9] * view[13] + view[10] * view[14])
  )
}

/**
 * Where the gizmo is on a width x height viewport, for a gizmo at origin: its handles' ends, sized to GizmoSizePixels
 * on screen, and its plane squares, on the side of each axis that faces the camera and left out when the plane is
 * nearly edge-on. Null when the origin is behind the camera. The camera's right (for the world size of a pixel) is read
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

  const toCamera = normalize(sub(cameraPositionOf(view), origin))
  const planes: PlaneHandle[] = []
  for (const plane of Planes) {
    const { a, b, normal } = PlaneAxes[plane]
    const facing = Math.abs(dot(toCamera, AxisDirections[normal]))
    if (!(facing >= PlaneMinFacing)) continue
    // The square lies on the camera's side of both axes, so it is in front of the handles and never behind the gizmo
    const sa = dot(toCamera, AxisDirections[a]) >= 0 ? 1 : -1
    const sb = dot(toCamera, AxisDirections[b]) >= 0 ? 1 : -1
    const corner = (u: number, v: number): Pixel | null => {
      const world = add(
        origin,
        add(scale(AxisDirections[a], sa * u * worldLength), scale(AxisDirections[b], sb * v * worldLength))
      )
      const screen = worldToScreen(viewProjection, world, width, height)
      return screen ? { x: screen.x, y: screen.y } : null
    }
    const corners = [corner(PlaneNear, PlaneNear), corner(PlaneFar, PlaneNear), corner(PlaneFar, PlaneFar), corner(PlaneNear, PlaneFar)]
    if (corners.some((c) => c === null)) continue
    const alpha = Math.max(0, Math.min(1, (facing - PlaneMinFacing) / (PlaneFullFacing - PlaneMinFacing)))
    planes.push({ plane, corners: corners as PlaneHandle["corners"], alpha })
  }
  return { origin: { x: center.x, y: center.y }, worldLength, handles, planes }
}

/** Whether a pixel is inside a convex quad (on its edge counts) */
export function pointInQuad(p: Pixel, quad: readonly Pixel[]): boolean {
  let side = 0
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i]
    const b = quad[(i + 1) % quad.length]
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (cross === 0) continue
    const sign = Math.sign(cross)
    if (side === 0) side = sign
    else if (sign !== side) return false
  }
  return true
}

/**
 * The handle under the pixel. An axis handle within tolerance of the pixel wins (the nearest, if several), because the
 * axes are thin and sit over the squares when the view is oblique; otherwise the plane square that holds the pixel
 * (the one facing the camera most, if squares overlap on screen); null for none.
 */
export function hitTestGizmo(
  layout: GizmoLayout,
  pixel: Pixel,
  pixelRatio: number = 1,
  tolerance: number = GizmoPickPixels * pixelRatio
): HandleId | null {
  let best: { axis: Axis; distance: number } | null = null
  for (const handle of layout.handles) {
    const d = distanceToSegment(pixel, handle.from, handle.to)
    if (d <= tolerance && (best === null || d < best.distance)) best = { axis: handle.axis, distance: d }
  }
  if (best) return best.axis
  let plane: PlaneHandle | null = null
  for (const candidate of layout.planes) {
    if (pointInQuad(pixel, candidate.corners) && (plane === null || candidate.alpha > plane.alpha)) plane = candidate
  }
  return plane?.plane ?? null
}

/** The selected object as the gizmo needs it: GetEntity's local transform and world matrix */
export interface GizmoTarget {
  id: string
  name: string
  localPosition: Vec3
  localRotation: Quat
  localScale: Vec3
  worldMatrix: Mat4
  /**
   * The object's parent's world matrix (the identity for a root), when the editor has read it. With it the move is
   * exact whatever the signs of the scales; without it the parent is derived from the object's own world matrix, which
   * can't tell a mirrored parent from a mirrored child.
   */
  parentWorld?: Mat4
}

/**
 * The local position after moving the object by deltaWorld in the world. The engine does not compose
 * world = parentWorld * local as matrices: Transform::Combine gives position = pPos + pRot * (pScale * lPos), rotation =
 * pRot * lRot and scale = pScale * lScale (per component), and the world matrix is T * R * S.
 *
 * With the parent's world matrix P = T * R * S (target.parentWorld) the position is pPos + R * S * lPos = pPos +
 * P_linear * lPos, so the local change is P_linear^-1 * deltaWorld, whatever the signs of the scales (a mirrored parent
 * or child, a child with a zero scale). Null when P has no inverse.
 *
 * Without it the parent is derived from the object's world matrix: gRot is its columns normalised, gScale their
 * lengths, so pRot = gRot * lRot^-1 and pScale = gScale / lScale, and the local change is S(pScale)^-1 * R(pRot)^-1 *
 * deltaWorld, with R(pRot)^-1 = R(lRot) * R(gRot)^-1. A column's sign is not in the matrix: it is taken from the
 * object's own local scale (the parent's scale is assumed positive), which is right for a mirrored child and wrong
 * for a mirrored parent, hence parentWorld. Null when a scale is zero (nothing can be divided by it).
 */
export function localPositionAfterMove(target: GizmoTarget, deltaWorld: Vec3): Vec3 | null {
  if (target.parentWorld) {
    const inverse = mat4Invert(target.parentWorld)
    if (!inverse) return null
    const local = mat4TransformDirection(inverse, deltaWorld)
    return isFiniteVec3(local) ? add(target.localPosition, local) : null
  }
  const m = target.worldMatrix
  const c0 = vec3(m[0], m[1], m[2])
  const c1 = vec3(m[4], m[5], m[6])
  const c2 = vec3(m[8], m[9], m[10])
  const gScale = vec3(length(c0), length(c1), length(c2))
  const l = target.localScale
  if (!(gScale.x > 1e-9 && gScale.y > 1e-9 && gScale.z > 1e-9) || l.x === 0 || l.y === 0 || l.z === 0) return null
  // R(gRot)^-1 * delta: the rotation's axes are the columns divided by their (signed) scale, and the inverse takes
  // dot products with them
  const inGlobalFrame = vec3(
    dot(deltaWorld, c0) / (gScale.x * Math.sign(l.x)),
    dot(deltaWorld, c1) / (gScale.y * Math.sign(l.y)),
    dot(deltaWorld, c2) / (gScale.z * Math.sign(l.z))
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

/** What a drag of a handle gives: its handle, and the world move for the pointer now */
export interface DragSource {
  readonly handle: HandleId
  /** The move in the world since the drag began; null (keep the last one) when the pointer's ray can't be followed */
  deltaAt(pixel: Pixel): Vec3 | null
}

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

  get handle(): Axis {
    return this.axis
  }

  deltaAt(pixel: Pixel): Vec3 | null {
    const along = this.moveAt(pixel)
    return along === null ? null : scale(AxisDirections[this.axis], along)
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

/** The pointer's ray against a plane: where it meets it, and how far along the ray; null when it can't (too edge-on, or behind) */
export function rayPlane(
  ray: { origin: Vec3; direction: Vec3 },
  point: Vec3,
  normal: Vec3,
  minFacing: number = PlaneMinRayFacing
): { point: Vec3; s: number } | null {
  const denominator = dot(ray.direction, normal)
  if (!(Math.abs(denominator) >= minFacing)) return null
  const s = dot(sub(point, ray.origin), normal) / denominator
  if (!(s > 0) || !Number.isFinite(s)) return null
  return { point: add(ray.origin, scale(ray.direction, s)), s }
}

/**
 * The move in a plane a drag has made so far: the pointer's ray is intersected with the plane through the gizmo, and the
 * move is the change of the hit point, so the gizmo stays under the cursor. Like the axis drag it follows no ray that
 * meets the plane behind the camera or beyond the far plane (a nearly edge-on plane sends the hit to infinity), and cuts
 * one update's jump to maxStep.
 */
export class PlaneDrag implements DragSource {
  private last: Vec3 = vec3(0, 0, 0)

  private constructor(
    readonly handle: Plane,
    private readonly origin: Vec3,
    private readonly viewProjection: Mat4,
    private readonly width: number,
    private readonly height: number,
    private readonly start: Vec3,
    private readonly farPlane: number,
    private readonly maxStep: number
  ) {}

  /** Null when the drag can't start: the pointer's ray can't be made, or meets the plane edge-on, behind or too far */
  static begin(
    plane: Plane,
    origin: Vec3,
    viewProjection: Mat4,
    pixel: Pixel,
    width: number,
    height: number,
    farPlane: number = Infinity,
    maxStep: number = Infinity
  ): PlaneDrag | null {
    const ray = screenRay(viewProjection, pixel.x, pixel.y, width, height)
    const hit = ray ? rayPlane(ray, origin, AxisDirections[PlaneAxes[plane].normal]) : null
    if (!hit || hit.s > farPlane) return null
    return new PlaneDrag(plane, origin, viewProjection, width, height, hit.point, farPlane, maxStep)
  }

  deltaAt(pixel: Pixel): Vec3 | null {
    const ray = screenRay(this.viewProjection, pixel.x, pixel.y, this.width, this.height)
    const hit = ray ? rayPlane(ray, this.origin, AxisDirections[PlaneAxes[this.handle].normal]) : null
    if (!hit || hit.s > this.farPlane) return null
    const raw = sub(hit.point, this.start)
    if (!isFiniteVec3(raw)) return null
    const step = sub(raw, this.last)
    const l = length(step)
    this.last = l > this.maxStep ? add(this.last, scale(step, this.maxStep / l)) : raw
    return this.last
  }
}

/** What GizmoDrag needs of the engine and of the edit groups */
export interface GizmoDragDeps {
  engine: { setLocalTransform(entityId: string, position: Vec3, rotation: Quat, scale: Vec3): Promise<void> }
  groups: Pick<EditGroups, "begin" | "end">
  /** A refused or failed move (an object that is gone, say): reported, and the drag goes on with the others */
  onError(what: string, error: unknown): void
  /** The objects' positions changed on the host's side (after each move is sent): the frame is asked for again */
  onMoved?(): void
}

interface Move {
  index: number
  position: Vec3
}

/** The host's refusal for an object that is not (or no longer) in the scene: "<what> not found: <id>" */
const NotFound = /not found/i

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * One translate drag of one or several objects, from the press on a handle to the release: BeginEditGroup first, then
 * at most one batch of SetLocalTransform calls in flight (the latest positions win; a batch's calls are sent together,
 * since they share one ordered connection), then EndEditGroup, so the drag is one undo step however many moves it sent
 * and however many objects it moved. Releasing without having moved changes nothing. A failure is reported once per
 * object; an object the host says is not found is left out of the rest of the drag, one that failed otherwise is tried
 * again with the next move. An abandoned drag (the connection went, the scene was replaced) sends nothing more, even of
 * a batch it was in the middle of, and says nothing about what that costs. The targets must be the topmost of the
 * selection: an object under another that moves would be moved twice.
 */
export class GizmoDrag {
  /** Where the first object is now (local), as the drag has set it */
  position: Vec3
  private readonly sender: LatestWinsSender<Move[]>
  private readonly began: Promise<GroupHandle | null>
  private finished: Promise<void> | null = null
  private abandoned = false
  /** Objects the host does not have (any more) */
  private readonly dead = new Set<number>()
  /** Objects whose failure has been reported, and those whose skipping has: once per drag each */
  private readonly reported = new Set<number>()
  private readonly skipReported = new Set<number>()
  /** Objects a move was ever pushed for (what Escape puts back) */
  private readonly movedIndexes = new Set<number>()
  private readonly targets: readonly GizmoTarget[]
  /** Whether a position was ever pushed */
  moved = false
  /** The move in the world the drag has made (the snapped delta); every object moved by it */
  worldDelta: Vec3 = vec3(0, 0, 0)

  constructor(
    private readonly deps: GizmoDragDeps,
    target: GizmoTarget | readonly GizmoTarget[],
    private readonly drag: DragSource,
    private readonly snap: boolean = false
  ) {
    this.targets = Array.isArray(target) ? target : [target as GizmoTarget]
    this.position = this.targets[0].localPosition
    this.began = deps.groups.begin(
      this.targets.length === 1 ? `Move ${this.targets[0].name}` : `Move ${this.targets.length} objects`
    )
    this.sender = new LatestWinsSender<Move[]>(async (moves) => {
      // The group is open before the first edit goes
      await this.began
      await Promise.all(moves.map((move) => this.send(move)))
      if (!this.abandoned) deps.onMoved?.()
    })
  }

  private async send(move: Move): Promise<void> {
    if (this.abandoned || this.dead.has(move.index)) return
    const t = this.targets[move.index]
    try {
      await this.deps.engine.setLocalTransform(t.id, move.position, t.localRotation, t.localScale)
    } catch (e) {
      // After an abandon the failure is the connection's or the scene's going: nothing to say about it
      if (this.abandoned) return
      if (NotFound.test(messageOf(e))) this.dead.add(move.index)
      if (!this.reported.has(move.index)) {
        this.reported.add(move.index)
        this.deps.onError("Failed to move the object", e)
      }
    }
  }

  /**
   * The pointer moved: the objects go where the handle says (null when the maths keeps the last positions). Snapping
   * rounds the delta along each axis the handle moves along.
   */
  update(pixel: Pixel, snap: boolean = this.snap): Vec3 | null {
    if (this.finished) return null
    let delta = this.drag.deltaAt(pixel)
    if (delta === null || !isFiniteVec3(delta)) return null
    if (snap) {
      const axes = this.drag.handle
      delta = vec3(
        axes.includes("x") ? snapTo(delta.x, SnapStep) : delta.x,
        axes.includes("y") ? snapTo(delta.y, SnapStep) : delta.y,
        axes.includes("z") ? snapTo(delta.z, SnapStep) : delta.z
      )
    }
    const moves: Move[] = []
    this.targets.forEach((t, index) => {
      const position = localPositionAfterMove(t, delta!)
      if (position) {
        moves.push({ index, position })
        this.movedIndexes.add(index)
      } else if (!this.skipReported.has(index)) {
        this.skipReported.add(index)
        this.deps.onError("Failed to move the object", new Error(`${t.name} can't be moved: a scale of zero`))
      }
    })
    if (moves.length === 0) return null
    this.position = moves[0].index === 0 ? moves[0].position : this.position
    this.worldDelta = delta
    this.moved = true
    this.sender.push(moves)
    return this.position
  }

  /** The pointer was released: the last positions are sent, and the group ends */
  end(): Promise<void> {
    this.finished ??= this.finish()
    return this.finished
  }

  /**
   * The connection went or the scene was replaced: what is waiting to be sent is dropped (it is for objects that are
   * gone), a batch being sent stops before its next call, and the group ends. A call already on its way can't be
   * recalled.
   */
  abandon(): Promise<void> {
    this.abandoned = true
    if (!this.finished) {
      this.sender.discard()
      this.finished = this.finish()
    }
    return this.finished
  }

  /**
   * Escape: the objects that were moved go back to where they were, and the group ends. The group still holds the move
   * and the move back, so the host records a "Move" step that changes nothing (its FinishGroup skips only a group with
   * no edits): it marks the scene as changed and clears redo. Escape is kept as it is until the host skips such groups.
   */
  cancel(): Promise<void> {
    if (!this.finished) {
      if (this.moved) {
        this.position = this.targets[0].localPosition
        this.worldDelta = vec3(0, 0, 0)
        this.sender.push([...this.movedIndexes].map((index) => ({ index, position: this.targets[index].localPosition })))
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
