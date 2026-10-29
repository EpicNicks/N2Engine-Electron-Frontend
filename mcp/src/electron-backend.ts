// The --electron backend: the host is the person's open editor. The editor (Electron's main process) listens on a named pipe
// or Unix socket while "Allow AI agent for this project" is on and writes where, and this launch's secret, into a 0600 file in
// its user data (src/agent/discovery.ts). This backend reads that file, connects, and says Hello with the secret as the token:
// the endpoint speaks the editor protocol's own framing, so the bridge's EngineClient and every tool work unchanged over it.
// What differs is the editor's side (src/main/agent-endpoint.ts): the agent's role is an editor's at most, every change is an
// undo step labelled "AI: ...", the irreversible tier is confirmed by the person in a native dialog (so the bridge does not ask
// itself: connector.confirmsNatively), and the person's editor view is put back after a picture.
import * as net from "node:net"
import * as path from "node:path"
import { EngineClient, EngineError, HelloError, type SocketFactory } from "../../src/protocol/engine-client"
import type { CommandSpec } from "../../src/protocol/codec"
import { AgentCodes } from "../../src/agent/commands"
import { defaultUserData, discoveryFile, listDiscoveries, processAlive, readDiscovery, type DiscoveryRecord } from "../../src/agent/discovery"
import { BridgeError } from "./errors"
import { ClientName, LaunchUser, type HostConnector, type HostLink } from "./host"
import type { Scrubber } from "./scrub"

/** The environment variable that names the editor's user data folder when --user-data is not given */
export const EditorUserDataEnv = "N2ENGINE_EDITOR_USERDATA"

const NoEndpointAdvice =
  "Ask the person to open the project in the N2Engine editor and turn on 'Allow AI agent for this project' (the AI agent switch in the toolbar), then call the tool again."

const ElectronAdvice = {
  busy: "The editor is busy with the person's own work, or another call is in progress. Try again in a moment, not in a loop.",
  declined: "Do not retry it. Tell the person what you were trying to do and ask how to continue.",
  rate: "Wait a few seconds, and make fewer, larger calls.",
  stale: "The editor may have quit or restarted. Ask the person to check that it is open with 'Allow AI agent for this project' on, then call the tool again.",
  secret: "The editor does not accept this agent any more (the person turned the switch off, disconnected the agent, or the editor restarted). Ask the person to turn 'Allow AI agent for this project' on again.",
}

/** An EngineClient over the endpoint: the endpoint's own refusal codes become the bridge's, and it never asks for a Shutdown */
export class ElectronClient extends EngineClient {
  override async send<Request, Response>(spec: CommandSpec<Request, Response>, request: Request): Promise<Response> {
    try {
      return await super.send(spec, request)
    } catch (e) {
      throw mapEndpointError(e)
    }
  }

  /** The editor is the person's: closing the connection is all there is to do */
  override disconnect(): void {
    this.close()
  }
}

/** The BridgeError for one of the endpoint's codes; anything else is returned as it is (mapError handles it) */
export function mapEndpointError(e: unknown): unknown {
  if (!(e instanceof EngineError)) return e
  switch (e.code) {
    case AgentCodes.declined:
      return new BridgeError("confirmation_declined", "The person declined the operation in the editor.", ElectronAdvice.declined, undefined, e)
    case AgentCodes.busy:
      return new BridgeError("busy", "The editor is busy.", ElectronAdvice.busy, undefined, e)
    case AgentCodes.rateLimited:
      return new BridgeError("rate_limited", "The editor's agent endpoint is rate limiting this agent.", ElectronAdvice.rate, undefined, e)
    case AgentCodes.tooLarge:
      return new BridgeError("result_too_large", "The editor's agent endpoint refused a message as too large.", "Ask for less.", undefined, e)
    default:
      return e
  }
}

