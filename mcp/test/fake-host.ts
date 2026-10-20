// A stand-in for N2EditorHost for the bridge's tests: a real socket server (plain, or TLS with one of the repo's test-only
// identities) that speaks the editor protocol with the generated codecs and answers from a small in-memory world. Tests
// change the world, or replace one command's answer with host.on(name, handler); a handler returns the response's
// fields or throws a Refusal (an Error or ErrorCoded answer). Everything the host received is in host.received.
import * as net from "node:net"
import * as tls from "node:tls"
import { FrameReader } from "../../src/protocol/framing"
import {
  CommandResponse,
  CommandType,
  PROTOCOL_VERSION,
  RequestCodecs,
  ResponseCodecs,
  ResponseType,
  encodeFrame,
  type ComponentSchema,
  type EditorEvent,
  type HierarchyNode,
} from "../../src/protocol/protocol.generated"
import type { TestIdentity } from "../../src/test/test-tls-identity"

export class Refusal extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

export interface Received {
  name: string
  request: unknown
}

type Handler = (request: any) => unknown

/** A handler that returns this sends no answer at all (a hung host) */
export const Silence = Symbol("silence")

export const ProjectRoot = "C:\\Users\\agent\\Games\\Demo"
export const UserDataRoot = "C:\\Users\\agent\\AppData\\Local\\Demo"

export interface FakeHostOptions {
  /** The token Hello must carry (a host with no token accepts anything) */
  token?: string
  role?: string
  readOnly?: boolean
  user?: string
  /** Answer every Hello with ErrorCoded busy (and close) */
  busy?: boolean
  tls?: TestIdentity
  protocolVersion?: string
}

const Frame = (type: number, payload: Uint8Array): Buffer => Buffer.from(encodeFrame(type, payload))

export function node(id: string, parentId: string, index: number, name: string, components: string[] = []): HierarchyNode {
  return { id, parentId, index, name, active: true, activeInHierarchy: true, layer: 0, tag: "", components }
}

export function entityData(id: string, parentId: string, name: string, components: Array<{ type: string; uuid: string; values: unknown }>) {
  return {
    entity: { header: { id, parentId, index: 0, name, active: true, activeInHierarchy: true, layer: 0, tag: "Untagged" }, transform: {
      position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }, components },
    // Translation (1,2,3), identity rotation, scale (2,2,2)
    worldMatrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1],
  }
}

export const LightType: ComponentSchema = {
  typeName: "Light",
  singleton: false,
  fields: [
    { name: "intensity", displayName: "Intensity", kind: "Float", typeName: "float", hidden: false, readOnly: false, min: 0, max: 100, tooltip: "How bright" },
    { name: "color", displayName: "Color", kind: "Color", typeName: "Vector3", hidden: false, readOnly: false },
    { name: "mode", displayName: "Mode", kind: "Enum", typeName: "LightMode", hidden: false, readOnly: false, enumOptions: ["Point", "Spot"] },
    { name: "cookie", displayName: "Cookie", kind: "AssetRef", typeName: "uuid", hidden: false, readOnly: false, assetType: "Texture" },
    { name: "secret", displayName: "Secret", kind: "String", typeName: "string", hidden: true, readOnly: false },
    { name: "range", displayName: "Range", kind: "Float", typeName: "float", hidden: false, readOnly: true },
  ],
  defaults: { isActive: true, intensity: 1 },
}

export const LuaType: ComponentSchema = {
  typeName: "LuaComponent",
  singleton: false,
  fields: [{ name: "scriptUUID", displayName: "Script", kind: "AssetRef", typeName: "uuid", hidden: false, readOnly: false, assetType: "LuaScript" }],
}

export class FakeHost {
  readonly received: Received[] = []
  readonly helloUsers: string[] = []
  readonly helloTokens: string[] = []
  /** Connections opened, and how many are open now */
  connections = 0
  open = 0
  viewport = { width: 1280, height: 720 }

