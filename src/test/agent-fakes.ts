// Fakes for the agent endpoint's tests: an engine connection that records what it was sent, an agent that connects the way
// the n2-mcp bridge does (an EngineClient over the endpoint's pipe or socket), and a started endpoint.
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { CommandResponse, CommandType, RequestCodecs, ResponseCodecs, ResponseType, type ServerInfoResponse } from "../protocol/protocol.generated"
import { EngineClient, type SocketFactory } from "../protocol/engine-client"
import type { Frame } from "../protocol/framing"
import { newEndpointPath } from "../agent/discovery"
import { AgentEndpoint, type ConfirmRequest } from "../main/agent-endpoint"
import { Multiplexer } from "../main/agent-mux"

export const TestSecret = "ab".repeat(32)

export class Refused extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

export interface Call {
  name: string
  type: number
  request: any
}

/** The editor's own EngineClient, standing in: answers from handlers, and remembers every command in order */
export class FakeEngine extends EngineClient {
  calls: Call[] = []
  handlers = new Map<string, (request: any) => unknown>()
  up = true
  info: ServerInfoResponse = {
    protocolVersion: "1.22.0",
    engineVersion: "0.9.0",
    capabilities: ["editorExtensions"],
    projectLoaded: true,
    readOnly: false,
    user: "alice",
    role: "admin",
  }
  /** Called before a command is answered (to interleave things in a test) */
  before: ((call: Call) => Promise<void>) | null = null

  override get isConnected(): boolean {
    return this.up
  }
  override get serverInfo(): ServerInfoResponse | null {
    return this.up ? this.info : null
  }

  names(): string[] {
    return this.calls.map((c) => c.name)
  }

  override async sendRaw(type: number, payload: Uint8Array): Promise<Frame> {
    const name = (Object.keys(CommandType) as Array<keyof typeof CommandType>).find((k) => CommandType[k] === type) ?? `0x${type.toString(16)}`
    const codec = (RequestCodecs as Record<string, { decode(p: Uint8Array): unknown }>)[name]
    const request = codec ? codec.decode(payload) : {}
    const call = { name, type, request }
    this.calls.push(call)
    if (this.before) await this.before(call)
    try {
      const handler = this.handlers.get(name)
      const result = handler ? handler(request) : undefined
      const responseName = (CommandResponse as Record<string, string>)[name]
      if (responseName === "Ok" || responseName === undefined) return { type: ResponseType.Ok, payload: Buffer.alloc(0) }
      const encode = (ResponseCodecs as Record<string, { encode(v: any): Uint8Array }>)[responseName].encode
      const defaults = defaultResult(name)
      return { type: (ResponseType as Record<string, number>)[responseName], payload: Buffer.from(encode(result ?? defaults)) }
    } catch (e) {
      if (e instanceof Refused) {
        return e.code
          ? { type: ResponseType.ErrorCoded, payload: Buffer.from(ResponseCodecs.ErrorCoded.encode({ message: e.message, code: e.code })) }
          : { type: ResponseType.Error, payload: Buffer.from(ResponseCodecs.Error.encode({ message: e.message })) }
      }
      throw e
    }
  }
}

const SceneInfo = { path: "res://scenes/a.scene", name: "a", uuid: "33333333-0000-0000-0000-000000000000", revision: 1, savedRevision: 1 }
const ProjectInfo = { rootPath: "C:\P", userDataPath: "C:\U", project: { formatVersion: 1, name: "P", projectId: "x", engineVersion: "0", startupScene: "", scenes: [], settings: {} } }

