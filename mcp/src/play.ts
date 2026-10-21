// The play tools (MCP3): playtesting the open scene in a game of the bridge's own. Only the --launch backend has them
// (design M9: remote play stays disabled), because the game is a second N2EditorHost process that the bridge starts on
// this computer, exactly as the editor does: src/main/play-session.ts writes a snapshot of the open scene on the edit host
// (unsaved edits included, nothing saved), starts `N2EditorHost --play <snapshot>` with a fresh token in the child's
// environment only, and connects to it. The tools then pause, step, feed input, read the game's state, log and
// entities, and take pictures of it.
//
// They are write-class tools (a viewer may not play, design 3.2): listed only when the write tools are. Every Step,
// SetPaused, SendInput and the snapshot count against the agent session's host write budget, and steps and pictures
// against their own play budgets (limits.ts). A step runs in chunks with a cancellation check and a progress
// notification between them; n2_play_script checks for cancellation between ops, and a script that ends early (an
// error, a cancellation) releases every key and button it may have left down, so the game is left paused and with no
// input held: a consistent state the next call can build on.
import { z } from "zod"
import { DefaultReadyTimeoutMs, HostProcess, type SpawnFunction } from "../../src/main/host-launcher"
import { PlaySession, type PlayConnection } from "../../src/main/play-session"
import { EngineClient, EngineError } from "../../src/protocol/engine-client"
import type { EditorEvent, InputEvent } from "../../src/protocol/protocol.generated"
import type { PlayState } from "../../src/shared/api"
import type { HostContext } from "./bridge"
import { BridgeAdvice, BridgeError } from "./errors"
import * as limits from "./limits"
import { encodePng, fitSize } from "./png"
import { Budget, type Scrubber } from "./scrub"
import type { Session } from "./session"
import {
  DataNotice,
  decomposeMatrix,
  envelopeSchema,
  idText,
  invalidArgument,
  isSensitiveLogLine,
  scrubLogMessage,
  tool,
  type CallHooks,
  type ToolAnnotationsHint,
  type ToolDef,
  type ToolOutput,
} from "./tools"

/** What the --launch backend tells the play tools: the same host executable, project and renderer as the edit host */
export interface PlayOptions {
  hostPath: string
  projectPath: string
  renderer?: string
  readyTimeoutMs?: number
  /** A test's fake child process spawner */
  spawn?: SpawnFunction
  /** How long a stopped game gets to exit before it is killed (default: play-session's) */
  stopGraceMs?: number
  /** How long the game gets to answer its first request (default: play-session's) */
  requestTimeoutMs?: number
}

/** The play state as the tools report it (the message is scrubbed: it can quote the game's output) */
export interface PlayView {
  status: PlayState["status"]
  launch: number
  frame: number
  time: number
  message: string | null
}

/** Per-session play counters (the agent session's id is the key; they live as long as the bridge) */
interface PlayBudget {
  frames: number
  screenshots: number
}

/**
 * The bridge's one game: a PlaySession whose edit host is the bridge's current connection, and the little the tools
 * remember about the running game (its viewport size, where the next log read starts).
 */
export class PlayController {
  private readonly session: PlaySession
  private editor: EngineClient | null = null
  private viewport: { launch: number; width: number; height: number } | null = null
  private logCursor: { launch: number; epoch: number; seq: number } | null = null
  private readonly budgets = new Map<string, PlayBudget>()

  constructor(
    options: PlayOptions,
    private readonly scrubber: Scrubber,
    log: (message: string) => void = () => undefined
  ) {
    const self = this
    this.session = new PlaySession({
      editor: {
        get isConnected() {
          return self.editor?.isConnected ?? false
        },
        writePlaySnapshot(scenePath: string) {
          if (!self.editor) return Promise.reject(new Error("The editor host isn't connected"))
          return self.editor.writePlaySnapshot(scenePath)
        },
      },
      projectPath: () => options.projectPath,
      hostPath: () => options.hostPath,
      renderer: () => options.renderer,
      readyTimeoutMs: () => options.readyTimeoutMs ?? DefaultReadyTimeoutMs,
      createConnection: () => new EngineClient() as unknown as PlayConnection,
      publish: () => undefined,
      launch: async (launchOptions) => {
        const host = await HostProcess.launch({ ...launchOptions, spawn: options.spawn ?? launchOptions.spawn })
        // The game's token is in its environment only; should it ever be echoed, it is redacted like the bridge's own
        scrubber.addSecret(host.token)
        return host
      },
      log: (message) => log(`play: ${message}`),
      stopGraceMs: options.stopGraceMs,
      requestTimeoutMs: options.requestTimeoutMs,
    })
  }

