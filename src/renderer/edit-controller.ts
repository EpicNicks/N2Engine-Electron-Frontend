// Undo and redo as the editor runs them (engine #78, protocol 1.6.0): what registers in edit-actions.ts. Before the
// host is asked, the editor's own half-finished edits are made real, because the host undoes what it has recorded:
// - the inspector's pending edits (they wait 250 ms for more), a drag that is being ended, an action on several
//   objects that is running and a rename on its way are settled first (the page's settle), so what they send is in the
//   history and inside the group they belong to;
// - only then are the groups still open ended (a slider still being dragged): the host refuses Undo and Redo while
//   one is open;
// then the history is read, so an edit those made is a step to undo. After it, the host's events are polled at once,
// so the hierarchy, the inspector and the selection follow (EditorStore.lastSceneChange), and the scene's revisions
// are taken from the answer (undoing back to the saved state clears the unsaved marker). No DOM: it is given the
// pieces or fakes, so it is unit tested in Node.
import type { ReadonlySignal } from "@preact/signals-core"
import type { EditResultResponse } from "../protocol/protocol.generated"
import type { HistoryStatus } from "../protocol/edit-history"
import type { EngineApi } from "../shared/api"
import type { EditActions } from "./edit-actions"
import type { EditGroups } from "./edit-groups"
import { planJump } from "./history-jump"

export interface EditControllerDeps {
  engine: Pick<EngineApi, "undo" | "redo">
  groups: Pick<EditGroups, "closeAll">
  /** The history as last known (EditorStore.history) */
  history: ReadonlySignal<HistoryStatus>
  /**
   * Whether the editor can edit the scene now: connected, with a scene loaded, nothing busy and not showing a play
   * session (the host refuses Undo and Redo outside edit mode): EditorStore.canEdit
   */
  enabled(): boolean
  /**
   * Sends what the inspector and the hierarchy hold back (their pending edits), and resolves when it is answered and
   * what is running (a drag being ended, an action on several objects) is done
   */
  settle(): Promise<void>
  /** Reads the history from the host */
  refreshHistory(): Promise<void>
  /** After the host changed the scene: the events are polled now and the history read again */
  syncAfterEdit(): Promise<void>
  /** Takes the answer's revisions as the scene's */
  applyResult(result: EditResultResponse): void
}

export type Direction = "undo" | "redo"

export interface JumpOptions {
  /** Called before the first step (done 0) and after each step that was answered */
  onProgress?(done: number, total: number): void
  /** Asked before each step: true stops the jump there (the steps already done stay done) */
  cancelled?(): boolean
  /** The history the target was chosen from: when the fresh read differs, nothing is sent (outcome "changed", 0 steps) */
  expected?: { cursor: number; total: number }
}

export type JumpOutcome = "completed" | "cancelled" | "disabled" | "changed" | "refused"

export interface JumpResult {
  outcome: JumpOutcome
  /** Steps that were undone or redone */
  done: number
  /** Steps the jump planned */
  total: number
}

/** A step of a jump failed (the host's refusal, a lost connection): how many were done, and the cause */
export class JumpFailed extends Error {
  constructor(
    readonly done: number,
    readonly total: number,
    readonly reason: unknown
  ) {
    super(`${reason instanceof Error ? reason.message : String(reason)} (stopped after ${done} of ${total} steps)`)
    this.name = "JumpFailed"
  }
}

export class EditController implements EditActions {
  /** The one that is running, and at most one more waiting for it: a held key doesn't queue a step per repeat */
  private running: Promise<void> | null = null
  private waiting: { which: Direction; promise: Promise<void> } | null = null
  /** A jump is running: undo and redo asked meanwhile are ignored (a jump is one operation) */
  private jumping = false

  constructor(private readonly deps: EditControllerDeps) {}

  canUndo(): boolean {
    return this.deps.enabled() && this.deps.history.value.canUndo
  }

  canRedo(): boolean {
    return this.deps.enabled() && this.deps.history.value.canRedo
  }

  undoLabel(): string {
    return this.deps.history.value.label
  }

  redoLabel(): string {
    return this.deps.history.value.redoLabel
  }

  /** An undo or redo is running or waiting (a key that repeats is ignored meanwhile) */
  busy(): boolean {
    return this.running !== null
  }

  undo(): Promise<void> {
    return this.queue("undo")
  }

  redo(): Promise<void> {
    return this.queue("redo")
  }

