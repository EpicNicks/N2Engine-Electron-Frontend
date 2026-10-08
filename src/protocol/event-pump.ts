// The polling loop for server events (EpicNicks/N2Engine#6 §(c), PollEvents since protocol 1.2.0): the server keeps
// a bounded ring of events, each with a sequence number, and the client asks for everything after the last one it
// saw. The pump only needs a poll function, so it works with any transport and is tested with a fake.
//
// The epoch rule (docs/logging-and-editor.html §events): seqs count within an epoch, a random number each host
// process picks. The client polls with epoch 0 and afterSeq 0 first, then with each response's epoch and nextSeq,
// across reconnects too. A host that doesn't recognise the epoch (another host process), or hasn't reached the seq,
// reads afterSeq as 0 and answers with its own epoch: the client then has a new log, from that host's start.

/** Where the next poll starts: the epoch and seq of the last response (0, 0 before any) */
export interface EventCursor {
  epoch: number
  seq: number
}

export const StartCursor: EventCursor = Object.freeze({ epoch: 0, seq: 0 })

/** One PollEvents response */
export interface EventBatch<E> {
  /** The numbering the seqs belong to; the next poll sends it back */
  epoch: number
  /** The cursor to pass as afterSeq next time */
  nextSeq: number
  /** Events that fell off the server's ring before this client polled for them */
  dropped: number
  events: E[]
}

/** Calls PollEvents(epoch, afterSeq, maxEvents) */
export type PollFunction<E> = (epoch: number, afterSeq: number, maxEvents: number) => Promise<EventBatch<E>>

/**
 * Whether a response starts a new numbering: its epoch isn't the one asked about (another host process, or the
 * ring started again when its seqs ran out), or its seqs went backwards (the host read afterSeq as 0). Not when
 * asking from the start (epoch 0), which any epoch answers.
 */
export function isNewNumbering(asked: EventCursor, batch: Pick<EventBatch<unknown>, "epoch" | "nextSeq">): boolean {
  if (asked.epoch === 0) return false
  return batch.epoch !== asked.epoch || batch.nextSeq < asked.seq
}

export interface EventPumpHandlers<E> {
  /** Each non-empty batch, in order. If it throws, the batch is lost (the cursor has moved on) and onError is called. */
  onEvents(events: E[]): void
  /** The server dropped events this client never saw: state built from events should be refetched */
  onDropped?(count: number): void
  /**
   * A new numbering (isNewNumbering): another host process, or the same one after its seqs ran out. Called before
   * that batch's events, which are the new numbering's from its start; state built from events should be refetched.
   */
  onReset?(previous: EventCursor, next: EventCursor): void
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

  private cursor: EventCursor = StartCursor
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
    return this.cursor.seq
  }

  /** The epoch and afterSeq of the next poll; pass it to start() to carry on from here (after a reconnect) */
  get position(): EventCursor {
    return this.cursor
  }

  get isRunning(): boolean {
    return this.running
  }

  /**
   * Starts polling from a cursor: StartCursor (the default) for everything the server still retains, startup logs
   * included, or the position a previous run reached, to carry on without losing or repeating anything
   */
  start(from: EventCursor = StartCursor): void {
    this.stop()
    this.running = true
    this.cursor = { epoch: from.epoch, seq: from.seq }
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
      const asked = this.cursor
      const batch = await this.poll(asked.epoch, asked.seq, this.maxEvents)
      if (!this.running || generation !== this.generation) return

      // The cursor moves past these events whatever the handlers do. A handler that throws loses them (the error
      // goes to onError) rather than having the same batch redelivered, and failing, forever.
      const next = { epoch: batch.epoch, seq: batch.nextSeq }
      this.cursor = next
      if (isNewNumbering(asked, batch)) {
        this.notify(() => this.handlers.onReset?.(asked, next))
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
