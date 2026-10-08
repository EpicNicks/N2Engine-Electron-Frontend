// The engine's audio in the page: an AudioPlayer that plays while connected, its status as signals for the toolbar,
// and the mute setting, remembered in localStorage.
import { computed, signal } from "@preact/signals-core"
import { AudioPlayer, AudioPlayerStatus } from "./audio-player"
import type { EngineApi, PlayApi } from "../shared/api"
import type { AudioSource } from "./audio-player"

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
  private readonly editor: AudioSource
  /** Where the audio comes from: the editor host's, or the game's while one is live (useGame) */
  private source: AudioSource

  constructor(engine: Pick<EngineApi, "getAudio" | "isConnected">) {
    // Polls GetAudio through window.engine and plays it with Web Audio (see audio-player.ts)
    this.editor = { getAudio: () => engine.getAudio(), isConnected: () => engine.isConnected() }
    this.source = this.editor
    this.player = new AudioPlayer({ getAudio: () => this.source.getAudio(), isConnected: () => this.source.isConnected() })
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

  /**
   * Plays the game's audio (the play child has a stream of its own) instead of the editor host's, or the editor host's
   * again (null). The player starts over on the new source: its buffer holds nothing of the other one.
   */
  useGame(play: Pick<PlayApi, "getAudio" | "state"> | null): void {
    this.player.stop()
    this.source = play
      ? {
          getAudio: () => play.getAudio(),
          isConnected: () => play.state().status === "playing" || play.state().status === "paused",
        }
      : this.editor
    // The game's audio starts with the game; the editor host's again only when it is there to ask
    if (play || this.editor.isConnected()) this.player.start()
  }

  /** The toolbar button: mutes or unmutes, or resumes audio the autoplay policy suspended (a click is a gesture) */
  toggle(): void {
    const muted = this.status.value?.state === "suspended" ? false : !this.player.isMuted
    this.player.setMuted(muted)
    this.muted.value = muted
    saveMuted(muted)
  }
}
