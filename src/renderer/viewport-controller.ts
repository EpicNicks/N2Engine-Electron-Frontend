// The viewport's logic apart from the DOM: the editor camera (and how its pose reaches the host), the selected object
// as the gizmo sees it, the translate drag, frame selected and click to select. The panel (viewport-panel.tsx) only
// turns events into calls on it and draws what it says. It works in FRAME pixels (the engine's viewport size, top-left
// origin), which the panel converts from the page's pointer positions. No DOM: it is given the engine API or a fake,
// so it is unit tested in Node.
//
// Picking and bounds are a SEAM, not protocol: E7b's PickEntity and GetEntityBounds are not in the engine yet, so
// PickBackend is null until something implements it (the one place to wire them: createViewportController's
// `picking`). With none, a click does not select, and "frame selected" frames the object's world position instead.
import { signal } from "@preact/signals-core"
import type { EditorCameraResponse, Mat4, Quat, Vec3 } from "../protocol/protocol.generated"
import type { EngineApi } from "../shared/api"
import type { EditGroups } from "./edit-groups"
import { Bounds, EditorCameraController } from "./viewport-camera"
import { LatestWinsSender } from "./viewport-frames"
import {
  AxisDrag,
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
import { Pixel, add, mat4Multiply, mat4Translation, projectionMatrix, viewMatrix, ProjectionSettings } from "./viewport-math"
import type { PixelSize } from "./viewport-size"
import { ClickSlop, isClick } from "./viewport-input"

/**
 * The host's picking and bounds (E7b: PickEntity and GetEntityBounds; neither exists in protocol 1.7.0). Implement it
 * over the generated codecs when the engine has them, and pass it to the controller.
 */
export interface PickBackend {
  /** The object under the pixel (frame pixels, top-left origin), or null for none */
  pick(x: number, y: number, includeInactive: boolean): Promise<string | null>
  /** World bounds of the objects that have any; null when the host can't say */
  bounds(entityIds: string[]): Promise<Map<string, Bounds> | null>
}

type Engine = Pick<EngineApi, "isConnected" | "setEditorCamera" | "getEditorCamera" | "getEntity" | "setLocalTransform">

export interface ViewportDeps {
  engine: Engine
  groups: Pick<EditGroups, "begin" | "end">
  /** Null until the engine has PickEntity and GetEntityBounds (E7b) */
  picking: PickBackend | null
  /** A failure to show (the page's error banner) */
  onError(what: string, error: unknown): void
  /** Something worth a console line, not a banner (an unverified assumption failed) */
  onNote(message: string): void
  /** Whether the scene can be edited now (connected, not a play session): the gizmo is shown and used only then */
  canEdit(): boolean
  /** The primary selection, or what a click selected */
  selected(): string | null
  /**
   * The selected objects the gizmo moves: the topmost of the selection, so an object under another selected one is not
   * moved twice (it moves with its ancestor). Default: just the primary selection.
   */
  moveIds?(): readonly string[]
  /** Every selected object (a change to any of them reloads the gizmo's targets). Default: just the primary selection. */
  selectionIds?(): readonly string[]
  /** A click picked this object (null: empty space) */
  select(entityId: string | null): void
}

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

/** One update of a drag may move the object by at most this many handle lengths */
export const MaxStepHandleLengths = 50

export class ViewportController {
  readonly camera = new EditorCameraController()
  /**
   * Where the gizmo is: the primary selection as the gizmo needs it (or, when the primary has no transform, the first
   * object that moves); null with no selection
   */
  readonly target = signal<GizmoTarget | null>(null)
  /** The handle (an axis or a plane) under the pointer, or the one being dragged */
  readonly hoverHandle = signal<HandleId | null>(null)
  readonly dragging = signal(false)
  /** The selection's world bounds, when the host can say (the seam); drawn as a box */
  readonly selectionBounds = signal<Bounds | null>(null)
  /** Bumped when anything the overlay draws changed (the panel redraws on it) */
  readonly overlayVersion = signal(0)

  private size: PixelSize | null = null
  private readonly cameraSender: LatestWinsSender<ReturnType<EditorCameraController["toRequest"]>>
  private drag: GizmoDrag | null = null
  /** The objects a drag of the gizmo moves, as the host last said (the topmost of the selection that have a transform) */
  private movers: GizmoTarget[] = []
  private ended: Promise<void> = Promise.resolve()
  private pressed: { pixel: Pixel; onGizmo: boolean } | null = null
  /** Counts target loads, so a slow answer can't replace a newer one */
  private loads = 0
  private connections = 0
  private warned = false
  /** Frame pixels per CSS pixel: the gizmo's size, its pick distance and the click slop are CSS pixels */
  private ratio = 1
  private frameListener: (() => void) | null = null

  constructor(private readonly deps: ViewportDeps) {
    this.cameraSender = new LatestWinsSender(
      async (request) => {
        const { position, rotation, fovY, orthographic, orthoSize, nearPlane, farPlane } = request
        await deps.engine.setEditorCamera(position, rotation, fovY, orthographic, orthoSize, nearPlane, farPlane)
        // The host has the pose now: the next frame shows it
        this.frameNeeded()
      },
      (e) => deps.onError("Failed to move the camera", e)
    )
  }

  /** Who asks the host for a frame (the panel's renderer): called when the camera or the selected object moved */
  onFrameNeeded(listener: (() => void) | null): void {
    this.frameListener = listener
  }

  private frameNeeded(): void {
    this.frameListener?.()
  }

  /** Whether a click can select something (the seam has a backend) */
  get canPick(): boolean {
    return this.deps.picking !== null
  }

  get isDragging(): boolean {
    return this.drag !== null
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
    await this.verifyMatrices()
  }

  /** The connection ended: nothing of the host's is valid */
  disconnected(): void {
    this.connections++
    this.loads++
    if (this.drag) void this.finishDrag("abandon", false)
    this.pressed = null
    this.target.value = null
    this.movers = []
    this.selectionBounds.value = null
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
      orthographic: false,
      orthoSize: 5,
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
    this.camera.orbit(dx, dy)
    this.cameraChanged()
  }

  look(dx: number, dy: number): void {
    if (this.drag) return // the drag's maths is for the camera it began with
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
    this.camera.zoom(deltaPixels)
    this.cameraChanged()
  }

  fly(move: Vec3, dtSeconds: number, boost: boolean): void {
    if (this.drag) return
    this.camera.fly(move, dtSeconds, this.camera.flySpeed(boost))
    this.cameraChanged()
  }

  /**
   * Frames the selected object: its world bounds when the host can give them (the seam), else its world position
   * (GetEntity's world matrix) at a fixed distance. False when nothing is selected or the object can't be read.
   */
  async frameSelected(): Promise<boolean> {
    if (this.drag) return false
    const id = this.deps.selected()
    if (id === null) return false
    if (this.deps.picking) {
      try {
        const bounds = (await this.deps.picking.bounds([id]))?.get(id)
        if (bounds) {
          this.camera.frameBounds(bounds)
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
    if (!target) return false
    this.camera.framePoint(mat4Translation(target.worldMatrix))
    this.cameraChanged()
    return true
  }

  // ==================== The selected object ====================

  private moveIds(id: string): readonly string[] {
    return this.deps.moveIds?.() ?? [id]
  }

  /** One object as the gizmo needs it; null for one that is gone, can't be read or has no transform */
  private async readTarget(id: string): Promise<GizmoTarget | null> {
    try {
      const { entity, worldMatrix } = await this.deps.engine.getEntity(id)
      const t = entity.transform
      return t
        ? {
            id,
            name: entity.header.name,
            localPosition: { ...t.position },
            localRotation: { ...t.rotation } as Quat,
            localScale: { ...t.scale },
            worldMatrix,
          }
        : null
    } catch (e) {
      // An object that is gone, or one the host can't read: no gizmo for it
      console.debug("GetEntity failed:", e)
      return null
    }
  }

  /**
   * The selection's primary object changed, or the objects changed in the scene: read the primary and the objects a
   * drag moves (the topmost of the selection) for the gizmo
   */
  async loadTarget(id: string | null): Promise<void> {
    const load = ++this.loads
    if (id === null || !this.deps.engine.isConnected()) {
      this.target.value = null
      this.movers = []
      this.selectionBounds.value = null
      this.redraw()
      return
    }
    const moveIds = this.moveIds(id)
    const ids = [...new Set([id, ...moveIds])]
    const read = await Promise.all(ids.map((i) => this.readTarget(i)))
    if (load !== this.loads || this.drag) return
    const byId = new Map(ids.map((i, k) => [i, read[k]] as const))
    this.movers = moveIds.map((i) => byId.get(i) ?? null).filter((t): t is GizmoTarget => t !== null)
    this.target.value = byId.get(id) ?? this.movers[0] ?? null
    await this.loadBounds(id)
    if (load === this.loads) this.redraw()
  }

  /** Scene objects changed: the selected one is read again, unless this client is moving it (the drag knows) */
  objectsChanged(entityIds: readonly string[], full: boolean): void {
    const id = this.deps.selected()
    const selected = id === null ? [] : (this.deps.selectionIds?.() ?? [id])
    if (this.drag) {
      // The scene was replaced under the drag: its object is gone. Anything else is the echo of the drag's own edits.
      if (full) void this.finishDrag("abandon", true)
      return
    }
    if (id === null) return
    if (full || selected.some((s) => entityIds.includes(s))) void this.loadTarget(id)
  }

  private async loadBounds(id: string): Promise<void> {
    this.selectionBounds.value = null
    if (!this.deps.picking) return
    try {
      const bounds = (await this.deps.picking.bounds([id]))?.get(id) ?? null
      if (this.deps.selected() === id) this.selectionBounds.value = bounds
    } catch (e) {
      console.debug("GetEntityBounds failed:", e)
    }
  }

  // ==================== Gizmo and picking ====================

  /** Where the gizmo is now; null with no selection, no viewport size or the object behind the camera */
  layout(): GizmoLayout | null {
    const target = this.target.value
    const m = this.matrices()
    if (!target || !m || !this.size || (!this.drag && !this.deps.canEdit())) return null
    // While dragging, the object is where the drag has put it, not where the host last said
    const origin = mat4Translation(target.worldMatrix)
    return gizmoLayout(m.view, m.viewProjection, this.dragOrigin ?? origin, this.size.width, this.size.height, this.ratio)
  }

  /** The world position the gizmo is drawn at during a drag (the host's reading of it lags the drag) */
  private dragOrigin: Vec3 | null = null

  /** The selection's box on screen, as pixel pairs (empty without bounds) */
  boxEdges(): Array<[Pixel, Pixel]> {
    const bounds = this.selectionBounds.value
    const m = this.matrices()
    if (!bounds || !m || !this.size) return []
    return projectBox(m.viewProjection, bounds.min, bounds.max, this.size.width, this.size.height)
  }

  /** The pointer moved without a button: the handle under it lights up */
  hover(pixel: Pixel | null): void {
    if (this.drag) return
    const layout = pixel ? this.layout() : null
    const handle = layout && pixel ? hitTestGizmo(layout, pixel, this.ratio) : null
    if (handle !== this.hoverHandle.value) {
      this.hoverHandle.value = handle
      this.redraw()
    }
  }

  /**
   * The left button went down. True when a gizmo handle took it (a drag has begun: pointerMove and pointerUp follow);
   * false when it is a plain press, which selects on release if it didn't move (see click).
   */
  pointerDown(pixel: Pixel, snap: boolean): boolean {
    const target = this.target.value
    const layout = this.layout()
    const m = this.matrices()
    const handle = layout ? hitTestGizmo(layout, pixel, this.ratio) : null
    this.pressed = { pixel, onGizmo: false }
    if (!target || !layout || !m || !this.size || !handle || this.movers.length === 0) return false
    const origin = mat4Translation(target.worldMatrix)
    const farPlane = this.camera.farPlane
    const maxStep = layout.worldLength * MaxStepHandleLengths
    const { width, height } = this.size
    const source: DragSource | null = isPlane(handle)
      ? PlaneDrag.begin(handle, origin, m.viewProjection, pixel, width, height, farPlane, maxStep)
      : AxisDrag.begin(handle, origin, m.viewProjection, pixel, width, height, farPlane, maxStep)
    if (!source) return false
    this.pressed.onGizmo = true
    this.drag = new GizmoDrag(
      {
        engine: this.deps.engine,
        groups: this.deps.groups,
        onError: (what, e) => this.deps.onError(what, e),
        onMoved: () => this.frameNeeded(),
      },
      this.movers,
      source,
      snap
    )
    this.dragOrigin = origin
    this.dragging.value = true
    this.hoverHandle.value = handle
    this.redraw()
    return true
  }

  pointerMove(pixel: Pixel, snap: boolean): void {
    const drag = this.drag
    const target = this.target.value
    if (!drag || !target) return
    if (drag.update(pixel, snap)) {
      // The gizmo follows at once, on this side of the round trip
      this.dragOrigin = add(mat4Translation(target.worldMatrix), drag.worldDelta)
      this.redraw()
    }
  }

  /**
   * The left button was released at pixel. Ends a gizmo drag (resolving when its group has ended); otherwise a press
   * that stayed put is a click: with picking, it selects the object under the pointer (or none).
   */
  async pointerUp(pixel: Pixel): Promise<void> {
    const pressed = this.pressed
    this.pressed = null
    if (this.drag) return this.finishDrag("end", true)
    if (pressed && !pressed.onGizmo && isClick(pressed.pixel, pixel, ClickSlop * this.ratio)) await this.click(pixel)
  }

  /** The press was cancelled (Escape, or the window lost the pointer): a drag in progress puts the object back */
  async cancel(): Promise<void> {
    this.pressed = null
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
    this.dragOrigin = null
    this.dragging.value = false
    const done = how === "end" ? drag.end() : how === "cancel" ? drag.cancel() : drag.abandon()
    this.ended = done.then(
      () => undefined,
      () => undefined
    )
    // The host's reading of the object is the truth again
    return done.then(() => (reload ? this.loadTarget(this.deps.selected()) : undefined))
  }

  /** Resolves when a drag's group has ended (what the undo waits for) */
  get gestureEnded(): Promise<void> {
    return this.ended
  }

  private async click(pixel: Pixel): Promise<void> {
    const picking = this.deps.picking
    if (!picking) return
    try {
      this.deps.select(await picking.pick(pixel.x, pixel.y, false))
    } catch (e) {
      this.deps.onError("Failed to pick an object", e)
    }
  }

  private redraw(): void {
    this.overlayVersion.value++
  }
}
