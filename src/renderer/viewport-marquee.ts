// Marquee selection in the viewport (FE12): a left drag that begins on empty space (not on a gizmo handle) and goes
// past the click slop draws a rectangle; on release the objects whose projected world box (GetEntityBounds, the host's
// AABB of the object and everything under it) intersects the rectangle are selected, or with Alt only those fully
// inside it. Shift adds them to the selection, Ctrl (or Cmd) removes them; neither replaces it. The maths, the
// candidates, the bounds cache and the selection rule are here, with no DOM, so they are unit tested in Node; the
// controller (viewport-controller.ts) runs the gesture and the panel (viewport-panel.tsx) draws the rectangle.
import { batch } from "@preact/signals-core"
import type { Mat4, Vec3 } from "../protocol/protocol.generated"
import type { Bounds } from "./viewport-camera"
import type { ClickModifiers, HierarchyTree, Selection } from "./hierarchy-tree"
import { emptySelection } from "./hierarchy-tree"
import type { Pixel } from "./viewport-math"
import { BoxEdges, boxCorners } from "./viewport-gizmo"

/** A rectangle in frame pixels (top-left origin), min not above max */
export interface Rect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** The rectangle between two corners, in any order */
export const rectFrom = (a: Pixel, b: Pixel): Rect => ({
  minX: Math.min(a.x, b.x),
  minY: Math.min(a.y, b.y),
  maxX: Math.max(a.x, b.x),
  maxY: Math.max(a.y, b.y),
})

/** The part of the rectangle on the frame (the pointer is captured and can leave it); null when none of it is */
export function clampRect(r: Rect, width: number, height: number): Rect | null {
  const out = { minX: Math.max(0, r.minX), minY: Math.max(0, r.minY), maxX: Math.min(width, r.maxX), maxY: Math.min(height, r.maxY) }
  return out.minX <= out.maxX && out.minY <= out.maxY ? out : null
}

/** What the marquee does with what it found: replace the selection, add to it (Shift) or remove from it (Ctrl/Cmd) */
export type MarqueeOp = "replace" | "add" | "remove"

/** The keys held, as the marquee reads them (at the release; the drawing follows them during the drag) */
export interface MarqueeKeys {
  /** Alt: only the objects fully inside the rectangle (Alt at the PRESS orbits instead: see viewport-input.ts) */
  inside: boolean
  /** Shift */
  add: boolean
  /** Ctrl or Cmd */
  remove: boolean
}

export const NoMarqueeKeys: MarqueeKeys = { inside: false, add: false, remove: false }

/** The keys of a pointer event */
export const marqueeKeysOf = (e: { altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): MarqueeKeys => ({
  inside: e.altKey,
  add: e.shiftKey,
  remove: e.ctrlKey || e.metaKey,
})

/** Ctrl/Cmd (remove) wins over Shift (add) when both are held */
export const marqueeOpOf = (keys: MarqueeKeys): MarqueeOp => (keys.remove ? "remove" : keys.add ? "add" : "replace")

interface Clip {
  x: number
  y: number
  z: number
  w: number
}

const toClip = (m: Mat4, p: Vec3): Clip => ({
  x: m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
  y: m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
  z: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
  w: m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15],
})

/** A box on screen: the rectangle around its projection, and whether part of it is behind the near plane */
export interface ProjectedBox {
  rect: Rect
  /** Some of the box is behind the camera's near plane: only the part in front is in rect, so it is never "fully inside" */
  clipped: boolean
}

/**
 * The rectangle on screen around a world box, as the selection box is drawn (projectBox in viewport-gizmo.ts): every
 * edge is clipped against the near plane in clip space before the perspective divide, so a box with corners behind
 * the eye still gives the rectangle of the part in front, and a box wholly behind the near plane gives null. The
 * rectangle around the clipped corners holds the projected box (its projection is the convex hull of those points).
 */
export function projectBounds(viewProjection: Mat4, box: Bounds, width: number, height: number): ProjectedBox | null {
  const corners = boxCorners(box.min, box.max).map((c) => toClip(viewProjection, c))
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let clipped = false
  const addPoint = (c: Clip): void => {
    if (!(c.w > 0)) return
    const x = (c.x / c.w * 0.5 + 0.5) * width
    const y = (1 - (c.y / c.w * 0.5 + 0.5)) * height
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const [i, j] of BoxEdges) {
    let a = corners[i]
    let b = corners[j]
    // Inside the near plane: z + w >= 0 (the depth range is -1 to 1)
    const da = a.z + a.w
    const db = b.z + b.w
    if (!(da >= 0 || db >= 0)) {
      clipped = true
      continue
    }
    if (da < 0 || db < 0) {
      clipped = true
      const t = da / (da - db)
      const cut: Clip = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, w: a.w + (b.w - a.w) * t }
      if (da < 0) a = cut
      else b = cut
    }
    addPoint(a)
    addPoint(b)
  }
  if (minX > maxX || minY > maxY) return null
  return { rect: { minX, minY, maxX, maxY }, clipped }
}

/** Whether two rectangles share any point (touching edges count) */
export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY

/** Whether `inner` lies wholly within `outer` */
export const rectContains = (outer: Rect, inner: Rect): boolean =>
  inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY

/** Whether the marquee takes this box: it intersects the rectangle, or (inside) lies wholly in it and in front of the camera */
export function marqueeTakes(rect: Rect, projected: ProjectedBox | null, inside: boolean): boolean {
  if (!projected) return false
  if (inside) return !projected.clipped && rectContains(rect, projected.rect)
  return rectsIntersect(rect, projected.rect)
}