export interface ElectronConnectorOptions {
  /** The project's folder; without it the one project that has an endpoint is used */
  projectPath?: string
  /** The editor's user data folder (default: N2ENGINE_EDITOR_USERDATA, else where Electron puts it for the app) */
  userData?: string
  scrubber: Scrubber
  log?: (message: string) => void
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Tests: connect somewhere else than the file says */
  connectSocket?: (endpoint: string, onConnect: () => void) => net.Socket
}

function noEndpoint(detail: string): BridgeError {
  return new BridgeError("host_unavailable", `No AI agent endpoint of the editor was found: ${detail}`, NoEndpointAdvice)
}

/** The record to connect with; a BridgeError saying what to do when there is none */
export function locateEndpoint(options: Pick<ElectronConnectorOptions, "projectPath" | "userData" | "env" | "platform">): DiscoveryRecord & { endpoint: string; secret: string } {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const userData = options.userData ?? env[EditorUserDataEnv] ?? defaultUserData(platform, env)
  let record: DiscoveryRecord | null
  if (options.projectPath !== undefined) {
    record = readDiscovery(discoveryFile(userData, options.projectPath, platform))
    if (record === null) {
      throw noEndpoint("the editor is not running with this project open, or 'Allow AI agent for this project' is off (or the editor's user data is elsewhere: --user-data).")
    }
  } else {
    const all = listDiscoveries(userData)
    if (all.length === 0) throw noEndpoint("the editor is not running with a project open, or 'Allow AI agent for this project' is off (or the editor's user data is elsewhere: --user-data).")
    if (all.length > 1) {
      const names = all.map((d) => path.basename(d.record.projectPath)).slice(0, 8).join(", ")
      throw new BridgeError("invalid_argument", `Several projects have an AI agent endpoint (${names}).`, "Ask the operator to start the bridge with --project <folder>.")
    }
    record = all[0].record
  }
  if (record.endpoint === undefined || record.secret === undefined) {
    const reason = record.reason ?? "the endpoint is not running"
    const readOnly = /read-only|viewer/i.test(reason)
    throw new BridgeError(readOnly ? "read_only" : "host_unavailable", `The editor has 'Allow AI agent for this project' on, but ${reason}.`, readOnly ? "The editor cannot be changed in this state: only reads would be possible, and the endpoint is not offered. Tell the person." : NoEndpointAdvice)
  }
  return record as DiscoveryRecord & { endpoint: string; secret: string }
}

/** The --electron backend: connects to the person's editor through its agent endpoint */
export function electronConnector(options: ElectronConnectorOptions): HostConnector {
  return {
    kind: "electron",
    // The person's editor is the host: nothing to give way to, the editor's own queue puts the person first
    yields: false,
    confirmsNatively: true,
    async connect(): Promise<HostLink> {
      const record = locateEndpoint(options)
      options.scrubber.addSecret(record.secret)
      const open = options.connectSocket ?? ((endpoint, onConnect) => net.connect(endpoint, onConnect))
      const factory: SocketFactory = (_connectOptions, onConnect) => open(record.endpoint, onConnect)
      const client = new ElectronClient(factory)
      try {
        // The host and port are not used by the factory; the loopback name keeps the client's plaintext rule satisfied
        const info = await client.connect("127.0.0.1", 1, { token: record.secret, user: LaunchUser, clientName: ClientName })
        return { client, info }
      } catch (e) {
        client.close()
        const code = (e as NodeJS.ErrnoException | null)?.code
        if (code === "ENOENT" || code === "ECONNREFUSED") {
          const alive = processAlive(record.pid)
          throw new BridgeError("host_unavailable", alive ? "The editor's agent endpoint is not answering." : "The editor is not running (its endpoint file is left over from a crash).", ElectronAdvice.stale, undefined, e)
        }
        if (e instanceof HelloError) {
          throw new BridgeError("auth_failed", "The editor refused this agent's secret.", ElectronAdvice.secret, undefined, e)
        }
        throw e
      }
    },
    dispose() {
      // The editor owns the endpoint; the sockets are closed by the bridge
    },
  }
}
