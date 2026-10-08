// The viewport's logic apart from the DOM: the editor camera (and how its pose reaches the host), the selected object
// as the gizmo sees it, the translate drag, frame selected and click to select. The panel (viewport-panel.tsx) only
// turns events into calls on it and draws what it says. It works in FRAME pixels (the engine's viewport size, top-left
// origin), which the panel converts from the page's pointer positions. No DOM: it is given the engine API or a fake,
// so it is unit tested in Node.
//
// Picking and bounds (protocol 1.8.0: PickEntity, GetEntityBounds) are reached through PickBackend (the engine's
// implementation is viewport-picking.ts's createPickBackend, passed as `picking`). With none (a test, or a host without
// them), a click does not select, there is no selection box, and "frame selected" frames the object's world position.
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
import { IdentityMat4, Pixel, add, mat4Multiply, mat4Translation, projectionMatrix, viewMatrix, ProjectionSettings } from "./viewport-math"
import type { PixelSize } from "./viewport-size"
import { ClickSlop, isClick } from "./viewport-input"
import { selectionKeyOf } from "./viewport-selection"

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
  /**
   * Where the gizmo is: the primary selection as the gizmo needs it (or, when the primary has no transform, the first
   * object that moves); null with no selection
   */
  readonly target = signal<GizmoTarget | null>(null)
  /** The handle (an axis or a plane) under the pointer, or the one being dragged */
  readonly hoverHandle = signal<HandleId | null>(null)
  readonly dragging = signal(false)
  /** The world bounds of the selected objects the host could measure, by id; drawn as boxes */
  readonly selectionBounds = signal<ReadonlyMap<string, Bounds>>(new Map())
  /** Bumped when anything the overlay draws changed (the panel redraws on it) */
  readonly overlayVersion = signal(0)

  private size: PixelSize | null = null
  private readonly cameraSender: LatestWinsSender<ReturnType<EditorCameraController["toRequest"]>>
  private drag: GizmoDrag | null = null
  /** The objects a drag of the gizmo moves, as the host last said (the topmost of the selection that have a transform) */
  private movers: GizmoTarget[] = []
  /** What the targets were read for (selectionKeyOf), and each one as last read: only changed ones are read again */
  private moversKey: string | null = null
  private readonly read = new Map<string, GizmoTarget | null>()
  private ended: Promise<void> = Promise.resolve()
  private pressed: { pixel: Pixel; onGizmo: boolean } | null = null
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
    this.reloadBounds()
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
   * Frames the selected objects: the union of their world bounds when the host can give them (GetEntityBounds, one
   * call), else the primary object's world position (GetEntity's world matrix) at a fixed distance. False when nothing
   * is selected or the object can't be read.
   */
  async frameSelected(): Promise<boolean> {
    if (this.drag) return false
    const id = this.deps.selected()
    if (id === null) return false
    if (this.canPick && this.deps.picking && this.deps.engine.isConnected()) {
      try {
        const ids = [...new Set([id, ...this.selectedIds(id)])]
        const found = await this.deps.picking.bounds(ids)
        const union = found ? unionBounds(found.values()) : null
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
    if (!target) return false
    this.camera.framePoint(mat4Translation(target.worldMatrix))
    this.cameraChanged()
    return true
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
      this.redraw()
      return
    }
    const moveIds = this.moveIds(id)
    const key = selectionKeyOf(id, moveIds)
    const ids = [...new Set([id, ...moveIds])]
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
    if (this.drag) {
      if (replaced) {
        void this.finishDrag("abandon", true)
        this.reloadBounds()
      }
      return
    }
    // The boxes follow every change (also a "full" one, which a drag's own echo can be): an object's bounds include
    // what is under it, and a change names only what changed
    this.reloadBounds()
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
  reloadBounds(): void {
    if (this.boundsRunning) {
      this.boundsDirty = true
      return
    }
    this.boundsRunning = true
    void this.runBounds()
  }

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

  /**
   * The selected objects' boxes on screen, as pixel pairs: 12 edges per object (the ones with both ends in front of the
   * camera), for the objects still selected. During a drag the boxes move with it, ahead of the host's answer (every
   * selected object is one the drag moves or lies under one).
   */
  boxEdges(): Array<[Pixel, Pixel]> {
    const m = this.matrices()
    if (!m || !this.size) return []
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
    // A press on a handle is the gizmo's, even when no drag can begin from it: it never selects what is behind it
    this.pressed = { pixel, onGizmo: handle !== null }
    if (!target || !layout || !m || !this.size || !handle || this.movers.length === 0) return false
    // The objects the drag moves were read for another selection (a change of it is on its way): not this press
    const id = this.deps.selected()
    if (id === null || this.moversKey !== selectionKeyOf(id, this.moveIds(id))) return false
    const origin = mat4Translation(target.worldMatrix)
    const farPlane = this.camera.farPlane
    const maxStep = layout.worldLength * MaxStepHandleLengths
    const { width, height } = this.size
    const source: DragSource | null = isPlane(handle)
      ? PlaneDrag.begin(handle, origin, m.viewProjection, pixel, width, height, farPlane, maxStep)
      : AxisDrag.begin(handle, origin, m.viewProjection, pixel, width, height, farPlane, maxStep)
    if (!source) return false
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
   * that stayed put (within the click slop) is a click: with picking, it selects the object under the pointer, or none,
   * with the modifier keys held at the release. Resolves when the pick has been answered.
   */
  async pointerUp(pixel: Pixel, modifiers: ClickModifiers = {}): Promise<void> {
    const pressed = this.pressed
    this.pressed = null
    if (this.drag) return this.finishDrag("end", true)
    if (pressed && !pressed.onGizmo && isClick(pressed.pixel, pixel, ClickSlop * this.ratio)) this.click(pixel, modifiers)
    await this.pickSender.flush()
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
    return done.then(() => {
      if (!reload) return undefined
      // The objects moved: their boxes are the host's again too
      this.reloadBounds()
      return this.loadTarget(this.deps.selected())
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

  private redraw(): void {
    this.overlayVersion.value++
  }
}
