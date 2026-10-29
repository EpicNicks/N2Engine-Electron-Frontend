// The editor's agent endpoint (MCP6): a local server (a named pipe on Windows, a Unix socket elsewhere) that lets ONE AI agent
// work in the editor the person has open, through the editor's own engine connection. Node only (no Electron): the dialog,
// the page and the files are given in as functions, so everything here is unit tested with fakes.
//
// It speaks the editor protocol's own framing, as a small host of its own: the client says Hello with this launch's secret
// as its token (the n2-mcp bridge's EngineClient does exactly that) and then sends the commands it would send a host. What
// the endpoint adds, command by command (src/agent/commands.ts is the allowlist):
//  - the agent's role is capped at editor: no admin-only command, no extensions, no play, no Shutdown, and the host's
//    access token never leaves the main process (the agent never sees it, the host's address either);
//  - every scene change is inside an edit group labelled "AI: ..." (one the agent did not open is made for it), so the
//    person sees each step in the Edit menu and the history and can undo it;
//  - an irreversible command (saving, opening or creating a scene, project settings, import settings, overwriting a text
//    file, undoing a step that is the person's) first asks the person in a native dialog the page cannot answer;
//  - the editor view's size and camera are saved before the agent changes them and put back after its picture (risk R4);
//  - requests go through the Multiplexer, behind the person's own and after the page has settled its pending edits.
// One agent at a time; a wrong secret is refused (constant-time comparison) and too many wrong ones stop the endpoint.
import { createHash, timingSafeEqual } from "node:crypto"
import * as fs from "node:fs"
import * as net from "node:net"
import { agentClassOf, agentLabel, AgentCodes, commandName, isAgentLabel, needsWriteRights, type AgentCommandClass } from "../agent/commands"
import { Commands } from "../protocol/codec"
import { historyStatusOf } from "../protocol/edit-history"
import { FrameReader, FrameTooLargeError } from "../protocol/framing"
import type { EngineClient } from "../protocol/engine-client"
import {
  CommandType,
  ResponseCodecs,
  ResponseType,
  decodeBeginEditGroupRequest,
  decodeHelloRequest,
  decodeNewSceneRequest,
  decodeOpenSceneRequest,
  decodeReadTextAssetRequest,
  decodeSaveSceneToFileRequest,
  decodeSetImportSettingsRequest,
  decodeSetProjectSettingsRequest,
  decodeSetStartupSceneRequest,
  decodeWriteTextAssetRequest,
  encodeErrorCodedResponse,
  encodeFrame,
  type ServerInfoResponse,
  type SetEditorCameraRequest,
} from "../protocol/protocol.generated"
import { MuxError, type Lease, type Multiplexer } from "./agent-mux"

/** What the endpoint needs of the editor's engine connection */
export type AgentEngine = Pick<EngineClient, "send" | "sendRaw" | "isConnected" | "serverInfo">

export interface ConfirmRequest {
  /** One line naming the operation, for the dialog's message */
  message: string
  /** Why it matters */
  detail: string
}

export interface AgentLimits {
  /** The biggest request payload an agent may send (a text asset is at most 100 KB) */
  maxRequestBytes: number
  /** The biggest answer sent back (a 1568 px picture is about 10 MB) */
  maxResponseBytes: number
  /** Requests in any window of rateWindowMs */
  maxRequests: number
  rateWindowMs: number
  /** Requests one connection may have waiting; more ends the connection */
  maxPending: number
  /** Connections that have not said Hello yet */
  maxUnauthenticated: number
  helloTimeoutMs: number
  /** Wrong secrets before the endpoint stops itself */
  maxAuthFailures: number
  /** How long the person has to answer a confirmation (declined after that) */
  confirmTimeoutMs: number
}

export const DefaultAgentLimits: AgentLimits = {
  maxRequestBytes: 1024 * 1024,
  maxResponseBytes: 32 * 1024 * 1024,
  maxRequests: 600,
  rateWindowMs: 10000,
  maxPending: 8,
  maxUnauthenticated: 4,
  helloTimeoutMs: 5000,
  maxAuthFailures: 10,
  confirmTimeoutMs: 120000,
}

/** What Hello may be: tiny */
const MaxHelloBytes = 4096

/** The name the host gives the agent's session in ServerInfo.user */
export const AgentUserName = "AI agent (via the editor)"

