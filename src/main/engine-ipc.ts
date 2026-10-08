// The engine connection lives here, in the main process, and the page reaches it through IPC (Channels.engine*).
// The page never gets a socket: it can only call the commands in EngineCommandArgs, with arguments of the declared
// types, on the editor host the main process launched for the open project (ProjectSession connects to it, with the
// host's access token, which the page never sees).
import { IpcMain } from "electron"
import { EngineClient } from "../protocol/engine-client"
import { ArgKind, Channels, ConnectionState, EngineCommandArgs, EngineCommandName, EngineCommands } from "../shared/api"
import { EditorPage, handleResult } from "./ipc"

/** Launched hosts listen on loopback only (N2EditorHost's default --bind) */
const HostAddress = "127.0.0.1"

const KindDescriptions: Record<ArgKind, string> = {
  string: "a string",
  number: "a finite number",
  int32: "a 32-bit integer",
  uint32: "an unsigned 32-bit integer",
  vec3: "an {x, y, z} of finite numbers",
  jsonObject: "a JSON object",
}

/** How deeply nested a JSON argument may be (the page's merge patches are a few levels; this stops runaway input) */
export const MaxJsonDepth = 32

/** How many values (every scalar, array and object counts) a JSON argument may hold, shared references counted per use */
export const MaxJsonNodes = 100_000

/**
 * A fresh copy of the value if it is plain JSON (null, booleans, finite numbers, strings, arrays and plain
 * objects), else undefined. Class instances, functions, undefined, NaN and cycles (by the depth limit) are refused, as is more than MaxJsonNodes values.
 */
function copyJson(value: unknown, depth: number, budget: { nodes: number }): { value: unknown } | undefined {
  // Shared references (a DAG, not a cycle) copy once per use, so the depth limit alone doesn't bound the work
  if (--budget.nodes < 0) return undefined
  if (value === null || typeof value === "boolean" || typeof value === "string") return { value }
  if (typeof value === "number") return Number.isFinite(value) ? { value } : undefined
  if (depth >= MaxJsonDepth || typeof value !== "object") return undefined
  if (Array.isArray(value)) {
    const items: unknown[] = []
    for (const item of value) {
      const copy = copyJson(item, depth + 1, budget)
      if (!copy) return undefined
      items.push(copy.value)
    }
    return { value: items }
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  // fromEntries defines own properties, so a "__proto__" key stays data instead of setting the prototype
  const entries: Array<[string, unknown]> = []
  for (const [key, field] of Object.entries(value)) {
    const copy = copyJson(field, depth + 1, budget)
    if (!copy) return undefined
    entries.push([key, copy.value])
  }
  return { value: Object.fromEntries(entries) }
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

/**
 * The argument as the declared kind, or an error. Only primitives and fresh {x, y, z} objects are passed on, so a
 * page can't smuggle in an array or a {length: N} where a string is expected.
 */
export function checkArg(kind: ArgKind, value: unknown, where: string): unknown {
  switch (kind) {
    case "string":
      if (typeof value === "string") return value
      break
    case "number":
      if (isFiniteNumber(value)) return value
      break
    case "int32":
      if (Number.isInteger(value) && (value as number) >= -0x80000000 && (value as number) <= 0x7fffffff) return value
      break
    case "uint32":
      if (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff) return value
      break
    case "vec3":
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const { x, y, z } = value as Record<string, unknown>
        if (isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(z)) return { x, y, z }
      }
      break
    case "jsonObject":
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const copy = copyJson(value, 0, { nodes: MaxJsonNodes })
        if (copy) return copy.value
      }
      break
  }
  throw new Error(`${where} must be ${KindDescriptions[kind]}`)
}

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key)

/**
 * A view leaving at most this many bytes of its buffer unused is posted as it is. A frame assembled from several
 * socket chunks has a buffer of its own, of exactly the payload's size, and its pixels skip only the 8-byte
 * width and height; copying them would cost a whole frame's copy for nothing.
 */
export const MaxUnusedViewBytes = 4096