  /** The state, with its message scrubbed (it can hold the game's last output lines, paths among them) */
  view(): PlayView {
    const s = this.session.state
    return {
      status: s.status,
      launch: s.launch,
      frame: s.frame,
      time: s.time,
      message: s.message === null ? null : this.scrubber.message(s.message, 1500),
    }
  }

  get live(): boolean {
    const status = this.session.state.status
    return status === "playing" || status === "paused"
  }

  /** Starts the game from the open scene through the edit host ctx is connected to */
  async start(ctx: HostContext): Promise<void> {
    this.editor = ctx.client
    try {
      await this.session.start("")
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      if (e instanceof Error && e.name === "CancelledError") {
        throw new BridgeError("cancelled", "Starting the game was cancelled (it was stopped while it started).", "Call n2_play_start again if you still want to play.")
      }
      throw new BridgeError(
        "play_failed",
        "The game could not be started.",
        "Read the host's words below and n2_get_console. Fix the scene or its scripts, then call n2_play_start again.",
        this.scrubber.message(reason, 1500),
        e
      )
    }
  }

  stop(): Promise<void> {
    return this.session.stop()
  }

  /** The running game's connection; play_not_running when there is none */
  client(): EngineClient {
    if (!this.live) {
      const v = this.view()
      const why = v.status === "exited" || v.status === "failed" ? ` (it ${v.status === "exited" ? "ended" : "failed"}: see message in n2_play_observe)` : ""
      throw new BridgeError("play_not_running", `No game is running${why}.`, "Call n2_play_start first.")
    }
    return this.session.client as unknown as EngineClient
  }

  async setPaused(paused: boolean): Promise<void> {
    this.client()
    await this.session.setPaused(paused)
  }

  /** Steps a paused game, in chunks, with progress and a cancellation check between them; frames is already budgeted */
  async step(frames: number, call: CallHooks, progress?: (done: number) => void): Promise<number> {
    this.client()
    if (this.session.state.status !== "paused") {
      throw new BridgeError("invalid_argument", "Step needs a paused game.", "Pause it first (n2_play_control with action pause), then step.")
    }
    let done = 0
    while (done < frames) {
      if (call.signal?.aborted) break
      const chunk = Math.min(limits.StepChunkFrames, frames - done)
      await this.session.step(chunk)
      done += chunk
      progress?.(done)
    }
    return done
  }

  refresh(): Promise<unknown> {
    return this.session.refresh()
  }

  /** The game's picture at a size, setting the game's viewport when it differs (once per launch and size) */
  async screenshot(width: number, height: number, maxSide: number): Promise<{ png: Buffer; width: number; height: number; scaled: boolean }> {
    const client = this.client()
    const fit = fitSize(width, height, maxSide)
    const launch = this.session.state.launch
    if (!this.viewport || this.viewport.launch !== launch || this.viewport.width !== fit.width || this.viewport.height !== fit.height) {
      await client.setViewportSize(fit.width, fit.height)
      this.viewport = { launch, width: fit.width, height: fit.height }
    }
    const frame = await client.renderFrame()
    if (frame.pixels.length !== frame.width * frame.height * 4 || frame.width < 1 || frame.height < 1 || Math.max(frame.width, frame.height) > maxSide) {
      throw new BridgeError("host_error", "The game's picture was empty or malformed.", BridgeAdvice.host)
    }
    const png = encodePng(frame.width, frame.height, frame.pixels)
    if (png.length > limits.ScreenshotMaxPngBytes) {
      throw new BridgeError("result_too_large", "The game's picture is too large as a PNG.", "Ask for a smaller width and height.")
    }
    return { png, width: frame.width, height: frame.height, scaled: fit.scaled }
  }

