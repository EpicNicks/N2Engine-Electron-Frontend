// The viewport's keys: the fly keys (held while the right button is down: W A S D Q E and the arrows, Shift for faster),
// and the viewport's shortcuts, which are keymap actions (keymap.ts, scope "viewport": F frames the selection, Escape
// cancels the move in progress, W E R and Q choose the gizmo's tool: move, rotate, scale, none; X toggles world and local
// space, Z pivot and center). Framework-free, so it is tested without a canvas; viewport-panel.tsx feeds it.
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

/** The keymap actions of the space and pivot toggles */
export const SpaceAction = "gizmo.space"
export const PivotAction = "gizmo.pivot"

/** A name with the first chord of an action after it, for a tooltip: "Move tool (W)"; just the name when the action is unbound */
export function chordHint(keymap: Keymap, name: string, actionId: string): string {
  const first = keymap.formatted(actionId)[0]
  return first ? `${name} (${first})` : name
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
  /** Toggles world and local space; false when it can't be changed now (a drag is in progress). Without it the key is not registered. */
  toggleSpace?(): boolean
  /** Toggles pivot and center; false as toggleSpace. Without it the key is not registered. */
  togglePivot?(): boolean
  bookmark?(slot:number,save:boolean):boolean
  axisView?(axis:"front"|"back"|"left"|"right"|"top"|"bottom"):void
  toggleOrthographic?():void
  toggle2D?():void
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
    const toggles: Array<[string, (() => boolean) | undefined]> = [
      [SpaceAction, this.host.toggleSpace?.bind(this.host)],
      [PivotAction, this.host.togglePivot?.bind(this.host)],
    ]
    for (const [action, toggle] of toggles) {
      if (!toggle) continue
      off.push(
        keymap.handle(
          action,
          () => {
            // The game's keys while it is live; not while a drag is in progress (the key is left alone)
            if (this.host.live()) return false
            return toggle()
          },
          { within: view }
        )
      )
    }
    if(this.host.bookmark)for(let slot=1;slot<=9;slot++)for(const save of [false,true]) {
      off.push(keymap.handle(`viewport.bookmark${save?"Save":"Recall"}${slot}`,()=>{
        if(this.host.live())return false
        return this.host.bookmark!(slot,save)
      },{within:view}))
    }
    const views: Array<[string,()=>void]> = [
      ["viewport.orthographic",()=>this.host.toggleOrthographic?.()],
      ["viewport.twoD",()=>this.host.toggle2D?.()],
      ...(["front","back","left","right","top","bottom"] as const).map(axis=>[`viewport.axis${axis[0].toUpperCase()+axis.slice(1)}`,()=>this.host.axisView?.(axis)] as [string,()=>void])
    ]
    for(const [id,action] of views)off.push(keymap.handle(id,()=>{if(this.host.live())return false;action()},{within:view}))
    return () => off.forEach((unregister) => unregister())
  }
}
