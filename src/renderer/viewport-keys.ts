// The viewport's keys: the fly keys (held while the right button is down: W A S D Q E and the arrows, Shift for faster),
// and the viewport's shortcuts, which are keymap actions (keymap.ts, scope "viewport": F frames the selection, Escape
// cancels the move in progress, W E R and Q choose the gizmo's tool: move, rotate, scale, none). Framework-free, so it is tested without a canvas; viewport-panel.tsx feeds it.
//
// Priority: the view's own keydown listener asks keyDown() first, and when it took a fly key it prevents the default.
// The keymap's dispatcher (at the document, after the view's listener) leaves a key that was prevented alone, so while
// the right button is held a fly key is never also a shortcut, whatever shortcuts are bound to it.
import { isTextEntry } from "./edit-actions"
import { Keymap } from "./keymap"
import { FlyKeys, PointerAction } from "./viewport-input"
import { GizmoMode, GizmoModeTitles } from "./viewport-controller"

/** The keymap action that chooses each tool */
export const ModeActions: Readonly<Record<GizmoMode, string>> = {
  translate: "gizmo.translate",
  rotate: "gizmo.rotate",
  scale: "gizmo.scale",
  none: "gizmo.none",
}

/** The viewport's tool as its label shows it: "Tool: Rotate (E)", with the first chord of its action (none when unbound) */
export function toolLabel(keymap: Keymap, mode: GizmoMode): string {
  const first = keymap.formatted(ModeActions[mode])[0]
  return `Tool: ${GizmoModeTitles[mode]}${first ? ` (${first})` : ""}`
}

/** What the keys need to know of, and do to, the view */
export interface ViewportKeyHost {
  /** What the mouse gesture in progress is, if there is one */
  gesture(): PointerAction | null
  /** Ends the gesture (a move in progress is cancelled) */
  endGesture(): void
  /** Frames the selected object */
  frameSelected(): void
  /** A game is live: the keys are the game's */
  live(): boolean
  /** Chooses the gizmo's tool; false when it can't be changed now (a drag is in progress). Without it the tool keys are not registered. */
  setMode?(mode: GizmoMode): boolean
}

export interface KeyEventLike {
  code: string
  shiftKey: boolean
  target: EventTarget | null
}

export class ViewportKeyboard {
  readonly keys = new FlyKeys()
  /** Shift is held: the fly camera goes faster */
  boost = false

  constructor(private readonly host: ViewportKeyHost) {}

  /**
   * A key went down in the view (outside a game): notes Shift, and takes a fly key while the right button is held.
   * Returns whether it took the key; the caller then prevents the default, so the keymap leaves it alone.
   */
  keyDown(e: KeyEventLike): boolean {
    if (isTextEntry(e.target as Element | null)) return false
    this.boost = e.shiftKey
    return this.host.gesture() === "look" && this.keys.down(e.code)
  }

  keyUp(e: KeyEventLike): void {
    this.boost = e.shiftKey
    this.keys.up(e.code)
  }

  /** Registers the viewport's actions for key presses inside `view`; returns the unregister */
  register(keymap: Keymap, view: Element): () => void {
    const off = [
      keymap.handle(
        "viewport.cancel",
        () => {
          // Only a move in progress is cancelled; any other Escape isn't the view's
          if (this.host.live() || this.host.gesture() !== "select") return false
          this.host.endGesture()
        },
        { within: view }
      ),
      keymap.handle(
        "viewport.frame",
        () => {
          if (this.host.live()) return false
          this.host.frameSelected()
        },
        { within: view }
      ),
    ]
    const setMode = this.host.setMode?.bind(this.host)
    if (setMode) {
      for (const mode of Object.keys(ModeActions) as GizmoMode[]) {
        off.push(
          keymap.handle(
            ModeActions[mode],
            () => {
              // The game's keys while it is live; not while a drag is in progress (the key is left alone)
              if (this.host.live()) return false
              return setMode(mode)
            },
            { within: view }
          )
        )
      }
    }
    return () => off.forEach((unregister) => unregister())
  }
}
