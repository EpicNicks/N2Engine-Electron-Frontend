// The MCP server: the tools of tools.ts and tools-write.ts behind one handler that rate limits, runs the call against the
// host, and turns the outcome into a tool result. Both outcomes are bounded and scrubbed:
//   - success: structuredContent (the result envelope) plus a text block holding a short summary and the same data inside
//     an <n2-data ... untrusted> envelope that the data cannot close (older clients show only the text);
//   - failure: isError with a stable code, a fixed message and one sentence of advice; never an exception's text.
// The write tools are registered but listed only while the host's access allows them (viewer, read-only host and the
// operator's flags hide them), and an irreversible operation runs only with the operator's --allow-irreversible or the
// person's answer to an elicitation (callTool): no argument of the model is consent.
// MCP3 adds the play tools (listed like the write tools, and only when the bridge launched its own host), the resources
// with their subscriptions (resources.ts) and the prompts (prompts.ts); serveBridge wires one stdio connection.
import type { CallToolResult, ClientCapabilities, InputRequiredResult, RegisteredTool, ServerContext, Transport } from "@modelcontextprotocol/server"
import { CLIENT_CAPABILITIES_META_KEY, McpServer, inputRequired, inputResponse } from "@modelcontextprotocol/server"
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio"
import type { Bridge } from "./bridge"
import { BridgeError, errorText, mapError } from "./errors"
import { MaxListenSubscriptions, MaxResultBytes, RateLimitPerMinute } from "./limits"
import { DefaultPolicy, toolListedByPolicy, writesAllowed, type HostAccess, type Policy } from "./policy"
import { envelopeText } from "./scrub"
import { PlayTools } from "./play"
import { registerPrompts } from "./prompts"
import { ResourceWatch, registerResources } from "./resources"
import { DataNotice, ReadTools, type CallHooks, type ToolDef, type ToolOutput } from "./tools"
import { WriteTools } from "./tools-write"
import { BridgeName, BridgeVersion } from "./version"
import { assertWritable, sha256 } from "./write-core"

/** What the instructions say about the write tools (only when the operator's flags leave some listed) */
const WriteInstructions =
  " Write tools (listed only when the host lets this token change the project): every edit call is ONE undo step named AI: <tool> #<n> that the person can undo, and n2_apply_batch applies many edits all-or-nothing. Make changes only for what the person asked. Irreversible operations (saving, opening or creating a scene over unsaved changes, project settings, overwriting a file, restoring files in a revert) ask the person for confirmation or are refused: there is no argument that overrides this, so do not retry a refusal. Use n2_begin_session for a journal of your changes and n2_session_summary to report them. Never save unless asked."

/** What the instructions say about the play tools (the --launch backend, when the operator's flags leave some listed) */
const PlayInstructions =
  " Play tools (listed with the write tools when the bridge launched its own host): n2_play_start runs a copy of the open scene as a game in a host of the bridge's own (the project is not changed by it); n2_play_control pauses, resumes and steps it, n2_play_input sends keys and mouse input, n2_play_observe reads its state, log, entities and a picture, n2_play_script runs a whole playtest in one call, and n2_play_stop ends it."

/** The server-level instructions: what this is, and the one rule about what it returns */
export function serverInstructions(policy: Policy, play: boolean = false): string {
  const writes = WriteTools.some((t) => toolListedByPolicy(policy, t.name, true))
  const playing = play && PlayTools.some((t) => toolListedByPolicy(policy, t.name, true))
  return (
    "N2Engine editor bridge: inspect the scene hierarchy, entities and their components, component schemas, assets, text assets, the console and screenshots of an N2Engine project" +
    (writes ? ", and change the scene and its text assets" : " (read-only tools)") +
    ". Start with n2_status. " +
    DataNotice +
    " Results are paged and size-limited: when a result has nextCursor, pass it as cursor to continue. Errors carry a stable code and advice." +
    (writes ? WriteInstructions : "") +
    (playing ? PlayInstructions : "") +
    " The same reads are resources (n2://scene, n2://scene/hierarchy, n2://entity/{uuid}, n2://console...) that a client can subscribe to."
  )
}

/** The instructions for the default policy */
export const ServerInstructions = serverInstructions(DefaultPolicy)

