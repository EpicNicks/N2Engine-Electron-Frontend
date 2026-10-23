// The viewport's logic apart from the DOM: the editor camera (and how its pose reaches the host), the selected object
// as the gizmo sees it, the gizmo's mode (translate, rotate, scale, none), space (world or local), pivot (pivot or
// center) and snap settings, its drags, frame selected and click to select. The panel (viewport-panel.tsx) only
// turns events into calls on it and draws what it says. It works in FRAME pixels (the engine's viewport size, top-left
// origin), which the panel converts from the page's pointer positions. No DOM: it is given the engine API or a fake,
// so it is unit tested in Node.
//
// Picking and bounds (protocol 1.8.0: PickEntity, GetEntityBounds) are reached through PickBackend (the engine's
// implementation is viewport-picking.ts's createPickBackend, passed as `picking`). With none (a test, or a host without
// them), a click does not select, there is no selection box, and "frame selected" frames the object's world position.
import { DefaultViewPreferences, ViewPreferences } from "./viewport-view-prefs"
import { OverlayEntityCache, entityOverlays, gridLines, projectLine, OverlayOptions, MaxOverlayEntities } from "./viewport-overlays"
import { signal } from "@preact/signals-core"
import type { EditorCameraResponse, Mat4, Quat, Vec3 } from "../protocol/protocol.generated"
import type { EngineApi } from "../shared/api"
import type { EditGroups } from "./edit-groups"
import { Bounds, EditorCameraController } from "./viewport-camera"
import { LatestWinsSender } from "./viewport-frames"
import type { ClickModifiers } from "./hierarchy-tree"
import { insideFrame } from "./viewport-size"
import { remapToHostViewport, translateBounds, unionBounds } from "./viewport-picking"
import {
  AxisDrag,
  AxisFrame,
  DragSource,
  HandleId,
  PlaneDrag,
  isPlane,
  GizmoDrag,
  GizmoLayout,
  GizmoTarget,
  gizmoLayout,
  hitTestGizmo,
  projectBox,
} from "./viewport-gizmo"
import { RotateDrag, RotateGizmoDrag, RotateLayout, formatAngle, hitTestRotate, rotateLayout } from "./viewport-rotate"
import {
  ScaleDrag,
  ScaleGizmoDrag,
  ScaleHandleId,
  ScaleLayout,
  formatRatio,
  hitTestScale,
  scaleLayout,
  worldAxesOf,
} from "./viewport-scale"
import { IdentityMat4, Pixel, sub, scale, quatRotate, quatFromAxes, worldToScreen, add, mat4Multiply, mat4Translation, projectionMatrix, viewMatrix, ProjectionSettings } from "./viewport-math"
import type { PixelSize } from "./viewport-size"
import { ClickSlop, isClick } from "./viewport-input"
import { selectionKeyOf } from "./viewport-selection"
import { SnapSettings, SnapTool, defaultSnapSettings, snapActive, stepRadians } from "./viewport-snap"
import { GizmoPivot, GizmoSpace, gizmoAxes, otherPivot, otherSpace, pivotPosition } from "./viewport-tool-settings"
import { MarqueeBoundsCache, MarqueeKeys, MarqueeOp, NoMarqueeKeys, Rect, clampRect, marqueeHits, marqueeOpOf, rectFrom } from "./viewport-marquee"

/** The host's picking and bounds (PickEntity and GetEntityBounds, protocol 1.8.0) */
export interface PickBackend {
  /** The object under the pixel (frame pixels, top-left origin), or null for none */
  pick(x: number, y: number, includeInactive: boolean): Promise<string | null>
  /** World bounds of the objects that have any (an id the host can't measure is not in the map); null when the host can't say */
  bounds(entityIds: string[]): Promise<Map<string, Bounds> | null>
}

type Engine = Pick<EngineApi, "isConnected" | "setEditorCamera" | "getEditorCamera" | "getEntity" | "setLocalTransform">

export interface ViewportDeps {
  engine: Engine
  groups: Pick<EditGroups, "begin" | "end">
  /** Null without the engine's PickEntity and GetEntityBounds (see createPickBackend) */
  picking: PickBackend | null
  /** Whether the host can be asked to pick and measure now (a scene is open, the host has the commands). Default: yes. */
  canPick?(): boolean
  /** A failure to show (the page's error banner) */
  onError(what: string, error: unknown): void
  /** Something worth a console line, not a banner (an unverified assumption failed) */
  onNote(message: string): void
  /** Whether the scene can be edited now (connected, not a play session): the gizmo is shown and used only then */
  canEdit(): boolean
  /** The primary selection, or what a click selected */
  sceneKey?(): string
  selected(): string | null
  /**
   * The selected objects the gizmo moves: the topmost of the selection, so an object under another selected one is not
   * moved twice (it moves with its ancestor). Default: just the primary selection.
   */
  moveIds?(): readonly string[]
  /** Every selected object (a change to any of them reloads the gizmo's targets). Default: just the primary selection. */
  selectionIds?(): readonly string[]
  /**
   * A click picked this object (null: empty space), with the modifier keys held: the editor's selection acts on it the
   * way a click in the hierarchy does (plain: just it; Ctrl: toggle; Shift: extend; nothing and no modifier: clear)
   */
  select(entityId: string | null, modifiers: ClickModifiers): void
  /**
   * The objects a marquee may select (marqueeCandidatesOf: the hierarchy's active objects, in its order) and the
   * revision of the scene they were listed at; null when there are none to offer. Without it (or selectMany) a drag on
   * empty space draws no marquee.
   */
  marqueeCandidates?(): { revision: number; ids: readonly string[] } | null
  /** A marquee found these objects (in the hierarchy's order): the editor's selection is replaced, added to or removed from */
  selectMany?(entityIds: readonly string[], op: MarqueeOp): void
}

/** A marquee being drawn: where the press was, where the pointer is and the keys held */
interface Marquee {
  from: Pixel
  to: Pixel
  keys: MarqueeKeys
}

/** What the gizmo does: the three tools, or none (select only) */
export type GizmoMode = "translate" | "rotate" | "scale" | "none"
export const GizmoModes: readonly GizmoMode[] = ["translate", "rotate", "scale", "none"]
/** What the modes are called where they are shown */
export const GizmoModeTitles: Readonly<Record<GizmoMode, string>> = {
  translate: "Move",
  rotate: "Rotate",
  scale: "Scale",
  none: "Select",
}

