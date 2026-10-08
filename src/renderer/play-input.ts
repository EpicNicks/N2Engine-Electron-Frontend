// Input over the game view, forwarded to the play child with SendInput (protocol 1.10.0). The child has no keyboard or
// mouse of its own, so the page turns each key, button, pointer move and wheel event over the game's picture into an
// InputEvent. Pure: the DOM glue (viewport-panel.tsx) only calls these, and the sender and the clock are given, so it is
// unit tested in Node.
//
// Key names are the engine's Input::Key enum names, and DOM's KeyboardEvent.code is a physical key position, which is
// what a game's bindings (W A S D) mean. A button is Left, Right, Middle or Button4 to Button8. The pointer is in frame
// pixels, top-left origin (the same as PickEntity's). The wheel is in lines (one notch is about 1).
import { MaxInputEventsPerBatch, PlayInputEvent } from "../shared/api"

const CodeToKey: Readonly<Record<string, string>> = (() => {
  const keys: Record<string, string> = {
    Space: "Space",
    Quote: "Apostrophe",
    Comma: "Comma",
    Minus: "Minus",
    Period: "Period",
    Slash: "Slash",
    Semicolon: "Semicolon",
    Equal: "Equal",
    BracketLeft: "LeftBracket",
    Backslash: "Backslash",
    BracketRight: "RightBracket",
    Backquote: "GraveAccent",
    Escape: "Escape",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Insert: "Insert",
    Delete: "Delete",
    ArrowRight: "Right",
    ArrowLeft: "Left",
    ArrowDown: "Down",
    ArrowUp: "Up",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Home: "Home",
    End: "End",
    CapsLock: "CapsLock",
    ScrollLock: "ScrollLock",
    NumLock: "NumLock",
    PrintScreen: "PrintScreen",
    Pause: "Pause",
    NumpadDecimal: "KpDecimal",
    NumpadDivide: "KpDivide",
    NumpadMultiply: "KpMultiply",
    NumpadSubtract: "KpSubtract",
    NumpadAdd: "KpAdd",
    NumpadEnter: "KpEnter",
    NumpadEqual: "KpEqual",
    ShiftLeft: "LeftShift",
    ControlLeft: "LeftControl",
    AltLeft: "LeftAlt",
    MetaLeft: "LeftSuper",
    ShiftRight: "RightShift",
    ControlRight: "RightControl",
    AltRight: "RightAlt",
    MetaRight: "RightSuper",
    ContextMenu: "Menu",
  }
  for (let c = 0; c < 26; c++) keys[`Key${String.fromCharCode(65 + c)}`] = String.fromCharCode(65 + c)
  for (let d = 0; d <= 9; d++) {
    keys[`Digit${d}`] = `Key${d}`
    keys[`Numpad${d}`] = `Kp${d}`
  }
  for (let f = 1; f <= 12; f++) keys[`F${f}`] = `F${f}`
  return keys
})()

/** The engine's key name for a KeyboardEvent.code, or null for a key the engine has no name for */
export function engineKeyOf(code: string): string | null {
  return Object.prototype.hasOwnProperty.call(CodeToKey, code) ? CodeToKey[code] : null
}

const ButtonNames: readonly string[] = ["Left", "Middle", "Right", "Button4", "Button5"]

/** The engine's name for a MouseEvent.button (0 left, 1 middle, 2 right, 3 and 4 the side buttons), or null */
export function engineButtonOf(button: number): string | null {
  return Number.isInteger(button) && button >= 0 && button < ButtonNames.length ? ButtonNames[button] : null
}

const finite = (value: number): number => (Number.isFinite(value) ? value : 0)

/** One wheel notch is about 100 pixels (Chromium on Windows), or 3 lines; the engine takes lines */
export function scrollLines(deltaX: number, deltaY: number, deltaMode: number): { x: number; y: number } {
  const per = deltaMode === 0 ? 100 : deltaMode === 1 ? 3 : 1
  // The page scrolls down for a positive deltaY; the wheel's own offset is positive away from the user (up)
  return { x: finite(deltaX / per), y: finite(-deltaY / per) }
}

