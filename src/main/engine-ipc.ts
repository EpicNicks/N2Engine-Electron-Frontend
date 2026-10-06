// The engine connection lives here, in the main process, and the page reaches it through IPC (Channels.engine*).
// The page never gets a socket: it can only call the commands in EngineCommandNames on an editor host on this
// machine.
import { IpcMain, WebContents } from "electron"
import { EngineClient } from "../protocol/engine-client"
import { Channels, ConnectionState, EngineCommandName, EngineCommandNames, EngineCommands } from "../shared/api"
import { handleResult } from "./ipc"

const LoopbackHosts = new Set(["localhost", "127.0.0.1", "::1"])

export class EngineHost {
  private epoch = 0
  private readonly commands: EngineCommands
  private readonly allowed = new Set<string>(EngineCommandNames)

  constructor(
    readonly client: EngineClient,
    private readonly getEditor: () => WebContents | null
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
      handleResult(ipcMain, channel, this.getEditor, handler)

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
    if (typeof name !== "string" || !this.allowed.has(name)) {
      throw new Error(`Unknown engine command ${String(name)}`)
    }
    if (!Array.isArray(args)) {
      throw new Error(`${name}: arguments must be an array`)
    }
    const method = this.commands[name as EngineCommandName] as (...a: unknown[]) => Promise<unknown>
    return method.apply(this.client, args)
  }

  private bump(): ConnectionState {
    this.epoch++
    return this.state
  }

  /** Tells the page the connection changed (it closed, or the host dropped it) */
  private publish(): void {
    const state = this.bump()
    const editor = this.getEditor()
    if (editor && !editor.isDestroyed()) {
      editor.send(Channels.engineState, state)
    }
  }
}