/** The tools that have a snap setting (the select-only tool has none) */
export function snapToolOf(mode: GizmoMode): SnapTool | null {
  return mode === "none" ? null : mode
}

/** A handle of any of the gizmos: a translate axis or plane, a rotate ring (its axis), a scale axis or the uniform centre */
export type AnyHandle = HandleId | ScaleHandleId

/** The drag in progress */
type ActiveDrag = GizmoDrag | RotateGizmoDrag | ScaleGizmoDrag

/** The camera matrices at a viewport size */
export interface CameraMatrices {
  view: Mat4
  projection: Mat4
  viewProjection: Mat4
}

/** The largest difference between two matrices' elements */
export function maxMatrixDifference(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Infinity
  let worst = 0
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
  return worst
}

/** Matrices that differ by less than this agree (the host's are float32) */
export const MatrixTolerance = 1e-3

/** How many GetEntity calls a reload of the gizmo's targets has in flight at once */
export const MaxConcurrentReads = 16

/** Runs fn over the items with at most limit in flight; the results are in the items' order */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** One update of a drag may move the object by at most this many handle lengths */
export const MaxStepHandleLengths = 50

/** A click waiting for, or in, a pick */
interface PickClick {
  pixel: Pixel
  modifiers: ClickModifiers
  connection: number
  /** Which click this is (see clickGeneration), and the selection it was made over */
  generation: number
  selection: string
}

export class ViewportController {
  readonly camera = new EditorCameraController()
  readonly viewPreferences = signal<ViewPreferences>({overlays:{...DefaultViewPreferences.overlays},bookmarks:{}})
  private readonly overlayEntities: OverlayEntityCache
  private allBoundsPending = false
  private allBoundsKey = ""
  private allBoundsGeneration = 0
  private allBounds: ReadonlyMap<string, Bounds> = new Map()
  /**
   * Where the gizmo is: the primary selection as the gizmo needs it (or, when the primary has no transform, the first
   * object that moves); null with no selection
   */
  readonly target = signal<GizmoTarget | null>(null)
  /** The tool the gizmo is (changed by setMode; the keymap's gizmo.* actions call it) */
  readonly mode = signal<GizmoMode>("translate")
  /** World or local axes for the move and rotate handles (the scale handles are always the object's own) */
  readonly space = signal<GizmoSpace>("world")
  /** Whether the gizmo sits at the primary object's origin or at the centre of the selection's bounds */
  readonly pivot = signal<GizmoPivot>("pivot")
  /** The snap toggles, increments and kind (the toolbar's; Ctrl inverts the tool's toggle during a drag) */
  readonly snap = signal<SnapSettings>(defaultSnapSettings())
  /** The handle under the pointer, or the one being dragged */
  readonly hoverHandle = signal<AnyHandle | null>(null)
  readonly dragging = signal(false)
  /** The world bounds of the selected objects the host could measure, by id; drawn as boxes */
  readonly selectionBounds = signal<ReadonlyMap<string, Bounds>>(new Map())
  /** Bumped when anything the overlay draws changed (the panel redraws on it) */
  readonly overlayVersion = signal(0)

  private size: PixelSize | null = null
  private readonly cameraSender: LatestWinsSender<ReturnType<EditorCameraController["toRequest"]>>
  private drag: ActiveDrag | null = null
  /** The pivot (world) the drag in progress began at, and whether its tool's snap toggle was on then */
  private dragStart: Vec3 | null = null
  private dragToggle = false
  /** The objects a drag of the gizmo moves, as the host last said (the topmost of the selection that have a transform) */
  private movers: GizmoTarget[] = []
  /** What the targets were read for (selectionKeyOf), and each one as last read: only changed ones are read again */
  private moversKey: string | null = null
  private readonly read = new Map<string, GizmoTarget | null>()
  private ended: Promise<void> = Promise.resolve()
  private pressed: { pixel: Pixel; onGizmo: boolean } | null = null
  /** The marquee being drawn (a press on empty space that moved past the click slop) */
  private marquee: Marquee | null = null
  /** The candidates' world boxes, read once per scene revision (see marqueeKey) */
  private readonly marqueeBounds: MarqueeBoundsCache
  /** Counts the scene changes seen: a change the hierarchy has not re-read yet still makes the cached boxes old */
  private sceneChanges = 0
  /** The click to pick for (one pick in flight; clicks meanwhile wait, and only the newest of them is asked) */
  private readonly pickSender: LatestWinsSender<PickClick>
  /** Counts clicks (and misses): only the newest click's answer is applied */
  private clickGeneration = 0
  /** The size the host's viewport has been told, while it may differ from the picture's (null: unknown) */
  private hostSize: PixelSize | null = null
  private boundsRunning = false
  private boundsDirty = false
  /** Counts target loads, so a slow answer can't replace a newer one */
  private loads = 0
  private connections = 0
  private warned = false
  /** Frame pixels per CSS pixel: the gizmo's size, its pick distance and the click slop are CSS pixels */
  private ratio = 1
  private frameListener: (() => void) | null = null

  constructor(private readonly deps: ViewportDeps) {
    this.overlayEntities = new OverlayEntityCache(id=>deps.engine.getEntity(id),()=>this.redraw())
    this.cameraSender = new LatestWinsSender(
      async (request) => {
        const { position, rotation, fovY, orthographic, orthoSize, nearPlane, farPlane } = request
        await deps.engine.setEditorCamera(position, rotation, fovY, orthographic, orthoSize, nearPlane, farPlane)
        // The host has the pose now: the next frame shows it
        this.frameNeeded()
      },
      (e) => deps.onError("Failed to move the camera", e)
    )
    this.pickSender = new LatestWinsSender(
      (click) => this.pick(click),
      (e) => deps.onError("Failed to pick an object", e)
    )
    this.marqueeBounds = new MarqueeBoundsCache(async (ids) => (deps.picking ? deps.picking.bounds(ids) : null))
  }

  /** Who asks the host for a frame (the panel's renderer): called when the camera or the selected object moved */
  onFrameNeeded(listener: (() => void) | null): void {
    this.frameListener = listener
  }

  private frameNeeded(): void {
    this.frameListener?.()
  }

  /** Whether a click can select something: there is a backend, and the host can be asked (see ViewportDeps.canPick) */
  get canPick(): boolean {
    return this.deps.picking !== null && (this.deps.canPick?.() ?? true)
  }