  /**
   * The game's log since the last read in this launch (from its start the first time), at most `limit` lines kept by
   * `keep`; the cursor moves past everything read, kept or not. dropped counts events the game's ring lost. With `own`,
   * the read starts and ends at that cursor instead (n2_play_script's), and n2_play_observe's is left alone.
   */
  async readLog(limit: number, keep: (e: EditorEvent) => boolean, own?: LogCursor): Promise<{ lines: LogLine[]; dropped: number; more: boolean }> {
    const client = this.client()
    const launch = this.session.state.launch
    let cursor = own ?? (this.logCursor && this.logCursor.launch === launch ? this.logCursor : { launch, epoch: 0, seq: 0 })
    const lines: LogLine[] = []
    let dropped = 0
    let more = false
    for (let round = 0; round < 4; round++) {
      const batch = await client.pollEvents(cursor.epoch, cursor.seq, 1024)
      dropped += batch.dropped
      let next = { launch, epoch: batch.epoch, seq: batch.nextSeq }
      let stoppedEarly = false
      for (const event of batch.events) {
        if (lines.length >= limit) {
          more = true
          stoppedEarly = true
          break
        }
        next = { launch, epoch: batch.epoch, seq: event.seq }
        if (event.kind !== "log" || typeof event.message !== "string" || isSensitiveLogLine(event.message) || !keep(event)) continue
        lines.push({
          seq: event.seq,
          level: this.scrubber.name(event.level ?? "info", 16),
          time: typeof event.time === "number" ? event.time : 0,
          message: scrubLogMessage(this.scrubber, event.message),
        })
      }
      cursor = next
      if (stoppedEarly || batch.events.length < 1024) break
      if (round === 3) more = true
    }
    if (own) Object.assign(own, cursor)
    else this.logCursor = cursor
    return { lines, dropped, more }
  }

  /** A log cursor at the game's newest event: what is logged from now on */
  async logNow(): Promise<LogCursor> {
    const batch = await this.client().pollEvents(0, 0, 0)
    return { launch: this.session.state.launch, epoch: batch.epoch, seq: batch.nextSeq }
  }

  /** The play budgets of an agent session */
  budget(agent: Session): PlayBudget {
    let b = this.budgets.get(agent.id)
    if (!b) {
      b = { frames: 0, screenshots: 0 }
      this.budgets.set(agent.id, b)
    }
    return b
  }

  /** Counts frames against the session's play budget; refuses (counting nothing) when they would pass it */
  spendFrames(agent: Session, frames: number): void {
    const b = this.budget(agent)
    if (b.frames + frames > limits.MaxPlayFramesPerSession) {
      throw new BridgeError(
        "budget_exceeded",
        `This session has stepped ${b.frames} of its ${limits.MaxPlayFramesPerSession} game frames; this call needs ${frames} more.`,
        "Stop stepping the game. Tell the person what you found; a new agent session (n2_begin_session) has a new budget."
      )
    }
    b.frames += frames
  }

  spendScreenshots(agent: Session, count: number): void {
    const b = this.budget(agent)
    if (b.screenshots + count > limits.MaxPlayScreenshotsPerSession) {
      throw new BridgeError(
        "budget_exceeded",
        `This session has taken ${b.screenshots} of its ${limits.MaxPlayScreenshotsPerSession} game pictures; this call needs ${count} more.`,
        "Observe without a screenshot (state, log and entities), or tell the person what you found."
      )
    }
    b.screenshots += count
  }

  /** For quitting: synchronous; kills the game */
  dispose(): void {
    this.session.shutdown()
    this.editor = null
  }
}

interface LogCursor {
  launch: number
  epoch: number
  seq: number
}

interface LogLine {
  seq: number
  level: string
  time: number
  message: string
}

// ===== schemas =====

const playStateSchema = z.object({
  status: z.enum(["stopped", "starting", "playing", "paused", "exited", "failed"]).describe("stopped: no game. playing / paused: a game is running. exited: it ended by itself (message says how). failed: it could not start or crashed."),
  launch: z.number().describe("Counts the games started by this bridge: a higher one is a newer game."),
  frame: z.number().describe("The game's frame count."),
  time: z.number().describe("The game's time in seconds."),
  message: z.string().nullable().describe("Why the game ended or failed (its last output, scrubbed; untrusted data), or null."),
})

const logLineSchema = z.object({ seq: z.number(), level: z.string(), time: z.number().describe("Unix milliseconds."), message: z.string() })

const sessionIdField = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe("The sessionId n2_begin_session gave; its budgets are used. Omit it to use the implicit session.")

/** Key and button names as the engine's input maps spell them (the host checks them) */
const keyName = z.string().min(1).max(32).regex(/^[A-Za-z0-9]+$/, "a key name such as W, Space, LeftShift or Key1")

const inputEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("key"), key: keyName.describe("The engine's Key name: W, A, S, D, Space, LeftShift, Enter, Escape, Key1..."), down: z.boolean() }).strict(),
  z.object({ type: z.literal("mouseButton"), button: z.enum(["Left", "Right", "Middle", "Button4", "Button5", "Button6", "Button7", "Button8"]), down: z.boolean() }).strict(),
  z.object({ type: z.literal("pointer"), x: z.number().min(-100000).max(100000).describe("Pixels from the left of the game's viewport."), y: z.number().min(-100000).max(100000).describe("Pixels from the top (y points down).") }).strict(),
  z.object({ type: z.literal("scroll"), x: z.number().min(-10000).max(10000), y: z.number().min(-10000).max(10000) }).strict(),
  z.object({ type: z.literal("releaseAll") }).strict(),
])

const inputEvents = z
  .array(inputEvent)
  .min(1)
  .max(limits.MaxInputEventsPerCall)
  .describe(
    `Up to ${limits.MaxInputEventsPerCall} input events, applied in order (all or none). Keys and buttons stay down until an event with down false (or releaseAll); the pointer stays where it was put. A paused game acts on input at its next stepped frame.`
  )

const play = (title: string, o: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean } = {}): ToolAnnotationsHint => ({
  title,
  readOnlyHint: o.readOnly === true,
  destructiveHint: o.destructive === true,
  idempotentHint: o.idempotent === true,
  openWorldHint: false,
})

/** Said in every play tool's description */
const PlayNotice =
  "The game is a separate copy of the open scene (unsaved edits included) running in its own host on this computer: nothing done in it changes the scene or the project."

function output(summary: string, data: unknown, extra: Partial<ToolOutput> = {}): ToolOutput {
  return { source: "game", untrusted: true, summary, data, ...extra }
}

/** The bridge's game, or the tool is not available (never reached: the tools are only registered when it exists) */
function controller(ctx: HostContext): PlayController {
  if (!ctx.play) throw new BridgeError("forbidden", "Play is only available when the bridge launched its own host (--launch).", "Do not retry.")
  return ctx.play
}

function cancelled(): BridgeError {
  return new BridgeError("cancelled", "The call was cancelled; the game is left paused with no key or button held.", "Call n2_play_observe to see where it stopped.")
}

/** Leaves the game with no input held, after a script that ended early (best effort: the game may be gone) */
async function releaseAll(c: PlayController): Promise<void> {
  try {
    if (c.live) await c.client().sendInput([{ type: "releaseAll" }])
  } catch {
    // the game ended; nothing is held in a game that is gone
  }
}

// ===== n2_play_start / n2_play_stop =====

const stateData = z.object({ play: playStateSchema })

const playStart = tool({
  name: "n2_play_start",
  title: "Start playing",
  description:
    "Plays the open scene: the host writes a snapshot of it as it is in the editor (unsaved edits included; nothing is saved) and the bridge starts the game from it in a host of its own, then connects. Answers the game's state (playing, frame, time). When a game is already running it answers that game's state. Then use n2_play_control (pause, resume, step), n2_play_input, n2_play_observe and n2_play_script, and n2_play_stop when done. " +
    PlayNotice +
    " " +
    DataNotice,
  input: z.object({ sessionId: sessionIdField }).strict(),
  output: envelopeSchema(stateData),
  annotations: play("Start playing", { idempotent: true }),
  write: true,
  async handler(ctx, args) {
    const c = controller(ctx)
    const agent = ctx.sessions.resolve(args.sessionId)
    if (c.live) {
      await c.refresh()
      return output("A game is already running.", { play: c.view() }, { notes: ["The game was already running: call n2_play_stop first for a fresh one."] })
    }
    agent.spend(1)
    await c.start(ctx)
    const v = c.view()
    return output(`The game is ${v.status} (game ${v.launch}).`, { play: v })
  },
})

const playStop = tool({
  name: "n2_play_stop",
  title: "Stop playing",
  description: "Ends the game (Shutdown, then a kill after a grace period). Not an error when no game is running. The scene in the editor is unchanged. " + DataNotice,
  input: z.object({}).strict(),
  output: envelopeSchema(stateData),
  annotations: play("Stop playing", { idempotent: true }),
  write: true,
  async handler(ctx) {
    const c = controller(ctx)
    const was = c.live
    await c.stop()
    return output(was ? "The game was stopped." : "No game was running.", { play: c.view() })
  },
})

