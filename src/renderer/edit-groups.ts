// Edit groups (engine #78, protocol 1.6.0): every edit between BeginEditGroup and EndEditGroup is one undo step, so
// a drag of a slider or a move of several objects is undone with one Ctrl+Z. The host refuses Undo while a group is
// open and merges nothing else into a step that is still open, so a group left open is a bug: it swallows every later
// edit into one step. EditGroups therefore
// - sends the host's begin and end in order, one at a time (an end never overtakes its begin);
// - ends what it began whatever the work between did (within, in a finally);
// - ends every open group before an undo (closeAll), and forgets them when the connection goes (the host ends a
//   group its client left open when the connection closes and at the next Hello).
// No DOM: it is given the page's engine API or a fake, so it is unit tested in Node.
import type { EngineApi } from "../shared/api"

type Engine = Pick<EngineApi, "isConnected" | "beginEditGroup" | "endEditGroup">

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The host's answer to EndEditGroup when none is open: the group is closed, which is what was wanted */
const NoGroupOpen = /no edit group is open/i

export class EditGroups {
  /** The groups the host accepted and this client has not ended */
  private opened = 0
  /** Counts connections that ended: an answer for an earlier one says nothing about the current host */
  private epoch = 0
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly engine: Engine,
    /** A failure nobody awaits (ending a group in a finally, a gesture's end) */
    private readonly onError: (what: string, error: unknown) => void = () => {}
  ) {}

  /** How many groups are open as far as this client knows */
  get depth(): number {
    return this.opened
  }

  /** Resolves when every begin and end sent so far has been answered */
  get settled(): Promise<void> {
    return this.chain.then(
      () => undefined,
      () => undefined
    )
  }

  /** Runs the jobs one at a time, in the order they were asked for */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job)
    this.chain = run.catch(() => undefined)
    return run
  }

  /**
   * Starts a group named label (the host names the step after the outermost one). Resolves whether it is open: false
   * when the host refused it or isn't connected, in which case the edits that follow are simply not grouped (an
   * unrefused edit is still undoable, one step at a time). Never rejects.
   */
  begin(label: string): Promise<boolean> {
    const epoch = this.epoch
    return this.enqueue(async () => {
      if (!this.engine.isConnected() || epoch !== this.epoch) return false
      try {
        await this.engine.beginEditGroup(label)
      } catch (e) {
        console.debug("BeginEditGroup failed:", e)
        return false
      }
      // The connection ended while it was being answered: that host's group was closed with it
      if (epoch !== this.epoch) return false
      this.opened++
      return true
    })
  }

  /**
   * Ends the innermost group this client opened; nothing to do when none is. A failure is reported to onError and
   * never thrown. A group the host says isn't open, or one on a connection that has gone, counts as ended; any other
   * failure leaves it counted, so closeAll tries again.
   */
  end(): Promise<void> {
    const epoch = this.epoch
    return this.enqueue(async () => {
      if (this.opened === 0 || epoch !== this.epoch) return
      try {
        await this.engine.endEditGroup()
      } catch (e) {
        if (epoch !== this.epoch) return
        if (!NoGroupOpen.test(messageOf(e)) && this.engine.isConnected()) {
          this.onError("Failed to end the edit group", e)
          return
        }
      }
      if (epoch === this.epoch && this.opened > 0) this.opened--
    })
  }

  /**
   * Runs work inside a group named label, and ends the group whether the work resolves or throws (the work's own
   * outcome is the result). The work runs even when the group could not be opened.
   */
  async within<T>(label: string, work: () => Promise<T>): Promise<T> {
    const opened = await this.begin(label)
    try {
      return await work()
    } finally {
      if (opened) await this.end()
    }
  }

  /** Ends every open group (before an undo or redo, which the host refuses while one is open); stops at a failure */
  async closeAll(): Promise<void> {
    await this.settled
    while (this.opened > 0) {
      const before = this.opened
      await this.end()
      if (this.opened >= before) return // it could not be ended: it is reported, and not retried in a loop
    }
  }

  /** The connection ended or is another host's: it ended its groups itself */
  reset(): void {
    this.epoch++
    this.opened = 0
  }
}

/** What addEventListener needs of the document and the window (fakes in tests) */
export interface ListenerTarget {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/**
 * Calls end once, when the pointer that went down is released or cancelled (listened for on the document, so it
 * arrives even when the control was removed meanwhile) or the window loses the focus (a release outside the window
 * may never be seen). Every way a drag can end, and no way to miss one.
 */
export function endWhenReleased(doc: ListenerTarget, win: ListenerTarget, end: () => void): void {
  const done = (): void => {
    doc.removeEventListener("pointerup", done)
    doc.removeEventListener("pointercancel", done)
    win.removeEventListener("blur", done)
    end()
  }
  doc.addEventListener("pointerup", done)
  doc.addEventListener("pointercancel", done)
  win.addEventListener("blur", done)
}
