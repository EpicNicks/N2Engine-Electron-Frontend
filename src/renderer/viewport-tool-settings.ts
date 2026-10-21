// The gizmo's space and pivot, as the toolbar offers them (roadmap FE4, decision U3), and the maths they need: the axes a
// gizmo's handles run along (the world's, or the primary object's own in local space) and where the pivot is (the
// primary object's origin, or the centre of the selection's bounds). Pure functions and values, no DOM, no engine:
// tested in Node. Where the choices are kept is viewport-tool-prefs.ts.
import type { Mat4, Vec3 } from "../protocol/protocol.generated"
import type { Bounds } from "./viewport-camera"
import { AxisFrame, WorldAxes } from "./viewport-gizmo"
import { unionBounds } from "./viewport-picking"
import { mat4Translation, scale, add } from "./viewport-math"
import { worldAxesOf } from "./viewport-scale"

/** The space the move and rotate handles are in: the world's axes, or the primary object's own (local) */
export type GizmoSpace = "world" | "local"
export const GizmoSpaces: readonly GizmoSpace[] = ["world", "local"]
export const GizmoSpaceTitles: Readonly<Record<GizmoSpace, string>> = { world: "World", local: "Local" }

/** Where the gizmo sits, and what rotation and a uniform scale turn about: the primary object's origin, or the selection's centre */
export type GizmoPivot = "pivot" | "center"
export const GizmoPivots: readonly GizmoPivot[] = ["pivot", "center"]
export const GizmoPivotTitles: Readonly<Record<GizmoPivot, string>> = { pivot: "Pivot", center: "Center" }

export const otherSpace = (space: GizmoSpace): GizmoSpace => (space === "world" ? "local" : "world")
export const otherPivot = (pivot: GizmoPivot): GizmoPivot => (pivot === "pivot" ? "center" : "pivot")

/**
 * The axes the move and rotate handles run along. World space: the world's. Local space: the primary object's own, its
 * world matrix's columns with the scale stripped (the scale gizmo's axes too; a sheared parent chain makes them
 * approximate, as the README says). A column with no length falls back to the world axis.
 */
export function gizmoAxes(space: GizmoSpace, worldMatrix: Mat4 | null): AxisFrame {
  return space === "local" && worldMatrix ? worldAxesOf(worldMatrix) : WorldAxes
}

/** The centre of a box */
export function boundsCenter(box: Bounds): Vec3 {
  return scale(add(box.min, box.max), 0.5)
}

/**
 * Where the pivot is. "pivot": the primary object's world position. "center": the centre of the union of the selected
 * objects' bounds (what GetEntityBounds gave); the primary's position when there are none (a host without them, an
 * object it can't measure), so the gizmo never disappears for want of a box.
 */
export function pivotPosition(pivot: GizmoPivot, primaryWorld: Mat4, bounds: Iterable<Bounds>): Vec3 {
  const origin = mat4Translation(primaryWorld)
  if (pivot !== "center") return origin
  const union = unionBounds(bounds)
  if (!union) return origin
  const center = boundsCenter(union)
  return Number.isFinite(center.x) && Number.isFinite(center.y) && Number.isFinite(center.z) ? center : origin
}
