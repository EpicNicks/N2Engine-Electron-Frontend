import * as net from "net"
import {
  CameraPositionResponse,
  CommandType,
  EngineHealthResponse,
  EntityInfo,
  EventsResponse,
  FrameDataResponse,
  PROTOCOL_VERSION,
  ResponseType,
  SceneDataResponse,
  ServerInfoResponse,
  Vec3,
  encodeFrame,
  isProtocolCompatible,
  parseProtocolVersion,
} from "./protocol.generated"
import { CommandSpec, Commands, decodeError } from "./codec"
import { Frame, FrameReader } from "./framing"
import { AudioSamples } from "../audio-stream"

/** Type ids 0xC0-0xFE are reserved for frames the server sends unprompted (events), never responses */
export const FirstEventType = 0xc0
export const LastEventType = 0xfe

export function isEventType(type: number): boolean {
  return type >= FirstEventType && type <= LastEventType
}

/** The engine refuses requests with a larger payload (EditorServer::MaxPayloadBytes) */
export const MaxRequestPayloadBytes = 64 * 1024 * 1024

/**
 * Until a Hello succeeds, a host with an access token refuses a larger payload and closes the connection
 * (EditorServer::MaxPayloadBytesBeforeHello)
 */
export const MaxPayloadBytesBeforeHello = 64 * 1024

/**
 * How long connect() waits for Hello's answer, from when the socket connects (Hello is sent then). A host with an
 * access token closes a connection that hasn't completed a Hello within 5 s, but its clock starts at accept(),
 * which can come well after the connection was made (the host serves one connection at a time, and accepts the next
 * only when it's done). So the host's limit, plus a margin for a slow or busy host; one that never answers still
 * fails the connect.
 */
export const HelloTimeoutMilliseconds = 10000

/** The clientName sent in Hello (the host logs it) */
export const DefaultClientName = "N2Engine Electron editor"

export interface ConnectOptions {
  /** The host's access token; empty (the default) for a host started without one */
  token?: string
  clientName?: string
}

/** connect()'s Hello failed: the host refused it (wrong token, incompatible version), or never answered */
export class HelloError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HelloError"
  }
}

/** After Shutdown is written, how long to wait for the reply (or the server closing) before dropping the socket */
export const ShutdownGraceMilliseconds = 1000

interface PendingRequest {
  resolve: (frame: Frame) => void
  reject: (error: Error) => void
}

/** Opens the connection; a parameter so tests can substitute a fake socket */
export type SocketFactory = (options: net.NetConnectOpts, onConnect: () => void) => net.Socket

/** The message of an Error response, kept apart from local failures (not connected, connection closed) */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly command: string
  ) {
    super(message)
    this.name = "EngineError"
  }
}

/**
 * The editor protocol client: one TCP connection, requests answered in order. The server handles one request at
 * a time and replies in the order they arrived, so responses are matched to requests first in, first out. Frames
 * with an event type id (0xC0+) are not responses and go to the onEvent listener instead.
 *
 * Each connection opens a session with Hello (protocol 1.1) before anything else: connect() resolves with the
 * host's ServerInfo once Hello succeeds, and until then no other request is sent.
 */
export class EngineClient {
  private socket: net.Socket | null = null
  private reader = new FrameReader()
  private requestQueue: PendingRequest[] = []
  private eventListener: ((frame: Frame) => void) | null = null
  private closeListeners: Array<() => void> = []
  /** The connect() whose socket hasn't connected yet: it must settle however the socket ends */
  private pendingConnect: { socket: net.Socket; reject: (error: Error) => void } | null = null
  /** The current connection's answer to Hello; null until its Hello succeeds */
  private session: ServerInfoResponse | null = null

  constructor(
    private createSocket: SocketFactory = (options, onConnect) => net.connect(options, onConnect)
  ) {}

