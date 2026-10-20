// The viewport's keys: the fly keys (held while the right button is down: W A S D Q E and the arrows, Shift for faster),
// and the viewport's shortcuts, which are keymap actions (keymap.ts, scope "viewport": F frames the selection, Escape
// cancels the move in progress). Framework-free, so it is tested without a canvas; viewport-panel.tsx feeds it.
//
// Priority: the view's own keydown listener asks keyDown() first, and when it took a fly key it prevents the default.
// The keymap's dispatcher (at the document, after the view's listener) leaves a key that was prevented alone, so while
// the right button is held a fly key is never also a shortcut, whatever shortcuts are bound to it.
import { isTextEntry } from "./edit-actions"
import { Keymap } from "./keymap"
import { FlyKeys, PointerAction } from "./viewport-input"

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
    return () => off.forEach((unregister) => unregister())
  }
}
