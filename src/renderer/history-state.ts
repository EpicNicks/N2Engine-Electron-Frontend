// The history panel's state, without a DOM: the host's history as last read, kept current by the history events (the
// store's `history` status changes on every historyChanged and on every GetHistory), and the one jump that may run.
// It is given the pieces (or fakes), so it is unit tested in Node; the panel (history-panel.tsx) only draws it.
import { computed, effect, signal, type ReadonlySignal } from "@preact/signals-core"
import type { HistoryResponse } from "../protocol/protocol.generated"
import type { HistoryStatus } from "../protocol/edit-history"
import type { Timers } from "../protocol/event-pump"
import { JumpFailed, type JumpOptions, type JumpResult } from "./edit-controller"
import { diffHistory } from "./history-jump"

/** The wait after a history event before GetHistory is read (a drag sends many) */
export const RefreshDelayMs = 100

export interface JumpProgress {
  done: number
  total: number
  cancelling: boolean
}

export interface HistoryModelDeps {
  /** GetHistory */
  getHistory(): Promise<HistoryResponse>
  /** EditorStore.history: changes on every historyChanged event and every read, which is what makes the panel read */
  status: ReadonlySignal<HistoryStatus>
  connected: ReadonlySignal<boolean>
  /** EditorStore.readOnlyReason: why nothing can be written (a play session, a read-only host, a viewer), or null */
  readOnlyReason: ReadonlySignal<string | null>
  /** EditorStore.canEdit */
  canEdit: ReadonlySignal<boolean>
  /** EditGroups.openCount: groups this client has open (a drag in progress) */
  openGroups: ReadonlySignal<number>
  /** The scene's revisions (EditorStore.scene), null with no scene */
  revisions: ReadonlySignal<{ revision: number; savedRevision: number } | null>
  /** EditController.jumpTo */
  jump(target: number, options: JumpOptions): Promise<JumpResult>
  timers: Timers
}

export class HistoryModel {
  /** What the host said last; null until read, and when not connected */
  readonly history = signal<HistoryResponse | null>(null)
  readonly progress = signal<JumpProgress | null>(null)
  /** What went wrong last (a failed jump or read), shown until dismissed or the next jump */
  readonly error = signal<string | null>(null)
  /** Bumped when the rows' content changed in a way that should reset the keyboard position (a new scene, a new edit) */
  readonly generation = signal(0)

  private reads = 0
  private timer: unknown = null
  private disposers: Array<() => void> = []
  private cancelRequested = false
  private started = false
  get revisions(): ReadonlySignal<{ revision: number; savedRevision: number } | null> {
    return this.deps.revisions
  }

  constructor(private readonly deps: HistoryModelDeps) {}

  /** Why the rows can't be jumped to now; null when they can */
  readonly disabledReason: ReadonlySignal<string | null> = computed(() => {
    if (!this.deps.connected.value) return "Not connected"
    if (this.progress.value) return "A jump is running"
    const readOnly = this.deps.readOnlyReason.value
    if (readOnly !== null) return `Read-only: ${readOnly}`
    if (!this.deps.canEdit.value) return "The scene can't be edited now"
    if (this.deps.openGroups.value > 0) return "An edit group is open (a drag is in progress)"
    return null
  })

  /** Listens to the history events and reads the history; returns what stops it (the panel unmounting) */
  start(): () => void {
    if (this.started) return () => {}
    this.started = true
    let first = true
    this.disposers.push(
      effect(() => {
        this.deps.status.value // what this runs on
        const connected = this.deps.connected.value
        if (!connected) {
          this.reads++
          this.history.value = null
          return
        }
        // A jump reads the history when it is over, not at each of its own events
        if (this.progress.peek()) return
        if (first) {
          first = false
          this.refresh()
        } else this.schedule()
      })
    )
    return () => this.dispose()
  }

  dispose(): void {
    this.disposers.forEach((d) => d())
    this.disposers = []
    if (this.timer !== null) this.deps.timers.clearTimeout(this.timer)
    this.timer = null
    this.reads++ // an answer on its way is not wanted
    this.started = false
  }

  private schedule(): void {
    if (this.timer !== null) this.deps.timers.clearTimeout(this.timer)
    this.timer = this.deps.timers.setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, RefreshDelayMs)
  }

  /** Reads GetHistory; the newest read wins */
  async refresh(): Promise<void> {
    const read = ++this.reads
    try {
      const next = await this.deps.getHistory()
      if (read !== this.reads) return
      const change = diffHistory(this.history.peek(), next)
      if (change === "same") return
      this.history.value = next
      if (change !== "cursor") this.generation.value++
    } catch (e) {
      if (read !== this.reads) return
      this.error.value = `Failed to read the history: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  dismissError(): void {
    this.error.value = null
  }

  /** Asks the running jump to stop before its next step */
  cancel(): void {
    const progress = this.progress.value
    if (!progress || progress.cancelling) return
    this.cancelRequested = true
    this.progress.value = { ...progress, cancelling: true }
  }

  /** Jumps to a row (its cursor); does nothing while the rows are disabled. Never rejects: a failure is `error` */
  async jumpTo(target: number): Promise<void> {
    if (this.disabledReason.value !== null) return
    const current = this.history.value
    if (current !== null && target === current.cursor) return
    this.error.value = null
    this.cancelRequested = false
    this.progress.value = { done: 0, total: 0, cancelling: false }
    try {
      const result = await this.deps.jump(target, {
        onProgress: (done, total) => {
          this.progress.value = { done, total, cancelling: this.cancelRequested }
        },
        cancelled: () => this.cancelRequested,
      })
      if (result.outcome === "changed") {
        this.error.value = `The history changed while jumping (another client edited): stopped after ${result.done} of ${result.total} steps`
      } else if (result.outcome === "disabled") {
        this.error.value = `Editing became unavailable: stopped after ${result.done} of ${result.total} steps`
      } else if (result.outcome === "refused") {
        this.error.value = "The jump was not started: the scene can't be edited now"
      }
    } catch (e) {
      this.error.value =
        e instanceof JumpFailed ? `Jump failed: ${e.message}` : `Jump failed: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      this.progress.value = null
      this.cancelRequested = false
      // Whatever the outcome, what the host has now is what is shown
      await this.refresh()
    }
  }
}

/** The page's model, set by index.tsx once the store and the edit controller exist; the panel shows "not available" until then */
export const historyModel = signal<HistoryModel | null>(null)