// ===== n2_play_control =====

const controlData = z.object({ play: playStateSchema, framesStepped: z.number().describe("Frames the step ran (fewer than asked when the call was cancelled).") })

const playControl = tool({
  name: "n2_play_control",
  title: "Pause, resume or step the game",
  description:
    `pause stops the game's time; resume lets it run; step runs frames (1 to ${limits.MaxStepFramesPerCall}) of a PAUSED game, each one fixed timestep, then leaves it paused, so a test is repeatable. A step reports progress and can be cancelled between chunks of ${limits.StepChunkFrames} frames. Answers the game's state. ` +
    PlayNotice +
    " " +
    DataNotice,
  input: z
    .object({
      action: z.enum(["pause", "resume", "step"]),
      frames: z.number().int().min(1).max(limits.MaxStepFramesPerCall).optional().describe(`For step: how many frames (default 1, at most ${limits.MaxStepFramesPerCall}).`),
      sessionId: sessionIdField,
    })
    .strict(),
  output: envelopeSchema(controlData),
  annotations: play("Pause, resume or step the game"),
  write: true,
  async handler(ctx, args, call) {
    const c = controller(ctx)
    const agent = ctx.sessions.resolve(args.sessionId)
    c.client()
    if (args.action !== "step") {
      if (args.frames !== undefined) throw invalidArgument("frames goes with action step only.")
      agent.spend(1)
      await c.setPaused(args.action === "pause")
      const v = c.view()
      return output(`The game is ${v.status} at frame ${v.frame}.`, { play: v, framesStepped: 0 })
    }
    const frames = args.frames ?? 1
    const chunks = Math.ceil(frames / limits.StepChunkFrames)
    c.spendFrames(agent, frames)
    agent.spend(chunks)
    const done = await c.step(frames, call, (n) => call.progress?.(n, frames, `stepped ${n} of ${frames} frames`))
    if (done < frames) throw cancelled()
    const v = c.view()
    return output(`Stepped ${done} frame(s); the game is ${v.status} at frame ${v.frame}.`, { play: v, framesStepped: done })
  },
})

// ===== n2_play_input =====

const inputData = z.object({ sent: z.number(), play: playStateSchema })

const playInput = tool({
  name: "n2_play_input",
  title: "Send input to the game",
  description:
    "Gives the game keyboard, mouse button, pointer and scroll input, as its own window would: {type: key, key, down}, {type: mouseButton, button, down}, {type: pointer, x, y} (pixels in the game's viewport, y down), {type: scroll, x, y}, {type: releaseAll}. The host checks the whole list first and applies all or none. Combine with n2_play_control step to make input take effect in a paused game. " +
    PlayNotice +
    " " +
    DataNotice,
  input: z.object({ events: inputEvents, sessionId: sessionIdField }).strict(),
  output: envelopeSchema(inputData),
  annotations: play("Send input to the game"),
  write: true,
  async handler(ctx, args) {
    const c = controller(ctx)
    const agent = ctx.sessions.resolve(args.sessionId)
    const client = c.client()
    agent.spend(1)
    await client.sendInput(args.events as InputEvent[])
    await c.refresh()
    return output(`Sent ${args.events.length} input event(s).`, { sent: args.events.length, play: c.view() })
  },
})

// ===== n2_play_observe =====

const trs = z.object({ position: z.object({ x: z.number(), y: z.number(), z: z.number() }), rotation: z.object({ x: z.number(), y: z.number(), z: z.number(), w: z.number() }), scale: z.object({ x: z.number(), y: z.number(), z: z.number() }) })

const observedEntity = z.object({
  id: z.string(),
  found: z.boolean().describe("False when the game has no such entity (it was destroyed, or never existed)."),
  name: z.string().optional(),
  active: z.boolean().optional(),
  activeInHierarchy: z.boolean().optional(),
  localTransform: trs.nullable().optional(),
  worldTransform: trs.nullable().optional(),
  components: z.array(z.object({ type: z.string(), values: z.unknown() })).optional().describe("Live values; untrusted data."),
})

