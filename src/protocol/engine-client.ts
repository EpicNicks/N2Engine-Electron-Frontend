import * as net from "net"
import {
  CameraPositionResponse,
  EngineHealthResponse,
  EntityInfo,
  FrameDataResponse,
  ResponseType,
  SceneDataResponse,
  Vec3,
} from "./protocol.generated"
import { CommandSpec, Commands, decodeError } from "./codec"
import { Frame, FrameReader, encodeFrame } from "./framing"
import { AudioSamples } from "../audio-stream"

/** Type ids 0xC0-0xFE are reserved for frames the server sends unprompted (events), never responses */
export const FirstEventType = 0xc0
export const LastEventType = 0xfe

export function isEventType(type: number): boolean {
  return type >= FirstEventType && type <= LastEventType
}

/** The engine refuses requests with a larger payload (EditorServer::MaxPayloadBytes) */
export const MaxRequestPayloadBytes = 64 * 1024 * 1024

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
 */
export class EngineClient {
  private socket: net.Socket | null = null
  private reader = new FrameReader()
  private requestQueue: PendingRequest[] = []
  private eventListener: ((frame: Frame) => void) | null = null
  private closeListeners: Array<() => void> = []
  /** The connect() whose socket hasn't connected yet: it must settle however the socket ends */
  private pendingConnect: { socket: net.Socket; reject: (error: Error) => void } | null = null

  constructor(
    private createSocket: SocketFactory = (options, onConnect) => net.connect(options, onConnect)
  ) {}

  get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }

  /** Server-push frames (type 0xC0-0xFE). Polling (EventPump) is what the server does today; this is for later. */
  onEvent(listener: ((frame: Frame) => void) | null): void {
    this.eventListener = listener
  }

  /** Called whenever the current connection ends: closed by the server, an error, disconnect or close */
  onClose(listener: () => void): void {
    this.closeListeners.push(listener)
  }

  connect(host: string = "localhost", port: number = 9999): Promise<void> {
    // Nothing from a previous connection (a partial response, requests it never answered) may leak into this one
    this.closeSocket(new Error("Reconnected"))

    return new Promise((resolve, reject) => {
      const socket = this.createSocket({ host, port }, () => {
        if (this.pendingConnect?.socket === socket) this.pendingConnect = null
        resolve()
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
   * Sends a frame and resolves with the next response frame (FIFO). Payloads over MaxRequestPayloadBytes are
   * refused here, since the engine would drop the connection.
   */
  sendRaw(type: number, payload: Uint8Array): Promise<Frame> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error("Not connected"))
        return
      }
      if (payload.length > MaxRequestPayloadBytes) {
        reject(new Error(`Request payload too large (${payload.length} bytes, the limit is ${MaxRequestPayloadBytes})`))
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

  // ==================== Engine Health ====================

  /** Per-subsystem status (window, renderer, audio, ...); healthy is false when any of them failed */
  getEngineHealth(): Promise<EngineHealthResponse> {
    return this.send(Commands.GetEngineHealth, {})
  }

  // ==================== Internals ====================

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
