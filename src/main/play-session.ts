// Play mode (engine #102, protocol 1.10.0): the game runs in a second N2EditorHost process, and this launcher owns it
// (#6 decision 16, review 2.2). Playing is
//   1. WritePlaySnapshot on the edit host: the open scene as it is in memory, unsaved edits included, written to
//      <project>/.n2/play/<name>-<hash>.scene (nothing is saved, no revision moves);
//   2. N2EditorHost --project <same> [--renderer <same>] --port 0 --token-env <VAR> --play <file>
//      --exit-on-disconnect --exit-on-stdin-eof, a fresh token in that child's environment only, and its ready line;
//   3. a second connection to it (Hello with that token). The page then draws its frames, plays its audio, reads its
//      log and sends it input through the play commands (PlayCommands).
// Stopping sends Shutdown, waits StopGraceMs and kills. The launcher owns the Starting and Exited states: a host that
// answers says Playing or Paused. Node only (no Electron), so it is unit tested with fakes.
import * as fs from "fs"
import * as path from "path"
import type { PlayStateResponse } from "../protocol/protocol.generated"
import { GameEndedMessage, InitialPlayState, MaxStepFrames, PlayCommands, PlayState } from "../shared/api"
import { HostExit, HostProcess, LaunchOptions, describeExit } from "./host-launcher"
import { CancelledError } from "./project-session"

/** After Shutdown (stop), how long the child gets to exit before it is killed (the engine's docs say about 2 s) */
export const PlayStopGraceMs = 2000

/**
 * The child's own refusal reason (a snapshot it can't play ends it with one line, "N2EditorHost --play: <reason>"),
 * without the launcher's wrapping; the whole message when it has no such line
 */
export function playFailureReason(message: string): string {
  const prefix = "N2EditorHost --play: "
  const reasons = message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
  return reasons.length > 0 ? reasons.join("\n") : message
}

/** The edit host's connection, as play needs it */
export interface EditorConnection {
  readonly isConnected: boolean
  /** WritePlaySnapshot: the snapshot file's absolute path */
  writePlaySnapshot(scenePath: string): Promise<string>
}

/** The play child's connection (an EngineClient, or a fake): the page's PlayCommands, and what the launcher itself asks */
export interface PlayConnection extends PlayCommands {
  readonly isConnected: boolean
  connect(host: string, port: number, options: { token: string }): Promise<unknown>
  /** Sends Shutdown and closes */
  disconnect(): void
  close(): void
  onClose(listener: () => void): void
  setPaused(paused: boolean): Promise<void>
  step(frames: number): Promise<void>
  getPlayState(): Promise<PlayStateResponse>
}

/** The child's host address: it listens on loopback only */
const ChildAddress = "127.0.0.1"

export interface PlaySessionDeps {
  editor: EditorConnection
  /** The open project's folder, or null when none is open */
  projectPath(): string | null
  /** The N2EditorHost executable (throws with advice when it isn't set) */
  hostPath(): string
  /** The edit host's --renderer; the child gets the same */
  renderer?(): string | undefined
  readyTimeoutMs?(): number
  createConnection(): PlayConnection
  /** Tells the page the state changed */
  publish(state: PlayState): void
  launch?: (options: LaunchOptions) => Promise<HostProcess>
  /** Removes the snapshot once the child has loaded it (it printed its ready line); default: a quiet rm */
  removeFile?: (file: string) => Promise<void>
  /** Logs for the developer (never with the token) */
  log?: (message: string) => void
  /** How long a stopped child gets to exit (default PlayStopGraceMs) */
  stopGraceMs?: number
}