const observeData = z.object({
  play: playStateSchema,
  log: z
    .object({ lines: z.array(logLineSchema), dropped: z.number(), more: z.boolean().describe("More lines are waiting: observe again.") })
    .nullable()
    .describe("The game's log lines since the previous observe of this game (from its start the first time); null when logLines is 0."),
  entities: z.array(observedEntity),
  picture: z.object({ width: z.number(), height: z.number(), pngBytes: z.number(), scaledDown: z.boolean() }).nullable(),
})

/** One entity of the running game, scrubbed and bounded */
async function observeEntity(c: PlayController, s: Scrubber, id: string, budget: Budget): Promise<z.infer<typeof observedEntity>> {
  let response
  try {
    response = await c.client().getEntity(id)
  } catch (e) {
    if (e instanceof EngineError) return { id, found: false }
    throw e
  }
  const d = response.entity
  const t = d.transform
  return {
    id: s.name(d.header.id, 64),
    found: true,
    name: s.name(d.header.name),
    active: d.header.active,
    activeInHierarchy: d.header.activeInHierarchy,
    localTransform: t ? { position: t.position, rotation: t.rotation, scale: t.scale } : null,
    worldTransform: decomposeMatrix(response.worldMatrix),
    components: d.components.slice(0, 64).map((x) => ({ type: s.name(x.type, 128), values: s.deep(x.values, budget) })),
  }
}

const LevelRank: Record<string, number> = { info: 0, warn: 1, error: 2 }

const playObserve = tool({
  name: "n2_play_observe",
  title: "Observe the game",
  description:
    `Reads the running game without changing it: its state (playing or paused, frame, time), its log lines since the previous observe (logLines, default ${limits.ObserveDefaultLines}, at most ${limits.ObserveMaxLines}; level keeps that level or worse), live entities by id (up to ${limits.MaxObservedEntities}: name, active flags, local and world transform, component values) and, with screenshot true, a PNG of what the game's main camera shows. Works on a game that ended too (state and message only). ` +
    PlayNotice +
    " " +
    DataNotice,
  input: z
    .object({
      screenshot: z.boolean().optional().describe("Add a picture of the game (default false); counts against the session's picture budget."),
      width: z.number().int().min(16).max(4096).optional().describe(`Picture width (default ${limits.ScreenshotDefaultWidth}).`),
      height: z.number().int().min(16).max(4096).optional().describe(`Picture height (default ${limits.ScreenshotDefaultHeight}).`),
      entityIds: z.array(idText).max(limits.MaxObservedEntities).optional().describe("Entities to read from the game (their ids in the scene: the game is a copy of it)."),
      logLines: z.number().int().min(0).max(limits.ObserveMaxLines).optional(),
      level: z.enum(["info", "warn", "error"]).optional(),
      sessionId: sessionIdField,
    })
    .strict(),
  output: envelopeSchema(observeData),
  annotations: play("Observe the game", { readOnly: true, idempotent: false }),
  write: true,
  async handler(ctx, args) {
    const c = controller(ctx)
    const s = ctx.scrubber
    const agent = ctx.sessions.resolve(args.sessionId)
    if (!c.live) {
      if (args.screenshot || (args.entityIds?.length ?? 0) > 0) c.client()
      const v = c.view()
      return output(`No game is running (${v.status}).`, { play: v, log: null, entities: [], picture: null })
    }
    await c.refresh()
    const wanted = args.logLines ?? limits.ObserveDefaultLines
    const min = LevelRank[args.level ?? "info"]
    const log = wanted === 0 ? null : await c.readLog(wanted, (e) => (LevelRank[e.level ?? "info"] ?? 0) >= min)
    const budget = new Budget(limits.EntityValuesBytes)
    const entities = []
    for (const id of args.entityIds ?? []) entities.push(await observeEntity(c, s, id, budget))
    let picture: z.infer<typeof observeData>["picture"] = null
    let image: ToolOutput["image"]
    if (args.screenshot) {
      c.spendScreenshots(agent, 1)
      const shot = await c.screenshot(args.width ?? limits.ScreenshotDefaultWidth, args.height ?? limits.ScreenshotDefaultHeight, limits.ScreenshotMaxSide)
      picture = { width: shot.width, height: shot.height, pngBytes: shot.png.length, scaledDown: shot.scaled }
      image = { mimeType: "image/png", base64: shot.png.toString("base64") }
    }
    const v = c.view()
    return output(
      `The game is ${v.status} at frame ${v.frame}${log ? `; ${log.lines.length} log line(s)` : ""}${entities.length ? `; ${entities.length} entit${entities.length === 1 ? "y" : "ies"}` : ""}${picture ? "; with a picture" : ""}.`,
      { play: v, log, entities, picture },
      { truncated: budget.truncated || (log?.more ?? false), image }
    )
  },
})

