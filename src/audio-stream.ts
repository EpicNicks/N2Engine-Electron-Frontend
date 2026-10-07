// Audio streaming logic with no DOM, Electron or Node dependencies, so it can be unit tested (npm test):
// decoding GetAudio's AudioSamples payload, and the jitter buffer that decides when each chunk plays.

import { AudioSamplesResponse, decodeAudioSamplesResponse } from "./protocol/protocol.generated"

export type SampleFormat = "float32" | "int16"

/**
 * A decoded AudioSamples response. The samples are converted to float32 in [-1, 1] whatever the wire format was.
 */
export interface AudioSamples {
  sampleRate: number
  channels: number
  /** The format the server sent ("float32" or "int16") */
  sampleFormat: SampleFormat
  frameCount: number
  /** Frames the server discarded since the previous GetAudio because its 250 ms buffer was full: a gap */
  droppedFrames: number
  /** frameCount * channels samples, interleaved */
  samples: Float32Array
}

/**
 * Decodes an AudioSamples payload (everything after the 5-byte response header) with the generated decoder, then
 * checks it and converts the samples (audioSamplesFromResponse)
 */
export function decodeAudioSamples(payload: Uint8Array): AudioSamples {
  return audioSamplesFromResponse(decodeAudioSamplesResponse(payload))
}

/** Checks a decoded AudioSamples response and converts its raw little-endian samples to float32 */
export function audioSamplesFromResponse(response: AudioSamplesResponse): AudioSamples {
  const { sampleRate, channels, sampleFormat, frameCount, droppedFrames, samples: sampleBytes } = response

  if (sampleFormat !== "float32" && sampleFormat !== "int16") {
    throw new Error(`Unsupported audio sample format "${sampleFormat}"`)
  }
  if (sampleRate === 0 || channels === 0) {
    throw new Error(`Invalid audio format: ${sampleRate} Hz, ${channels} channels`)
  }

  const bytesPerSample = sampleFormat === "float32" ? 4 : 2
  const expectedBytes = frameCount * channels * bytesPerSample
  if (sampleBytes.byteLength !== expectedBytes) {
    throw new Error(
      `AudioSamples has ${sampleBytes.byteLength} sample bytes, expected ${expectedBytes} ` +
        `(${frameCount} frames, ${channels} channels, ${sampleFormat})`
    )
  }

  const samples = sampleFormat === "float32" ? float32FromBytes(sampleBytes) : int16ToFloat32(sampleBytes)
  return { sampleRate, channels, sampleFormat, frameCount, droppedFrames, samples }
}

/**
 * Little-endian int16 samples to float32 in [-1, 1)
 */
export function int16ToFloat32(bytes: Uint8Array): Float32Array {
  const count = bytes.byteLength >> 1
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768
  }
  return out
}

/**
 * Little-endian float32 samples (copied: the bytes needn't be 4-byte aligned)
 */
export function float32FromBytes(bytes: Uint8Array): Float32Array {
  const count = bytes.byteLength >> 2
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    out[i] = view.getFloat32(i * 4, true)
  }
  return out
}

/**
 * Splits interleaved samples into one array per channel (what AudioBuffer.copyToChannel takes)
 */
export function deinterleave(samples: Float32Array, channels: number): Float32Array<ArrayBuffer>[] {
  const frames = Math.floor(samples.length / channels)
  const out: Float32Array<ArrayBuffer>[] = []
  for (let c = 0; c < channels; c++) {
    const channel = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      channel[i] = samples[i * channels + c]
    }
    out.push(channel)
  }
  return out
}

/**
 * Linearly resamples interleaved frames to outFrames frames, keeping the first and last frame so consecutive
 * chunks still join up. Used for the jitter buffer's small drift corrections (a fraction of a percent).
 */
export function resampleLinear(samples: Float32Array, channels: number, outFrames: number): Float32Array {
  const inFrames = Math.floor(samples.length / channels)
  const out = new Float32Array(outFrames * channels)
  if (inFrames === 0 || outFrames === 0) return out

  const step = outFrames > 1 ? (inFrames - 1) / (outFrames - 1) : 0
  for (let i = 0; i < outFrames; i++) {
    const position = i * step
    const index = Math.min(Math.floor(position), inFrames - 1)
    const next = Math.min(index + 1, inFrames - 1)
    const fraction = position - index
    for (let c = 0; c < channels; c++) {
      const a = samples[index * channels + c]
      const b = samples[next * channels + c]
      out[i * channels + c] = a + (b - a) * fraction
    }
  }
  return out
}

/**
 * Ramps the first `frames` interleaved frames up from silence, in place, so audio that starts after a
 * discontinuity (a resync) doesn't click
 */