  // The world
  nodes: HierarchyNode[] = [
    node("11111111-0000-0000-0000-000000000001", "", 0, "Root", []),
    node("11111111-0000-0000-0000-000000000002", "11111111-0000-0000-0000-000000000001", 0, "Player", ["MeshRenderer"]),
    node("11111111-0000-0000-0000-000000000003", "11111111-0000-0000-0000-000000000002", 0, "Camera", ["Camera"]),
    node("11111111-0000-0000-0000-000000000004", "11111111-0000-0000-0000-000000000001", 1, "Light", ["Light"]),
  ]
  hierarchyRevision = 5
  entities = new Map<string, ReturnType<typeof entityData>>()
  componentTypes: ComponentSchema[] = [LightType, LuaType]
  assets: Array<{ path: string; uuid: string; type: string; size: number; modified: number; subAssets?: unknown[] }> = [
    { path: "res://scripts/Player.lua", uuid: "a0000000-0000-0000-0000-000000000001", type: "LuaScript", size: 120, modified: 1700000000000 },
    { path: "res://textures/wall.png", uuid: "a0000000-0000-0000-0000-000000000002", type: "Texture", size: 4096, modified: 1700000001000 },
  ]
  folders: string[] = ["res://scripts", "res://textures"]
  texts = new Map<string, string>([["res://scripts/Player.lua", "-- Player\nfunction update() end\n"]])
  events: EditorEvent[] = []
  epoch = 777
  projectName = "Demo"

  private readonly server: net.Server
  private readonly handlers = new Map<string, Handler>()
  private readonly sockets = new Set<net.Socket>()
  port = 0