// ===== n2_play_script =====

const scriptOp = z.union([
  z.object({ input: z.object({ events: inputEvents }).strict() }).strict(),
  z.object({ step: z.object({ frames: z.number().int().min(1).max(limits.MaxStepFramesPerCall) }).strict() }).strict(),
  z
    .object({
      screenshot: z
        .object({
          width: z.number().int().min(16).max(4096).optional(),
          height: z.number().int().min(16).max(4096).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      expectLog: z
        .object({
          contains: z.string().min(1).max(200).describe("Text a log line must contain (case-insensitive)."),
          level: z.enum(["info", "warn", "error"]).optional().describe("The lowest level the line may have."),
          absent: z.boolean().optional().describe("True: passes when NO such line was logged (e.g. no error)."),
        })
        .strict(),
    })
    .strict(),
])

const scriptResult = z.object({
  index: z.number(),
  kind: z.enum(["input", "step", "screenshot", "expectLog"]),
  ok: z.boolean(),
  frame: z.number().describe("The game's frame after the op."),
  detail: z.string().optional().describe("For expectLog: the matching line (untrusted data) or why it failed; for screenshot: which picture it is."),
})

const scriptData = z.object({
  play: playStateSchema,
  completed: z.boolean().describe("Every op ran (an expectLog that failed stops the script unless continueOnFailure)."),
  passed: z.boolean().describe("Every expectLog passed."),
  results: z.array(scriptResult),
  pictures: z.array(z.object({ op: z.number(), width: z.number(), height: z.number(), pngBytes: z.number() })),
  log: z.array(logLineSchema).describe(`The game's log lines during the script (the last ${limits.ConsoleResourceLines}).`),
})

const playScript = tool({
  name: "n2_play_script",
  title: "Run a playtest script",
  description:
    `A playtest in one call: up to ${limits.MaxScriptOps} ops run in order on the running game, which is paused first (if it was playing) and left paused, so frames advance only by step ops and the result is repeatable. Ops: {input: {events}} (as n2_play_input), {step: {frames}} (1 to ${limits.MaxStepFramesPerCall}; ${limits.MaxScriptFrames} in all), {screenshot: {width?, height?}} (at most ${limits.MaxScriptScreenshots}, long side ${limits.ScriptScreenshotMaxSide} px), {expectLog: {contains, level?, absent?}} (checks the log lines since the script started). Reports progress after each op and can be cancelled between ops; a script that ends early releases every key and button. An expectLog that fails stops the script unless continueOnFailure. ` +
    PlayNotice +
    " " +
    DataNotice,
  input: z
    .object({
      ops: z.array(scriptOp).min(1).max(limits.MaxScriptOps),
      continueOnFailure: z.boolean().optional().describe("Keep going after an expectLog fails (default false)."),
      sessionId: sessionIdField,
    })
    .strict(),
  output: envelopeSchema(scriptData),
  annotations: play("Run a playtest script"),
  write: true,
  async handler(ctx, args, call) {
    const c = controller(ctx)
    const s = ctx.scrubber
    const agent = ctx.sessions.resolve(args.sessionId)
    c.client()
    // The whole script is checked and budgeted before the game is touched
    let frames = 0
    let shots = 0
    let commands = 1
    for (const op of args.ops) {
      if ("step" in op) {
        frames += op.step.frames
        commands += Math.ceil(op.step.frames / limits.StepChunkFrames)
      } else if ("screenshot" in op) shots++
      else if ("input" in op) commands++
    }
    if (frames > limits.MaxScriptFrames) throw invalidArgument(`The script steps ${frames} frames; at most ${limits.MaxScriptFrames} per script.`)
    if (shots > limits.MaxScriptScreenshots) throw invalidArgument(`The script takes ${shots} pictures; at most ${limits.MaxScriptScreenshots} per script.`)
    c.spendFrames(agent, frames)
    c.spendScreenshots(agent, shots)
    agent.spend(commands)

    const total = args.ops.length
    const results: Array<z.infer<typeof scriptResult>> = []
    const pictures: Array<z.infer<typeof scriptData>["pictures"][number]> = []
    const images: Array<{ mimeType: string; base64: string }> = []
    const seen: LogLine[] = []
    let pngBytes = 0
    let passed = true
    let completed = true
    let ended = false
    // The script's own log cursor: n2_play_observe still sees every line since its previous call
    let cursor: LogCursor | null = null
    const collect = async (): Promise<void> => {
      cursor ??= await c.logNow()
      const { lines } = await c.readLog(1000, () => true, cursor)
      seen.push(...lines)
      if (seen.length > limits.ConsoleResourceLines * 4) seen.splice(0, seen.length - limits.ConsoleResourceLines * 4)
    }
    try {
      // Lines logged before the script are not its own
      cursor = await c.logNow()
      if (c.view().status === "playing") await c.setPaused(true)
      for (let i = 0; i < total; i++) {
        if (call.signal?.aborted) throw cancelled()
        if (!c.live) {
          completed = false
          ended = true
          break
        }
        const op = args.ops[i]
        if ("input" in op) {
          await c.client().sendInput(op.input.events as InputEvent[])
          results.push({ index: i, kind: "input", ok: true, frame: c.view().frame })
        } else if ("step" in op) {
          const done = await c.step(op.step.frames, call)
          if (done < op.step.frames) throw cancelled()
          results.push({ index: i, kind: "step", ok: true, frame: c.view().frame })
        } else if ("screenshot" in op) {
          const shot = await c.screenshot(op.screenshot.width ?? limits.ScreenshotDefaultWidth, op.screenshot.height ?? limits.ScreenshotDefaultHeight, limits.ScriptScreenshotMaxSide)
          if (pngBytes + shot.png.length > limits.MaxResultPngBytes) {
            results.push({ index: i, kind: "screenshot", ok: false, frame: c.view().frame, detail: "Left out: the pictures together passed the result's size limit. Ask for smaller ones." })
          } else {
            pngBytes += shot.png.length
            pictures.push({ op: i, width: shot.width, height: shot.height, pngBytes: shot.png.length })
            images.push({ mimeType: "image/png", base64: shot.png.toString("base64") })
            results.push({ index: i, kind: "screenshot", ok: true, frame: c.view().frame, detail: `picture ${pictures.length}` })
          }
        } else {
          await collect()
          const needle = op.expectLog.contains.toLowerCase()
          const min = LevelRank[op.expectLog.level ?? "info"]
          const match = seen.find((l) => (LevelRank[l.level] ?? 0) >= min && l.message.toLowerCase().includes(needle))
          const ok = op.expectLog.absent === true ? match === undefined : match !== undefined
          const detail = match ? `line ${match.seq}: ${match.message}` : op.expectLog.absent === true ? "no such line was logged" : "no such line was logged yet"
          results.push({ index: i, kind: "expectLog", ok, frame: c.view().frame, detail: s.str(detail, { maxChars: 600 }) })
          if (!ok) {
            passed = false
            if (args.continueOnFailure !== true) {
              completed = i === total - 1
              call.progress?.(i + 1, total, `op ${i + 1} of ${total}: expectLog failed`)
              break
            }
          }
        }
        call.progress?.(i + 1, total, `op ${i + 1} of ${total}: ${results[results.length - 1].kind}`)
      }
      if (c.live) await collect()
    } catch (e) {
      // Ended early: nothing is left held down, and the game stays paused where it stopped
      await releaseAll(c)
      throw e
    }
    if (ended) await releaseAll(c)
    const v = c.view()
    const log = seen.slice(-limits.ConsoleResourceLines)
    const failed = results.filter((r) => !r.ok).length
    return output(
      `${results.length} of ${total} op(s) ran${ended ? " (the game ended)" : ""}; ${failed === 0 ? "all passed" : `${failed} failed`}; the game is ${v.status} at frame ${v.frame}${images.length ? `; ${images.length} picture(s) follow in op order` : ""}.`,
      { play: v, completed: completed && !ended && results.length === total, passed, results, pictures, log },
      images.length > 0 ? { image: images[0], images: images.slice(1) } : {}
    )
  },
})

/** The play tools in the order they are listed, after the write tools */
export const PlayTools: readonly ToolDef[] = [playStart, playStop, playControl, playInput, playObserve, playScript]

export const PlayToolNames: readonly string[] = PlayTools.map((t) => t.name)
