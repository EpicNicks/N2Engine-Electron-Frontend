import { AudioSamples, JitterBuffer, applyFadeIn, deinterleave, resampleLinear } from "../audio-stream"

// Plays the engine's mixed audio (GetAudio) through Web Audio. Runs in the page; the samples come from the main
// process's EngineClient through window.engine.getAudio (already decoded to float32).

/** Time between the end of one GetAudio and the start of the next (requests never overlap) */
const PollIntervalMilliseconds = 25
/** After an unexpected error, wait this long before polling again */
const ErrorRetryMilliseconds = 1000
/** How often the status (buffer level etc.) is reported while playing */
const StatusIntervalMilliseconds = 250
/** The server's format is fixed at 48 kHz; a context at the same rate avoids resampling */
const PreferredSampleRate = 48000

export type AudioPlayerState =
  | "stopped" // not started, or disconnected
  | "playing"
  | "muted" // polling and scheduling, at zero gain
  | "suspended" // the AudioContext needs a user gesture (autoplay policy): unmute to resume
  | "unavailable" // the server has no audio stream (not on a loopback device)
  | "error"

export interface AudioPlayerStatus {
  state: AudioPlayerState
  message: string
  bufferedMs: number
  sampleRate: number
  channels: number
  sampleFormat: string
  underruns: number
  gaps: number
  serverDroppedFrames: number
}

export interface AudioSource {
  getAudio(): Promise<AudioSamples | null>
  isConnected(): boolean
}

export class AudioPlayer {
  private context: AudioContext | null = null
  private gain: GainNode | null = null
  private jitter = new JitterBuffer()
  private sources = new Set<AudioBufferSourceNode>()
  private running = false
  // Bumped by start and stop, so a GetAudio still in flight from an earlier run is ignored
  private generation = 0
  private pollTimer: number | null = null
  private statusTimer: number | null = null
  private muted = false
  private state: AudioPlayerState = "stopped"
  private message = ""
  // The last GetAudio failure, until a later one succeeds
  private failure: string | null = null
  private format = { sampleRate: 0, channels: 0, sampleFormat: "" }
  private listeners: Array<(status: AudioPlayerStatus) => void> = []

  constructor(private source: AudioSource) {}

  get isMuted(): boolean {
    return this.muted
  }

  /** Whether it is started (polling and playing, or waiting for a gesture), and not stopped */
  get isRunning(): boolean {
    return this.running
  }

  onStatus(listener: (status: AudioPlayerStatus) => void): void {
    this.listeners.push(listener)
    listener(this.status())
  }

  /** Starts polling and playing; call once connected */
  start(): void {
    if (this.running) return
    this.running = true
    this.generation++
    this.jitter = new JitterBuffer()
    this.format = { sampleRate: 0, channels: 0, sampleFormat: "" }
    this.failure = null

    try {
      this.createContext()
    } catch (e) {
      console.error("Failed to create an AudioContext:", e)
      this.running = false
      this.setState("error", `No Web Audio: ${errorMessage(e)}`)
      return
    }

    this.updatePlaybackState()
    this.statusTimer = window.setInterval(() => this.emitStatus(), StatusIntervalMilliseconds)
    this.poll(this.generation)
  }

  /** Stops polling and playback and releases the AudioContext; call on disconnect */
  stop(state: AudioPlayerState = "stopped", message: string = ""): void {
    this.running = false
    this.generation++
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (this.statusTimer !== null) {
      window.clearInterval(this.statusTimer)
      this.statusTimer = null
    }

    this.sources.forEach((source) => {
      try {
        source.stop()
      } catch {
        // already stopped
      }
      source.disconnect()
    })
    this.sources.clear()

    if (this.context) {
      this.context.onstatechange = null
      this.context.close().catch(() => {})
      this.context = null
      this.gain = null
    }
    this.jitter.reset()
    this.setState(state, message)
  }

  /** Unmuting also resumes a context the autoplay policy suspended (call it from a click, a user gesture) */
  setMuted(muted: boolean): void {
    this.muted = muted
    if (this.context && this.gain) {
      // A short ramp, so muting doesn't click
      this.gain.gain.setTargetAtTime(muted ? 0 : 1, this.context.currentTime, 0.01)
      if (!muted && this.context.state === "suspended") {
        this.context.resume().catch((e) => console.error("Failed to resume audio:", e))
      }
    }
    this.updatePlaybackState()
  }