export interface ServerOptions {
  /** Called with each failure's code (the bridge's log gets the rest) */
  onError?: (tool: string, error: BridgeError) => void
  /**
   * List the write tools as for this access without asking the host (the golden schema file, tests). Normally the server
   * asks the host on the first tools/list (design 3.1) and lists the write tools only for an editor on a host that is not read-only.
   */
  assumeAccess?: HostAccess
  /** The connection's resource watch (serveBridge makes one); without it the resources can be read but not subscribed to */
  watch?: ResourceWatch
}

/** What a tool call knows about the client and its answers to this call's confirmation questions */
export interface CallEnv {
  /** The client can show the person a form (elicitation), in either protocol era */
  canElicit: boolean
  /** The retry of a call that asked: it is not a new call from the model, so the rate limit does not count it */
  retry: boolean
  /** The person's answer to the question with this key: accept, decline or cancel; missing when there is none */
  answer(key: string): "accept" | "decline" | "cancel" | "missing"
  /** The call's cancellation and progress (long play tools use them) */
  hooks?: CallHooks
}

/** A call that needs the person's confirmation first: the question to ask, keyed by what it is about */
export interface Ask {
  ask: { key: string; message: string }
}

export const isAsk = (value: unknown): value is Ask => typeof value === "object" && value !== null && "ask" in value

function errorResult(error: BridgeError, bridge: Bridge): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: errorText(error, bridge.scrubber) }],
    _meta: { "n2/errorCode": error.code },
  }
}

/**
 * The structured content and the text block of an output, as every tool result and resource read has them; a BridgeError
 * when the text is too big or would carry a secret
 */
