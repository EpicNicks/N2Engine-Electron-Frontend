// The page's side of play mode (engine #102, F7): the toolbar's Play, Pause, Step and Stop, the state they show, and
// what a game running in the play child changes in the editor:
//   - the scene is read-only (EditorStore.playMode: the inspector, the hierarchy and scene changes follow it);
//   - the viewport shows the game's frames and the audio is the game's (viewport-panel.tsx, AudioController);
//   - the game's log lines join the console, and its playState events refresh the toolbar;
//   - a game that crashed, a snapshot that couldn't be written and a child that couldn't start are said where they can
//     be seen (the console, and the error banner).
// The main process owns the child (main/play-session.ts); this only calls window.play and follows its state. No DOM:
// it is given the page's API or a fake, so it is unit tested in Node.
import { batch, computed, signal } from "@preact/signals-core"
import type { EditorEvent } from "../protocol/protocol.generated"
import { EventPumpOptions } from "../protocol/event-pump"
import { GameEndedMessage, InitialPlayState, MaxStepFrames, PlayApi, PlayState } from "../shared/api"
import { ConsoleEntry, ConsoleStore, entryFromEvent } from "./console-store"

/** While a game is live, its frame and time are read this often (the pause flag too: a game can pause itself) */
export const PlayRefreshMs = 250

/** The reason the editor gives while a game runs: shown by the inspector and the hierarchy */
export const PlayReadOnlyReason = "the game is running"

/** The parts of the page's play API the controller uses */
export type PlayControllerApi = Pick<
  PlayApi,
  "state" | "onStateChange" | "start" | "stop" | "setPaused" | "step" | "refresh" | "pollEvents"
>

export interface PlayControllerDeps {
  api: PlayControllerApi
  /** Makes the scene read-only (EditorStore.setPlayMode: a reason) or editable again (null) */
  setPlayMode(reason: string | null): void
  /** Waits for the edits still on their way to the edit host (a rename, the inspector's 250 ms debounce) */
  settle?(): Promise<void>
  /** Whether the editor can start a game now: connected, a scene loaded, nothing busy */
  canStart(): boolean
  /** Adds the game's own log lines to the console */
  addLog(entries: Array<Omit<ConsoleEntry, "id">>): void
  /** An editor note for the console (a game started, ended, crashed) */
  note(level: "info" | "warn" | "error", message: string): void
  /** A failure to show on the error banner */
  onError(what: string, error: unknown): void
  /** Runs callback every ms; returns what stops it */
  every?(callback: () => void, ms: number): () => void
  eventOptions?: EventPumpOptions
}

/** Whether the state is one with a child running (or starting) */
export const isActive = (state: PlayState): boolean =>
  state.status === "starting" || state.status === "playing" || state.status === "paused"

/** What the toolbar says about the game */
export function describePlay(state: PlayState): string {
  switch (state.status) {
    case "starting":
      return "Starting the game..."
    case "playing":
      return `Playing: frame ${state.frame}, ${state.time.toFixed(1)} s`
    case "paused":
      return `Paused: frame ${state.frame}, ${state.time.toFixed(1)} s`
    case "exited":
      return state.message === GameEndedMessage ? "The game ended" : "The game crashed"
    case "failed":
      return "The game couldn't start"
    default:
      return ""
  }
}

const everyMs = (callback: () => void, ms: number): (() => void) => {
  const handle = setInterval(callback, ms)
  return () => clearInterval(handle)
}

export class PlayController {
  readonly state = signal<PlayState>(InitialPlayState)
  /** A child is starting or running: the scene is read-only */
  readonly active = computed(() => isActive(this.state.value))
  /** The game is connected (playing or paused): its frames, audio and input are what the editor shows */
  readonly live = computed(() => this.state.value.status === "playing" || this.state.value.status === "paused")
  readonly paused = computed(() => this.state.value.status === "paused")
  readonly text = computed(() => describePlay(this.state.value))
  /** A request (start, stop, pause, step) is on its way: the buttons wait */
  readonly busy = signal(false)
  /** Whether the Play button can start a game now */
  readonly canPlay = computed(() => !this.active.value && !this.busy.value && this.deps.canStart())

  private console: ConsoleStore | null = null
  private stopRefresh: (() => void) | null = null
  private readonly every: (callback: () => void, ms: number) => () => void

  constructor(private readonly deps: PlayControllerDeps) {
    this.every = deps.every ?? everyMs
    this.apply(deps.api.state())
    deps.api.onStateChange((state) => this.apply(state))
  }

  /** Plays the open scene (unsaved edits included) */
  async start(): Promise<void> {
    if (!this.canPlay.value) return
    // The snapshot is of what the edit host holds: what was typed a moment ago must have reached it
    await this.run(async () => {
      await this.deps.settle?.()
      await this.deps.api.start()
    }, "The game couldn't start")
  }