function defaultResult(name: string): unknown {
  switch (name) {
    case "OpenScene":
    case "SaveSceneToFile":
    case "NewScene":
    case "RestoreAutosave":
    case "GetOpenScene":
      return SceneInfo
    case "SetProjectSettings":
    case "SetStartupScene":
      return ProjectInfo
    case "Undo":
    case "Redo":
      return { label: "x", revision: 2, canUndo: true, canRedo: true, savedRevision: 1 }
    case "ReadTextAsset":
      return { text: "" }
    case "CreateEntityEx":
    case "DuplicateEntity":
      return { entityId: "00000000-0000-4000-8000-000000000009" }
    case "GetHistory":
      return { cursor: 0, entries: [] }
    case "GetEditorCamera":
      return {
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        fovY: 60,
        orthographic: false,
        orthoSize: 5,
        nearPlane: 0.1,
        farPlane: 1000,
        view: new Array(16).fill(0),
        projection: new Array(16).fill(0),
      }
    case "RenderFrame":
      return { width: 2, height: 2, pixels: new Uint8Array(16) }
    case "RenderFrameIfChanged":
      return { revision: 1, modified: true, width: 2, height: 2, pixels: new Uint8Array(16) }
    case "GetHierarchy":
      return { revision: 1, nodes: [] }
    case "GetProjectInfo":
      return { rootPath: "C:\\P", userDataPath: "C:\\U", project: { formatVersion: 1, name: "P", projectId: "x", engineVersion: "0", startupScene: "", scenes: [], settings: {} } }
    default:
      return undefined
  }
}

export interface Started {
  endpoint: AgentEndpoint
  mux: Multiplexer
  engine: FakeEngine
  listenPath: string
  asked: ConfirmRequest[]
  answers: boolean[]
  prepares: string[]
  log: string[]
  changed: number
  lockouts: number
  connections: boolean[]
  humanView: { width: number; height: number } | null
  dir: string
  stop(): Promise<void>
}

export interface StartOptions {
  engine?: FakeEngine
  /** What the person answers to each question (default: yes) */
  answer?: (request: ConfirmRequest) => boolean | Promise<boolean>
  limits?: ConstructorParameters<typeof AgentEndpoint>[0]["limits"]
  prepare?: () => Promise<void>
  leaseIdleMs?: number
}

export async function startEndpoint(options: StartOptions = {}): Promise<Started> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2agent-test-"))
  fs.mkdirSync(path.join(dir, "agent"), { recursive: true })
  const engine = options.engine ?? new FakeEngine()
  const started: Started = {
    endpoint: null as unknown as AgentEndpoint,
    mux: null as unknown as Multiplexer,
    engine,
    listenPath: newEndpointPath(dir).path,
    asked: [],
    answers: [],
    prepares: [],
    log: [],
    changed: 0,
    lockouts: 0,
    connections: [],
    humanView: null,
    dir,
    async stop() {
      await started.endpoint.stop()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
  started.mux = new Multiplexer({
    prepare: async () => {
      started.prepares.push("settle")
      await options.prepare?.()
    },
    expire: () => started.endpoint.endAgentWork(),
    leaseIdleMs: options.leaseIdleMs ?? 5000,
    log: (m) => started.log.push(m),
  })
  started.endpoint = new AgentEndpoint({
    engine,
    mux: started.mux,
    secret: TestSecret,
    listenPath: started.listenPath,
    confirm: async (request) => {
      started.asked.push(request)
      const answer = await (options.answer ? options.answer(request) : true)
      started.answers.push(answer)
      return answer
    },
    humanViewport: () => started.humanView,
    onConnection: (c) => started.connections.push(c),
    onChanged: () => started.changed++,
    onLockout: () => started.lockouts++,
    log: (m) => started.log.push(m),
    limits: options.limits,
  })
  await started.endpoint.start()
  return started
}

/** An agent: an EngineClient over the endpoint, saying Hello with the secret as the bridge does */
export async function connectAgent(started: Pick<Started, "listenPath">, secret: string = TestSecret): Promise<EngineClient> {
  const factory: SocketFactory = (_o, onConnect) => net.connect(started.listenPath, onConnect)
  const client = new EngineClient(factory)
  await client.connect("127.0.0.1", 1, { token: secret, user: "n2-mcp", clientName: "test agent" })
  return client
}

export const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms))