export function applyFadeIn(samples: Float32Array, channels: number, frames: number): void {
  const count = Math.min(frames, Math.floor(samples.length / channels))
  for (let i = 0; i < count; i++) {
    const gain = (i + 1) / (count + 1)
    for (let c = 0; c < channels; c++) {
      samples[i * channels + c] *= gain
    }
  }
}

// ==================== Jitter Buffer ====================

export interface JitterBufferOptions {
  /** Audio scheduled ahead of playback right after a chunk is added; also the playback latency */
  targetSeconds: number
  /** Drift correction starts when the (smoothed) buffer level is further than this from the target */
  toleranceSeconds: number
  /** ...and stops once it is back within this of the target */
  settleSeconds: number
  /**
   * Weight of each new measurement in the smoothed buffer level (an exponential moving average over chunks), which
   * filters out poll timing, server mix timing and a coarse playback clock
   */
  smoothing: number
  /** Above this, the excess is dropped at once instead of corrected gradually */
  maxSeconds: number
  /** Nothing is scheduled closer to now than this; a buffer that ran below it has underrun */
  minLeadSeconds: number
  /** At most this fraction of a chunk's frames is dropped or repeated by drift correction (a pitch change) */
  maxCorrection: number
  /** The first chunk after a resync fades in over this long */
  fadeInSeconds: number
}

export const DefaultJitterBufferOptions: JitterBufferOptions = {
  targetSeconds: 0.1,
  toleranceSeconds: 0.02,
  settleSeconds: 0.01,
  smoothing: 0.1,
  maxSeconds: 0.25,
  minLeadSeconds: 0.01,
  maxCorrection: 0.001,
  fadeInSeconds: 0.003,
}

/**
 * Why a chunk was scheduled where it was:
 * - start: the first chunk (or the first after a reset)
 * - gap: the server dropped frames (droppedFrames > 0), so the buffer was resynchronized
 * - underrun: everything scheduled had played (or nearly), so the buffer was resynchronized
 * - overflow: far more than the target was buffered, so the excess was dropped
 * - drift: the buffer drifted out of its band and the chunk is squeezed or stretched slightly
 * - steady: the chunk plays as is, right after the previous one
 */
export type ScheduleReason = "start" | "gap" | "underrun" | "overflow" | "drift" | "steady"

export interface ScheduleDecision {
  /** Time (on the playback clock, in seconds) the chunk starts */
  startTime: number
  /** Leading frames of the chunk to drop */
  skipFrames: number
  /** The remaining frames are played resampled to this many (equal to them unless correcting drift); 0 plays nothing */
  outputFrames: number
  /** Fade in this many leading output frames (see applyFadeIn): the chunk follows a discontinuity */
  fadeInFrames: number
  reason: ScheduleReason
}

export interface JitterBufferStats {
  chunks: number
  underruns: number
  gaps: number
  /** Frames the server reported dropped */
  serverDroppedFrames: number
  /** Frames dropped here to resynchronize (start, gap, underrun, overflow) */
  skippedFrames: number
  /** Net frames removed (positive) or added (negative) by drift correction */
  correctedFrames: number
}

/**
 * Decides where each chunk from GetAudio plays on the playback clock (an AudioContext's currentTime), keeping about
 * targetSeconds of audio scheduled ahead of playback.
 *
 * The server mixes by elapsed time, so a late poll just returns more frames: the buffer measured right after adding a
 * chunk stays near the target however irregular the polls are. What moves it is the server's and the sound card's
 * clocks differing (drift, corrected a little per chunk by resampling) and transport stalls (underruns, resynced).
 */
export class JitterBuffer {
  readonly options: JitterBufferOptions
  private nextStartTime: number | null = null
  // The end of everything scheduled so far. Unlike nextStartTime it survives a reset, so a resync never schedules
  // over audio that is still to play.
  private scheduledUntil: number | null = null
  private sampleRate = 0
  private correcting = false
  private smoothedError: number | null = null
  private pendingReason: ScheduleReason = "start"
  private _stats: JitterBufferStats = JitterBuffer.emptyStats()

  constructor(options: Partial<JitterBufferOptions> = {}) {
    this.options = { ...DefaultJitterBufferOptions, ...options }
  }

  get stats(): JitterBufferStats {
    return { ...this._stats }
  }

  /** Seconds of scheduled audio not yet played at `now` */
  bufferedSeconds(now: number): number {
    return this.nextStartTime === null ? 0 : Math.max(0, this.nextStartTime - now)
  }

  /** Forget the schedule: the next chunk starts afresh (e.g. after playback was paused or its clock replaced) */
  reset(reason: ScheduleReason = "start"): void {
    this.nextStartTime = null
    this.correcting = false
    this.smoothedError = null
    this.pendingReason = reason
  }

  resetStats(): void {
    this._stats = JitterBuffer.emptyStats()
  }

