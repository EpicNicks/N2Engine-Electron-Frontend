// The Profiler panel's state, without a DOM (FE-S5, protocol 1.28.0): polls GetEngineStats on the active host and keeps
// the frame history client-side. Given its pieces (or fakes), so it is unit tested in Node; profiler-panel.tsx draws it.
//
// The rules it keeps:
//  - nothing is asked without the engineStats capability (an older host has no GetEngineStats) or a connection;
//  - it polls every EngineStatsPollMs (4 Hz) only between start() and stop(), which the panel calls while it is shown
//    (mounted), and skips a tick while the window is hidden; the host turns its frame timers off 10 s after the last
//    request, so a closed panel costs the host nothing;
//  - one request at a time: a tick while one is on its way is skipped (the next one asks from where the history ends);
//  - the active host is the play host while a game is live (playing or paused), else the edit host; switching host, a
//    new play session, a new connection or a frame number going backwards starts the history again, and an answer that
//    comes after such a switch is dropped;
//  - an edit host runs no game frames: its frames are empty, and its counters are still shown;
//  - Pause freezes what is shown, not the polling.
import { computed, signal, type ReadonlySignal } from "@preact/signals-core"
import { EngineStatsPollMs, FrameHistory, FrameHistoryCapacity, summarise } from "../protocol/engine-stats"
import type { EngineFrameRecord, EngineStats } from "../protocol/protocol.generated"
import { errorTextOf } from "../shared/api"

/** Which host is asked: the edit host, or the play host of a session (launch counts sessions) */
export interface ProfilerTarget {
  kind: "edit" | "play"
  session: number
}

export interface ProfilerDeps {
  /** GetEngineStats on the given host */
  getEngineStats(target: ProfilerTarget["kind"], sinceFrame: number): Promise<EngineStats>
  connected: ReadonlySignal<boolean>
  /** Whether the edit host's Hello lists the engineStats capability */
  supported: ReadonlySignal<boolean>
  /** The host to ask now */
  target: ReadonlySignal<ProfilerTarget>
  /** Changes (to another value or object) at each connection to the edit host: a reconnect starts the history again */
  connection?: ReadonlySignal<unknown>
  /** Runs callback every ms; returns what stops it */
  every?(callback: () => void, ms: number): () => void
  /** Whether the editor window is hidden (minimised, another tab): no request then */
  hidden?(): boolean
  capacity?: number
}

export const ProfilerUnsupportedReason =
  "This host has no engine stats (it is older than protocol 1.28.0, without the engineStats capability)."

const everyMs = (callback: () => void, ms: number): (() => void) => {
  const handle = setInterval(callback, ms)
  return () => clearInterval(handle)
}

export class ProfilerModel {
  /** The host's last answer (its figures and summary); null until one came, and after a switch of host */
  readonly latest = signal<EngineStats | null>(null)
  /** The history's records as of the last answer (a new array each time, so the view redraws) */
  readonly records = signal<readonly EngineFrameRecord[]>([])
  /** Why the last request failed, until one succeeds */
  readonly error = signal<string | null>(null)
  /** Frames that never arrived (the host's ring wrapped between two answers) */
  readonly missed = signal(0)
  /** Pause: the view keeps what it showed; polling goes on */
  readonly paused = signal(false)
  private readonly frozen = signal<readonly EngineFrameRecord[]>([])
  /** What the graph and the breakdown show: the history, or what it was when paused */
  readonly shown = computed(() => (this.paused.value ? this.frozen.value : this.records.value))
  readonly summary = computed(() => summarise(this.shown.value))
  /** Whether polling is on (between start and stop) */
  readonly running = signal(false)

  private readonly history: FrameHistory
  private stopTimer: (() => void) | null = null
  private inFlight = false
  /** The host the history belongs to; null before the first request */
  private key: string | null = null
  /** A number for each connection value seen (objects by identity) */
  private readonly connectionIds = new Map<unknown, number>()
  private connectionCount = 0

  constructor(private readonly deps: ProfilerDeps) {
    this.history = new FrameHistory(deps.capacity ?? FrameHistoryCapacity)
  }

  /** Why nothing is asked now (not connected, an older host), or null */
  get blockedReason(): string | null {
    if (!this.deps.connected.value) return "Not connected"
    if (!this.deps.supported.value) return ProfilerUnsupportedReason
    return null
  }

  get target(): ProfilerTarget {
    return this.deps.target.value
  }

  /** Starts polling: one request now, then every EngineStatsPollMs. Nothing when already started. */
  start(): void {
    if (this.stopTimer) return
    this.running.value = true
    this.stopTimer = (this.deps.every ?? everyMs)(() => void this.poll(), EngineStatsPollMs)
    void this.poll()
  }

  stop(): void {
    this.stopTimer?.()
    this.stopTimer = null
    this.running.value = false
  }

  setPaused(paused: boolean): void {
    if (paused) this.frozen.value = this.records.value
    this.paused.value = paused
  }

  /** Drops the history and the last answer (Clear, and a switch of host) */
  clear(): void {
    this.history.clear()
    this.records.value = []
    this.frozen.value = []
    this.missed.value = 0
    this.latest.value = null
  }

  private currentKey(): string {
    const target = this.deps.target.value
    const connection = this.deps.connection?.value ?? null
    let id = this.connectionIds.get(connection)
    if (id === undefined) {
      // Only the current connection matters: forget the older ones
      this.connectionIds.clear()
      id = ++this.connectionCount
      this.connectionIds.set(connection, id)
    }
    return `${id}:${target.kind}:${target.session}`
  }

  /** One GetEngineStats, unless one is on its way, nothing may be asked or the window is hidden */
  async poll(): Promise<void> {
    if (this.blockedReason !== null) {
      if (this.key !== null) {
        this.key = null
        this.clear()
      }
      this.error.value = null
      return
    }
    if (this.inFlight || this.deps.hidden?.()) return
    const key = this.currentKey()
    if (key !== this.key) {
      this.key = key
      this.clear()
    }
    const target = this.deps.target.value
    this.inFlight = true
    try {
      const stats = await this.deps.getEngineStats(target.kind, this.history.sinceFor())
      if (this.key !== key || this.currentKey() !== key) return
      this.history.merge(stats.frame, stats.frames)
      this.records.value = [...this.history.records]
      this.missed.value = this.history.missed
      this.latest.value = stats
      this.error.value = null
    } catch (e) {
      if (this.key !== key) return
      console.debug("GetEngineStats failed:", e)
      this.error.value = errorTextOf(e)
    } finally {
      this.inFlight = false
    }
  }
}