export function renderOutput(out: ToolOutput, bridge: Bridge): { structured: Record<string, unknown>; text: string } | BridgeError {
  const structured = JSON.parse(
    JSON.stringify({
      source: out.source,
      untrusted: out.untrusted,
      truncated: out.truncated === true,
      nextCursor: out.nextCursor,
      notes: out.notes,
      data: out.data,
    })
  ) as Record<string, unknown>
  // The summary sits outside the envelope but may quote a name (a write's summary does): no < or > in it, so it can't write a tag
  const summary = bridge.scrubber.str(out.summary, { maxChars: 600 }).replace(/[<>]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"))
  const text = envelopeText(summary, out.source, structured)
  if (bridge.scrubber.hasSecret(text)) {
    // Never expected: every string passed the scrubber. Refuse rather than leak.
    bridge.log("a result held a registered secret and was withheld")
    return new BridgeError("internal", "The result was withheld by the bridge.", "Try again once; if it repeats, report it to the operator.")
  }
  if (Buffer.byteLength(text) > MaxResultBytes) {
    return new BridgeError("result_too_large", "The result is larger than the bridge's limit.", "Ask for less: a smaller limit, a rootId, a folder or a range.")
  }
  return { structured, text }
}

/** The tool result for an output; an error result when it is too big or would carry a secret */
export function successResult(out: ToolOutput, bridge: Bridge): CallToolResult {
  const rendered = renderOutput(out, bridge)
  if (rendered instanceof BridgeError) return errorResult(rendered, bridge)
  const content: CallToolResult["content"] = [{ type: "text", text: rendered.text }]
  for (const image of [...(out.image ? [out.image] : []), ...(out.images ?? [])]) content.push({ type: "image", data: image.base64, mimeType: image.mimeType })
  return { content, structuredContent: rendered.structured }
}

/** The key of a confirmation question: it names the exact operation, so an answer to one question never allows another */
export const confirmKey = (tool: string, sentence: string): string => `confirm-${sha256(`${tool}\n${sentence}`).slice(0, 16)}`

/**
 * One tool call: rate limit, run, map. An irreversible operation (def.irreversible says so after looking at the host)
 * runs only with the operator's consent (--allow-irreversible) or the person's answer to an elicitation, which is asked
 * outside the call (the call returns an Ask and runs again with the answer). The model's arguments never count.
 */
export async function callTool(bridge: Bridge, def: ToolDef, args: unknown, options: ServerOptions = {}, env?: CallEnv): Promise<CallToolResult | Ask> {
  const wait = env?.retry ? 0 : bridge.rateLimited()
  if (wait > 0) {
    const error = new BridgeError(
      "rate_limited",
      `More than ${RateLimitPerMinute} tool calls in a minute.`,
      `Wait ${wait} s before calling again, and make fewer, larger calls.`
    )
    options.onError?.(def.name, error)
    return errorResult(error, bridge)
  }
  try {
    const out = await bridge.run(async (context): Promise<ToolOutput | Ask> => {
      if (def.write) {
        if (!toolListedByPolicy(bridge.policy, def.name, true)) {
          throw new BridgeError("forbidden", "The operator turned this tool off.", "Do not retry. Use another tool, or ask the operator.")
        }
        assertWritable(context)
      }
      if (def.irreversible) {
        const sentence = await def.irreversible(context, args as never)
        if (sentence !== null) {
          if (bridge.policy.allowIrreversible) {
            context.consent = "operator"
          } else if (env?.canElicit === true) {
            const key = confirmKey(def.name, sentence)
            const answer = env.answer(key)
            if (answer === "missing") {
              const message = `An AI agent asks to do something that cannot be undone: ${sentence}\nTool: ${def.name}. Allow it?`
              return { ask: { key, message: bridge.scrubber.str(message, { multiline: true, maxChars: 900 }) } }
            }
            if (answer !== "accept") {
              throw new BridgeError("confirmation_declined", "The person declined the operation.", "Do not retry it. Tell the person what you were trying to do and ask how to continue.")
            }
            context.consent = "elicited"
          } else {
            throw new BridgeError(
              "irreversible_refused",
              "This operation cannot be undone, and this client cannot ask the person to confirm it, so it is refused.",
              "Do not retry: no argument overrides this. Tell the person what you wanted to do; the operator can allow it by starting the bridge with --allow-irreversible."
            )
          }
        }
      }
      // The handler stops when the client cancels or when the bridge gives up on the call (its timeout)
      const hooks = env?.hooks ?? {}
      const signal = hooks.signal ? AbortSignal.any([hooks.signal, context.signal]) : context.signal
      return def.handler(context, args as never, { ...hooks, signal })
    }, def.name)
    if (isAsk(out)) return out
    return successResult(out, bridge)
  } catch (e) {
    const error = mapError(e, { command: def.name }, bridge.scrubber)
    bridge.log(`${def.name} failed: ${error.code}${error.cause instanceof Error ? ` (${error.cause.message})` : ""}`)
    options.onError?.(def.name, error)
    return errorResult(error, bridge)
  }
}

/** Whether the client declared that it can show the person a form (elicitation), in the 2026-07-28 envelope or the 2025 handshake */
function clientCanElicit(server: McpServer, ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined
  const caps = (envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined) ?? server.server.getClientCapabilities()
  const form = caps?.elicitation
  if (form === undefined || form === null) return false
  const keys = Object.keys(form)
  return keys.length === 0 || keys.includes("form")
}

function callEnv(server: McpServer, ctx: ServerContext): CallEnv {
  const responses = ctx.mcpReq.inputResponses
  const token = ctx.mcpReq._meta?.progressToken
  return {
    hooks: {
      signal: ctx.mcpReq.signal,
      // Only for a client that asked (a progressToken): numbers and a short fixed message, never project text
      progress:
        token === undefined
          ? undefined
          : (done, total, message) => {
              void ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: done, total, message } }).catch(() => undefined)
            },
    },
    canElicit: clientCanElicit(server, ctx),
    retry: responses !== undefined && Object.keys(responses).length > 0,
    answer(key) {
      const view = inputResponse(responses, key)
      if (view.kind !== "elicit") return "missing"
      if (view.action === "accept") return view.content?.proceed === true ? "accept" : "decline"
      return view.action
    },
  }
}

/** The question the person is asked: a yes or no, nothing else */
function confirmation(ask: Ask["ask"]): InputRequiredResult {
  return inputRequired({
    inputRequests: {
      [ask.key]: inputRequired.elicit({
        message: ask.message,
        requestedSchema: {
          type: "object",
          properties: {
            proceed: { type: "boolean", title: "Allow this operation", description: "Yes allows exactly the operation described above; no refuses it.", default: false },
          },
          required: ["proceed"],
        },
      }),
    },
  })
}

