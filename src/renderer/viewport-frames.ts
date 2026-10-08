// When the viewport asks the host for a frame, and how its updates reach the host. No polling at a fixed rate: the
// editor view only changes when something changed it (RenderFrameIfChanged, protocol 1.7.0), so a frame is asked for
// - once on starting (sinceRevision 0, the frame is whatever the host has);
// - when this client changed the view itself (the camera moved, the viewport was resized): invalidate();
// - when the host says the view changed (a frameChanged or sceneChanged event, polled with the other events): invalidate().
// Asks are coalesced: at most one is in flight and at most one waits, started on the next animation frame, so a
// drag that moves the camera 200 times a second costs one SetEditorCamera and one RenderFrameIfChanged per frame.
// An answer with modified false (a few bytes) leaves the picture as it is. No DOM: the clock is given, so it is unit
// tested in Node.
import type { FrameUpdateResponse } from "../protocol/protocol.generated"

export interface FrameSchedulerDeps {
  /** RenderFrameIfChanged(sinceRevision) */
  request(sinceRevision: number): Promise<FrameUpdateResponse>
  /** Shows a frame (modified true only) */
  present(frame: FrameUpdateResponse): void
  /** Runs callback on the next animation frame; returns what cancels it */
  schedule(callback: () => void): () => void
  /** A request failed: the scheduler has stopped */
  onError(error: unknown): void
  isConnected(): boolean
}

export class FrameScheduler {
  private running = false
  private dirty = false
  private inFlight = false
  private cancel: (() => void) | null = null
  /** The revision of the frame on screen: 0 when none (a revision means nothing across hosts) */
  private held = 0
  // Bumped by every start and stop: an answer for an earlier run is dropped
  private generation = 0
  /** How many requests were sent (tests and the status line) */
  requests = 0

  constructor(private readonly deps: FrameSchedulerDeps) {}

  get revision(): number {
    return this.held
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Starts asking (once connected); the first ask holds nothing, so the host sends whatever it has */
  start(): void {
    if (this.running) return
    this.running = true
    this.held = 0
    this.generation++
    this.dirty = true
    this.arm()
  }

  stop(): void {
    this.running = false
    this.generation++
    this.dirty = false
    this.inFlight = false
    this.held = 0
    this.cancel?.()
    this.cancel = null
  }

  /** The view may have changed: ask again (soon, and once for all the changes before it) */
  invalidate(): void {
    if (!this.running) return
    this.dirty = true
    this.arm()
  }

  /** Forget the frame on screen, so the next ask takes whatever the host has (the screen was cleared) */
  forget(): void {
    this.held = 0
    this.invalidate()
  }

  private arm(): void {
    if (this.cancel !== null || this.inFlight) return
    this.cancel = this.deps.schedule(() => {
      this.cancel = null
      void this.tick()
    })
  }

  private async tick(): Promise<void> {
    if (!this.running || !this.dirty || this.inFlight) return
    if (!this.deps.isConnected()) {
      this.stop()
      return
    }
    const generation = this.generation
    this.dirty = false
    this.inFlight = true
    this.requests++
    try {
      const frame = await this.deps.request(this.held)
      if (generation !== this.generation) return
      this.held = frame.revision
      if (frame.modified) this.deps.present(frame)
    } catch (e) {
      if (generation === this.generation) {
        this.stop()
        this.deps.onError(e)
      }
      return
    }
    this.inFlight = false
    // Changed again while this one was on its way
    if (this.dirty) this.arm()
  }
}

/**
 * Sends the newest of a stream of values, one at a time: while a send is on its way only the latest value is kept, so
 * a drag produces at most one request in flight and the host always ends on the last value. A failed send is reported
 * and does not stop later ones.
 */
export class LatestWinsSender<T> {
  private pending: { value: T } | null = null
  private running: Promise<void> | null = null

  constructor(
    private readonly send: (value: T) => Promise<void>,
    private readonly onError: (error: unknown) => void = () => {}
  ) {}

  push(value: T): void {
    this.pending = { value }
    if (this.running === null) this.running = this.drain()
  }

  /** Resolves when nothing is pending or in flight */
  async flush(): Promise<void> {
    while (this.running !== null) await this.running
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending !== null) {
        const { value } = this.pending
        this.pending = null
        try {
          await this.send(value)
        } catch (e) {
          this.onError(e)
        }
      }
    } finally {
      this.running = null
    }
  }
}
