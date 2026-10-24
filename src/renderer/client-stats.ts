// Measurements made by this client, not host CPU/GPU timings. All timestamps use one monotonic clock: a remote
// event's wall-clock time is deliberately not compared with ours. No extra engine requests are made for these stats.
import type { PlayState } from "../shared/api"

export const ClientStatsWindowMs = 5000
export const MaxMetricSamples = 512
export const MaxPlaySamples = 128
export const ClientStatsRefreshMs = 250
export type FrameSource = "edit" | "game"

interface Sample { at: number; value: number }

/** A capped rolling series. If the cap shortens its window, rates use that shorter measured interval. */
class Series {
  private samples: Sample[] = []
  private coveredFrom: number
  private observed = false

  constructor(start: number) { this.coveredFrom = start }

  add(at: number, value: number): void {
    if (!Number.isFinite(value) || value < 0) return
    this.observed = true
    this.samples.push({ at, value })
    while (this.samples.length > MaxMetricSamples) this.coveredFrom = this.samples.shift()!.at
    this.prune(at)
  }

  private prune(now: number): void {
    const cutoff = now - ClientStatsWindowMs
    while (this.samples.length && this.samples[0].at < cutoff) this.samples.shift()
  }

  mean(now: number): number | null {
    this.prune(now)
    return this.samples.length ? this.samples.reduce((sum, s) => sum + s.value, 0) / this.samples.length : null
  }

  rate(now: number): number | null {
    this.prune(now)
    const duration = now - Math.max(now - ClientStatsWindowMs, this.coveredFrom)
    return this.observed && duration > 0 ? this.samples.reduce((sum, s) => sum + s.value, 0) * 1000 / duration : null
  }

  get size(): number { return this.samples.length }
}

export interface RequestMeasurement {
  readonly session: number
  readonly view: number
  readonly at: number
  readonly source: FrameSource | null
}

interface PlaySample { at: number; frame: number; time: number }

export interface ClientStatsSnapshot {
  connected: boolean
  frameSource: FrameSource | null
  editorRequestMs: number | null
  /** Decoded RGBA pixel payload only: excludes framing and unchanged-response metadata. */
  editorPixelBytesPerSecond: number | null
  displayedFramesPerSecond: number | null
  eventPollMs: number | null
  eventPollAgeMs: number | null
  playFramesPerSecond: number | null
  playTimePerSecond: number | null
  playStatus: PlayState["status"] | null
}

export class ClientStats {
  private connected = false
  private session = 0
  private view = 0
  private frameSource: FrameSource | null = null
  private lastClock = 0
  private editorLatency = new Series(0)
  private editorBytes = new Series(0)
  private displayed = new Series(0)
  private polls = new Series(0)
  private lastPoll: number | null = null
  private playLaunch: number | null = null
  private playStatus: PlayState["status"] | null = null
  private play: PlaySample[] = []

  constructor(private readonly clock: () => number = () => performance.now()) {}

  private now(): number {
    const next = this.clock()
    if (Number.isFinite(next)) this.lastClock = Math.max(this.lastClock, next)
    return this.lastClock
  }

  /** Every connection notification is a new epoch, including reconnects to the same host. */
  connectionChanged(connected: boolean): void {
    this.connected = connected
    this.session++
    this.view++
    const now = this.now()
    this.editorLatency = new Series(now)
    this.editorBytes = new Series(now)
    this.displayed = new Series(now)
    this.polls = new Series(now)
    this.lastPoll = null
    this.playLaunch = null
    this.playStatus = null
    this.play = []
    this.frameSource = null
  }

  viewportStarted(source: FrameSource): void {
    this.view++
    this.frameSource = source
    this.displayed = new Series(this.now())
  }

  viewportStopped(): void {
    this.view++
    this.frameSource = null
    this.displayed = new Series(this.now())
  }

  beginFrameRequest(source: FrameSource): RequestMeasurement {
    return { session: this.session, view: this.view, at: this.now(), source }
  }

  frameReceived(request: RequestMeasurement, pixelBytes: number): void {
    if (!this.valid(request) || request.view !== this.view || request.source !== this.frameSource) return
    if (request.source === "edit") {
      const now = this.now()
      this.editorLatency.add(now, now - request.at)
      this.editorBytes.add(now, pixelBytes)
    }
  }

  /** Called only after a successful putImageData, never for an unchanged or stale reply. */
  framePresented(source: FrameSource): void {
    if (this.connected && source === this.frameSource) this.displayed.add(this.now(), 1)
  }

  beginEventPoll(): RequestMeasurement {
    return { session: this.session, view: this.view, at: this.now(), source: null }
  }

  eventPollReceived(request: RequestMeasurement): void {
    if (!this.valid(request)) return
    const now = this.now()
    this.polls.add(now, now - request.at)
    this.lastPoll = now
  }

  private valid(request: RequestMeasurement): boolean {
    return this.connected && request.session === this.session
  }

  beginPlayObservation(): RequestMeasurement {
    return { session: this.session, view: this.view, at: this.now(), source: null }
  }

  playStateReceived(request: RequestMeasurement, state: PlayState): void {
    if (this.valid(request)) this.observePlayState(state)
  }

  observePlayState(state: PlayState): void {
    if (!this.connected) return
    this.playStatus = state.status
    if (state.status !== "playing" && state.status !== "paused") {
      this.play = []
      this.playLaunch = null
      return
    }
    if (!Number.isSafeInteger(state.frame) || state.frame < 0 || !Number.isFinite(state.time) || state.time < 0) return
    const now = this.now()
    const last = this.play.at(-1)
    if (state.launch !== this.playLaunch || (last && (state.frame < last.frame || state.time < last.time))) this.play = []
    this.playLaunch = state.launch
    const previous = this.play.at(-1)
    if (previous && (previous.at === now ||
      (previous.frame === state.frame && previous.time === state.time && now - previous.at < 100))) return
    this.play.push({ at: now, frame: state.frame, time: state.time })
    while (this.play.length > MaxPlaySamples) this.play.shift()
    while (this.play.length && this.play[0].at < now - ClientStatsWindowMs) this.play.shift()
  }

  snapshot(): ClientStatsSnapshot {
    const now = this.now()
    while (this.play.length && this.play[0].at < now - ClientStatsWindowMs) this.play.shift()
    let playFramesPerSecond: number | null = null
    let playTimePerSecond: number | null = null
    const first = this.play[0], last = this.play.at(-1)
    if (first && last && last.at - first.at >= 100 && now - last.at <= ClientStatsWindowMs) {
      const seconds = (last.at - first.at) / 1000
      playFramesPerSecond = (last.frame - first.frame) / seconds
      playTimePerSecond = (last.time - first.time) / seconds
    }
    return {
      connected: this.connected,
      frameSource: this.connected ? this.frameSource : null,
      editorRequestMs: this.connected ? this.editorLatency.mean(now) : null,
      editorPixelBytesPerSecond: this.connected ? this.editorBytes.rate(now) : null,
      displayedFramesPerSecond: this.connected && this.frameSource ? this.displayed.rate(now) : null,
      eventPollMs: this.connected ? this.polls.mean(now) : null,
      eventPollAgeMs: this.connected && this.lastPoll !== null ? now - this.lastPoll : null,
      playFramesPerSecond,
      playTimePerSecond,
      playStatus: this.playStatus,
    }
  }

  /** A diagnostic bound used by tests. */
  get retainedSamples(): number {
    return this.editorLatency.size + this.editorBytes.size + this.displayed.size + this.polls.size + this.play.length
  }
}