/** A server with every tool registered; one per connection (serveStdio's factory calls this) */
export function createServer(bridge: Bridge, options: ServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: BridgeName, version: BridgeVersion },
    // No `capabilities.tools` here: with it the SDK registers its tool handlers at once, before the wrapper below is in place
    // (registerTool then declares tools with listChanged, which the write tools' appearance needs)
    { instructions: serverInstructions(bridge.policy, bridge.play !== null) }
  )
  // The tools listed only for a token that may change the project: the write tools, and the play tools of a --launch bridge
  const gated: readonly ToolDef[] = bridge.play !== null ? [...WriteTools, ...PlayTools] : WriteTools
  if (options.assumeAccess === undefined && gated.some((t) => toolListedByPolicy(bridge.policy, t.name, true))) {
    // tools/list (and a tools/call that comes first) asks the host once who this token is (when no connection has yet), so
    // the first list is already right.
    // A host that can't be reached lists the read tools only; the list is sent again when a connection opens.
    const inner = server.server as unknown as { setRequestHandler(method: string, handler: (...a: unknown[]) => unknown): void }
    const original = inner.setRequestHandler.bind(inner)
    const writeNames = new Set(gated.map((t) => t.name))
    inner.setRequestHandler = (method, handler) =>
      original(
        method,
        method === "tools/list"
          ? async (...a: unknown[]) => {
              if (bridge.hostAccess === null) await bridge.run(async () => undefined, "tools/list").catch(() => undefined)
              return handler(...a)
            }
          : method === "tools/call"
            ? async (...a: unknown[]) => {
                const name = (a[0] as { params?: { name?: unknown } } | undefined)?.params?.name
                if (bridge.hostAccess === null && typeof name === "string" && writeNames.has(name)) {
                  try {
                    await bridge.run(async () => undefined, name)
                  } catch (e) {
                    // The host can't be reached (busy, wrong token...): say so, rather than that the tool is disabled
                    const error = mapError(e, { command: name }, bridge.scrubber)
                    options.onError?.(name, error)
                    return errorResult(error, bridge)
                  }
                }
                return handler(...a)
              }
            : handler
      )
  }
  const register = (def: ToolDef): RegisteredTool =>
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input as never,
        outputSchema: def.output as never,
        annotations: def.annotations,
      },
      (async (args: unknown, ctx: ServerContext) => {
        const outcome = await callTool(bridge, def, args, options, callEnv(server, ctx))
        return isAsk(outcome) ? confirmation(outcome.ask) : outcome
      }) as never
    )
  for (const def of ReadTools) {
    if (!bridge.policy.disabledTools.has(def.name)) register(def)
  }
  // The write tools are registered, and listed only while the host's access allows them (design 3.1)
  const writes = new Map<string, RegisteredTool>()
  for (const def of gated) {
    if (!toolListedByPolicy(bridge.policy, def.name, true)) continue
    const registered = register(def)
    registered.disable()
    writes.set(def.name, registered)
  }
  const apply = (access: HostAccess | null): void => {
    const listed = writesAllowed(access, bridge.allowAdmin)
    for (const registered of writes.values()) {
      if (registered.enabled === listed) continue
      if (listed) registered.enable()
      else registered.disable()
    }
  }
  if (writes.size > 0) {
    apply(options.assumeAccess ?? bridge.hostAccess)
    if (options.assumeAccess === undefined) {
      const off = bridge.onConnect(apply)
      const previous = server.server.onclose
      server.server.onclose = () => {
        off()
        previous?.()
      }
    }
  }
  // Resources (with subscriptions through the connection's watch) and prompts (design 3.6, 3.7)
  const watch = options.watch ?? new ResourceWatch(bridge)
  const removeSink = registerResources(server, bridge, watch)
  registerPrompts(server, { play: bridge.play !== null && PlayTools.some((t) => toolListedByPolicy(bridge.policy, t.name, true)) })
  const beforeClose = server.server.onclose
  server.server.onclose = () => {
    removeSink()
    if (options.watch === undefined) watch.dispose()
    beforeClose?.()
  }
  return server
}

export interface ServeOptions {
  /** The transport (tests); default: this process's stdin and stdout */
  transport?: Transport
  onerror?: (error: Error) => void
  /** The resource watch's poll and debounce timings (tests) */
  watch?: ConstructorParameters<typeof ResourceWatch>[1]
}

/**
 * Serves the bridge on one stdio connection: the SDK's serveStdio (both protocol eras), a server per instance it asks for,
 * and one resource watch for the connection, which sees the SDK's subscriptions/listen streams through a transport tap.
 */
export function serveBridge(bridge: Bridge, options: ServeOptions = {}): { close(): Promise<void>; watch: ResourceWatch } {
  const watch = new ResourceWatch(bridge, options.watch)
  const handle = serveStdio(() => createServer(bridge, { watch }), {
    transport: watch.tap(options.transport ?? new StdioServerTransport()),
    onerror: options.onerror,
    maxSubscriptions: MaxListenSubscriptions,
  })
  return {
    watch,
    async close() {
      watch.dispose()
      await handle.close()
    },
  }
}
