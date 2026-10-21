// The part of a gizmo drag that does not depend on the tool: the objects it changes, the edit group that makes it one
// undo step, the one batch of SetLocalTransform calls in flight, and how it ends (release, Escape, abandon). The
// translate drag (viewport-gizmo.ts), the rotate drag (viewport-rotate.ts) and the scale drag (viewport-scale.ts) are
// subclasses that only work out, for the pointer now, what each object's local transform becomes. No DOM: it is given
// the engine API and the edit groups or fakes of them, so it is unit tested in Node.
import type { Mat4, Quat, Vec3 } from "../protocol/protocol.generated"
import type { EditGroups, GroupHandle } from "./edit-groups"
import { LatestWinsSender } from "./viewport-frames"
import { vec3 } from "./viewport-math"

/** The selected object as a gizmo needs it: GetEntity's local transform and world matrix */
export interface GizmoTarget {
  id: string
  name: string
  localPosition: Vec3
  localRotation: Quat
  localScale: Vec3
  worldMatrix: Mat4
  /**
   * The object's parent's world matrix (the identity for a root), when the editor has read it. With it a change is
   * exact whatever the signs of the scales; without it the parent is derived from the object's own world matrix, which
   * can't tell a mirrored parent from a mirrored child.
   */
  parentWorld?: Mat4
}

/** What a drag needs of the engine and of the edit groups */
export interface GizmoDragDeps {
  engine: { setLocalTransform(entityId: string, position: Vec3, rotation: Quat, scale: Vec3): Promise<void> }
  groups: Pick<EditGroups, "begin" | "end">
  /** A refused or failed change (an object that is gone, say): reported, and the drag goes on with the others */
  onError(what: string, error: unknown): void
  /** The objects' transforms changed on the host's side (after each batch is sent): the frame is asked for again */
  onMoved?(): void
}

/** One object's new local transform */
export interface TransformMove {
  index: number
  position: Vec3
  rotation: Quat
  scale: Vec3
}

/** What a subclass says for one object: its new local transform, or why it can't be changed ("can't be moved: ...") */
export type TransformResult = TransformMove | string

/** How a drag names itself: its undo step ("Move", "Rotate", "Scale") and its failures ("Failed to move the object") */
export interface DragWording {
  step: string
  failed: string
}

/** The host's refusal for an object that is not (or no longer) in the scene: "<what> not found: <id>" */
const NotFound = /not found/i

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * One drag of one or several objects, from the press on a handle to the release: BeginEditGroup first, then at most
 * one batch of SetLocalTransform calls in flight (the latest transforms win; a batch's calls are sent together, since
 * they share one ordered connection), then EndEditGroup, so the drag is one undo step however many updates it sent and
 * however many objects it changed. Releasing without having changed anything changes nothing. A failure is reported
 * once per object; an object the host says is not found is left out of the rest of the drag, one that failed otherwise
 * is tried again with the next update. An abandoned drag (the connection went, the scene was replaced) sends nothing
 * more, even of a batch it was in the middle of, and says nothing about what that costs. The targets must be the
 * topmost of the selection: an object under another that changes would be changed twice.
 */
export abstract class TransformDrag {
  /** Where the first object is now (local), as the drag has set it */
  position: Vec3
  private readonly sender: LatestWinsSender<TransformMove[]>
  private readonly began: Promise<GroupHandle | null>
  private finished: Promise<void> | null = null
  private abandoned = false
  /** Objects the host does not have (any more) */
  private readonly dead = new Set<number>()
  /** Objects whose failure has been reported, and those whose skipping has: once per drag each */
  private readonly reported = new Set<number>()
  private readonly skipReported = new Set<number>()
  /** Objects a change was ever pushed for (what Escape puts back) */
  private readonly changedIndexes = new Set<number>()
  protected readonly targets: readonly GizmoTarget[]
  /** Whether a change was ever pushed */
  moved = false
  /** The move in the world the drag has made (the snapped delta); zero for a drag that does not move the pivot */
  worldDelta: Vec3 = vec3(0, 0, 0)