  /** The size the host's viewport was last told (null: none), so a click on a picture of another size is mapped exactly */
  setHostSize(size: PixelSize | null): void {
    this.hostSize = size
  }

  get isDragging(): boolean {
    return this.drag !== null
  }

  /**
   * Changes the tool. Not during a drag (false: the drag is of the tool it began with, and the mode would change under
   * it); true when the mode is now `mode`. The hovered handle is the old tool's: cleared.
   */
  setMode(mode: GizmoMode): boolean {
    if (this.drag) return false
    if (mode !== this.mode.peek()) {
      this.mode.value = mode
      this.hoverHandle.value = null
      this.redraw()
    }
    return true
  }

  /** Changes the space (world or local). Not during a drag (false); true when the space is now `space`. */
  setSpace(space: GizmoSpace): boolean {
    if (this.drag) return false
    if (space !== this.space.peek()) {
      this.space.value = space
      this.hoverHandle.value = null
      this.redraw()
    }
    return true
  }

  /** Changes the pivot (pivot or center). Not during a drag (false); true when the pivot is now `pivot`. */
  setPivot(pivot: GizmoPivot): boolean {
    if (this.drag) return false
    if (pivot !== this.pivot.peek()) {
      this.pivot.value = pivot
      this.hoverHandle.value = null
      this.redraw()
    }
    return true
  }

  /** The other space (what the keymap's gizmo.space does); false during a drag */
  toggleSpace(): boolean {
    return this.setSpace(otherSpace(this.space.peek()))
  }

  /** The other pivot (what the keymap's gizmo.pivot does); false during a drag */
  togglePivot(): boolean {
    return this.setPivot(otherPivot(this.pivot.peek()))
  }

  /**
   * Replaces the snap settings. A drag in progress keeps the ones it began with (a setting changed under the pointer
   * would make the next update jump), so this is allowed at any time.
   */
  setSnap(snap: SnapSettings): void {
    this.snap.value = snap
  }

  /** The viewport's pixel size: the size of the frame on screen, which the host renders at (not the one last asked for) */
  setSize(size: PixelSize | null): boolean {
    const same = size?.width === this.size?.width && size?.height === this.size?.height && (size === null) === (this.size === null)
    this.size = size
    if (!same) this.redraw()
    return !same
  }

  /** devicePixelRatio, for what is sized in CSS pixels */
  setPixelRatio(ratio: number): void {
    if (Number.isFinite(ratio) && ratio > 0 && ratio !== this.ratio) {
      this.ratio = ratio
      this.redraw()
    }
  }

  // ==================== Connection ====================

  /** Connected (or reconnected): the camera starts where the host's is, and the selection's object is read */
  async connected(): Promise<void> {
    const connection = ++this.connections
    this.warned = false
    try {
      const host = await this.deps.engine.getEditorCamera()
      if (connection !== this.connections) return
      this.camera.adopt(host)
      this.redraw()
    } catch (e) {
      this.deps.onError("Failed to read the editor camera", e)
    }
    await this.loadTarget(this.deps.selected())
    void this.reloadBounds()
    await this.verifyMatrices()
  }

  /** The connection ended: nothing of the host's is valid */
  disconnected(): void {
    this.connections++
    this.overlayEntities.clear()
    this.allBoundsGeneration++
    this.allBoundsKey=""
    this.allBounds=new Map()
    this.loads++
    if (this.drag) void this.finishDrag("abandon", false)
    this.pressed = null
    this.marquee = null
    this.marqueeBounds.clear()
    this.target.value = null
    this.movers = []
    this.moversKey = null
    this.read.clear()
    this.pickSender.discard()
    this.selectionBounds.value = new Map()
    this.dragging.value = false
    this.hoverHandle.value = null
    this.redraw()
  }

  /**
   * Checks the matrices computed here against GetEditorCamera's (the host's own view and projection), which is what the
   * gizmo's alignment with the picture rests on; says so once if they differ. Nothing in the editor needs the answer.
   */
  async verifyMatrices(): Promise<void> {
    if (this.warned || !this.size || !this.deps.engine.isConnected()) return
    const connection = this.connections
    const version = this.camera.version
    const size = this.size
    let host: EditorCameraResponse
    try {
      await this.cameraSender.flush()
      host = await this.deps.engine.getEditorCamera()
    } catch {
      return
    }
    // The camera moved or the connection changed meanwhile: the comparison would be of different poses
    if (connection !== this.connections || version !== this.camera.version || size !== this.size) return
    const mine = this.matrices()
    if (!mine) return
    const difference = Math.max(
      maxMatrixDifference(mine.view, host.view),
      maxMatrixDifference(mine.projection, host.projection)
    )
    if (difference > MatrixTolerance) {
      this.warned = true
      this.deps.onNote(
        `The viewport gizmo's camera maths differs from the editor host's view and projection matrices (by ${difference.toPrecision(3)}): handles may not line up with the picture`
      )
    }
  }

  // ==================== Camera ====================

  /** The camera's matrices for the viewport's size; null before it has one */
  matrices(): CameraMatrices | null {
    if (!this.size) return null
    const settings: ProjectionSettings = {
      fovY: this.camera.fovY,
      orthographic: this.camera.orthographic,
      orthoSize: this.camera.orthoSize,
      nearPlane: this.camera.nearPlane,
      farPlane: this.camera.farPlane,
    }
    const view = viewMatrix(this.camera.position, this.camera.rotation)
    const projection = projectionMatrix(settings, this.size.width / this.size.height)
    return { view, projection, viewProjection: mat4Multiply(projection, view) }
  }

  /** The camera changed: send the pose (the latest, one at a time) and redraw the overlay */
  cameraChanged(): void {
    if (!this.deps.engine.isConnected()) return
    this.cameraSender.push(this.camera.toRequest())
    this.redraw()
  }

  orbit(dx: number, dy: number): void {
    if (this.drag) return // the drag's maths is for the camera it began with
    if(this.camera.mode2D) { this.pan(dx,dy);return }
    this.camera.orbit(dx, dy)
    this.cameraChanged()
  }

  look(dx: number, dy: number): void {
    if (this.drag) return // the drag's maths is for the camera it began with
    if(this.camera.mode2D) { this.pan(dx,dy);return }
    this.camera.look(dx, dy)
    this.cameraChanged()
  }

