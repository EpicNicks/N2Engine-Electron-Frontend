// The engine connection lives here, in the main process, and the page reaches it through IPC (Channels.engine*).
// The page never gets a socket: it can only call the commands in EngineCommandArgs, with arguments of the declared
// types, on an editor host on this machine.
import { IpcMain } from "electron"
import { EngineClient } from "../protocol/engine-client"
import {
  ArgKind,
  Channels,
  ConnectionState,
  EngineCommandArgs,
  EngineCommandName,
  EngineCommands,
} from "../shared/api"
import { EditorPage, handleResult } from "./ipc"

const LoopbackHosts = new Set(["localhost", "127.0.0.1", "::1"])

const KindDescriptions: Record<ArgKind, string> = {
  string: "a string",
  number: "a finite number",
  int32: "a 32-bit integer",
  vec3: "an {x, y, z} of finite numbers",
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
    case "vec3":
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const { x, y, z } = value as Record<string, unknown>
        if (isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(z)) return { x, y, z }
      }
      break
  }
  throw new Error(`${where} must be ${KindDescriptions[kind]}`)
}

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key)

export class EngineHost {
  private epoch = 0
  private readonly commands: EngineCommands

  constructor(
    readonly client: EngineClient,
    private readonly page: EditorPage
  ) {
    // EngineClient must implement every forwarded command with the API's signature
    this.commands = client
    client.onClose(() => this.publish())
  }

  get state(): ConnectionState {
    return { connected: this.client.isConnected, epoch: this.epoch }
  }

  register(ipcMain: IpcMain): void {
    const handle = (channel: string, handler: (...args: unknown[]) => unknown): void =>
      handleResult(ipcMain, channel, this.page, handler)

    handle(Channels.engineCall, (name, args) => this.call(name, args))
    handle(Channels.engineConnect, (host, port) => this.connect(host, port))
    handle(Channels.engineDisconnect, () => {
      this.client.disconnect()
      return this.bump()
    })
    handle(Channels.engineAttach, () => {
      // A page that (re)loads starts without a connection, as it did when the client lived in the preload
      this.client.close()
      return this.bump()
    })
  }

  /** Closes the connection without shutting the host down (the window closed) */
  close(): void {
    this.client.close()
  }

  private async connect(host: unknown = "localhost", port: unknown = 9999): Promise<ConnectionState> {
    if (typeof host !== "string" || !LoopbackHosts.has(host)) {
      throw new Error(`Only an editor host on this machine can be connected to (got ${String(host)})`)
    }
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port ${String(port)}`)
    }
    await this.client.connect(host, port)
    return this.bump()
  }

  private call(name: unknown, args: unknown): unknown {
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
    return method.apply(this.client, checked)
  }

  private bump(): ConnectionState {
    this.epoch++
    return this.state
  }

  /** Tells the page the connection changed (it closed, or the host dropped it) */
  private publish(): void {
    const state = this.bump()
    const editor = this.page.getEditor()
    if (editor && !editor.isDestroyed()) {
      editor.send(Channels.engineState, state)
    }
  }
}