  constructor(private readonly options: FakeHostOptions = {}) {
    const onSocket = (socket: net.Socket): void => this.accept(socket)
    this.server = options.tls
      ? tls.createServer({ key: options.tls.key, cert: options.tls.cert }, onSocket)
      : net.createServer(onSocket)
    this.installDefaults()
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve))
    this.port = (this.server.address() as net.AddressInfo).port
    return this
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  /** Replaces one command's answer */
  on(name: string, handler: Handler): void {
    this.handlers.set(name, handler)
  }

  /** Closes every open connection from the host's side (an idle close, a crash) */
  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy()
  }

  count(name: string): number {
    return this.received.filter((r) => r.name === name).length
  }

  /** Every byte the host got that isn't Hello's payload, as text: for "the token never appears elsewhere" */
  addLogEvents(...messages: Array<[string, string]>): void {
    for (const [level, message] of messages) {
      this.events.push({ seq: this.events.length + 1, kind: "log", level, message, time: 1700000000000 + this.events.length })
    }
  }

  private installDefaults(): void {
    const h = this.handlers
    h.set("GetProjectInfo", () => ({
      rootPath: ProjectRoot,
      userDataPath: UserDataRoot,
      project: { formatVersion: 1, name: this.projectName, projectId: "22222222-0000-0000-0000-000000000000", engineVersion: "0.9.0", startupScene: "res://scenes/Main.scene", scenes: ["res://scenes/Main.scene"], settings: { window: { title: "Demo" } } },
    }))
    h.set("GetOpenScene", () => ({ path: "res://scenes/Main.scene", name: "Main", uuid: "33333333-0000-0000-0000-000000000000", revision: this.hierarchyRevision, savedRevision: this.hierarchyRevision }))
    h.set("GetPlayState", () => ({ state: "Edit", frame: 0, time: 0 }))
    h.set("GetEngineHealth", () => ({ healthy: true, count: 1, subsystems: [{ name: "renderer", state: "ok", detail: "software" }] }))
    h.set("GetHistory", () => ({ cursor: 2, entries: [{ label: "Add Light", bytes: 10 }, { label: "Move Player", bytes: 10 }, { label: "Redoable", bytes: 10 }] }))
    h.set("GetHierarchy", () => ({ revision: this.hierarchyRevision, nodes: this.nodes }))
    h.set("GetEntity", (r) => {
      const entity = this.entities.get(r.entityId)
      if (!entity) throw new Refusal("No such object")
      return entity
    })
    h.set("GetComponentTypes", () => ({ types: this.componentTypes }))
    h.set("GetLuaFields", () => ({
      schema: { typeName: "LuaComponent", singleton: false, fields: [
        LuaType.fields[0],
        { name: "speed", displayName: "Speed", kind: "Float", typeName: "float", hidden: false, readOnly: false, container: "scriptData" },
      ] },
    }))
    h.set("ListAssets", (r) => ({ folders: r.folder === "" || r.folder === "res://" ? this.folders : [], assets: this.assets }))
    h.set("GetAssetInfo", (r) => {
      const a = this.assets.find((x) => x.path === r.uuidOrPath || x.uuid === r.uuidOrPath)
      if (!a) throw new Refusal("Not an indexed asset")
      return { info: { ...a, customData: { filter: "linear" }, loaded: false } }
    })
    h.set("ReadTextAsset", (r) => {
      const text = this.texts.get(r.path)
      if (text === undefined) throw new Refusal("Not a text asset")
      return { text }
    })
    h.set("SetViewportSize", (r) => {
      this.viewport = { width: r.width, height: r.height }
    })
    const frame = (): Uint8Array => {
      const { width, height } = this.viewport
      const pixels = new Uint8Array(width * height * 4)
      for (let i = 0; i < pixels.length; i += 4) {
        const p = i / 4
        pixels[i] = p % width & 255
        pixels[i + 1] = Math.floor(p / width) & 255
        pixels[i + 2] = 128
        pixels[i + 3] = 255
      }
      return pixels
    }
    h.set("RenderFrame", () => ({ ...this.viewport, pixels: frame() }))
    h.set("RenderFrameIfChanged", () => ({ revision: 9, modified: true, ...this.viewport, pixels: frame() }))
    h.set("PollEvents", (r) => {
      const from = r.epoch === 0 || r.epoch === this.epoch ? r.afterSeq : 0
      const matching = this.events.filter((e) => e.seq > from)
      const events = matching.slice(0, Math.min(r.maxEvents, 1024))
      const newest = this.events.length > 0 ? this.events[this.events.length - 1].seq : 0
      return { epoch: this.epoch, nextSeq: events.length > 0 ? events[events.length - 1].seq : Math.max(newest, from), dropped: 0, events }
    })
  }

  private accept(socket: net.Socket): void {
    this.connections++
    this.open++
    this.sockets.add(socket)
    const reader = new FrameReader()
    let helloDone = false
    socket.on("error", () => {})
    socket.on("close", () => {
      this.open--
      this.sockets.delete(socket)
    })
    socket.on("data", (chunk: Buffer) => {
      for (const frame of reader.push(chunk)) {
        const name = (Object.keys(CommandType) as Array<keyof typeof CommandType>).find((k) => CommandType[k] === frame.type)
        if (!name) {
          socket.write(Frame(ResponseType.Error, ResponseCodecs.Error.encode({ message: "Unknown command" })))
          continue
        }
        if (name === "Hello") {
          if (!this.hello(socket, frame.payload)) return
          helloDone = true
          continue
        }
        if (!helloDone) {
          socket.end()
          return
        }
        const codec = (RequestCodecs as Record<string, { decode(p: Uint8Array): unknown }>)[name]
        const request = codec ? codec.decode(frame.payload) : {}
        this.received.push({ name, request })
        const answer = this.answer(name, request)
        if (answer !== null) socket.write(answer)
      }
    })
  }

  /** Answers Hello; false when the connection was refused (and closed) */
  private hello(socket: net.Socket, payload: Uint8Array): boolean {
    const request = RequestCodecs.Hello.decode(payload)
    this.helloUsers.push(request.user)
    this.helloTokens.push(request.token)
    if (this.options.busy) {
      socket.write(Frame(ResponseType.ErrorCoded, ResponseCodecs.ErrorCoded.encode({ code: "busy", message: "The host is serving another session (an editor session); try again later" })))
      socket.end()
      return false
    }
    if (this.options.token !== undefined && request.token !== this.options.token) {
      socket.write(Frame(ResponseType.Error, ResponseCodecs.Error.encode({ message: "Invalid access token" })))
      socket.end()
      return false
    }
    socket.write(
      Frame(
        ResponseType.ServerInfo,
        ResponseCodecs.ServerInfo.encode({
          protocolVersion: this.options.protocolVersion ?? PROTOCOL_VERSION,
          engineVersion: "0.9.0",
          capabilities: [],
          projectLoaded: true,
          readOnly: this.options.readOnly ?? false,
          user: request.user || this.options.user || "token",
          role: this.options.role ?? "editor",
        })
      )
    )
    return true
  }

  private answer(name: string, request: unknown): Buffer | null {
    const handler = this.handlers.get(name)
    try {
      if (!handler) throw new Refusal(`${name} is not implemented by the fake host`)
      const value = handler(request)
      if (value === Silence) return null
      const responseName = CommandResponse[name as keyof typeof CommandResponse]
      const codec = ResponseCodecs[responseName as keyof typeof ResponseCodecs] as { encode(v: unknown): Uint8Array }
      return Frame(ResponseType[responseName as keyof typeof ResponseType], codec.encode(value ?? {}))
    } catch (e) {
      if (!(e instanceof Refusal)) throw e
      if (e.code) return Frame(ResponseType.ErrorCoded, ResponseCodecs.ErrorCoded.encode({ message: e.message, code: e.code }))
      return Frame(ResponseType.Error, ResponseCodecs.Error.encode({ message: e.message }))
    }
  }
}