  protected constructor(
    private readonly deps: GizmoDragDeps,
    target: GizmoTarget | readonly GizmoTarget[],
    private readonly wording: DragWording
  ) {
    this.targets = Array.isArray(target) ? target : [target as GizmoTarget]
    this.position = this.targets[0].localPosition
    this.began = deps.groups.begin(
      this.targets.length === 1 ? `${wording.step} ${this.targets[0].name}` : `${wording.step} ${this.targets.length} objects`
    )
    this.sender = new LatestWinsSender<TransformMove[]>(async (moves) => {
      // The group is open before the first edit goes
      await this.began
      await Promise.all(moves.map((move) => this.send(move)))
      if (!this.abandoned) deps.onMoved?.()
    })
  }

  private async send(move: TransformMove): Promise<void> {
    if (this.abandoned || this.dead.has(move.index)) return
    const t = this.targets[move.index]
    try {
      await this.deps.engine.setLocalTransform(t.id, move.position, move.rotation, move.scale)
    } catch (e) {
      // After an abandon the failure is the connection's or the scene's going: nothing to say about it
      if (this.abandoned) return
      if (NotFound.test(messageOf(e))) this.dead.add(move.index)
      if (!this.reported.has(move.index)) {
        this.reported.add(move.index)
        this.deps.onError(this.wording.failed, e)
      }
    }
  }

  /**
   * Sends what a subclass worked out for each object (in the order of the targets): the objects it has a transform for
   * go out as one batch, an object it could not change is reported once. False when nothing could be changed.
   */
  protected submit(results: readonly TransformResult[]): boolean {
    const moves: TransformMove[] = []
    results.forEach((result, index) => {
      if (typeof result === "string") {
        if (!this.skipReported.has(index)) {
          this.skipReported.add(index)
          this.deps.onError(this.wording.failed, new Error(`${this.targets[index].name} ${result}`))
        }
      } else {
        moves.push(result)
        this.changedIndexes.add(result.index)
      }
    })
    if (moves.length === 0) return false
    this.position = moves[0].index === 0 ? moves[0].position : this.position
    this.moved = true
    this.sender.push(moves)
    return true
  }

  /** Whether the drag has ended (or is ending): no more updates */
  protected get isFinished(): boolean {
    return this.finished !== null
  }

  /** The pointer was released: the last transforms are sent, and the group ends */
  end(): Promise<void> {
    this.finished ??= this.finish()
    return this.finished
  }

  /**
   * The connection went or the scene was replaced: what is waiting to be sent is dropped (it is for objects that are
   * gone), a batch being sent stops before its next call, and the group ends. A call already on its way can't be
   * recalled.
   */
  abandon(): Promise<void> {
    this.abandoned = true
    if (!this.finished) {
      this.sender.discard()
      this.finished = this.finish()
    }
    return this.finished
  }

  /**
   * Escape: the objects that were changed go back to what they were, and the group ends. The group still holds the
   * change and the change back, so the host records a step that changes nothing (its FinishGroup skips only a group
   * with no edits): it marks the scene as changed and clears redo. Escape is kept as it is until the host skips such
   * groups.
   */
  cancel(): Promise<void> {
    if (!this.finished) {
      if (this.moved) {
        this.position = this.targets[0].localPosition
        this.worldDelta = vec3(0, 0, 0)
        this.sender.push(
          [...this.changedIndexes].map((index) => {
            const t = this.targets[index]
            return { index, position: t.localPosition, rotation: t.localRotation, scale: t.localScale }
          })
        )
      }
      this.finished = this.finish()
    }
    return this.finished
  }

  private async finish(): Promise<void> {
    const handle = await this.began
    await this.sender.flush()
    await this.deps.groups.end(handle)
  }
}