  /** Whether there is a connection whose Hello succeeded */
  get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.session !== null
  }

  /** The host's answer to this connection's Hello; null when not connected */
  get serverInfo(): ServerInfoResponse | null {
    return this.isConnected ? this.session : null
  }

  /** Server-push frames (type 0xC0-0xFE). Polling (EventPump) is what the server does today; this is for later. */
  onEvent(listener: ((frame: Frame) => void) | null): void {
    this.eventListener = listener
  }

  /** Called whenever the current connection ends: closed by the server, an error, disconnect or close */
  onClose(listener: () => void): void {
    this.closeListeners.push(listener)
  }

  /**
   * Connects and says Hello, with options.token when the host has an access token. Resolves with the host's
   * ServerInfo. Rejects, and closes the connection, when the socket fails or Hello does: a HelloError when the host
   * refused it (a wrong token, an incompatible protocol version) or didn't answer within HelloTimeoutMilliseconds.
   */
  async connect(
    host: string = "localhost",
    port: number = 9999,
    options: ConnectOptions = {}
  ): Promise<ServerInfoResponse> {
    const socket = await this.open(host, port)
    try {
      return await this.hello(socket, options)
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      // A host with an access token closes the connection after a failed Hello itself; one without would keep it
      // open, but the editor treats every failed Hello alike
      if (this.socket === socket) this.closeSocket(error)
      throw error
    }
  }

  /** Opens a socket, replacing any current one; resolves once it has connected */
  private open(host: string, port: number): Promise<net.Socket> {
    // Nothing from a previous connection (a partial response, requests it never answered) may leak into this one
    this.closeSocket(new Error("Reconnected"))

    return new Promise((resolve, reject) => {
      const socket = this.createSocket({ host, port }, () => {
        if (this.pendingConnect?.socket === socket) this.pendingConnect = null
        resolve(socket)
      })
      this.socket = socket
      this.pendingConnect = { socket, reject }

      // Each handler only acts while its socket is the current one: an old socket's events can arrive after a reconnect
      socket.on("data", (chunk: Buffer) => {
        if (this.socket !== socket) return
        this.onData(chunk)
      })

      socket.on("error", (err: Error) => {
        if (this.socket === socket) {
          this.rejectPending(err)
        }
        this.failConnect(socket, err)
      })

      socket.on("close", () => {
        // Before the early return: a socket closed before it connected must still settle its connect()
        this.failConnect(socket, new Error("Connection closed before it opened"))
        if (this.socket !== socket) return
        this.socket = null
        this.session = null
        this.reader.reset()
        this.rejectPending(new Error("Connection closed"))
        this.emitClose()
      })
    })
  }

  /**
   * Asks the server to shut down and closes the connection. The connection is over for this client at once
   * (pending requests are rejected), but the socket is only ended, so the Shutdown request is still delivered; it
   * is destroyed on the reply, or after ShutdownGraceMilliseconds.
   */
  disconnect(): void {
    const socket = this.socket
    if (!socket) return
    if (this.session === null) {
      // Still saying Hello: a host with an access token would refuse Shutdown (and one without a token wasn't asked
      // for anything yet), so just close
      this.close()
      return
    }
    this.detach(new Error("Disconnected"))

    const timer = setTimeout(() => socket.destroy(), ShutdownGraceMilliseconds)
    timer.unref?.()
    socket.once("close", () => clearTimeout(timer))
    socket.on("data", () => socket.destroy()) // the reply
    try {
      socket.write(encodeFrame(Commands.Shutdown.command, Commands.Shutdown.encode({})))
      socket.end()
    } catch {
      socket.destroy()
    }
  }

  /** Closes the connection without asking the server to shut down */
  close(): void {
    this.closeSocket(new Error("Disconnected"))
  }

  /**
   * Sends one command and decodes its response. An Error response rejects with an EngineError carrying the
   * server's message; any other unexpected type rejects with a mismatch error.
   */
  async send<Request, Response>(spec: CommandSpec<Request, Response>, request: Request): Promise<Response> {
    const frame = await this.sendRaw(spec.command, spec.encode(request))
    if (frame.type === ResponseType.Error) {
      const message = decodeError(frame.payload)
      throw new EngineError(message || `${spec.name} failed`, spec.name)
    }
    if (frame.type !== spec.response) {
      throw new Error(`${spec.name}: expected response type ${spec.response}, got ${frame.type}`)
    }
    return spec.decode(frame.payload)
  }

  /**
   * Sends a frame and resolves with the next response frame (FIFO). Until the connection's Hello has succeeded,
   * only Hello itself is sent. Payloads over MaxRequestPayloadBytes (MaxPayloadBytesBeforeHello before Hello) are
   * refused here, since the engine would drop the connection.
   */
  sendRaw(type: number, payload: Uint8Array): Promise<Frame> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error("Not connected"))
        return
      }
      const beforeHello = this.session === null
      if (beforeHello && type !== CommandType.Hello) {
        reject(new Error("Not connected (the connection's Hello hasn't completed)"))
        return
      }
      const limit = beforeHello ? MaxPayloadBytesBeforeHello : MaxRequestPayloadBytes
      if (payload.length > limit) {
        reject(new Error(`Request payload too large (${payload.length} bytes, the limit is ${limit})`))
        return
      }
      // Encode first: the request joins the queue only once its frame exists, so a throw can't desync the FIFO
      const frame = encodeFrame(type, payload)
      this.requestQueue.push({ resolve, reject })
      this.socket.write(frame)
    })
  }

  // ==================== Rendering ====================

  renderFrame(): Promise<FrameDataResponse> {
    return this.send(Commands.RenderFrame, {})
  }

  setViewportSize(width: number, height: number): Promise<void> {
    return this.send(Commands.SetViewportSize, { width, height })
  }

  // ==================== Audio ====================

  /**
   * Everything the server mixed since the previous GetAudio (at most 250 ms of it), with the samples converted to
   * float32. Null when the server has no audio stream (audio isn't running on a loopback device, see GetEngineHealth).
   */
  async getAudio(): Promise<AudioSamples | null> {
    try {
      return await this.send(Commands.GetAudio, {})
    } catch (e) {
      if (e instanceof EngineError && e.message.startsWith("No audio stream")) {
        return null
      }
      throw e
    }
  }

  // ==================== Camera ====================

  setCameraPosition(x: number, y: number, z: number): Promise<void> {
    return this.send(Commands.SetCameraPosition, { x, y, z })
  }

  getCameraPosition(): Promise<CameraPositionResponse> {
    return this.send(Commands.GetCameraPosition, {})
  }

  // ==================== Scene Management ====================

  /** Creates a new empty scene in the engine */
  createScene(name: string): Promise<SceneDataResponse> {
    return this.send(Commands.CreateScene, { name })
  }

  /** Loads a scene from JSON (the client reads the file and sends its contents) */
  loadScene(sceneJson: string): Promise<void> {
    return this.send(Commands.LoadScene, { sceneJson })
  }

  /** The current scene as JSON (the client writes it to a file) */
  saveScene(): Promise<SceneDataResponse> {
    return this.send(Commands.SaveScene, {})
  }

  /** Deletes a scene from the engine's scene list by name */
  deleteScene(sceneName: string): Promise<void> {
    return this.send(Commands.DeleteScene, { sceneName })
  }

  /** The currently loaded scene, or null when none is */
  async getCurrentScene(): Promise<SceneDataResponse | null> {
    try {
      return await this.send(Commands.GetCurrentScene, {})
    } catch (e) {
      if (e instanceof EngineError) return null // no scene loaded
      throw e
    }
  }

  // ==================== Entity Management ====================

  async createEntity(name: string): Promise<string> {
    return (await this.send(Commands.CreateEntity, { name })).entityId
  }

  destroyEntity(entityId: string): Promise<void> {
    return this.send(Commands.DestroyEntity, { entityId })
  }

  async getAllEntities(): Promise<EntityInfo[]> {
    return (await this.send(Commands.GetAllEntities, {})).entities
  }

  setEntityTransform(entityId: string, position: Vec3, rotation: Vec3, scale: Vec3): Promise<void> {
    return this.send(Commands.SetEntityTransform, { entityId, position, rotation, scale })
  }

  getEntityTransform(entityId: string): Promise<{ position: Vec3; rotation: Vec3; scale: Vec3 }> {
    return this.send(Commands.GetEntityTransform, { entityId })
  }

  // ==================== Assets ====================

  async createScript(name: string): Promise<string> {
    return (await this.send(Commands.CreateScript, { name })).scriptTemplate
  }

  rescanAssets(): Promise<void> {
    return this.send(Commands.RescanAssets, {})
  }

  // ==================== Events ====================

  /**
   * The host's events (its log lines, for now) after afterSeq in epoch: see EventPump for the epoch rule. Pass 0, 0
   * for everything the host still keeps; maxEvents 0 skips to the newest seq.
   */
  pollEvents(epoch: number, afterSeq: number, maxEvents: number): Promise<EventsResponse> {
    return this.send(Commands.PollEvents, { epoch, afterSeq, maxEvents })
  }

  // ==================== Engine Health ====================

  /** Per-subsystem status (window, renderer, audio, ...); healthy is false when any of them failed */
  getEngineHealth(): Promise<EngineHealthResponse> {
    return this.send(Commands.GetEngineHealth, {})
  }

  // ==================== Internals ====================

  /** Says Hello on the socket that just connected, and opens the session when the host accepts it */
  private async hello(socket: net.Socket, options: ConnectOptions): Promise<ServerInfoResponse> {
    const request = {
      clientName: options.clientName ?? DefaultClientName,
      protocolVersion: PROTOCOL_VERSION,
      token: options.token ?? "",
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new HelloError(`The editor host didn't answer Hello within ${HelloTimeoutMilliseconds} ms`)),
        HelloTimeoutMilliseconds
      )
    })
    let info: ServerInfoResponse
    try {
      info = await Promise.race([this.send(Commands.Hello, request), timeout])
    } catch (e) {
      if (e instanceof EngineError) throw new HelloError(`The editor host refused Hello: ${e.message}`)
      throw e
    } finally {
      clearTimeout(timer)
    }

    if (!isProtocolCompatible(info.protocolVersion)) {
      throw new HelloError(
        `The editor host speaks protocol ${info.protocolVersion}, this editor ${PROTOCOL_VERSION} ` +
          "(the major versions must match)"
      )
    }
    if (parseProtocolVersion(info.protocolVersion)?.minor !== parseProtocolVersion(PROTOCOL_VERSION)?.minor) {
      console.warn(
        `The editor host speaks protocol ${info.protocolVersion}, this editor ${PROTOCOL_VERSION}: ` +
          "commands only one of them knows will fail"
      )
    }
    // A reconnect or close while waiting rejects the Hello request, but one can come between its answer and here
    if (this.socket !== socket) throw new Error("Connection closed")
    this.session = info
    return info
  }

  private onData(chunk: Buffer): void {
    let frames: Frame[]
    try {
      frames = this.reader.push(chunk)
    } catch (e) {
      // A corrupt stream can't be resynchronised
      console.error("Closing the engine connection:", e)
      this.closeSocket(e instanceof Error ? e : new Error(String(e)))
      return
    }

    for (const frame of frames) {
      if (isEventType(frame.type)) {
        this.eventListener?.(frame)
        continue
      }
      const pending = this.requestQueue.shift()
      if (pending) {
        pending.resolve(frame)
      } else {
        console.warn("Received a response with no pending request:", frame.type)
      }
    }
  }

  /** Destroys the current socket (if any), drops any partial response and rejects every pending request */
  private closeSocket(error: Error): void {
    const socket = this.detach(error)
    socket?.destroy()
  }

  /**
   * Ends the current connection for this client without touching the socket: the socket stops being current, a
   * connect() still waiting on it and every pending request are rejected, and close listeners are told
   */
  private detach(error: Error): net.Socket | null {
    const socket = this.socket
    this.socket = null
    this.session = null
    this.reader.reset()
    if (socket) this.failConnect(socket, error)
    this.rejectPending(error)
    if (socket) {
      this.emitClose()
    }
    return socket
  }

  /** Rejects the connect() waiting on socket, if any */
  private failConnect(socket: net.Socket, error: Error): void {
    if (this.pendingConnect?.socket !== socket) return
    const { reject } = this.pendingConnect
    this.pendingConnect = null
    reject(error)
  }

  private rejectPending(error: Error): void {
    const pending = this.requestQueue
    this.requestQueue = []
    pending.forEach((req) => req.reject(error))
  }

  private emitClose(): void {
    this.closeListeners.forEach((listener) => {
      try {
        listener()
      } catch (e) {
        console.error("Engine close listener failed:", e)
      }
    })
  }
}