/** The ids (in the candidates' order) whose box the marquee takes; an id with no box is not taken */
export function marqueeHits(
  viewProjection: Mat4,
  width: number,
  height: number,
  rect: Rect,
  candidates: readonly string[],
  bounds: ReadonlyMap<string, Bounds>,
  inside: boolean
): string[] {
  const hits: string[] = []
  for (const id of candidates) {
    const box = bounds.get(id)
    if (box && marqueeTakes(rect, projectBounds(viewProjection, box, width, height), inside)) hits.push(id)
  }
  return hits
}

/**
 * The objects a marquee may select: every object of the hierarchy that is active in it, in the tree's order (a click
 * does not pick an inactive object either: PickEntity is asked without includeInactive)
 */
export const marqueeCandidatesOf = (tree: HierarchyTree): string[] =>
  tree.order.filter((id) => tree.nodes.get(id)?.activeInHierarchy !== false)

/**
 * The selection after a marquee found `hits` (in the tree's order). Replace: just them (the last is the primary; none
 * clears the selection, as a click on empty space does). Add: them as well (the primary stays; with none it is the
 * last hit). Remove: the selection without them (the primary stays unless it was removed). The same object when
 * nothing changes.
 */
export function marqueeSelection(selection: Selection, hits: readonly string[], op: MarqueeOp): Selection {
  if (op === "replace") {
    if (hits.length === 0) return selection.ids.size === 0 ? selection : emptySelection
    return { ids: new Set(hits), anchor: hits[0], primary: hits[hits.length - 1] }
  }
  if (op === "add") {
    const fresh = hits.filter((id) => !selection.ids.has(id))
    if (fresh.length === 0) return selection
    const ids = new Set([...selection.ids, ...fresh])
    return { ids, anchor: selection.anchor ?? hits[0], primary: selection.primary ?? hits[hits.length - 1] }
  }
  const removed = new Set(hits)
  if (![...selection.ids].some((id) => removed.has(id))) return selection
  const ids = new Set([...selection.ids].filter((id) => !removed.has(id)))
  const primary = selection.primary !== null && ids.has(selection.primary) ? selection.primary : ([...ids].pop() ?? null)
  const anchor = selection.anchor !== null && ids.has(selection.anchor) ? selection.anchor : null
  return { ids, anchor, primary }
}

/**
 * The world boxes of the marquee's candidates, read once per key (the scene's revision, the connection and the
 * controller's count of scene changes): a marquee over an unchanged scene asks the host nothing. A read in flight is
 * shared; a failed one is not kept. The backend chunks the ids (GetEntityBounds takes at most 4096 per call).
 */
export class MarqueeBoundsCache {
  private key: string | null = null
  private value: Promise<ReadonlyMap<string, Bounds>> | null = null

  constructor(private readonly measure: (ids: string[]) => Promise<ReadonlyMap<string, Bounds> | null>) {}

  get(key: string, ids: readonly string[]): Promise<ReadonlyMap<string, Bounds>> {
    if (this.key === key && this.value) return this.value
    this.key = key
    const value = this.measure([...ids]).then((found) => found ?? new Map<string, Bounds>())
    this.value = value
    value.catch(() => {
      if (this.value === value) this.clear()
    })
    return value
  }

  /** Whether the boxes for this key are held (or being read) */
  has(key: string): boolean {
    return this.key === key && this.value !== null
  }

  clear(): void {
    this.key = null
    this.value = null
  }
}

/** The part of the hierarchy's state a marquee changes (HierarchyState) */
export interface MarqueeSelectionTarget {
  readonly selection: { peek(): Selection }
  setSelection(selection: Selection): void
  /** Opens the way to an object, so its row is shown */
  expandAncestors(id: string): void
}

/**
 * Applies a marquee's hits to the hierarchy's selection (marqueeSelection): the objects it selects have their rows
 * shown (as a click in the view does), and nothing happens when the selection would not change
 */
export function applyMarquee(target: MarqueeSelectionTarget, hits: readonly string[], op: MarqueeOp): void {
  const current = target.selection.peek()
  const next = marqueeSelection(current, hits, op)
  if (next === current) return
  batch(() => {
    if (op !== "remove") for (const id of hits) target.expandAncestors(id)
    target.setSelection(next)
  })
}

/** The keys of a pointer event the select gesture reads */
export interface PointerKeys {
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

/** What the left-button (select) gesture calls on the controller (ViewportController) */
export interface SelectGestureTarget {
  pointerDown(pixel: Pixel, ctrl: boolean): boolean
  pointerMove(pixel: Pixel, ctrl: boolean, keys: MarqueeKeys): void
  pointerUp(pixel: Pixel, modifiers: ClickModifiers, keys: MarqueeKeys): Promise<void>
}

/**
 * The panel's left-button gesture, event by event (viewport-panel.tsx calls these; the DOM tests drive them with real
 * pointer events). Ctrl at the press inverts a gizmo drag's snapping; at the release of a click, Ctrl/Cmd or Shift
 * toggles the picked object; for a marquee the keys at the release choose inside/intersect and add/remove/replace.
 */
export const selectGesture = {
  down: (target: SelectGestureTarget, pixel: Pixel, e: PointerKeys): boolean => target.pointerDown(pixel, e.ctrlKey),
  move: (target: SelectGestureTarget, pixel: Pixel, e: PointerKeys): void => target.pointerMove(pixel, e.ctrlKey, marqueeKeysOf(e)),
  up: (target: SelectGestureTarget, pixel: Pixel, e: PointerKeys): Promise<void> =>
    target.pointerUp(pixel, { toggle: e.ctrlKey || e.metaKey || e.shiftKey }, marqueeKeysOf(e)),
}
