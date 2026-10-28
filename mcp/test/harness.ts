// Test harness: a bridge wired to a FakeHost, served over an in-memory MCP connection to the SDK's own client. The bridge
// connects to the fake host over a plain loopback socket here (the real --connect backend, with TLS and a pinned
// fingerprint, is tested in connect-backend.test.ts).
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { Bridge, type BridgeOptions } from "../src/bridge"
import { EngineClient } from "../../src/protocol/engine-client"
import { LaunchUser, ClientName, type HostConnector } from "../src/host"
import { Scrubber } from "../src/scrub"
import type { ResourceWatch } from "../src/resources"
import { serveBridge, type ServeOptions } from "../src/server"
import { FakeHost, type FakeHostOptions } from "./fake-host"

export const TestToken = "test-token-0123456789abcdef-SECRET"

/** The bridge's connection to a fake host over plain loopback */
export function plainConnector(host: FakeHost, token: string = TestToken, user: string = LaunchUser, yields: boolean = true): HostConnector & { disposed: number } {
  const connector = {
    kind: "connect",
    yields,
    disposed: 0,
    async connect() {
      const client = new EngineClient()
      const info = await client.connect("127.0.0.1", host.port, { token, user, clientName: ClientName, yield: yields })
      return { client, info }
    },
    dispose() {
      connector.disposed++
    },
  }
  return connector
}

export interface Harness {
  host: FakeHost
  bridge: Bridge
  scrubber: Scrubber
  client: Client
  /** The connection's resource watch */
  watch: ResourceWatch
  logs: string[]
  /** The questions the client was asked to show the person (elicitation), in order */
  asked: string[]
  /** Calls a tool and returns the result (isError results are results, not exceptions) */
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>
  close(): Promise<void>
}

export interface ToolResult {
  isError?: boolean
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  structuredContent?: any
  _meta?: Record<string, unknown>
}

export interface HarnessOptions {
  host?: FakeHostOptions
  bridge?: Partial<BridgeOptions>
  /** "legacy": the client opens with initialize (2025-11-25); "auto": it probes server/discover first (2026-07-28) */
  era?: "legacy" | "auto"
  /**
   * The client can show the person a form (elicitation): "form" declares {form:{}}, "legacy" the 2025-06-18 shape {}.
   * The answer is what the person says to each question (default: accept with proceed true); a function sees the message.
   */
  elicit?: "form" | "legacy"
  answer?: { action: "accept" | "decline" | "cancel"; proceed?: boolean } | ((message: string) => { action: "accept" | "decline" | "cancel"; proceed?: boolean })
  /** A host that is already running (shared between harnesses) */
  existingHost?: FakeHost
  /** The resource watch's timings */
  watch?: ServeOptions["watch"]
}

const open: Harness[] = []

/** Closes every harness a test left open (an assertion that failed before its close): so a failure doesn't hang the run */
export async function closeAllHarnesses(): Promise<void> {
  await Promise.all(open.splice(0).map((h) => h.close()))
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const host = options.existingHost ?? (await new FakeHost({ token: TestToken, ...options.host }).start())
  const scrubber = new Scrubber()
  scrubber.addSecret(TestToken)
  const logs: string[] = []
  const connector = options.bridge?.connector ?? plainConnector(host)
  const bridge = new Bridge({
    scrubber,
    connector,
    busyWaitMs: 5,
    sleep: () => Promise.resolve(),
    log: (m) => logs.push(m),
    ...options.bridge,
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const served = serveBridge(bridge, { transport: serverSide, watch: options.watch })
  const asked: string[] = []
  const client = new Client(
    { name: "test-client", version: "0" },
    {
      versionNegotiation: { mode: options.era === "auto" ? "auto" : "legacy" },
      ...(options.elicit ? { capabilities: { elicitation: options.elicit === "form" ? { form: {} } : {} } } : {}),
    }
  )
  if (options.elicit) {
    client.setRequestHandler("elicitation/create", async (request) => {
      const message = (request.params as { message: string }).message
      asked.push(message)
      const a = typeof options.answer === "function" ? options.answer(message) : (options.answer ?? { action: "accept", proceed: true })
      return a.action === "accept" ? { action: "accept", content: { proceed: a.proceed ?? true } } : { action: a.action }
    })
  }
  await client.connect(clientSide)
  const harness: Harness = {
    host,
    bridge,
    scrubber,
    client,
    watch: served.watch,
    logs,
    asked,
    async call(name, args = {}) {
      return (await client.callTool({ name, arguments: args })) as unknown as ToolResult
    },
    async close() {
      await client.close().catch(() => undefined)
      await served.close().catch(() => undefined)
      bridge.dispose()
      if (!options.existingHost) await host.stop()
      const at = open.indexOf(harness)
      if (at >= 0) open.splice(at, 1)
    },
  }
  open.push(harness)
  return harness
}

/** The text of a result's first text block */
export function textOf(result: ToolResult): string {
  return result.content.find((c) => c.type === "text")?.text ?? ""
}

/** Every string a result holds (text blocks and structured content), for scanning */
export function everything(result: ToolResult): string {
  return JSON.stringify(result)
}