  private createContext(): void {
    let context: AudioContext
    try {
      context = new AudioContext({ sampleRate: PreferredSampleRate, latencyHint: "interactive" })
    } catch {
      // Some devices reject a forced rate; the default works, and AudioBuffers at 48 kHz are resampled to it
      context = new AudioContext({ latencyHint: "interactive" })
    }

    const gain = context.createGain()
    gain.gain.value = this.muted ? 0 : 1
    gain.connect(context.destination)

    context.onstatechange = () => this.updatePlaybackState()
    this.context = context
    this.gain = gain

    if (context.state === "suspended") {
      // Allowed without a gesture under Electron's autoplay policy (see main.ts); otherwise unmuting resumes it
      context.resume().catch(() => {})
    }
  }

  private updatePlaybackState(): void {
    if (!this.running || !this.context) return

    if (this.failure !== null) {
      this.setState("error", this.failure)
    } else if (this.context.state !== "running") {
      this.setState("suspended", "Audio is paused by the autoplay policy: unmute to start it")
    } else {
      this.setState(this.muted ? "muted" : "playing", "")
    }
  }

  private async poll(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return

    let delay = PollIntervalMilliseconds
    try {
      const chunk = await this.source.getAudio()
      if (!this.running || generation !== this.generation) return

      if (chunk === null) {
        // Not a loopback device: the server will never have a stream, so stop asking
        this.stop("unavailable", "The engine has no audio stream (audio isn't on a loopback device)")
        return
      }
      this.play(chunk)
      if (this.failure !== null) {
        this.failure = null
        this.updatePlaybackState()
      }
    } catch (e) {
      if (!this.running || generation !== this.generation) return
      if (!this.source.isConnected()) {
        this.stop()
        return
      }
      console.error("GetAudio failed:", e)
      this.failure = errorMessage(e)
      this.updatePlaybackState()
      delay = ErrorRetryMilliseconds
    }

    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null
      this.poll(generation)
    }, delay)
  }

  private play(chunk: AudioSamples): void {
    const context = this.context
    const gain = this.gain
    if (!context || !gain) return

    if (
      chunk.sampleRate !== this.format.sampleRate ||
      chunk.channels !== this.format.channels ||
      chunk.sampleFormat !== this.format.sampleFormat
    ) {
      this.format = { sampleRate: chunk.sampleRate, channels: chunk.channels, sampleFormat: chunk.sampleFormat }
      this.emitStatus()
    }

    if (context.state !== "running") {
      // The clock isn't moving, so nothing can be scheduled; start afresh once it runs (the chunk is discarded)
      this.jitter.reset()
      return
    }

    const decision = this.jitter.schedule(context.currentTime, chunk.frameCount, chunk.sampleRate, chunk.droppedFrames)
    if (decision?.reason === "gap") {
      const ms = ((chunk.droppedFrames / chunk.sampleRate) * 1000).toFixed(0)
      console.warn(`Audio gap: the engine dropped ${chunk.droppedFrames} frames (${ms} ms) we fell behind on; resyncing`)
    }
    if (!decision || decision.outputFrames === 0) return
    if (decision.reason === "underrun") {
      console.warn("Audio underrun: the jitter buffer ran dry; resyncing")
    }

    const channels = chunk.channels
    let samples = chunk.samples.subarray(decision.skipFrames * channels)
    if (decision.outputFrames !== chunk.frameCount - decision.skipFrames) {
      samples = resampleLinear(samples, channels, decision.outputFrames)
    }
    if (decision.fadeInFrames > 0) {
      applyFadeIn(samples, channels, decision.fadeInFrames)
    }

    const buffer = context.createBuffer(channels, decision.outputFrames, chunk.sampleRate)
    deinterleave(samples, channels).forEach((channelData, c) => buffer.copyToChannel(channelData, c))

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(gain)
    source.onended = () => {
      source.disconnect()
      this.sources.delete(source)
    }
    this.sources.add(source)
    source.start(decision.startTime)
  }

  private setState(state: AudioPlayerState, message: string): void {
    if (state === this.state && message === this.message) return
    this.state = state
    this.message = message
    this.emitStatus()
  }

  private status(): AudioPlayerStatus {
    const stats = this.jitter.stats
    const now = this.context ? this.context.currentTime : 0
    return {
      state: this.state,
      message: this.message,
      bufferedMs: Math.round(this.jitter.bufferedSeconds(now) * 1000),
      sampleRate: this.format.sampleRate,
      channels: this.format.channels,
      sampleFormat: this.format.sampleFormat,
      underruns: stats.underruns,
      gaps: stats.gaps,
      serverDroppedFrames: stats.serverDroppedFrames,
    }
  }

  private emitStatus(): void {
    const status = this.status()
    this.listeners.forEach((listener) => {
      try {
        listener(status)
      } catch (e) {
        console.error("Audio status listener failed:", e)
      }
    })
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
