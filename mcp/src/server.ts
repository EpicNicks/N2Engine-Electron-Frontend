// The MCP server: the tools of tools.ts and tools-write.ts behind one handler that rate limits, runs the call against the
// host, and turns the outcome into a tool result. Both outcomes are bounded and scrubbed:
//   - success: structuredContent (the result envelope) plus a text block holding a short summary and the same data inside
//     an <n2-data ... untrusted> envelope that the data cannot close (older clients show only the text);
//   - failure: isError with a stable code, a fixed message and one sentence of advice; never an exception's text.
// The write tools are registered but listed only while the host's access allows them (viewer, read-only host and the
// operator's flags hide them), and an irreversible operation runs only with the operator's --allow-irreversible or the
// person's answer to an elicitation (callTool): no argument of the model is consent.
import type { CallToolResult, ClientCapabilities, InputRequiredResult, RegisteredTool, ServerContext } from "@modelcontextprotocol/server"
import { CLIENT_CAPABILITIES_META_KEY, McpServer, inputRequired, inputResponse } from "@modelcontextprotocol/server"
import type { Bridge } from "./bridge"
import { BridgeError, errorText, mapError } from "./errors"
import { MaxResultBytes, RateLimitPerMinute } from "./limits"
import { DefaultPolicy, toolListedByPolicy, writesAllowed, type HostAccess, type Policy } from "./policy"
import { envelopeText } from "./scrub"
import { DataNotice, ReadTools, type ToolDef, type ToolOutput } from "./tools"
import { WriteTools } from "./tools-write"
import { BridgeName, BridgeVersion } from "./version"
import { assertWritable, sha256 } from "./write-core"

/** What the instructions say about the write tools (only when the operator's flags leave some listed) */
const WriteInstructions =
  " Write tools (listed only when the host lets this token change the project): every edit call is ONE undo step named AI: <tool> #<n> that the person can undo, and n2_apply_batch applies many edits all-or-nothing. Make changes only for what the person asked. Irreversible operations (saving, opening or creating a scene over unsaved changes, project settings, overwriting a file, restoring files in a revert) ask the person for confirmation or are refused: there is no argument that overrides this, so do not retry a refusal. Use n2_begin_session for a journal of your changes and n2_session_summary to report them. Never save unless asked."

/** The server-level instructions: what this is, and the one rule about what it returns */
export function serverInstructions(policy: Policy): string {
  const writes = WriteTools.some((t) => toolListedByPolicy(policy, t.name, true))
  return (
    "N2Engine editor bridge: inspect the scene hierarchy, entities and their components, component schemas, assets, text assets, the console and screenshots of an N2Engine project" +
    (writes ? ", and change the scene and its text assets" : " (read-only tools)") +
    ". Start with n2_status. " +
    DataNotice +
    " Results are paged and size-limited: when a result has nextCursor, pass it as cursor to continue. Errors carry a stable code and advice." +
    (writes ? WriteInstructions : "")
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
}

/** What a tool call knows about the client and its answers to this call's confirmation questions */
export interface CallEnv {
  /** The client can show the person a form (elicitation), in either protocol era */
  canElicit: boolean
  /** The retry of a call that asked: it is not a new call from the model, so the rate limit does not count it */
  retry: boolean
  /** The person's answer to the question with this key: accept, decline or cancel; missing when there is none */
  answer(key: string): "accept" | "decline" | "cancel" | "missing"
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

/** The tool result for an output; an error result when it is too big or would carry a secret */
export function successResult(out: ToolOutput, bridge: Bridge): CallToolResult {
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
    return errorResult(new BridgeError("internal", "The result was withheld by the bridge.", "Try again once; if it repeats, report it to the operator."), bridge)
  }
  if (Buffer.byteLength(text) > MaxResultBytes) {
    return errorResult(
      new BridgeError("result_too_large", "The result is larger than the bridge's limit.", "Ask for less: a smaller limit, a rootId, a folder or a range."),
      bridge
    )
  }
  const content: CallToolResult["content"] = [{ type: "text", text }]
  if (out.image) content.push({ type: "image", data: out.image.base64, mimeType: out.image.mimeType })
  return { content, structuredContent: structured }
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
      return def.handler(context, args as never)
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
  return {
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
    { instructions: serverInstructions(bridge.policy) }
  )
  if (options.assumeAccess === undefined && WriteTools.some((t) => toolListedByPolicy(bridge.policy, t.name, true))) {
    // tools/list (and a tools/call that comes first) asks the host once who this token is (when no connection has yet), so
    // the first list is already right.
    // A host that can't be reached lists the read tools only; the list is sent again when a connection opens.
    const inner = server.server as unknown as { setRequestHandler(method: string, handler: (...a: unknown[]) => unknown): void }
    const original = inner.setRequestHandler.bind(inner)
    const writeNames = new Set(WriteTools.map((t) => t.name))
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
  for (const def of WriteTools) {
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
  return server
}