  /**
   * Schedules a chunk of frameCount frames that arrived at `now`. Returns null when there's nothing to play.
   */
  schedule(now: number, frameCount: number, sampleRate: number, droppedFrames: number = 0): ScheduleDecision | null {
    const o = this.options

    // Only a gap in what's playing counts: the first chunk after a start or reset is placed afresh anyway, and the
    // server reports the frames it dropped before then (e.g. while no client was connected) on it
    if (droppedFrames > 0 && this.nextStartTime !== null) {
      this._stats.gaps++
      this._stats.serverDroppedFrames += droppedFrames
      this.reset("gap")
    }
    if (sampleRate !== this.sampleRate) {
      if (this.nextStartTime !== null) this.reset("start")
      this.sampleRate = sampleRate
    }
    if (frameCount <= 0 || sampleRate <= 0) return null

    this._stats.chunks++
    const chunkSeconds = frameCount / sampleRate

    if (this.nextStartTime !== null && this.nextStartTime - now < o.minLeadSeconds) {
      this._stats.underruns++
      this.reset("underrun")
    }

    if (this.nextStartTime === null) {
      // (Re)start so that the end of this chunk is targetSeconds ahead, keeping its newest frames (closest to the
      // frames being rendered) and dropping older ones that don't fit
      const reason = this.pendingReason
      this.pendingReason = "steady"
      const fitFrames = Math.max(1, Math.round((o.targetSeconds - o.minLeadSeconds) * sampleRate))
      let skipFrames = Math.max(0, frameCount - fitFrames)
      let outputFrames = frameCount - skipFrames
      let startTime = now + o.targetSeconds - outputFrames / sampleRate

      // Audio scheduled before the reset may still be playing past that point: start where it ends instead,
      // dropping as many more of the oldest frames (the chunk's end stays targetSeconds ahead)
      if (this.scheduledUntil !== null && this.scheduledUntil > startTime) {
        const overlapFrames = Math.min(outputFrames, Math.round((this.scheduledUntil - startTime) * sampleRate))
        skipFrames += overlapFrames
        outputFrames -= overlapFrames
        startTime = this.scheduledUntil
      }

      this._stats.skippedFrames += skipFrames
      return this.finish({ startTime, skipFrames, outputFrames, fadeInFrames: this.fadeInFrames(outputFrames), reason })
    }

    const startTime = this.nextStartTime
    const afterSeconds = startTime - now + chunkSeconds
    const error = afterSeconds - o.targetSeconds

    if (afterSeconds > o.maxSeconds) {
      // Far too much buffered (e.g. a burst after a stall): drop the excess from the start of this chunk
      const skipFrames = Math.min(frameCount, Math.round(error * sampleRate))
      const outputFrames = frameCount - skipFrames
      this._stats.skippedFrames += skipFrames
      this.correcting = false
      this.smoothedError = null
      const fadeInFrames = skipFrames > 0 ? this.fadeInFrames(outputFrames) : 0
      return this.finish({ startTime, skipFrames, outputFrames, fadeInFrames, reason: "overflow" })
    }

    // Correct the smoothed level, with hysteresis, so jitter inside the band doesn't keep nudging the pitch
    const smoothed =
      this.smoothedError === null ? error : this.smoothedError + o.smoothing * (error - this.smoothedError)
    this.smoothedError = smoothed
    if (Math.abs(smoothed) > o.toleranceSeconds) this.correcting = true
    else if (Math.abs(smoothed) < o.settleSeconds) this.correcting = false

    let outputFrames = frameCount
    let reason: ScheduleReason = "steady"
    if (this.correcting) {
      const maxFrames = Math.max(1, Math.floor(frameCount * o.maxCorrection))
      const correction = Math.max(-maxFrames, Math.min(maxFrames, Math.round(smoothed * sampleRate)))
      if (correction !== 0) {
        outputFrames = frameCount - correction
        reason = "drift"
        this._stats.correctedFrames += correction
      }
    }

    return this.finish({ startTime, skipFrames: 0, outputFrames, fadeInFrames: 0, reason })
  }

  private finish(decision: ScheduleDecision): ScheduleDecision {
    this.nextStartTime = decision.startTime + decision.outputFrames / this.sampleRate
    this.scheduledUntil = Math.max(this.scheduledUntil ?? this.nextStartTime, this.nextStartTime)
    return decision
  }

  private fadeInFrames(outputFrames: number): number {
    return Math.min(outputFrames, Math.round(this.options.fadeInSeconds * this.sampleRate))
  }

  private static emptyStats(): JitterBufferStats {
    return { chunks: 0, underruns: 0, gaps: 0, serverDroppedFrames: 0, skippedFrames: 0, correctedFrames: 0 }
  }
}
