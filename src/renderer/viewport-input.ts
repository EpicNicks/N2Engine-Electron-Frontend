// What the viewport's mouse and keys mean, as pure functions (the page's handlers only forward events to them):
//   left button            select (the gizmo's handle under the pointer takes it first)
//   Alt + left button      orbit
//   middle button          pan
//   right button           look (the fly camera); W A S D move, E and Q go up and down, Shift is faster
//   Alt + right button     dolly (drag up or down)
//   wheel                  zoom
//   F                      frame the selected object
import type { Vec3 } from "../protocol/protocol.generated"
import { vec3 } from "./viewport-math"

export type PointerAction = "select" | "orbit" | "pan" | "look" | "dolly" | "none"

export interface PointerModifiers {
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** What a pointer that went down with this button (MouseEvent.button) does while it is dragged */
export function pointerActionFor(button: number, modifiers: PointerModifiers): PointerAction {
  switch (button) {
    case 0:
      return modifiers.altKey ? "orbit" : "select"
    case 1:
      return "pan"
    case 2:
      return modifiers.altKey ? "dolly" : "look"
    default:
      return "none"
  }
}

/** A press that moved less than this many pixels is a click, not a drag */
export const ClickSlop = 4

export function isClick(down: { x: number; y: number }, up: { x: number; y: number }, slop: number = ClickSlop): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= slop
}

/** A wheel event's deltaMode: pixels, lines or pages */
export const DomDeltaPixel = 0
export const DomDeltaLine = 1
export const DomDeltaPage = 2

/** A wheel event's delta in pixels, whatever the unit it came in; capped so one fast flick can't jump across the scene */
export function wheelPixels(deltaY: number, deltaMode: number): number {
  const factor = deltaMode === DomDeltaLine ? 16 : deltaMode === DomDeltaPage ? 400 : 1
  const pixels = deltaY * factor
  if (!Number.isFinite(pixels)) return 0
  return Math.max(-400, Math.min(400, pixels))
}

/** The fly keys (KeyboardEvent.code, so a layout other than QWERTY keeps them in place) */
const FlyAxes: Readonly<Record<string, Vec3>> = {
  KeyW: vec3(0, 0, 1),
  ArrowUp: vec3(0, 0, 1),
  KeyS: vec3(0, 0, -1),
  ArrowDown: vec3(0, 0, -1),
  KeyD: vec3(1, 0, 0),
  ArrowRight: vec3(1, 0, 0),
  KeyA: vec3(-1, 0, 0),
  ArrowLeft: vec3(-1, 0, 0),
  KeyE: vec3(0, 1, 0),
  KeyQ: vec3(0, -1, 0),
}

export const isFlyKey = (code: string): boolean => Object.prototype.hasOwnProperty.call(FlyAxes, code)

/** The fly keys held down */
export class FlyKeys {
  private readonly held = new Set<string>()

  /** Returns whether the key is a fly key (and so was taken) */
  down(code: string): boolean {
    if (!isFlyKey(code)) return false
    this.held.add(code)
    return true
  }

  up(code: string): void {
    this.held.delete(code)
  }

  /** The window lost the focus, or the look ended: a key released elsewhere is never seen */
  clear(): void {
    this.held.clear()
  }

  get any(): boolean {
    return this.held.size > 0
  }

  /** The direction held: x right, y up, z forward, each -1 to 1 (opposite keys cancel) */
  direction(): Vec3 {
    let x = 0
    let y = 0
    let z = 0
    for (const code of this.held) {
      const axis = FlyAxes[code]
      x += axis.x
      y += axis.y
      z += axis.z
    }
    const clamp = (v: number): number => Math.max(-1, Math.min(1, v))
    return vec3(clamp(x), clamp(y), clamp(z))
  }
}

export type ViewportShortcut = "frameSelected"

/** The viewport's key shortcuts; nothing for a key with Ctrl, Alt or Meta (those are the editor's) */
export function shortcutFor(event: { code: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): ViewportShortcut | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null
  return event.code === "KeyF" ? "frameSelected" : null
}