export interface AgentEndpointDeps {
  engine: AgentEngine
  mux: Multiplexer
  /** This launch's secret: 64 hex digits */
  secret: string
  /** The named pipe or socket path to listen on */
  listenPath: string
  /** Asks the person (a native dialog); false for no, for closing the dialog and for no answer */
  confirm(request: ConfirmRequest, signal: AbortSignal): Promise<boolean>
  /** The size the person's page last set the viewport to, or null when it has not */
  humanViewport(): { width: number; height: number } | null
  /** An agent attached or detached */
  onConnection?(connected: boolean): void
  /** The agent changed the scene (the page should look again when the lane goes back to the person) */
  onChanged?(): void
  /** Too many wrong secrets: the endpoint has stopped listening */
  onLockout?(): void
  log?(message: string): void
  limits?: Partial<AgentLimits>
}

interface Reply {
  type: number
  payload: Uint8Array
}

interface Conn {
  socket: net.Socket
  reader: FrameReader
  authed: boolean
  pending: number
  chain: Promise<void>
  times: number[]
  helloTimer: ReturnType<typeof setTimeout> | undefined
}

/** A view the agent changed, with what to put back */
interface ViewEpisode {
  camera: SetEditorCameraRequest | null
  size: { width: number; height: number } | null
}

const textOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Text for a dialog: no control characters (nothing a name holds can fake a second line) and a bounded length */
export function dialogText(value: unknown, max = 160): string {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
  return text.length > max ? `${text.slice(0, max)}...` : text
}

/** Whether two strings are equal, in time that does not depend on where they differ */
export function secretMatches(given: string, secret: string): boolean {
  const a = createHash("sha256").update(given, "utf8").digest()
  const b = createHash("sha256").update(secret, "utf8").digest()
  return timingSafeEqual(a, b)
}

export class AgentEndpoint {
  private server: net.Server | null = null
  private readonly connections = new Set<Conn>()
  private active: Conn | null = null
  private authFailures = 0
  /** Edit groups the agent has open (each BeginEditGroup it made that is not yet ended) */
  private depth = 0
  private view: ViewEpisode | null = null
  private readonly limits: AgentLimits
  /** One confirmation at a time */
  private confirming: Promise<unknown> = Promise.resolve()
  private stopped = false
  private readonly confirmAborts = new Set<AbortController>()

  constructor(private readonly deps: AgentEndpointDeps) {
    this.limits = { ...DefaultAgentLimits, ...deps.limits }
  }

  get connected(): boolean {
    return this.active !== null
  }

  get listening(): boolean {
    return this.server?.listening === true
  }

  /** Starts listening. A Unix socket is made readable by its owner only. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.accept(socket))
      server.once("error", reject)
      server.listen(this.deps.listenPath, () => {
        server.off("error", reject)
        server.on("error", (e) => this.deps.log?.(`the agent endpoint failed: ${textOf(e)}`))
        if (process.platform !== "win32") {
          try {
            fs.chmodSync(this.deps.listenPath, 0o600)
          } catch (e) {
            server.close()
            reject(e)
            return
          }
        }
        this.server = server
        resolve()
      })
    })
  }

  /** Disconnects the agent (the endpoint keeps listening) */
  disconnect(): void {
    this.active?.socket.destroy()
  }

  /** Stops listening and drops every connection; the agent's open work is ended first */
  async stop(): Promise<void> {
    this.shutdown()
    await this.deps.mux.close()
    this.deps.mux.open()
  }