/** Resolves once the child has exited, or after ms (false then) */
function waitForExit(host: HostProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    host.onExit(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** Whether file lies inside dir (so the launcher never deletes anything but the project's snapshots) */
export function isInside(dir: string, file: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(file))
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

export class PlaySession {
  private current: PlayState = InitialPlayState
  private child: HostProcess | null = null
  private connection: PlayConnection | null = null
  /** Kills the child being spawned, until it settles */
  private killLaunching: (() => void) | null = null
  /** Bumped by every start and stop: a start that was overtaken by a stop gives up */
  private token = 0
  private disposed = false
  /** A start is in progress or the game is running: no second start */
  private active = false

  private readonly launch: (options: LaunchOptions) => Promise<HostProcess>
  private readonly removeFile: (file: string) => Promise<void>
  private readonly stopGraceMs: number

  constructor(private readonly deps: PlaySessionDeps) {
    this.launch = deps.launch ?? HostProcess.launch
    this.removeFile = deps.removeFile ?? ((file) => fs.promises.rm(file, { force: true }))
    this.stopGraceMs = deps.stopGraceMs ?? PlayStopGraceMs
  }

  get state(): PlayState {
    return this.current
  }

  /** The child's connection while the game is playing or paused; throws otherwise */
  get client(): PlayConnection {
    if (!this.connection || !this.connection.isConnected || !this.isLive) throw new Error("No game is running")
    return this.connection
  }

  /** Playing or paused: the child is connected */
  private get isLive(): boolean {
    return this.current.status === "playing" || this.current.status === "paused"
  }

  /**
   * Plays the open scene: snapshot, child, connection. Resolves once the game is playing (or paused, if the child
   * says so); rejects, with the state failed (or stopped, for CancelledError), when it couldn't start.
   */
  async start(scenePath: string = ""): Promise<void> {
    if (this.disposed) throw new CancelledError("Cancelled: the editor is closing")
    if (this.active) throw new Error("A game is already running")
    const projectPath = this.deps.projectPath()
    if (projectPath === null) throw new Error("No project is open")
    if (!this.deps.editor.isConnected) throw new Error("The editor host isn't connected")
    const hostPath = this.deps.hostPath()

    const token = ++this.token
    this.active = true
    this.setState({ status: "starting", launch: this.current.launch + 1, frame: 0, time: 0, message: null })
    const cancelled = (): boolean => token !== this.token

    let file = ""
    let child: HostProcess | null = null
    let connection: PlayConnection | null = null
    try {
      try {
        file = await this.deps.editor.writePlaySnapshot(scenePath)
      } catch (e) {
        throw new Error(`Couldn't write the play snapshot: ${errorMessage(e)}`)
      }
      if (cancelled()) throw new CancelledError("Cancelled: play was stopped while it started")

      try {
        child = await this.launch({
          hostPath,
          projectDir: projectPath,
          renderer: this.deps.renderer?.(),
          playFile: file,
          readyTimeoutMs: this.deps.readyTimeoutMs?.(),
          onExit: (exit, host) => this.onChildExit(host, exit),
          onSpawned: (kill) => (this.killLaunching = kill),
        })
      } catch (e) {
        if (cancelled()) throw new CancelledError("Cancelled: play was stopped while it started")
        throw new Error(`Couldn't start the game: ${playFailureReason(errorMessage(e))}`)
      } finally {
        this.killLaunching = null
      }
      if (cancelled()) throw new CancelledError("Cancelled: play was stopped while it started")
      this.child = child
      this.deps.log?.(`N2EditorHost --play started for ${file} (pid ${child.pid ?? "?"}, port ${child.port})`)
      // The child has loaded the snapshot (it printed its ready line): the launcher may delete it
      void this.discardSnapshot(projectPath, file)

      connection = this.deps.createConnection()
      this.connection = connection
      connection.onClose(() => {
        if (this.connection === connection) this.onConnectionClosed()
      })
      try {
        await connection.connect(ChildAddress, child.port, { token: child.token })
      } catch (e) {
        if (cancelled()) throw new CancelledError("Cancelled: play was stopped while it started")
        // Did it die between its ready line and Hello? Then its exit says why, not the closed connection
        const exited = child.exit ?? ((await waitForExit(child, 500)) ? child.exit : null)
        if (exited) {
          throw new Error(`The game ${describeExit(exited)} before the editor could connect${child.lastOutput}`)
        }
        throw new Error(`Couldn't connect to the game: ${errorMessage(e)}`)
      }
      if (cancelled()) throw new CancelledError("Cancelled: play was stopped while it started")

      const state = await connection.getPlayState()
      if (cancelled()) throw new CancelledError("Cancelled: play was stopped while it started")
      this.setState({ ...statusOf(state), message: null })
    } catch (e) {
      if (cancelled()) {
        // stop() already ended and reported everything; make sure nothing of this start is left running
        child?.kill()
        connection?.close()
        throw e
      }
      this.child = null
      this.connection = null
      this.active = false
      child?.kill()
      connection?.close()
      const message = errorMessage(e)
      this.deps.log?.(message)
      this.setState({ status: "failed", message })
      throw e
    }
  }

  /**
   * Ends the game: Shutdown, then a kill after the grace period. Nothing running is no error. reason is a note for
   * the page (the edit host went away); an ended or failed session goes back to stopped.
   */
  async stop(reason: string | null = null): Promise<void> {
    const child = this.child
    const connection = this.connection
    if (!this.active && child === null && this.current.status !== "exited" && this.current.status !== "failed") return
    // Overtakes a start in progress; from here the child's exit is expected, not a crash
    this.token++
    this.active = false
    this.child = null
    this.connection = null
    this.killLaunching?.()
    if (child === null) {
      connection?.close()
      this.setState({ status: "stopped", frame: 0, time: 0, message: reason })
      return
    }
    // Shown as stopped as soon as the user asked; the process may take a moment to end
    this.setState({ status: "stopped", frame: 0, time: 0, message: reason })
    if (connection && connection.isConnected) connection.disconnect()
    else connection?.close()
    if (await waitForExit(child, this.stopGraceMs)) return
    this.deps.log?.("The game didn't exit after Shutdown: killing it")
    child.kill()
    await waitForExit(child, this.stopGraceMs)
  }

  /** For quitting: synchronous and final. Kills the child (and one being spawned); nothing starts afterwards. */
  shutdown(): void {
    this.disposed = true
    this.token++
    this.active = false
    const child = this.child
    this.child = null
    const connection = this.connection
    this.connection = null
    // The connection is closed first, so an --exit-on-disconnect child that outlives the kill still exits
    connection?.close()
    child?.kill()
    this.killLaunching?.()
  }

  /** Pauses or resumes the game, then reads its state back */
  async setPaused(paused: boolean): Promise<void> {
    await this.client.setPaused(paused)
    await this.refresh()
  }

  /** Runs frames of a paused game (1 to MaxStepFrames), then reads its state back */
  async step(frames: number): Promise<void> {
    if (!Number.isInteger(frames) || frames < 1 || frames > MaxStepFrames) {
      throw new Error(`Step takes 1 to ${MaxStepFrames} frames`)
    }
    if (this.current.status !== "paused") throw new Error("Step needs a paused game")
    await this.client.step(frames)
    await this.refresh()
  }

  /** Asks the child for its state (GetPlayState): the pause flag, frame and time. A game that isn't live keeps its state. */
  async refresh(): Promise<PlayState> {
    if (!this.isLive) return this.current
    const connection = this.client
    const token = this.token
    const answer = await connection.getPlayState()
    // The game ended or restarted while the answer was on its way
    if (token === this.token && this.isLive) {
      const next = statusOf(answer)
      const c = this.current
      if (next.status !== c.status || next.frame !== c.frame || next.time !== c.time) {
        this.setState(next)
      }
    }
    return this.current
  }

  /** The child ended on its own (a crash, or the game quit) */
  private onChildExit(host: HostProcess, exit: HostExit): void {
    if (host !== this.child) return
    this.child = null
    this.endedUnexpectedly(`The game ${describeExit(exit)}${host.lastOutput}`, exit)
  }

  /** The connection to the child closed while it was current: if the process is still alive, it will exit by itself */
  private onConnectionClosed(): void {
    const child = this.child
    if (child === null || child.exited) return
    // --exit-on-disconnect: the child ends now. Its exit says why, but a hung one is killed.
    void waitForExit(child, this.stopGraceMs).then((exited) => {
      if (!exited && child === this.child) child.kill()
    })
  }

  private endedUnexpectedly(message: string, exit: HostExit): void {
    // Still starting: start() is waiting on the connection, which fails now, and reports this failure itself
    if (this.current.status === "starting") return
    this.connection?.close()
    this.connection = null
    this.active = false
    this.token++
    this.deps.log?.(message)
    // A game that quit by itself (Application::Quit, exit code 0) is no failure; the page words it
    this.setState({ status: "exited", message: exit.code === 0 ? GameEndedMessage : message })
  }

  private async discardSnapshot(projectPath: string, file: string): Promise<void> {
    // Only what the host wrote under the project's own .n2 folder
    if (!isInside(path.join(projectPath, ".n2"), file)) return
    try {
      await this.removeFile(file)
    } catch (e) {
      this.deps.log?.(`Couldn't remove the play snapshot ${file}: ${errorMessage(e)}`)
    }
  }

  private setState(change: Partial<PlayState>): void {
    this.current = { ...this.current, ...change }
    this.deps.publish(this.current)
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The state fields GetPlayState says: Playing or Paused (an "Edit" answer means no game: treated as playing) */
function statusOf(answer: PlayStateResponse): Pick<PlayState, "status" | "frame" | "time"> {
  return {
    status: answer.state === "Paused" ? "paused" : "playing",
    frame: answer.frame,
    time: answer.time,
  }
}