/**
 * The value with every typed array or DataView that views a small part of a larger buffer replaced by a copy of
 * just its bytes. Decoded bytes fields (FrameData's pixels) are views into the payload, which can be a view of a
 * socket chunk (or Node's shared allocation pool) holding other data; IPC's structured clone copies a view's whole
 * underlying buffer, so posting one would send (and keep alive) all of it. A view that spans its buffer, or all but
 * MaxUnusedViewBytes of it, is passed on as it is.
 */
export function ownedViews<T>(value: T): T {
  if (ArrayBuffer.isView(value)) {
    if (value.buffer.byteLength - value.byteLength <= MaxUnusedViewBytes) return value
    // A plain Uint8Array over the same bytes, whose slice copies (a Buffer's slice would be another view)
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
    if (value instanceof DataView) return new DataView(bytes.buffer) as T
    if (value instanceof Uint8Array) return bytes as T
    const TypedArray = value.constructor as new (buffer: ArrayBufferLike) => T
    return new TypedArray(bytes.buffer)
  }
  if (Array.isArray(value)) return value.map(ownedViews) as T
  if (typeof value === "object" && value !== null) {
    const copy: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(value)) copy[key] = ownedViews(field)
    return copy as T
  }
  return value
}

export interface EngineHostOptions {
  /** Called when a page (re)loads, after its connection is closed: a new page starts with no project or host */
  onAttach?: () => void
}

export class EngineHost {
  private epoch = 0
  private readonly commands: EngineCommands

  constructor(
    readonly client: EngineClient,
    private readonly page: EditorPage,
    private readonly options: EngineHostOptions = {}
  ) {
    // EngineClient must implement every forwarded command with the API's signature
    this.commands = client
    client.onClose(() => this.publish())
  }

  get state(): ConnectionState {
    return { connected: this.client.isConnected, epoch: this.epoch, serverInfo: this.client.serverInfo }
  }

  register(ipcMain: IpcMain): void {
    const handle = (channel: string, handler: (...args: unknown[]) => unknown): void =>
      handleResult(ipcMain, channel, this.page, handler)

    handle(Channels.engineCall, (name, args) => this.call(name, args))
    handle(Channels.engineAttach, () => {
      // A page that (re)loads starts without a connection, as it did when the client lived in the preload
      this.client.close()
      this.options.onAttach?.()
      return this.bump()
    })
  }

  /**
   * Connects to a host the main process launched, on this machine, and says Hello with its access token (empty for
   * a host without one). The token is never sent to the page: not in ConnectionState, results or errors. The new
   * state is pushed to the page. A failed Hello rejects, with the connection already closed (and that published).
   */
  async connectTo(port: number, token: string): Promise<ConnectionState> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port ${String(port)}`)
    }
    await this.client.connect(HostAddress, port, { token })
    return this.publish()
  }

  /** Asks the host to shut down (Shutdown) and closes the connection */
  disconnect(): void {
    this.client.disconnect()
  }

  /** Closes the connection without asking the host to shut down (one started with --exit-on-disconnect exits) */
  close(): void {
    this.client.close()
  }

  private async call(name: unknown, args: unknown): Promise<unknown> {
    if (typeof name !== "string" || !hasOwn(EngineCommandArgs, name)) {
      throw new Error(`Unknown engine command ${String(name)}`)
    }
    const kinds: readonly ArgKind[] = EngineCommandArgs[name as EngineCommandName]
    if (!Array.isArray(args)) {
      throw new Error(`${name}: arguments must be an array`)
    }
    if (args.length !== kinds.length) {
      throw new Error(`${name} takes ${kinds.length} arguments, got ${args.length}`)
    }
    const checked = kinds.map((kind, i) => checkArg(kind, args[i], `${name} argument ${i + 1}`))
    const method = this.commands[name as EngineCommandName] as (...a: unknown[]) => Promise<unknown>
    // The result goes over IPC: never as a view onto a larger buffer
    return ownedViews(await method.apply(this.client, checked))
  }

  private bump(): ConnectionState {
    this.epoch++
    return this.state
  }

  /** Tells the page the connection changed (it opened or closed, or the host dropped it) */
  private publish(): ConnectionState {
    const state = this.bump()
    const editor = this.page.getEditor()
    if (editor && !editor.isDestroyed()) {
      editor.send(Channels.engineState, state)
    }
    return state
  }
}