  /** The synchronous part of stop(), also for the editor quitting */
  shutdown(): void {
    this.stopped = true
    for (const abort of this.confirmAborts) abort.abort()
    this.server?.close()
    this.server = null
    for (const conn of [...this.connections]) conn.socket.destroy()
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(this.deps.listenPath)
      } catch {
        // already gone
      }
    }
  }

  /** Mux.expire: closes the groups the agent left open and puts the person's view back */
  async endAgentWork(): Promise<void> {
    const { engine } = this.deps
    while (this.depth > 0) {
      this.depth--
      try {
        await engine.send(Commands.EndEditGroup, {})
      } catch (e) {
        this.deps.log?.(`ending an edit group of the agent failed: ${textOf(e)}`)
      }
    }
    await this.restoreView()
  }

  // ---- connections

  private accept(socket: net.Socket): void {
    if (this.stopped) {
      socket.destroy()
      return
    }
    const unauthenticated = [...this.connections].filter((c) => !c.authed).length
    if (unauthenticated >= this.limits.maxUnauthenticated) {
      socket.destroy()
      return
    }
    const conn: Conn = {
      socket,
      reader: new FrameReader(this.limits.maxRequestBytes),
      authed: false,
      pending: 0,
      chain: Promise.resolve(),
      times: [],
      helloTimer: undefined,
    }
    this.connections.add(conn)
    conn.helloTimer = setTimeout(() => {
      if (!conn.authed) socket.destroy()
    }, this.limits.helloTimeoutMs)
    conn.helloTimer.unref?.()
    socket.on("data", (chunk: Buffer) => this.onData(conn, chunk))
    socket.on("error", () => socket.destroy())
    socket.on("close", () => this.onClose(conn))
  }

  private onClose(conn: Conn): void {
    clearTimeout(conn.helloTimer)
    this.connections.delete(conn)
    if (this.active !== conn) return
    this.active = null
    this.deps.log?.("the AI agent disconnected")
    void this.deps.mux.close().finally(() => {
      if (!this.stopped) this.deps.mux.open()
      this.deps.onConnection?.(false)
    })
  }

  private onData(conn: Conn, chunk: Buffer): void {
    let frames
    try {
      frames = conn.reader.push(chunk)
    } catch (e) {
      if (e instanceof FrameTooLargeError) this.deps.log?.("an agent frame was over the size limit; the connection was dropped")
      conn.socket.destroy()
      return
    }
    for (const frame of frames) {
      if (!conn.authed) {
        if (frame.type !== CommandType.Hello) {
          conn.socket.destroy()
          return
        }
        this.hello(conn, frame.payload)
        // Nothing but Hello before it is answered; later frames in the same chunk are handled after it
        continue
      }
      const verdict = this.admit(conn)
      if (verdict === "dropped") return
      conn.pending++
      conn.chain = conn.chain.then(async () => {
        const reply =
          verdict === "limited"
            ? this.refuse(AgentCodes.rateLimited, "The AI agent sent too many requests; slow down")
            : await this.handle(frame.type, frame.payload).catch((e) => this.plainError(textOf(e)))
        conn.pending--
        this.write(conn, reply)
      })
    }
  }

  /** Rate limit and queue bound: "dropped" when the connection was ended for them, "limited" for a refusal in order */
  private admit(conn: Conn): "ok" | "limited" | "dropped" {
    const now = Date.now()
    while (conn.times.length > 0 && now - conn.times[0] >= this.limits.rateWindowMs) conn.times.shift()
    if (conn.pending >= this.limits.maxPending) {
      this.deps.log?.("the AI agent sent too many requests at once; the connection was dropped")
      conn.socket.destroy()
      return "dropped"
    }
    if (conn.times.length >= this.limits.maxRequests) return "limited"
    conn.times.push(now)
    return "ok"
  }

  private write(conn: Conn, reply: Reply): void {
    if (conn.socket.destroyed) return
    let out = reply
    if (reply.payload.length > this.limits.maxResponseBytes) {
      out = this.refuse(AgentCodes.tooLarge, "The answer is larger than the AI agent endpoint allows")
    }
    conn.socket.write(encodeFrame(out.type, out.payload))
  }

  private hello(conn: Conn, payload: Uint8Array): void {
    let token: string
    try {
      if (payload.length > MaxHelloBytes) throw new Error("Hello too large")
      token = decodeHelloRequest(payload).token
    } catch {
      conn.socket.destroy()
      return
    }
    if (!secretMatches(token, this.deps.secret)) {
      this.deps.log?.("a connection to the agent endpoint was refused: wrong secret")
      this.finish(conn, this.plainError("Hello refused"))
      if (++this.authFailures >= this.limits.maxAuthFailures) {
        this.deps.log?.("too many wrong secrets; the agent endpoint has stopped")
        this.shutdown()
        this.deps.onLockout?.()
      }
      return
    }
    const info = this.deps.engine.serverInfo
    if (!this.deps.engine.isConnected || info === null) {
      this.finish(conn, this.plainError("The editor has no connection to its host right now"))
      return
    }
    if (this.active !== null) {
      this.finish(conn, this.refuse("busy", "The editor already has an AI agent attached (an editor session); try again later"))
      return
    }
    this.authFailures = 0
    conn.authed = true
    clearTimeout(conn.helloTimer)
    this.active = conn
    conn.socket.write(encodeFrame(ResponseType.ServerInfo, ResponseCodecs.ServerInfo.encode(this.agentInfo(info))))
    this.deps.log?.("an AI agent attached")
    this.deps.onConnection?.(true)
  }

  /** Answers a refused Hello and closes after it is written */
  private finish(conn: Conn, reply: Reply): void {
    conn.socket.end(encodeFrame(reply.type, reply.payload))
  }

  /** The host's ServerInfo with the agent's role: an editor at most (a viewer stays a viewer), never an admin */
  private agentInfo(info: ServerInfoResponse): ServerInfoResponse {
    return { ...info, role: info.role === "viewer" || !this.hostRoleMayWrite(info) ? "viewer" : "editor", user: AgentUserName }
  }

  /** A host with no role (before protocol 1.12, or no tokens file) lets the token do anything; an unknown role does not */
  private hostRoleMayWrite(info: ServerInfoResponse): boolean {
    return info.role === "" || info.role === "admin" || info.role === "editor"
  }

  private canWrite(info: ServerInfoResponse): boolean {
    return !info.readOnly && this.hostRoleMayWrite(info)
  }

  // ---- replies

  private refuse(code: string, message: string): Reply {
    return { type: ResponseType.ErrorCoded, payload: encodeErrorCodedResponse({ message, code }) }
  }

  private plainError(message: string): Reply {
    return { type: ResponseType.Error, payload: ResponseCodecs.Error.encode({ message }) }
  }

  // ---- requests

  private async handle(type: number, payload: Uint8Array): Promise<Reply> {
    const cls = agentClassOf(type)
    if (cls === undefined) return this.refuse(AgentCodes.notAllowed, `${commandName(type)} is not available to an AI agent`)
    const info = this.deps.engine.serverInfo
    if (!this.deps.engine.isConnected || info === null) return this.plainError("The editor has no connection to its host right now")
    if (needsWriteRights(cls) && !this.canWrite(info)) {
      return this.refuse(AgentCodes.readOnly, info.readOnly ? "The editor is read-only" : "The AI agent's role may not change the project")
    }
    try {
      return await this.dispatch(cls, type, payload)
    } catch (e) {
      if (e instanceof MuxError) return this.refuse(AgentCodes.busy, e.message)
      throw e
    }
  }

  private dispatch(cls: AgentCommandClass, type: number, payload: Uint8Array): Promise<Reply> {
    switch (cls) {
      case "read":
      case "file":
        return this.lane(() => this.forward(type, payload))
      case "view":
        return this.lane((lease) => this.viewCommand(type, payload, lease))
      case "group":
        return type === CommandType.BeginEditGroup ? this.lane((lease) => this.beginGroup(payload, lease)) : this.lane((lease) => this.endGroup(lease))
      case "write":
        return this.lane(() => this.writeCommand(type, payload))
      case "irreversible":
        return this.irreversible(type, payload)
      case "history":
        return this.history(type, payload)
    }
  }

  private lane<T>(job: (lease: Lease) => Promise<T>): Promise<T> {
    return this.deps.mux.agent(job)
  }

  /** Sends the command to the host as it is and answers with the host's frame */
  private async forward(type: number, payload: Uint8Array): Promise<Reply> {
    const frame = await this.deps.engine.sendRaw(type, payload)
    return { type: frame.type, payload: frame.payload }
  }

  private isOk(reply: Reply): boolean {
    return reply.type !== ResponseType.Error && reply.type !== ResponseType.ErrorCoded
  }

  private async beginGroup(payload: Uint8Array, lease: Lease): Promise<Reply> {
    let label: string
    try {
      label = decodeBeginEditGroupRequest(payload).label
    } catch {
      return this.plainError("BeginEditGroup: bad request")
    }
    const reply = await this.forward(CommandType.BeginEditGroup, Commands.BeginEditGroup.encode({ label: agentLabel(label) }))
    if (this.isOk(reply)) {
      this.depth++
      lease.hold()
      this.deps.onChanged?.()
    }
    return reply
  }

  private async endGroup(lease: Lease): Promise<Reply> {
    if (this.depth === 0) return this.refuse(AgentCodes.noGroup, "The AI agent has no edit group open")
    const reply = await this.forward(CommandType.EndEditGroup, new Uint8Array(0))
    if (this.isOk(reply)) {
      this.depth--
      if (this.depth === 0 && this.view === null) lease.release()
    }
    return reply
  }

  /** A scene change: inside the agent's group when it has one, else inside one made just for this command */
  private async writeCommand(type: number, payload: Uint8Array): Promise<Reply> {
    this.deps.onChanged?.()
    if (this.depth > 0) return this.forward(type, payload)
    const begun = await this.forward(CommandType.BeginEditGroup, Commands.BeginEditGroup.encode({ label: agentLabel(commandName(type)) }))
    if (!this.isOk(begun)) return begun
    try {
      return await this.forward(type, payload)
    } finally {
      await this.forward(CommandType.EndEditGroup, new Uint8Array(0)).catch((e) => this.deps.log?.(`ending an edit group failed: ${textOf(e)}`))
    }
  }

  // ---- the person's view (risk R4)

  /**
   * SetViewportSize, SetEditorCamera and the renders they are for. The first change of a view saves the camera and the
   * person's viewport size and holds the lane, so the person's own requests cannot interleave with the agent's picture; a
   * render ends the episode (or the lease going idle, or the agent leaving, does) and puts both back.
   */
  private async viewCommand(type: number, payload: Uint8Array, lease: Lease): Promise<Reply> {
    const changesView = type === CommandType.SetViewportSize || type === CommandType.SetEditorCamera
    if (changesView && this.view === null) {
      let camera: SetEditorCameraRequest | null = null
      try {
        const c = await this.deps.engine.send(Commands.GetEditorCamera, {})
        camera = {
          position: c.position,
          rotation: c.rotation,
          fovY: c.fovY,
          orthographic: c.orthographic,
          orthoSize: c.orthoSize,
          nearPlane: c.nearPlane,
          farPlane: c.farPlane,
        }
      } catch (e) {
        this.deps.log?.(`reading the editor camera failed: ${textOf(e)}`)
      }
      this.view = { camera, size: this.deps.humanViewport() }
      lease.hold()
    }
    const reply = await this.forward(type, payload)
    const renders = type === CommandType.RenderFrame || type === CommandType.RenderFrameIfChanged
    if (renders && this.view !== null) {
      await this.restoreView()
      if (this.depth === 0) lease.release()
    }
    return reply
  }

  private async restoreView(): Promise<void> {
    const view = this.view
    if (view === null) return
    this.view = null
    const { engine } = this.deps
    if (view.size) {
      await engine.send(Commands.SetViewportSize, view.size).catch((e) => this.deps.log?.(`restoring the viewport size failed: ${textOf(e)}`))
    }
    if (view.camera) {
      await engine.send(Commands.SetEditorCamera, view.camera).catch((e) => this.deps.log?.(`restoring the editor camera failed: ${textOf(e)}`))
    }
  }

  // ---- the irreversible tier

  private async irreversible(type: number, payload: Uint8Array): Promise<Reply> {
    let operation: ConfirmRequest | null
    try {
      operation = await this.describe(type, payload)
    } catch {
      return this.plainError(`${commandName(type)}: bad request`)
    }
    if (operation !== null && !(await this.ask(operation))) {
      return this.refuse(AgentCodes.declined, "The person declined this operation in the editor")
    }
    return this.lane(async () => {
      this.deps.onChanged?.()
      return this.forward(type, payload)
    })
  }

  /** What to ask the person, or null when the command is not irreversible after all (a text file that is new) */
  private async describe(type: number, payload: Uint8Array): Promise<ConfirmRequest | null> {
    const detail = "The editor's Undo cannot take this back."
    switch (type) {
      case CommandType.SaveSceneToFile: {
        const { path } = decodeSaveSceneToFileRequest(payload)
        return { message: path === "" ? "Save the open scene over its file" : `Save the open scene to ${dialogText(path)}`, detail: `${detail} The file on disk is replaced.` }
      }
      case CommandType.OpenScene: {
        const { path } = decodeOpenSceneRequest(payload)
        return { message: `Open the scene ${dialogText(path)}`, detail: "Unsaved changes in the open scene are lost, and the undo history is cleared." }
      }
      case CommandType.NewScene: {
        const { path, name } = decodeNewSceneRequest(payload)
        return { message: `Make a new empty scene${name ? ` "${dialogText(name, 60)}"` : ""}${path ? ` in ${dialogText(path)}` : ""}`, detail: "Unsaved changes in the open scene are lost, and the undo history is cleared." }
      }
      case CommandType.SetProjectSettings: {
        const { settings } = decodeSetProjectSettingsRequest(payload)
        const keys = settings !== null && typeof settings === "object" ? Object.keys(settings).slice(0, 8).map((k) => dialogText(k, 40)).join(", ") : ""
        return { message: `Change the project's settings${keys ? ` (${keys})` : ""}`, detail }
      }
      case CommandType.SetStartupScene: {
        const { path } = decodeSetStartupSceneRequest(payload)
        return { message: `Set the project's startup scene to ${dialogText(path)}`, detail }
      }
      case CommandType.SetImportSettings: {
        const { path } = decodeSetImportSettingsRequest(payload)
        return { message: `Replace the import settings of ${dialogText(path)}`, detail }
      }
      case CommandType.WriteTextAsset: {
        const { path } = decodeWriteTextAssetRequest(payload)
        if (!(await this.fileExists(path))) return null
        return { message: `Overwrite the file ${dialogText(path)}`, detail: `${detail} Its previous text is kept only in the agent's own journal.` }
      }
      case CommandType.RestoreAutosave:
        return { message: "Replace the open scene with its autosave", detail: "Changes made since the autosave was written are lost." }
      case CommandType.DiscardAutosave:
        return { message: "Delete the open scene's autosave", detail }
      default:
        return { message: commandName(type), detail }
    }
  }

  /** Whether a text file exists: asked of the host in the lane. A failure that does not say "not found" counts as existing. */
  private async fileExists(path: string): Promise<boolean> {
    return this.lane(async () => {
      const frame = await this.deps.engine.sendRaw(CommandType.ReadTextAsset, Commands.ReadTextAsset.encode({ path }))
      if (frame.type !== ResponseType.Error && frame.type !== ResponseType.ErrorCoded) return true
      const message = frame.type === ResponseType.Error ? ResponseCodecs.Error.decode(frame.payload).message : ""
      return !/not found|does not exist|no such|missing/i.test(message)
    })
  }

  /** Undo and Redo: the agent's own steps run; a step that is the person's is confirmed first */
  private async history(type: number, payload: Uint8Array): Promise<Reply> {
    const redo = type === CommandType.Redo
    const first = await this.lane(() => this.nextStepLabel(redo))
    const mine = first === "" || isAgentLabel(first)
    if (!mine) {
      const ok = await this.ask({
        message: `${redo ? "Redo" : "Undo"} the step "${dialogText(first, 80)}", which is not the AI agent's own`,
        detail: "It is a step of yours (or of another client).",
      })
      if (!ok) return this.refuse(AgentCodes.declined, "The person declined this operation in the editor")
    }
    return this.lane(async () => {
      // The person may have edited since the question: a step that was not asked about is not undone
      const now = await this.nextStepLabel(redo)
      if (now !== first && !(now === "" || isAgentLabel(now))) {
        return this.refuse(AgentCodes.busy, "The history changed while the person was asked; call again")
      }
      this.deps.onChanged?.()
      return this.forward(type, payload)
    })
  }

  private async nextStepLabel(redo: boolean): Promise<string> {
    const status = historyStatusOf(await this.deps.engine.send(Commands.GetHistory, {}))
    return redo ? status.redoLabel : status.label
  }

  private ask(request: ConfirmRequest): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      if (this.stopped) return false
      const abort = new AbortController()
      this.confirmAborts.add(abort)
      const timer = setTimeout(() => abort.abort(), this.limits.confirmTimeoutMs)
      timer.unref?.()
      try {
        return await this.deps.confirm(request, abort.signal)
      } catch {
        return false
      } finally {
        clearTimeout(timer)
        this.confirmAborts.delete(abort)
      }
    }
    const result = this.confirming.then(run, run)
    this.confirming = result.catch(() => undefined)
    return result
  }
}
