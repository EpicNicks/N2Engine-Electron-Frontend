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
  Axis,
  AxisDrag,
  GizmoDrag,
  GizmoLayout,
  GizmoTarget,
  gizmoLayout,
  hitTestGizmo,
  projectBox,
} from "./viewport-gizmo"
import { Pixel, add, mat4Multiply, mat4Translation, projectionMatrix, viewMatrix, ProjectionSettings } from "./viewport-math"
import type { PixelSize } from "./viewport-size"
import { isClick } from "./viewport-input"

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

export class ViewportController {
  readonly camera = new EditorCameraController()
  /** The selected object as the gizmo needs it; null with none, or one that has no transform */
  readonly target = signal<GizmoTarget | null>(null)
  /** The handle under the pointer, or the one being dragged */
  readonly hoverAxis = signal<Axis | null>(null)
  readonly dragging = signal(false)
  /** The selection's world bounds, when the host can say (the seam); drawn as a box */
  readonly selectionBounds = signal<Bounds | null>(null)
  /** Bumped when anything the overlay draws changed (the panel redraws on it) */
  readonly overlayVersion = signal(0)

  private size: PixelSize | null = null
  private readonly cameraSender: LatestWinsSender<ReturnType<EditorCameraController["toRequest"]>>
  private drag: GizmoDrag | null = null
  private ended: Promise<void> = Promise.resolve()
  private pressed: { pixel: Pixel; onGizmo: boolean } | null = null
  /** Counts target loads, so a slow answer can't replace a newer one */
  private loads = 0
  private connections = 0
  private warned = false
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

  /** The viewport's pixel size (as sent to SetViewportSize) */
  setSize(size: PixelSize | null): void {
    this.size = size
    this.redraw()
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
  }

  /** The connection ended: nothing of the host's is valid */
  disconnected(): void {
    this.connections++
    this.loads++
    this.drag = null
    this.pressed = null
    this.target.value = null
    this.selectionBounds.value = null
    this.dragging.value = false
    this.hoverAxis.value = null
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
    this.camera.orbit(dx, dy)
    this.cameraChanged()
  }

  look(dx: number, dy: number): void {
    this.camera.look(dx, dy)
    this.cameraChanged()
  }

  pan(dx: number, dy: number): void {
    if (!this.size) return
    this.camera.pan(dx, dy, this.size.height)
    this.cameraChanged()
  }

  zoom(deltaPixels: number): void {
    this.camera.zoom(deltaPixels)
    this.cameraChanged()
  }

  fly(move: Vec3, dtSeconds: number, boost: boolean): void {
    this.camera.fly(move, dtSeconds, this.camera.flySpeed(boost))
    this.cameraChanged()
  }

  /**
   * Frames the selected object: its world bounds when the host can give them (the seam), else its world position
   * (GetEntity's world matrix) at a fixed distance. False when nothing is selected or the object can't be read.
   */
  async frameSelected(): Promise<boolean> {
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

  /** The selection's primary object changed, or the objects changed in the scene: read it for the gizmo */
  async loadTarget(id: string | null): Promise<void> {
    const load = ++this.loads
    if (id === null || !this.deps.engine.isConnected()) {
      this.target.value = null
      this.selectionBounds.value = null
      this.redraw()
      return
    }
    try {
      const { entity, worldMatrix } = await this.deps.engine.getEntity(id)
      if (load !== this.loads || this.drag) return
      const t = entity.transform
      this.target.value = t
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
      // An object that is gone, or one the host can't read: no gizmo
      console.debug("GetEntity failed:", e)
      if (load === this.loads) this.target.value = null
    }
    if (load === this.loads) {
      await this.loadBounds(id)
      this.redraw()
    }
  }

  /** Scene objects changed: the selected one is read again, unless this client is moving it (the drag knows) */
  objectsChanged(entityIds: readonly string[], full: boolean): void {
    const id = this.deps.selected()
    if (id === null || this.drag) return
    if (full || entityIds.includes(id)) void this.loadTarget(id)
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
    return gizmoLayout(m.view, m.viewProjection, this.dragOrigin ?? origin, this.size.width, this.size.height)
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
    const axis = layout && pixel ? hitTestGizmo(layout, pixel) : null
    if (axis !== this.hoverAxis.value) {
      this.hoverAxis.value = axis
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
    const axis = layout ? hitTestGizmo(layout, pixel) : null
    this.pressed = { pixel, onGizmo: false }
    if (!target || !layout || !m || !this.size || !axis) return false
    const origin = mat4Translation(target.worldMatrix)
    const axisDrag = AxisDrag.begin(axis, origin, m.viewProjection, pixel, this.size.width, this.size.height)
    if (!axisDrag) return false
    this.pressed.onGizmo = true
    this.drag = new GizmoDrag(
      {
        engine: this.deps.engine,
        groups: this.deps.groups,
        onError: (what, e) => this.deps.onError(what, e),
        onMoved: () => this.frameNeeded(),
      },
      target,
      axisDrag,
      snap
    )
    this.dragOrigin = origin
    this.dragging.value = true
    this.hoverAxis.value = axis
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
    const drag = this.drag
    if (drag) {
      this.drag = null
      this.dragOrigin = null
      this.dragging.value = false
      const done = drag.end()
      this.ended = done.then(() => undefined, () => undefined)
      await done
      // The host's reading of the object is the truth again
      await this.loadTarget(this.deps.selected())
      return
    }
    if (pressed && !pressed.onGizmo && isClick(pressed.pixel, pixel)) await this.click(pixel)
  }

  /** The press was cancelled (Escape, or the window lost the pointer): a drag in progress puts the object back */
  async cancel(): Promise<void> {
    this.pressed = null
    const drag = this.drag
    if (!drag) return
    this.drag = null
    this.dragOrigin = null
    this.dragging.value = false
    const done = drag.cancel()
    this.ended = done.then(() => undefined, () => undefined)
    await done
    await this.loadTarget(this.deps.selected())
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
