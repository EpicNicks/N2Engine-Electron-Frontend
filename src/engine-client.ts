import * as net from "net"
import {
  CommandType,
  ResponseType,
  FrameDataResponse,
  CameraPositionResponse,
  SceneDataResponse,
  EngineHealthResponse,
  SubsystemStatus,
} from "./protocol.generated"
import { readString, writeString } from "./serialization"
import { AudioSamples, decodeAudioSamples } from "./audio-stream"

interface PendingRequest {
  resolve: (data: Buffer) => void
  reject: (error: Error) => void
}

/** Opens the connection; a parameter so tests can substitute a fake socket */
export type SocketFactory = (options: net.NetConnectOpts, onConnect: () => void) => net.Socket

export class EngineClient {
  private socket: net.Socket | null = null
  private buffer: Buffer = Buffer.alloc(0)
  private requestQueue: PendingRequest[] = []

  constructor(
    private createSocket: SocketFactory = (options, onConnect) => net.connect(options, onConnect)
  ) {}

  get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }

  connect(host: string = "localhost", port: number = 9999): Promise<void> {
    // Nothing from a previous connection (a partial response, requests it never answered) may leak into this one
    this.closeSocket(new Error("Reconnected"))

    return new Promise((resolve, reject) => {
      const socket = this.createSocket({ host, port }, () => {
        resolve()
      })
      this.socket = socket

      // Each handler only acts while its socket is the current one: an old socket's events can arrive after a reconnect
      socket.on("data", (chunk: Buffer) => {
        if (this.socket !== socket) return
        this.buffer = Buffer.concat([this.buffer, chunk])
        this.processBuffer()
      })

      socket.on("error", (err: Error) => {
        if (this.socket === socket) {
          this.rejectPending(err)
        }
        reject(err)
      })

      socket.on("close", () => {
        if (this.socket !== socket) return
        this.socket = null
        this.buffer = Buffer.alloc(0)
        this.rejectPending(new Error("Connection closed"))
      })
    })
  }

  disconnect(): void {
    if (this.socket) {
      this.sendCommandRaw(CommandType.Shutdown, Buffer.alloc(0)).catch(() => {})
      this.closeSocket(new Error("Disconnected"))
    }
  }

  /** Destroys the current socket (if any), drops any partial response and rejects every pending request */
  private closeSocket(error: Error): void {
    const socket = this.socket
    this.socket = null
    this.buffer = Buffer.alloc(0)
    if (socket) {
      socket.destroy()
    }
    this.rejectPending(error)
  }

  private rejectPending(error: Error): void {
    while (this.requestQueue.length > 0) {
      const req = this.requestQueue.shift()!
      req.reject(error)
    }
  }

  private processBuffer(): void {
    while (true) {
      if (this.buffer.length < 5) return

      const payloadLength = this.buffer.readUInt32LE(1)
      const totalLength = 1 + 4 + payloadLength

      if (this.buffer.length < totalLength) return

      const response = Buffer.from(this.buffer.subarray(0, totalLength))
      this.buffer = Buffer.from(this.buffer.subarray(totalLength))

      const pendingRequest = this.requestQueue.shift()
      if (pendingRequest) {
        pendingRequest.resolve(response)
      } else {
        console.warn("Received response with no pending request:", response.readUInt8(0))
      }
    }
  }

  private sendCommandRaw(type: CommandType, payload: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error("Not connected"))
        return
      }

      const header = Buffer.alloc(5)
      header.writeUInt8(type, 0)
      header.writeUInt32LE(payload.length, 1)

      this.requestQueue.push({ resolve, reject })
      this.socket.write(Buffer.concat([header, payload]))
    })
  }

  /**
   * Throws the server's message for an Error response (e.g. RenderFrame without a renderer), or a mismatch error
   * for any type other than the expected one
   */
  private expectResponse(response: Buffer, expected: ResponseType, name: string): void {
    const type = response.readUInt8(0)
    if (type === ResponseType.Error) {
      const message = response.subarray(5).toString("utf-8")
      throw new Error(message || `Expected ${name}, got Error`)
    }
    if (type !== expected) {
      throw new Error(`Expected ${name}, got ${type}`)
    }
  }

  private expectOk(response: Buffer): void {
    const type = response.readUInt8(0)
    if (type === ResponseType.Error) {
      const message = response.subarray(5).toString("utf-8")
      throw new Error(message || "Unknown error")
    }
    if (type !== ResponseType.Ok) {
      throw new Error(`Expected Ok, got ${type}`)
    }
  }

  // ==================== Rendering ====================

  async renderFrame(): Promise<FrameDataResponse> {
    const response = await this.sendCommandRaw(CommandType.RenderFrame, Buffer.alloc(0))

    this.expectResponse(response, ResponseType.FrameData, "FrameData")

    const width = response.readUInt32LE(5)
    const height = response.readUInt32LE(9)
    const pixels = new Uint8Array(response.subarray(13))

    return { width, height, pixels }
  }

  async setViewportSize(width: number, height: number): Promise<void> {
    const payload = Buffer.alloc(8)
    payload.writeInt32LE(width, 0)
    payload.writeInt32LE(height, 4)

    const response = await this.sendCommandRaw(CommandType.SetViewportSize, payload)
    this.expectOk(response)
  }

  // ==================== Audio ====================

  /**
   * Everything the server mixed since the previous GetAudio (at most 250 ms of it), with the samples converted to
   * float32. Null when the server has no audio stream (audio isn't running on a loopback device, see GetEngineHealth).
   */
  async getAudio(): Promise<AudioSamples | null> {
    const response = await this.sendCommandRaw(CommandType.GetAudio, Buffer.alloc(0))

    const type = response.readUInt8(0)
    if (type === ResponseType.Error) {
      const message = response.subarray(5).toString("utf-8")
      if (message.startsWith("No audio stream")) {
        return null
      }
      throw new Error(message || "Failed to get audio")
    }
    if (type !== ResponseType.AudioSamples) {
      throw new Error(`Expected AudioSamples, got ${type}`)
    }

    return decodeAudioSamples(response.subarray(5))
  }

  // ==================== Camera ====================

  async setCameraPosition(x: number, y: number, z: number): Promise<void> {
    const payload = Buffer.alloc(12)
    payload.writeFloatLE(x, 0)
    payload.writeFloatLE(y, 4)
    payload.writeFloatLE(z, 8)

    const response = await this.sendCommandRaw(CommandType.SetCameraPosition, payload)
    this.expectOk(response)
  }

  async getCameraPosition(): Promise<CameraPositionResponse> {
    const response = await this.sendCommandRaw(CommandType.GetCameraPosition, Buffer.alloc(0))

    this.expectResponse(response, ResponseType.CameraPosition, "CameraPosition")

    return {
      x: response.readFloatLE(5),
      y: response.readFloatLE(9),
      z: response.readFloatLE(13),
    }
  }

  // ==================== Scene Management ====================

  /**
   * Create a new empty scene in the engine
   */
  async createScene(name: string): Promise<SceneDataResponse> {
    const nameBytes = Buffer.from(name, "utf-8")
    const payload = Buffer.alloc(4 + nameBytes.length)
    payload.writeUInt32LE(nameBytes.length, 0)
    nameBytes.copy(payload, 4)

    const response = await this.sendCommandRaw(CommandType.CreateScene, payload)

    const type = response.readUInt8(0)
    if (type === ResponseType.Error) {
      const message = response.subarray(5).toString("utf-8")
      throw new Error(message || "Failed to create scene")
    }
    if (type !== ResponseType.SceneData) {
      // ← Changed from SceneInfo
      throw new Error(`Expected SceneData, got ${type}`)
    }

    const jsonRes = readString(response, 5)
    return { sceneJson: jsonRes.value }
  }

  /**
   * Load scene from JSON data (client reads file, sends JSON to engine)
   */
  async loadScene(sceneJson: string): Promise<void> {
    const jsonBytes = Buffer.from(sceneJson, "utf-8")
    const payload = Buffer.alloc(4 + jsonBytes.length)
    payload.writeUInt32LE(jsonBytes.length, 0)
    jsonBytes.copy(payload, 4)

    const response = await this.sendCommandRaw(CommandType.LoadScene, payload)
    this.expectOk(response)
  }

  /**
   * Save current scene - engine returns JSON data (client writes to file)
   */
  async saveScene(): Promise<SceneDataResponse> {
    const response = await this.sendCommandRaw(CommandType.SaveScene, Buffer.alloc(0))

    const type = response.readUInt8(0)
    if (type === ResponseType.Error) {
      const message = response.subarray(5).toString("utf-8")
      throw new Error(message || "Failed to save scene")
    }
    if (type !== ResponseType.SceneData) {
      throw new Error(`Expected SceneData, got ${type}`)
    }

    const jsonRes = readString(response, 5)
    return { sceneJson: jsonRes.value }
  }

  /**
   * Delete scene from engine's scene list by name
   */
  async deleteScene(sceneName: string): Promise<void> {
    const nameBytes = Buffer.from(sceneName, "utf-8")
    const payload = Buffer.alloc(4 + nameBytes.length)
    payload.writeUInt32LE(nameBytes.length, 0)
    nameBytes.copy(payload, 4)

    const response = await this.sendCommandRaw(CommandType.DeleteScene, payload)
    this.expectOk(response)
  }

  /**
   * Get info about currently loaded scene
   */
  async getCurrentScene(): Promise<SceneDataResponse | null> {
    const response = await this.sendCommandRaw(CommandType.GetCurrentScene, Buffer.alloc(0))

    const type = response.readUInt8(0)
    if (type === ResponseType.Error) {
      console.log("No current scene loaded") // DEBUG
      return null // No scene loaded
    }
    if (type !== ResponseType.SceneData) {
      throw new Error(`Expected SceneData, got ${type}`)
    }

    const jsonRes = readString(response, 5)
    console.log("Received current scene JSON:", jsonRes.value) // DEBUG
    return { sceneJson: jsonRes.value }
  }

  // ==================== Entity Management ====================

  async createEntity(name: string): Promise<string> {
    const nameBytes = Buffer.from(name, "utf-8")
    const payload = Buffer.alloc(4 + nameBytes.length)
    payload.writeUInt32LE(nameBytes.length, 0)
    nameBytes.copy(payload, 4)

    const response = await this.sendCommandRaw(CommandType.CreateEntity, payload)

    const type = response.readUInt8(0)
    if (type === ResponseType.Error) {
      const message = response.subarray(5).toString("utf-8")
      throw new Error(message || "Failed to create entity")
    }
    if (type !== ResponseType.EntityCreated) {
      throw new Error(`Expected EntityCreated, got ${type}`)
    }

    const result = readString(response, 5)
    return result.value
  }

  async destroyEntity(entityId: string): Promise<void> {
    const idBytes = Buffer.from(entityId, "utf-8")
    const payload = Buffer.alloc(4 + idBytes.length)
    writeString(payload, 0, entityId)

    const response = await this.sendCommandRaw(CommandType.DestroyEntity, payload)
    this.expectOk(response)
  }

  async getAllEntities(): Promise<Array<{ id: string; name: string }>> {
    const response = await this.sendCommandRaw(CommandType.GetAllEntities, Buffer.alloc(0))

    this.expectResponse(response, ResponseType.EntityList, "EntityList")

    const entities: Array<{ id: string; name: string }> = []
    let offset = 5

    const count = response.readUInt32LE(offset)
    offset += 4

    for (let i = 0; i < count; i++) {
      const idRes = readString(response, offset)
      offset = idRes.offset

      const nameRes = readString(response, offset)
      offset = nameRes.offset

      entities.push({ id: idRes.value, name: nameRes.value })
    }

    console.log("Retrieved entities:", entities) // DEBUG

    return entities
  }

  async setEntityTransform(
    entityId: string,
    position: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number },
    scale: { x: number; y: number; z: number }
  ): Promise<void> {
    const idBytes = Buffer.from(entityId, "utf-8")
    const payload = Buffer.alloc(4 + idBytes.length + 9 * 4)

    let offset = 0
    offset = writeString(payload, offset, entityId)

    payload.writeFloatLE(position.x, offset)
    offset += 4
    payload.writeFloatLE(position.y, offset)
    offset += 4
    payload.writeFloatLE(position.z, offset)
    offset += 4
    payload.writeFloatLE(rotation.x, offset)
    offset += 4
    payload.writeFloatLE(rotation.y, offset)
    offset += 4
    payload.writeFloatLE(rotation.z, offset)
    offset += 4
    payload.writeFloatLE(scale.x, offset)
    offset += 4
    payload.writeFloatLE(scale.y, offset)
    offset += 4
    payload.writeFloatLE(scale.z, offset)

    const response = await this.sendCommandRaw(CommandType.SetEntityTransform, payload)
    this.expectOk(response)
  }

  async getEntityTransform(entityId: string): Promise<{
    position: { x: number; y: number; z: number }
    rotation: { x: number; y: number; z: number }
    scale: { x: number; y: number; z: number }
  }> {
    const idBytes = Buffer.from(entityId, "utf-8")
    const payload = Buffer.alloc(4 + idBytes.length)
    writeString(payload, 0, entityId)

    const response = await this.sendCommandRaw(CommandType.GetEntityTransform, payload)

    this.expectResponse(response, ResponseType.EntityTransform, "EntityTransform")

    let offset = 5
    return {
      position: {
        x: response.readFloatLE(offset),
        y: response.readFloatLE(offset + 4),
        z: response.readFloatLE(offset + 8),
      },
      rotation: {
        x: response.readFloatLE(offset + 12),
        y: response.readFloatLE(offset + 16),
        z: response.readFloatLE(offset + 20),
      },
      scale: {
        x: response.readFloatLE(offset + 24),
        y: response.readFloatLE(offset + 28),
        z: response.readFloatLE(offset + 32),
      },
    }
  }

  async createScript(name: string): Promise<string> {
    const nameBytes = Buffer.from(name, "utf-8")
    const payload = Buffer.alloc(4 + nameBytes.length)
    payload.writeUInt32LE(nameBytes.length, 0)
    nameBytes.copy(payload, 4)

    const response = await this.sendCommandRaw(CommandType.CreateScript, payload)

    const type = response.readUInt8(0)
    if (type === ResponseType.Error) {
      const message = response.subarray(5).toString("utf-8")
      throw new Error(message || "Failed to create script")
    }
    if (type !== ResponseType.ScriptData) {
      throw new Error(`Expected ScriptData, got ${type}`)
    }

    const result = readString(response, 5)
    return result.value
  }

  async rescanAssets(): Promise<void> {
    const response = await this.sendCommandRaw(CommandType.RescanAssets, Buffer.alloc(0))
    this.expectOk(response)
  }

  // ==================== Engine Health ====================

  /**
   * Per-subsystem status (window, renderer, audio, ...); healthy is false when any of them failed
   */
  async getEngineHealth(): Promise<EngineHealthResponse> {
    const response = await this.sendCommandRaw(CommandType.GetEngineHealth, Buffer.alloc(0))
    this.expectResponse(response, ResponseType.EngineHealth, "EngineHealth")

    let offset = 5
    const healthy = response.readUInt8(offset) !== 0
    offset += 1
    const count = response.readUInt32LE(offset)
    offset += 4

    const subsystems: SubsystemStatus[] = []
    for (let i = 0; i < count; i++) {
      const nameRes = readString(response, offset)
      const stateRes = readString(response, nameRes.offset)
      const detailRes = readString(response, stateRes.offset)
      offset = detailRes.offset

      subsystems.push({ name: nameRes.value, state: stateRes.value, detail: detailRes.value })
    }

    return { healthy, count, subsystems }
  }
}