  /** Ends the game (not an error when none runs) */
  async stop(): Promise<void> {
    await this.run(() => this.deps.api.stop(), "Failed to stop the game")
  }

  async setPaused(paused: boolean): Promise<void> {
    if (!this.live.value) return
    await this.run(() => this.deps.api.setPaused(paused), paused ? "Failed to pause the game" : "Failed to resume the game")
  }

  async togglePause(): Promise<void> {
    await this.setPaused(!this.paused.value)
  }

  /** Runs frames (1 to MaxStepFrames) of a paused game */
  async step(frames: number = 1): Promise<void> {
    if (!this.paused.value) return
    const count = Math.min(MaxStepFrames, Math.max(1, Math.floor(frames)))
    await this.run(() => this.deps.api.step(count), "Failed to step the game")
  }

  /** The game's picture or audio or input failed: if the game is gone that is no news, else it is shown */
  async failure(what: string, e: unknown): Promise<void> {
    if (!this.live.value) return
    // Ask the child before blaming it: the connection may just have closed because the game ended
    try {
      await this.deps.api.refresh()
    } catch {
      return
    }
    if (this.live.value) this.deps.onError(what, e)
  }

  private async run(action: () => Promise<void>, what: string): Promise<void> {
    this.busy.value = true
    try {
      await action()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // The editor ended it itself (stopped while it started): no error
      if (!message.startsWith("Cancelled:")) {
        // A failed start is reported by its state too (failed, with the child's reason); the banner says it once
        this.deps.onError(what, e)
      }
    } finally {
      this.busy.value = false
    }
  }

  /** A new state from the main process */
  private apply(next: PlayState): void {
    const previous = this.state.value
    if (next === previous) return
    batch(() => {
      this.state.value = next
      this.deps.setPlayMode(isActive(next) ? PlayReadOnlyReason : null)
    })
    const wasLive = previous.status === "playing" || previous.status === "paused"
    if (next.launch !== previous.launch && next.status === "starting") {
      this.deps.note("info", "Starting the game (a second N2EditorHost, from the scene as it is in the editor)")
    }
    if (this.live.value && (!wasLive || next.launch !== previous.launch)) this.connectEvents(next.launch)
    if (!this.live.value && this.console) this.disconnectEvents()
    if (!wasLive && this.live.value) this.deps.note("info", "The game is running")
    if (wasLive && next.status === "paused" && previous.status === "playing") this.deps.note("info", "The game paused")
    if (wasLive && next.status === "playing" && previous.status === "paused") this.deps.note("info", "The game resumed")
    if (previous.status !== next.status || previous.launch !== next.launch) this.report(previous, next)
  }

  /** What a state change means in the console, and on the banner when it is a failure */
  private report(previous: PlayState, next: PlayState): void {
    if (next.status === "stopped" && isActive(previous)) {
      this.deps.note("info", next.message ?? "The game was stopped")
    } else if (next.status === "exited") {
      if (next.message === GameEndedMessage) this.deps.note("info", "The game ended")
      else {
        this.deps.note("error", next.message ?? "The game exited")
        this.deps.onError("The game stopped unexpectedly", new Error(next.message ?? "The game exited"))
      }
    } else if (next.status === "failed") {
      this.deps.note("error", next.message ?? "The game couldn't start")
    }
  }

  private connectEvents(launch: number): void {
    this.disconnectEvents()
    const console = new ConsoleStore((epoch, afterSeq, maxEvents) => this.deps.api.pollEvents(epoch, afterSeq, maxEvents), {
      ...this.deps.eventOptions,
      onEvents: (events) => this.onEvents(events),
    })
    this.console = console
    console.connect(launch)
    this.stopRefresh = this.every(() => {
      this.deps.api.refresh().catch(() => {
        // The game ended or is going: its state follows
      })
    }, PlayRefreshMs)
  }

  private disconnectEvents(): void {
    this.console?.disconnect()
    this.console = null
    this.stopRefresh?.()
    this.stopRefresh = null
  }

  private onEvents(events: EditorEvent[]): void {
    const entries: Array<Omit<ConsoleEntry, "id">> = []
    let stateChanged = false
    for (const event of events) {
      const entry = entryFromEvent(event)
      if (entry) entries.push({ ...entry, source: "game" })
      else if (event.kind === "playState") stateChanged = true
    }
    if (entries.length > 0) this.deps.addLog(entries)
    // The game paused or resumed (it can pause itself: a frame that threw): the toolbar follows now, not in 250 ms
    if (stateChanged) this.deps.api.refresh().catch(() => {})
  }

  /** Stops following the game (the page is going away) */
  dispose(): void {
    this.disconnectEvents()
  }
}
