// The engine's audio in the page: an AudioPlayer that plays while connected, its status as signals for the toolbar,
// and the mute setting, remembered in localStorage.
import { computed, signal } from "@preact/signals-core"
import { AudioPlayer, AudioPlayerStatus } from "./audio-player"
import type { EngineApi } from "../shared/api"

const MutedStorageKey = "audioMuted"

function loadMuted(): boolean {
  try {
    return localStorage.getItem(MutedStorageKey) === "true"
  } catch {
    return false
  }
}

function saveMuted(muted: boolean): void {
  try {
    localStorage.setItem(MutedStorageKey, String(muted))
  } catch {
    // not persisted; the setting still applies for this session
  }
}

/** The toolbar's text for a status */
export function describeAudio(status: AudioPlayerStatus): string {
  const format = status.sampleRate > 0 ? ` (${status.sampleRate / 1000} kHz ${status.sampleFormat})` : ""
  const problems = status.underruns + status.gaps > 0 ? `, ${status.underruns} underruns, ${status.gaps} gaps` : ""
  switch (status.state) {
    case "playing":
      return `Audio: ${status.bufferedMs} ms buffered${format}${problems}`
    case "muted":
      return `Audio: muted${format}`
    case "suspended":
      return "Audio: paused until enabled"
    case "unavailable":
      return "Audio: none (engine not on a loopback device)"
    case "error":
      return `Audio error: ${status.message}`
    default:
      return "Audio: off"
  }
}

export class AudioController {
  readonly status = signal<AudioPlayerStatus | null>(null)
  readonly muted = signal(loadMuted())
  readonly text = computed(() => (this.status.value ? describeAudio(this.status.value) : "Audio: off"))
  readonly warning = computed(() => this.status.value?.state === "error" || this.status.value?.state === "suspended")
  readonly buttonLabel = computed(() =>
    this.status.value?.state === "suspended" ? "🔇 Enable audio" : this.muted.value ? "🔇 Unmute" : "🔊 Mute"
  )

  private readonly player: AudioPlayer

  constructor(engine: Pick<EngineApi, "getAudio" | "isConnected">) {
    // Polls GetAudio through window.engine and plays it with Web Audio (see audio-player.ts)
    this.player = new AudioPlayer({ getAudio: () => engine.getAudio(), isConnected: () => engine.isConnected() })
    this.player.setMuted(this.muted.value)
    this.player.onStatus((status) => {
      const previous = this.status.value?.state
      if (status.state !== previous && (status.state === "error" || status.state === "unavailable")) {
        console.warn(`Audio ${status.state}: ${status.message}`)
      }
      this.status.value = status
    })
  }

  start(): void {
    this.player.start()
  }

  stop(): void {
    this.player.stop()
  }

  /** The toolbar button: mutes or unmutes, or resumes audio the autoplay policy suspended (a click is a gesture) */
  toggle(): void {
    const muted = this.status.value?.state === "suspended" ? false : !this.player.isMuted
    this.player.setMuted(muted)
    this.muted.value = muted
    saveMuted(muted)
  }
}
