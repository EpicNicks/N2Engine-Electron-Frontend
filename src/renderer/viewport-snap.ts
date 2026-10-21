// The gizmo's snapping, as pure functions and the settings they take (roadmap FE4, decision U4): a rounding that is not
// fooled by floating point, a move snapped RELATIVE to where it began (the delta along each handle axis is rounded) or
// to an ABSOLUTE world grid, a turn snapped across the wrap of a full circle, a scale ratio snapped to a step, and the
// rule for Ctrl (it inverts the tool's snap toggle). No DOM, no engine: tested in Node.
import type { Vec3 } from "../protocol/protocol.generated"
import { add, dot, scale, vec3 } from "./viewport-math"

/** The three tools that have a snap (the select-only tool has none) */
export type SnapTool = "translate" | "rotate" | "scale"

/** How a move snaps: its delta to a multiple of the step (relative, the default) or the world position to a grid (absolute) */
export type TranslateSnapKind = "relative" | "absolute"
export const TranslateSnapKinds: readonly TranslateSnapKind[] = ["relative", "absolute"]

/** The snap settings: a toggle and an increment per tool (U4's defaults: move 0.5, rotate 15 degrees, scale 0.1) */
export interface SnapSettings {
  translate: { enabled: boolean; step: number; kind: TranslateSnapKind }
  /** The step is in degrees (what the person types); the maths takes radians (see stepRadians) */
  rotate: { enabled: boolean; stepDegrees: number }
  scale: { enabled: boolean; step: number }
}

export const DefaultSnapSettings: Readonly<SnapSettings> = {
  translate: { enabled: false, step: 0.5, kind: "relative" },
  rotate: { enabled: false, stepDegrees: 15 },
  scale: { enabled: false, step: 0.1 },
}

/** A fresh copy of the defaults (settings are changed by replacing them, never in place) */
export const defaultSnapSettings = (): SnapSettings => ({
  translate: { ...DefaultSnapSettings.translate },
  rotate: { ...DefaultSnapSettings.rotate },
  scale: { ...DefaultSnapSettings.scale },
})

/** The range an increment may have (a value outside it is refused by the toolbar and replaced by the default when stored) */
export const StepLimits: Readonly<Record<"translate" | "rotateDegrees" | "scale", { min: number; max: number }>> = {
  translate: { min: 0.0001, max: 100000 },
  rotateDegrees: { min: 0.01, max: 180 },
  scale: { min: 0.0001, max: 1000 },
}

/** Whether a step is a usable increment: a finite number within the limits */
export function validStep(value: unknown, limits: { min: number; max: number }): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= limits.min && value <= limits.max
}

/**
 * What a text field says about a step: the number, or null when it is not an acceptable increment (empty, not a number,
 * zero, negative or outside the limits). A decimal comma is read as a point.
 */
export function parseStep(text: string, limits: { min: number; max: number }): number | null {
  const trimmed = text.trim().replace(",", ".")
  if (trimmed === "" || !/^[+]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(trimmed)) return null
  const value = Number(trimmed)
  return validStep(value, limits) ? value : null
}

/** A step as a field shows it: no trailing zeros, no floating-point tail */
export function formatStep(value: number): string {
  return String(Number(value.toPrecision(10)))
}

export const degreesToRadians = (degrees: number): number => (degrees * Math.PI) / 180

/** The rotate step in radians */
export const stepRadians = (settings: SnapSettings): number => degreesToRadians(settings.rotate.stepDegrees)

/**
 * Whether a drag snaps: the tool's toggle, inverted while Ctrl is held (U4). With the toggle off Ctrl turns snapping on
 * (as it always did); with it on Ctrl turns it off for that drag.
 */
export function snapActive(toggle: boolean, ctrl: boolean): boolean {
  return toggle !== ctrl
}

/** Cleans the floating-point tail a product leaves (3 * 0.1 is 0.30000000000000004) and the sign of a zero */
function clean(value: number): number {
  if (value === 0) return 0
  const rounded = Number(value.toPrecision(12))
  return rounded === 0 ? 0 : rounded
}

/**
 * The value rounded to the nearest multiple of step (halves away from zero, so a value and its negative snap
 * alike), without the floating-point tail of the product and never to -0. A step that is not positive and finite, or a
 * value that is not finite, leaves the value as it is.
 */
export function snapValue(value: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(step) || !Number.isFinite(value)) return value
  const n = value / step
  const rounded = Math.sign(n) * Math.round(Math.abs(n))
  return clean(rounded * step)
}

/**
 * A move snapped RELATIVE to where it began: its component along each of the handle's axes (the axes are unit vectors,
 * the world's or the object's own) is rounded to a multiple of the step, and the move is rebuilt from them. With the
 * world axes this is the delta's x, y and z rounded, for the axes the handle moves along.
 */
export function snapDeltaRelative(delta: Vec3, axes: readonly Vec3[], step: number): Vec3 {
  let out = vec3(0, 0, 0)
  let rest = delta
  for (const axis of axes) {
    const along = dot(delta, axis)
    const snapped = snapValue(along, step)
    out = add(out, scale(axis, snapped))
    rest = add(rest, scale(axis, -along))
  }
  // What the handle's axes don't span (nothing, for an axis or a plane handle) stays as it was
  return add(out, rest)
}

/**
 * A move snapped to the ABSOLUTE world grid: where the pivot would be (origin + delta) is rounded to a multiple of the
 * step along each WORLD axis the handle moves along (`moved`: which of x, y, z), the move is the difference. Only for
 * handles along the world axes; a handle along an object's own (rotated) axis can't land on a world grid without leaving
 * its line, so the controller uses the relative snap there.
 */
export function snapDeltaAbsolute(origin: Vec3, delta: Vec3, moved: { x: boolean; y: boolean; z: boolean }, step: number): Vec3 {
  const axis = (o: number, d: number, on: boolean): number => (on ? snapValue(o + d, step) - o : d)
  return vec3(axis(origin.x, delta.x, moved.x), axis(origin.y, delta.y, moved.y), axis(origin.z, delta.z, moved.z))
}

/**
 * A turn snapped to a multiple of the step (both radians). The angle is the drag's TOTAL, not wrapped, so a drag that
 * goes past half a turn or round the whole circle keeps snapping to the multiples it passes (23.9 steps of 15 degrees
 * near a full turn is a full turn: the rotation that results is the identity's, the angle shown 360).
 */
export function snapAngle(radians: number, stepRad: number): number {
  return snapValue(radians, stepRad)
}

/** A scale ratio snapped to a multiple of the step, and never below one step (zero is not a scale to snap to) */
export function snapScaleRatio(ratio: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return ratio
  return Math.max(snapValue(ratio, step), step)
}