  /** Runs one at a time. While one runs, one more is kept; asking again meanwhile is that same one, not another */
  private queue(which: Direction): Promise<void> {
    if (this.jumping) return Promise.resolve()
    if (this.running === null) return this.start(which)
    if (this.waiting === null) {
      const running = this.running
      const promise = running.then(
        () => this.start(which),
        () => this.start(which)
      )
      this.waiting = { which, promise }
      void promise.then(
        () => undefined,
        () => undefined
      )
    }
    return this.waiting.promise
  }

  private start(which: Direction): Promise<void> {
    this.waiting = null
    return this.track(this.run(which))
  }

  private track(run: Promise<void>): Promise<void> {
    const mine: Promise<void> = run.then(
      () => this.finished(mine),
      (e) => {
        this.finished(mine)
        throw e
      }
    )
    this.running = mine
    return mine
  }

  private finished(run: Promise<void>): void {
    if (this.running === run) this.running = null
  }

  /** Resolves when it is done; rejects with the host's refusal ("Nothing to undo", a step that can't be undone, ...) */
  private async run(which: Direction): Promise<void> {
    if (!this.deps.enabled()) return
    await this.deps.settle()
    await this.deps.groups.closeAll()
    // What settling sent may be a step of its own (and the history held may be 100 ms old): the host's answer decides
    await this.deps.refreshHistory()
    const status = this.deps.history.value
    if (which === "undo" ? !status.canUndo : !status.canRedo) return
    let result: EditResultResponse
    try {
      result = await this.deps.engine[which]()
    } catch (e) {
      // A step that can't be undone clears the history and pushes a full change: the panels hear of it now
      await this.deps.syncAfterEdit().catch(() => undefined)
      throw e
    }
    this.deps.applyResult(result)
    await this.deps.syncAfterEdit()
  }

  /** A jump is running (or one undo or redo is: they exclude each other) */
  isJumping(): boolean {
    return this.jumping
  }

  /**
   * Makes the state after the first `target` steps of the history the scene's: what an undo or redo does, as many
   * times as it takes, one at a time, as one operation. What runs before the host is asked runs once (settle, close
   * the groups, read the history), the plan is made from the host's answer, then the steps are sent; it stops at the
   * first refusal (JumpFailed, after the history and the panels were brought up to date), when cancelled (between
   * two steps), when the editor can no longer edit (a play session, a read-only answer) and when the history is not
   * the one planned (another client edited: the total of steps changes, never by our own undo or redo).
   * Rejects at once when an undo, redo or jump is running.
   */
  jumpTo(target: number, options: JumpOptions = {}): Promise<JumpResult> {
    if (this.running !== null) return Promise.reject(new Error("An undo or redo is running"))
    let result: JumpResult = { outcome: "refused", done: 0, total: 0 }
    this.jumping = true
    const run = this.track(
      this.runJump(target, options, (r) => (result = r)).finally(() => {
        this.jumping = false
      })
    )
    return run.then(() => result)
  }

  private async runJump(target: number, options: JumpOptions, report: (result: JumpResult) => void): Promise<void> {
    if (!this.deps.enabled()) return
    await this.deps.settle()
    await this.deps.groups.closeAll()
    await this.deps.refreshHistory()
    const status = this.deps.history.value
    const cursor = status.undoCount
    const total = status.undoCount + status.redoCount
    if (options.expected && (options.expected.cursor !== cursor || options.expected.total !== total)) {
      return report({ outcome: "changed", done: 0, total: 0 })
    }
    const plan = planJump(cursor, total, Math.min(Math.max(target, 0), total))
    let done = 0
    const finish = (outcome: JumpOutcome): void => report({ outcome, done, total: plan.steps })
    if (plan.kind === "none") return finish("completed")
    options.onProgress?.(0, plan.steps)
    let touched = false
    try {
      while (done < plan.steps) {
        if (options.cancelled?.()) return finish("cancelled")
        if (!this.deps.enabled()) return finish("disabled")
        const now = this.deps.history.value
        if (now.undoCount + now.redoCount !== total) return finish("changed")
        touched = true
        let step: EditResultResponse
        try {
          step = await this.deps.engine[plan.kind]()
        } catch (e) {
          throw new JumpFailed(done, plan.steps, e)
        }
        done++
        this.deps.applyResult(step)
        options.onProgress?.(done, plan.steps)
        // The host says it can't go on (the history it has is not the one that was read)
        if (done < plan.steps && !(plan.kind === "undo" ? step.canUndo : step.canRedo)) return finish("changed")
      }
      finish("completed")
    } finally {
      // Whatever ended it: the panels hear of the scene as it is now, and the history is read again
      if (touched) await this.deps.syncAfterEdit().catch(() => undefined)
    }
  }
}