  pan(dx: number, dy: number): void {
    if (this.drag) return // the drag's maths is for the camera it began with
    if (!this.size) return
    this.camera.pan(dx, dy, this.size.height)
    this.cameraChanged()
  }

  zoom(deltaPixels: number): void {
    if (this.drag) return // the drag's maths is for the camera it began with
    if (this.marquee) return // the rectangle is over the picture as it was when it was drawn
    this.camera.zoom(deltaPixels)
    this.cameraChanged()
  }

  fly(move: Vec3, dtSeconds: number, boost: boolean): void {
    if (this.drag) return
    this.camera.fly(move, dtSeconds, this.camera.flySpeed(boost))
    this.cameraChanged()
  }

  /**
   * Frames the selected objects: the union of their world bounds when the host can give them (GetEntityBounds, one
   * call), else the primary object's world position (GetEntity's world matrix) at a fixed distance. False when nothing
   * is selected or the object can't be read.
   */
  async frameSelected(): Promise<boolean> {
    if (this.drag || this.marquee) return false // a marquee's rectangle is over the picture it was drawn on
    const id = this.deps.selected()
    if (id === null) return false
    if (this.canPick && this.deps.picking && this.deps.engine.isConnected()) {
      try {
        const ids = [...new Set([id, ...this.selectedIds(id)])]
        const found = await this.deps.picking.bounds(ids)
        const union = found ? unionBounds(found.values()) : null
        if (this.drag || this.marquee) return false // a drag began while the bounds were awaited
        if (union) {
          this.camera.frameBounds(union)
          this.cameraChanged()
          return true
        }
      } catch (e) {
        console.debug("GetEntityBounds failed:", e)
      }
    }
    let target = this.target.value?.id === id ? this.target.value : null
    if (!target) {
      await this.loadTarget(id)
      target = this.target.value?.id === id ? this.target.value : null
    }
    if (!target || this.drag || this.marquee) return false
    this.camera.framePoint(mat4Translation(target.worldMatrix))
    this.cameraChanged()
    return true
  }

  setOverlay(key: keyof OverlayOptions, value:boolean):void {
    this.viewPreferences.value={...this.viewPreferences.value,overlays:{...this.viewPreferences.value.overlays,[key]:value}}
    this.redraw()
  }

  setOrthographic(value:boolean):void { if(this.drag || this.marquee)return;this.camera.setOrthographic(value);this.cameraChanged() }
  set2D(value:boolean):void { if(this.drag || this.marquee)return;this.camera.set2D(value);this.cameraChanged() }
  setAxis(axis:"front"|"back"|"left"|"right"|"top"|"bottom"):void {
    if(this.drag || this.marquee)return
    if(this.camera.mode2D)this.camera.set2D(false)
    this.camera.setAxis(axis);this.cameraChanged()
  }
  alignViewToSelected():boolean {
    if(this.drag || this.marquee || !this.target.value)return false
    const target=this.target.value
    // The selected object's world axes, rather than its local rotation under a rotated parent.
    const axes=worldAxesOf(target.worldMatrix)
    const rotation=quatFromAxes(axes.x,axes.y,axes.z)
    if(!rotation)return false
    this.camera.set2D(false)
    const position=sub(mat4Translation(target.worldMatrix),scale(quatRotate(rotation,{x:0,y:0,z:-1}),this.camera.distance))
    this.camera.adopt({...this.camera.toRequest(),position,rotation})
    this.cameraChanged();return true
  }
  bookmark(slot:number,save:boolean):boolean {
    const key=this.deps.sceneKey?.() ?? ""
    if(!key || key.length>512 || !Number.isInteger(slot) || slot<1 || slot>9 || this.drag || this.marquee)return false
    const prefs=this.viewPreferences.value
    const existing=Object.hasOwn(prefs.bookmarks,key)?prefs.bookmarks[key]:[]
    if(save) {
      const bookmarks=Array.from({length:9},(_,i)=>existing[i] ?? null)
      bookmarks[slot-1]={camera:this.camera.toRequest(),distance:this.camera.distance,mode2D:this.camera.mode2D}
      const entries=Object.entries({...prefs.bookmarks,[key]:bookmarks}).slice(-64)
      this.viewPreferences.value={...prefs,bookmarks:Object.fromEntries(entries)}
      this.redraw();return true
    }
    const bookmark=existing[slot-1]
    if(!bookmark)return false
    this.camera.set2D(false)
    if(bookmark.mode2D)this.camera.set2D(true)
    this.camera.adopt(bookmark.camera,bookmark.distance)
    this.cameraChanged();return true
  }
  hasBookmark(slot:number):boolean {
    const key=this.deps.sceneKey?.() ?? "",all=this.viewPreferences.value.bookmarks
    return Object.hasOwn(all,key) && !!all[key][slot-1]
  }

