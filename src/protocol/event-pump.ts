// The polling loop for server events (EpicNicks/N2Engine#6 §(c)): the server keeps a bounded ring of events,
// each with a sequence number, and the client asks for everything after the last one it saw. PollEvents itself
// arrives with the engine's E1b; the pump only needs a poll function, so it works with any transport and is
// tested with a fake.

/** One PollEvents response */
export interface EventBatch<E> {
  /** The cursor to pass as afterSeq next time */
  nextSeq: number
  /** Events that fell off the server's ring before this client polled for them */
  dropped: number
  events: E[]
}

/** Calls PollEvents(afterSeq, maxEvents) */
export type PollFunction<E> = (afterSeq: number, maxEvents: number) => Promise<EventBatch<E>>

export interface EventPumpHandlers<E> {
  /** Each non-empty batch, in order. If it throws, the batch is lost (the cursor has moved on) and onError is called. */
  onEvents(events: E[]): void
  /** The server dropped events this client never saw: state built from events should be refetched */
  onDropped?(count: number): void
  /** The cursor went backwards (the server restarted its ring): state built from events should be refetched */
  onReset?(previousSeq: number, nextSeq: number): void
  /** A poll failed; the pump retries after errorRetryMs */
  onError?(error: unknown): void
}

/** setTimeout and clearTimeout, injectable for tests */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface EventPumpOptions {
  /** Time between the end of one poll and the start of the next */
  intervalMs?: number
  /** maxEvents per poll; a full batch is followed by another poll straight away */
  maxEvents?: number
  /** Delay after a failed poll */
  errorRetryMs?: number
  timers?: Timers
}

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class EventPump<E> {
  private readonly intervalMs: number
  private readonly maxEvents: number
  private readonly errorRetryMs: number
  private readonly timers: Timers

  private cursor = 0
  private running = false
  // Bumped by start and stop, so a poll still in flight from an earlier run is ignored
  private generation = 0
  private timer: unknown = null
  private inFlight: Promise<void> | null = null

  constructor(
    private readonly poll: PollFunction<E>,
    private readonly handlers: EventPumpHandlers<E>,
    options: EventPumpOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? 100
    this.maxEvents = options.maxEvents ?? 256
    this.errorRetryMs = options.errorRetryMs ?? 1000
    this.timers = options.timers ?? defaultTimers
  }

  /** The afterSeq of the next poll */
  get nextSeq(): number {
    return this.cursor
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Starts polling from afterSeq (0: everything the server still retains, including startup logs) */
  start(afterSeq: number = 0): void {
    this.stop()
    this.running = true
    this.cursor = afterSeq
    this.schedule(0)
  }

  stop(): void {
    this.running = false
    this.generation++
    this.inFlight = null
    this.cancelTimer()
  }

  /**
   * Polls now instead of waiting for the timer (for example right after a mutating command, or alongside each
   * frame in play mode). Never overlaps a poll in flight: it returns that poll instead.
   */
  pollNow(): Promise<void> {
    if (!this.running) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    this.cancelTimer()
    return this.runPoll(this.generation)
  }

  /** Runs a handler; one that throws is reported through onError and doesn't stop the pump */
  private notify(call: () => void): void {
    try {
      call()
    } catch (e) {
      try {
        this.handlers.onError?.(e)
      } catch {
        // nothing more to do
      }
    }
  }

  private schedule(ms: number): void {
    this.cancelTimer()
    const generation = this.generation
    this.timer = this.timers.setTimeout(() => {
      this.timer = null
      if (generation === this.generation && !this.inFlight) {
        this.runPoll(generation)
      }
    }, ms)
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer)
      this.timer = null
    }
  }

  private runPoll(generation: number): Promise<void> {
    const promise = this.pollOnce(generation).finally(() => {
      if (this.inFlight === promise) this.inFlight = null
    })
    this.inFlight = promise
    return promise
  }

  private async pollOnce(generation: number): Promise<void> {
    let delay = this.intervalMs
    try {
      const batch = await this.poll(this.cursor, this.maxEvents)
      if (!this.running || generation !== this.generation) return

      // The cursor moves past these events whatever the handlers do. A handler that throws loses them (the error
      // goes to onError) rather than having the same batch redelivered, and failing, forever.
      const previous = this.cursor
      this.cursor = batch.nextSeq
      if (batch.nextSeq < previous) {
        this.notify(() => this.handlers.onReset?.(previous, batch.nextSeq))
      }
      if (batch.dropped > 0) {
        this.notify(() => this.handlers.onDropped?.(batch.dropped))
      }
      if (batch.events.length > 0) {
        this.notify(() => this.handlers.onEvents(batch.events))
      }
      if (batch.events.length >= this.maxEvents) {
        delay = 0 // more are waiting
      }
    } catch (e) {
      if (!this.running || generation !== this.generation) return
      this.handlers.onError?.(e)
      delay = this.errorRetryMs
    }

    if (this.running && generation === this.generation) {
      this.schedule(delay)
    }
  }
}