export interface InputForwarderDeps {
  /** SendInput on the play child */
  send(events: PlayInputEvent[]): Promise<void>
  /** Runs callback soon (the next animation frame); returns what cancels it */
  schedule(callback: () => void): () => void
  /** A send failed (the batch is dropped) */
  onError(error: unknown): void
}

/**
 * Collects the events of a frame into batches. Held keys and buttons are remembered (a repeating key is one press), a
 * run of pointer moves is only its last one, at most one SendInput is in flight, and releaseAll goes out at once, in
 * place of what was queued, so focus lost mid-key can't leave a key down in the game.
 */
export class InputForwarder {
  private queue: PlayInputEvent[] = []
  private readonly keys = new Set<string>()
  private readonly buttons = new Set<string>()
  private cancel: (() => void) | null = null
  private sending = false
  private disposed = false
  /** How many SendInput calls were made (tests) */
  sent = 0

  constructor(private readonly deps: InputForwarderDeps) {}

  /** Whether anything is held down in the game */
  get anyHeld(): boolean {
    return this.keys.size > 0 || this.buttons.size > 0
  }

  /** A key went down or up: false when the engine has no name for the key (the page then leaves the key alone) */
  key(code: string, down: boolean): boolean {
    const key = engineKeyOf(code)
    if (key === null) return false
    if (down === this.keys.has(key)) return true // a repeat, or a release of a key that wasn't down
    if (down) this.keys.add(key)
    else this.keys.delete(key)
    this.push({ type: "key", key, down })
    return true
  }

  mouseButton(button: number, down: boolean): void {
    const name = engineButtonOf(button)
    if (name === null || down === this.buttons.has(name)) return
    if (down) this.buttons.add(name)
    else this.buttons.delete(name)
    this.push({ type: "mouseButton", button: name, down })
  }

  /** The pointer moved to a frame pixel */
  pointer(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const last = this.queue[this.queue.length - 1]
    if (last?.type === "pointer") {
      // Only where it ended up matters; a press or a key in between keeps its own place in the order
      last.x = x
      last.y = y
      return
    }
    this.push({ type: "pointer", x, y })
  }

  /** The wheel turned, in lines */
  scroll(x: number, y: number): void {
    if (x === 0 && y === 0) return
    const last = this.queue[this.queue.length - 1]
    if (last?.type === "scroll") {
      last.x = (last.x ?? 0) + x
      last.y = (last.y ?? 0) + y
      return
    }
    this.push({ type: "scroll", x, y })
  }

  /** Every key and button comes up (focus left the game view): sent at once, in place of what is queued */
  releaseAll(): void {
    if (this.disposed) return
    const held = this.anyHeld
    this.keys.clear()
    this.buttons.clear()
    // Nothing held and nothing waiting: the game already sees everything released
    if (!held && this.queue.length === 0) return
    // What was queued before is moot: the game sees everything released
    this.queue = [{ type: "releaseAll" }]
    this.pump()
  }

  /** Forgets what is queued and held without sending (the game is gone) */
  reset(): void {
    this.queue = []
    this.keys.clear()
    this.buttons.clear()
    this.cancel?.()
    this.cancel = null
  }

  dispose(): void {
    this.disposed = true
    this.reset()
  }

  private push(event: PlayInputEvent): void {
    if (this.disposed) return
    this.queue.push(event)
    if (this.cancel === null && !this.sending) {
      this.cancel = this.deps.schedule(() => {
        this.cancel = null
        this.pump()
      })
    }
  }

  /** Sends the next batch, if none is in flight; the rest follows when it is answered */
  private pump(): void {
    if (this.sending || this.queue.length === 0 || this.disposed) return
    this.cancel?.()
    this.cancel = null
    const batch = this.queue.splice(0, MaxInputEventsPerBatch)
    this.sending = true
    this.sent++
    this.deps.send(batch).then(
      () => this.sendDone(),
      (e) => {
        this.deps.onError(e)
        this.sendDone()
      }
    )
  }

  private sendDone(): void {
    this.sending = false
    if (this.queue.length > 0 && !this.disposed) this.pump()
  }
}