  drawSceneOverlays(ctx:CanvasRenderingContext2D,width:number,height:number,ratio:number):void {
    const matrices=this.matrices();if(!matrices || !this.deps.engine.isConnected())return
    const options=this.viewPreferences.value.overlays,selected=new Set(this.deps.selectionIds?.() ?? (this.deps.selected()?[this.deps.selected()!]:[]))
    const candidates=this.deps.marqueeCandidates?.()
    const all=options.allColliders || options.icons || options.ranges || options.bounds
    const ids=all ? [...selected,...(candidates?.ids ?? [])] : [...selected]
    const revision=JSON.stringify([this.connections,this.sceneChanges,candidates?.revision ?? 0,this.deps.sceneKey?.() ?? ""])
    const entities=this.overlayEntities.get(ids,revision)
    const lines=options.grid ? gridLines(this.camera.target,this.camera.orthographic?this.camera.orthoSize:this.camera.distance,this.camera.forward,this.camera.orthographic):[]
    for(const entity of entities) {
      const geometry=entityOverlays(entity,options,selected.has(entity.entity.header.id));lines.push(...geometry.lines.slice(0,Math.max(0,20000-lines.length)))
      if(options.icons)for(const icon of geometry.icons) {
        const pixel=worldToScreen(matrices.viewProjection,icon.at,width,height)
        if(pixel && pixel.depth>=-1 && pixel.depth<=1) {ctx.fillStyle=icon.color;ctx.font=`${16*ratio}px sans-serif`;ctx.fillText(icon.label,pixel.x,pixel.y)}
      }
    }
    for(const line of lines) {
      const points=projectLine(matrices.viewProjection,line,width,height);if(!points)continue
      ctx.strokeStyle=line.color;ctx.globalAlpha=line.alpha;ctx.lineWidth=ratio;ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);ctx.lineTo(points[1].x,points[1].y);ctx.stroke()
    }
    ctx.globalAlpha=1
    if(options.bounds && this.deps.picking) {
      const bounded=[...new Set(ids)].slice(0,MaxOverlayEntities),key=JSON.stringify([revision,bounded])
      if(key!==this.allBoundsKey && !this.allBoundsPending) {
        this.allBoundsPending=true
        this.allBoundsKey=key;this.allBounds=new Map();const generation=++this.allBoundsGeneration
        void this.deps.picking.bounds(bounded).then(found=>{if(generation===this.allBoundsGeneration){this.allBounds=found ?? new Map();this.redraw()}},()=>{}).finally(()=>{this.allBoundsPending=false;this.redraw()})
      }
      ctx.strokeStyle="#789bbb";ctx.lineWidth=ratio
      for(const bounds of this.allBounds.values())for(const [a,b] of projectBox(matrices.viewProjection,bounds.min,bounds.max,width,height)) {ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke()}
    }
  }

  // ==================== The selected object ====================

  private selectedIds(primary: string | null): readonly string[] {
    return this.deps.selectionIds?.() ?? (primary === null ? [] : [primary])
  }

  private moveIds(id: string): readonly string[] {
    return this.deps.moveIds?.() ?? [id]
  }

  /**
   * One object as the gizmo needs it, with its parent's world matrix (so a move is exact whatever the signs of the
   * scales); null for one that is gone, can't be read or has no transform. parents shares the parents read by one load.
   */
  private async readTarget(id: string, parents: Map<string, Promise<Mat4 | undefined>>): Promise<GizmoTarget | null> {
    try {
      const { entity, worldMatrix } = await this.deps.engine.getEntity(id)
      const t = entity.transform
      if (!t) return null
      const parentId = entity.header.parentId
      let parentWorld: Mat4 | undefined = IdentityMat4
      if (parentId !== "") {
        let parent = parents.get(parentId)
        if (!parent) {
          // A parent that can't be read leaves the move to be derived from the object's own world matrix
          parent = this.deps.engine.getEntity(parentId).then(
            (r) => r.worldMatrix,
            () => undefined
          )
          parents.set(parentId, parent)
        }
        parentWorld = await parent
      }
      return {
        id,
        name: entity.header.name,
        localPosition: { ...t.position },
        localRotation: { ...t.rotation } as Quat,
        localScale: { ...t.scale },
        worldMatrix,
        parentWorld,
      }
    } catch (e) {
      // An object that is gone, or one the host can't read: no gizmo for it
      console.debug("GetEntity failed:", e)
      return null
    }
  }

  /**
   * The selection's primary object changed, or the objects changed in the scene: read the primary and the objects a
   * drag moves (the topmost of the selection) for the gizmo. With changed, only those of them that are in it are read
   * again (when the selection is the one the targets were read for); a bounded number of reads at a time.
   */
  async loadTarget(id: string | null, changed: ReadonlySet<string> | null = null): Promise<void> {
    const load = ++this.loads
    if (id === null || !this.deps.engine.isConnected()) {
      this.target.value = null
      this.movers = []
      this.moversKey = null
      this.read.clear()
      if (!this.drag) this.dragOrigin = null
      this.redraw()
      return
    }
    const moveIds = this.moveIds(id)
    const key = selectionKeyOf(id, moveIds)
    const ids = [...new Set([id, ...moveIds])]
    // Another selection: the point a last drag was held at is not its pivot
    if (this.moversKey !== key && !this.drag) this.dragOrigin = null
    const partial = changed !== null && this.moversKey === key
    if (!partial) this.read.clear()
    const toRead = partial ? ids.filter((i) => changed.has(i) || !this.read.has(i)) : ids
    const results = await mapLimit(toRead, MaxConcurrentReads, (i) => this.readTarget(i, new Map()))
    if (load !== this.loads || this.drag) return
    toRead.forEach((i, k) => this.read.set(i, results[k]))
    this.movers = moveIds.map((i) => this.read.get(i) ?? null).filter((t): t is GizmoTarget => t !== null)
    this.target.value = this.read.get(id) ?? this.movers[0] ?? null
    this.moversKey = key
    this.redraw()
  }

  /**
   * Scene objects changed: the selected ones named are read again (all of them when the change is full). During a drag
   * only a REPLACEMENT of the scene (the host flagged another scene loaded) abandons it: any other change, a "too many
   * objects to list" one included, is the echo of the drag's own edits, and the targets are read again when the drag
   * has ended.
   */
  objectsChanged(entityIds: readonly string[], full: boolean, replaced: boolean = false): void {
    const id = this.deps.selected()
    // Any change (a move, a new object, another scene) makes the marquee's boxes old
    this.sceneChanges++
    this.marqueeBounds.clear()
    if (this.drag) {
      if (replaced) {
        void this.finishDrag("abandon", true)
        void this.reloadBounds()
      }
      return
    }
    // The boxes follow every change (also a "full" one, which a drag's own echo can be): an object's bounds include
    // what is under it, and a change names only what changed
    void this.reloadBounds()
    if (id === null) return
    if (full) {
      void this.loadTarget(id)
      return
    }
    const changed = new Set(entityIds)
    if ((this.deps.selectionIds?.() ?? [id]).some((s) => changed.has(s))) void this.loadTarget(id, changed)
  }

  /**
   * The selection's boxes are read again (one GetEntityBounds for all the selected objects): after a change of the
   * selection, a change of the scene, or a connection. One read is in flight at a time; asking meanwhile makes one
   * more read when it is done, and an answer that is out of date by then is not shown.
   */
  reloadBounds(): Promise<void> {
    if (this.boundsRunning) {
      this.boundsDirty = true
      return this.boundsDone
    }
    this.boundsRunning = true
    this.boundsDone = this.runBounds()
    return this.boundsDone
  }

  /** Resolves when the read in flight (and the one it was asked for after) has been answered */
  private boundsDone: Promise<void> = Promise.resolve()

  private async runBounds(): Promise<void> {
    try {
      do {
        this.boundsDirty = false
        const connection = this.connections
        const picking = this.deps.picking
        const ids = [...new Set(this.selectedIds(this.deps.selected()))]
        const key = this.selectionKey()
        if (!picking || !this.canPick || ids.length === 0 || !this.deps.engine.isConnected()) {
          this.setBounds(new Map())
          continue
        }
        // An answer is out of date only when the selection or the connection changed meanwhile: a change of the scene
        // still shows it (another read follows), so a storm of events can't keep the boxes from ever appearing
        const current = (): boolean => connection === this.connections && key === this.selectionKey()
        try {
          const found = await picking.bounds(ids)
          if (current()) this.setBounds(found ?? new Map())
        } catch (e) {
          // The box is a convenience: a host that can't measure leaves the objects unboxed
          console.debug("GetEntityBounds failed:", e)
          if (current()) this.setBounds(new Map())
        }
      } while (this.boundsDirty)
    } finally {
      this.boundsRunning = false
    }
  }

  private setBounds(bounds: ReadonlyMap<string, Bounds>): void {
    if (bounds.size === 0 && this.selectionBounds.peek().size === 0) return
    this.selectionBounds.value = bounds
    this.redraw()
  }

  // ==================== Gizmo and picking ====================

  /**
   * What every tool's layout needs: the primary object, the camera and the viewport, and where the gizmo is (while
   * dragging, where the drag has put it, not where the host last said). Null with no selection, no viewport size, a
   * scene that can't be edited (and no drag in progress) or the wrong tool.
   */
  private gizmoSetup(mode: GizmoMode): { target: GizmoTarget; m: CameraMatrices; size: PixelSize; origin: Vec3 } | null {
    const target = this.target.value
    const m = this.matrices()
    if (this.mode.value !== mode || !target || !m || !this.size || (!this.drag && !this.deps.canEdit())) return null
    return { target, m, size: this.size, origin: this.dragOrigin ?? this.pivotPoint(target) }
  }

  /**
   * Where the pivot is in the world: the primary object's origin, or (pivot "center") the centre of the selected objects'
   * bounds as the host last measured them (the primary's origin when it has none).
   */
  private pivotPoint(target: GizmoTarget): Vec3 {
    if (this.pivot.value !== "center") return mat4Translation(target.worldMatrix)
    const selected = new Set(this.selectedIds(this.deps.selected()))
    const boxes: Bounds[] = []
    for (const [id, box] of this.selectionBounds.value) if (selected.has(id)) boxes.push(box)
    return pivotPosition("center", target.worldMatrix, boxes)
  }

  /** The axes the move and rotate handles run along: the world's, or the primary's own in local space (a drag keeps the ones it began with: the target is not read again until it ends) */
  private handleAxes(target: GizmoTarget): AxisFrame {
    return gizmoAxes(this.space.value, target.worldMatrix)
  }

  /** Where the translate gizmo is now; null unless the tool is Move, and with no selection, no viewport size or the object behind the camera */
  layout(): GizmoLayout | null {
    const g = this.gizmoSetup("translate")
    return g ? gizmoLayout(g.m.view, g.m.viewProjection, g.origin, g.size.width, g.size.height, this.ratio, this.handleAxes(g.target)) : null
  }

  /** Where the rotate gizmo's rings are now; null unless the tool is Rotate (and as layout()) */
  rotateLayout(): RotateLayout | null {
    const g = this.gizmoSetup("rotate")
    return g ? rotateLayout(g.m.view, g.m.viewProjection, g.origin, g.size.width, g.size.height, this.ratio, this.handleAxes(g.target)) : null
  }

  /** Where the scale gizmo's handles are now; null unless the tool is Scale (and as layout()). Its axes are the primary object's own. */
  scaleLayout(): ScaleLayout | null {
    const g = this.gizmoSetup("scale")
    return g
      ? scaleLayout(g.m.view, g.m.viewProjection, g.origin, worldAxesOf(g.target.worldMatrix), g.size.width, g.size.height, this.ratio)
      : null
  }

  /** What the drag in progress has made so far, for the overlay to show ("X +37.5 deg", "Y x1.25"); null for none (a move shows itself) */
  dragReadout(): string | null {
    const drag = this.drag
    if (drag instanceof RotateGizmoDrag) return drag.axis.toUpperCase() + " " + formatAngle(drag.angle)
    if (drag instanceof ScaleGizmoDrag) return (drag.handle === "uniform" ? "All" : drag.handle.toUpperCase()) + " " + formatRatio(drag.ratio)
    return null
  }

  /** The world position the gizmo is drawn at during a drag (the host's reading of it lags the drag) */
  private dragOrigin: Vec3 | null = null

  /**
   * The selected objects' boxes on screen, as pixel pairs: 12 edges per object (the ones with both ends in front of the
   * camera), for the objects still selected. During a drag the boxes move with it, ahead of the host's answer (every
   * selected object is one the drag moves or lies under one).
   */
  boxEdges(): Array<[Pixel, Pixel]> {
    const m = this.matrices()
    if (!m || !this.size) return []
    // A rotate or scale drag turns the boxes into ones the host's AABBs can't give: they are left off until it ends
    if (this.drag && !(this.drag instanceof GizmoDrag)) return []
    const selected = new Set(this.selectedIds(this.deps.selected()))
    const edges: Array<[Pixel, Pixel]> = []
    for (const [id, box] of this.selectionBounds.value) {
      if (!selected.has(id)) continue
      const shown = this.drag ? translateBounds(box, this.drag.worldDelta) : box
      edges.push(...projectBox(m.viewProjection, shown.min, shown.max, this.size.width, this.size.height))
    }
    return edges
  }

  /** The pointer moved without a button: the handle under it lights up */
  hover(pixel: Pixel | null): void {
    if (this.drag || this.marquee) return
    const handle = pixel ? this.handleAt(pixel) : null
    if (handle !== this.hoverHandle.value) {
      this.hoverHandle.value = handle
      this.redraw()
    }
  }

  /** The handle of the current tool under the pixel; null for none (and with the tool "none") */
  private handleAt(pixel: Pixel): AnyHandle | null {
    switch (this.mode.value) {
      case "translate": {
        const layout = this.layout()
        return layout ? hitTestGizmo(layout, pixel, this.ratio) : null
      }
      case "rotate": {
        const layout = this.rotateLayout()
        return layout ? hitTestRotate(layout, pixel, this.ratio) : null
      }
      case "scale": {
        const layout = this.scaleLayout()
        return layout ? hitTestScale(layout, pixel, this.ratio) : null
      }
      default:
        return null
    }
  }

  /**
   * The left button went down, with Ctrl held or not (Ctrl inverts the tool's snap toggle for the drag). True when a
   * gizmo handle took it (a drag has begun: pointerMove and pointerUp follow); false when it is a plain press, which
   * selects on release if it didn't move (see click).
   */
  pointerDown(pixel: Pixel, ctrl: boolean): boolean {
    const target = this.target.value
    const m = this.matrices()
    const handle = this.handleAt(pixel)
    // A press on a handle is the gizmo's, even when no drag can begin from it: it never selects what is behind it
    this.pressed = { pixel, onGizmo: handle !== null }
    if (!target || !m || !this.size || !handle || this.movers.length === 0) return false
    // The objects the drag changes were read for another selection (a change of it is on its way): not this press
    const id = this.deps.selected()
    if (id === null || this.moversKey !== selectionKeyOf(id, this.moveIds(id))) return false
    // Just after a drag the gizmo is still where the drag put it: the boxes (and the target) are the host's old ones
    // until their reads are answered, and the pivot must not jump back to them
    const origin = this.dragOrigin ?? this.pivotPoint(target)
    const tool = snapToolOf(this.mode.value)
    const settings = this.snap.value
    this.dragToggle = tool !== null && settings[tool].enabled
    const drag = this.beginDrag(handle, origin, m, pixel, snapActive(this.dragToggle, ctrl), settings, this.handleAxes(target))
    if (!drag) return false
    this.drag = drag
    this.dragStart = origin
    this.dragOrigin = origin
    this.dragging.value = true
    this.hoverHandle.value = handle
    this.redraw()
    return true
  }

  /** The drag of the current tool on the handle; null when it can't begin (the pointer's ray can't be followed) */
  private beginDrag(
    handle: AnyHandle,
    origin: Vec3,
    m: CameraMatrices,
    pixel: Pixel,
    snap: boolean,
    settings: SnapSettings,
    axes: AxisFrame
  ): ActiveDrag | null {
    const size = this.size!
    const { width, height } = size
    const farPlane = this.camera.farPlane
    const deps = {
      engine: this.deps.engine,
      groups: this.deps.groups,
      onError: (what: string, e: unknown) => this.deps.onError(what, e),
      onMoved: () => this.frameNeeded(),
    }
    switch (this.mode.value) {
      case "translate": {
        const layout = this.layout()
        if (!layout || handle === "uniform") return null
        const maxStep = layout.worldLength * MaxStepHandleLengths
        const source: DragSource | null = isPlane(handle)
          ? PlaneDrag.begin(handle, origin, m.viewProjection, pixel, width, height, farPlane, maxStep, axes)
          : AxisDrag.begin(handle, origin, m.viewProjection, pixel, width, height, farPlane, maxStep, axes)
        const { step, kind } = settings.translate
        return source ? new GizmoDrag(deps, this.movers, source, snap, { step, absolute: kind === "absolute", origin }) : null
      }
      case "rotate": {
        const layout = this.rotateLayout()
        if (!layout || handle === "uniform" || isPlane(handle)) return null
        const source = RotateDrag.begin(handle, layout, origin, m.viewProjection, pixel, width, height, farPlane)
        return source ? new RotateGizmoDrag(deps, this.movers, source, origin, snap, stepRadians(settings)) : null
      }
      case "scale": {
        const layout = this.scaleLayout()
        if (!layout || (handle !== "uniform" && isPlane(handle))) return null
        const source = ScaleDrag.begin(handle, layout, origin, m.viewProjection, pixel, width, height, this.ratio, farPlane)
        return source ? new ScaleGizmoDrag(deps, this.movers, source, origin, snap, settings.scale.step) : null
      }
      default:
        return null
    }
  }

  /**
   * The pointer moved with the left button down, with Ctrl held or not (it inverts the snap toggle a gizmo drag began
   * with), and the keys the marquee reads. A press on empty space that moves past the click slop begins a marquee
   * (when the host can measure objects); the rectangle then follows the pointer.
   */
  pointerMove(pixel: Pixel, ctrl: boolean, keys: MarqueeKeys = NoMarqueeKeys): void {
    const drag = this.drag
    const start = this.dragStart
    if (!drag || !start) {
      this.moveMarquee(pixel, keys)
      return
    }
    if (drag.update(pixel, snapActive(this.dragToggle, ctrl)) !== null) {
      // The gizmo follows at once, on this side of the round trip
      this.dragOrigin = add(start, drag.worldDelta)
      this.redraw()
    }
  }

  /**
   * The left button was released at pixel. Ends a gizmo drag (resolving when its group has ended); otherwise a press
   * that stayed put (within the click slop) is a click: with picking, it selects the object under the pointer, or none,
   * with the modifier keys held at the release. Resolves when the pick has been answered.
   */
  async pointerUp(pixel: Pixel, modifiers: ClickModifiers = {}, keys?: MarqueeKeys): Promise<void> {
    const pressed = this.pressed
    this.pressed = null
    if (this.drag) return this.finishDrag("end", true)
    const marquee = this.marquee
    if (marquee) {
      this.marquee = null
      this.redraw()
      return this.finishMarquee(marquee.from, pixel, keys ?? marquee.keys)
    }
    if (pressed && !pressed.onGizmo && isClick(pressed.pixel, pixel, ClickSlop * this.ratio)) this.click(pixel, modifiers)
    await this.pickSender.flush()
  }

  /** The press was cancelled (Escape, or the window lost the pointer): a drag in progress puts the object back */
  async cancel(): Promise<void> {
    this.pressed = null
    if (this.marquee) {
      // Escape: the rectangle goes and the selection is left as it was
      this.marquee = null
      this.redraw()
    }
    if (this.drag) await this.finishDrag("cancel", true)
  }

  /**
   * Finishes a drag in progress as it is (the host's Undo and Redo are refused while its group is open, and a drag
   * that went on across one would be split in two): resolves when the group has ended. Nothing to do without a drag.
   */
  async endActiveDrag(): Promise<void> {
    if (this.drag) await this.finishDrag("end", true)
    else await this.ended
  }

  private finishDrag(how: "end" | "cancel" | "abandon", reload: boolean): Promise<void> {
    const drag = this.drag!
    this.drag = null
    if (!reload) this.dragOrigin = null
    this.dragStart = null
    this.dragging.value = false
    const done = how === "end" ? drag.end() : how === "cancel" ? drag.cancel() : drag.abandon()
    this.ended = done.then(
      () => undefined,
      () => undefined
    )
    // The host's reading of the object is the truth again
    return done.then(async () => {
      if (!reload) return undefined
      // The objects moved: their boxes are the host's again too. The gizmo stays where the drag put it until they are
      // (else it jumps back to the old centre, and a quick next press would turn about that stale point)
      const target = this.loadTarget(this.deps.selected())
      try {
        await this.reloadBounds()
      } finally {
        if (!this.drag) {
          this.dragOrigin = null
          this.redraw()
        }
      }
      return target
    })
  }

  /** Resolves when a drag's group has ended (what the undo waits for) */
  get gestureEnded(): Promise<void> {
    return this.ended
  }

  /** What is selected, as one string (the primary and every selected id): a pick's answer is for the selection it began over */
  private selectionKey(): string {
    return `${this.deps.selected() ?? ""}|${[...new Set(this.selectedIds(this.deps.selected()))].sort().join(",")}`
  }

  /**
   * A click on the frame. A pixel outside the viewport is a miss (no call). Else the host is asked, at the pixel the
   * host will see: if its viewport was resized since the picture on screen was rendered, the pixel is mapped to the new
   * size (remapToHostViewport; one that falls outside the new viewport is a miss too).
   */
  private click(pixel: Pixel, modifiers: ClickModifiers): void {
    if (!this.canPick || !this.deps.engine.isConnected()) return
    // Every click and miss makes the answers of earlier ones out of date
    const generation = ++this.clickGeneration
    const missed = (): void => {
      this.pickSender.discard()
      this.deps.select(null, modifiers)
    }
    if (!this.size || !insideFrame(pixel, this.size)) return missed()
    const asked = this.hostSize ? remapToHostViewport(pixel, this.size, this.hostSize) : pixel
    if (this.hostSize && !insideFrame(asked, this.hostSize)) return missed()
    this.pickSender.push({ pixel: asked, modifiers, connection: this.connections, generation, selection: this.selectionKey() })
  }

  private async pick(click: PickClick): Promise<void> {
    const picking = this.deps.picking
    if (!picking) return
    const id = await picking.pick(click.pixel.x, click.pixel.y, false)
    // Applied only for the newest click, on the connection it was made on, and when nothing else (the hierarchy, a
    // later click) changed the selection while it was asked: an old answer must not undo what came after it
    if (
      click.connection === this.connections &&
      click.generation === this.clickGeneration &&
      click.selection === this.selectionKey()
    ) {
      this.deps.select(id, click.modifiers)
    }
  }

  // ==================== Marquee ====================

  /** Whether a marquee can be drawn: the editor offers candidates and takes a selection, and the host can measure */
  private get canMarquee(): boolean {
    return !!this.deps.marqueeCandidates && !!this.deps.selectMany && this.canPick && this.deps.engine.isConnected()
  }

  /** Whether a marquee is being drawn */
  get isMarquee(): boolean {
    return this.marquee !== null
  }

  /** The marquee's rectangle (frame pixels) and what it will do, for the overlay; null when none is being drawn */
  marqueeShape(): { rect: Rect; inside: boolean; op: MarqueeOp } | null {
    const m = this.marquee
    if (!m) return null
    return { rect: rectFrom(m.from, m.to), inside: m.keys.inside, op: marqueeOpOf(m.keys) }
  }

  private moveMarquee(pixel: Pixel, keys: MarqueeKeys): void {
    if (this.marquee) {
      this.marquee = { ...this.marquee, to: pixel, keys }
      this.redraw()
      return
    }
    const pressed = this.pressed
    if (!pressed || pressed.onGizmo || isClick(pressed.pixel, pixel, ClickSlop * this.ratio) || !this.canMarquee) return
    this.marquee = { from: pressed.pixel, to: pixel, keys }
    this.hoverHandle.value = null
    // The boxes are asked for now, so they are likely in by the release
    const key = this.marqueeKey()
    if (key) void this.marqueeBounds.get(key.key, key.ids).catch(() => undefined)
    this.redraw()
  }

  /** What the cached boxes are for: the connection, the scene changes seen and the hierarchy's revision; null with no candidates */
  private marqueeKey(): { key: string; ids: readonly string[] } | null {
    const candidates = this.deps.marqueeCandidates?.()
    if (!candidates || candidates.ids.length === 0) return null
    return { key: `${this.connections}|${this.sceneChanges}|${candidates.revision}|${candidates.ids.length}`, ids: candidates.ids }
  }

  /**
   * The marquee was released at `to`: the candidates whose projected box it takes (marqueeHits) go to selectMany with
   * the keys held. Applied only when nothing else (a click, the hierarchy, the connection) changed the selection while
   * the boxes were read.
   */
  private async finishMarquee(from: Pixel, to: Pixel, keys: MarqueeKeys): Promise<void> {
    const selectMany = this.deps.selectMany
    const size = this.size
    if (!selectMany || !size || !this.canMarquee) return
    // A marquee makes the answer of a click before it out of date, as a later click does
    const generation = ++this.clickGeneration
    this.pickSender.discard()
    const connection = this.connections
    const selection = this.selectionKey()
    const op = marqueeOpOf(keys)
    const rect = clampRect(rectFrom(from, to), size.width, size.height)
    const key = this.marqueeKey()
    let hits: string[] = []
    if (rect && key) {
      let bounds
      try {
        bounds = await this.marqueeBounds.get(key.key, key.ids)
      } catch (e) {
        if (connection === this.connections) this.deps.onError("Failed to measure the objects for the marquee", e)
        return
      }
      // The camera can't move during the drag (zoom is refused, the other camera gestures are other buttons); a frame
      // resized while the boxes were read leaves the rectangle over another picture
      const m = this.matrices()
      if (!m || this.size?.width !== size.width || this.size?.height !== size.height) return
      hits = marqueeHits(m.viewProjection, size.width, size.height, rect, key.ids, bounds, keys.inside)
    }
    if (connection !== this.connections || generation !== this.clickGeneration || selection !== this.selectionKey()) return
    selectMany(hits, op)
  }

  private redraw(): void {
    this.overlayVersion.value++
  }
}
