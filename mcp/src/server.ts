// The MCP server: the tools of tools.ts behind one handler that rate limits, runs the call against the host, and turns
// the outcome into a tool result. Both outcomes are bounded and scrubbed:
//   - success: structuredContent (the result envelope) plus a text block holding a short summary and the same data inside
//     an <n2-data ... untrusted> envelope that the data cannot close (older clients show only the text);
//   - failure: isError with a stable code, a fixed message and one sentence of advice; never an exception's text.
import type { CallToolResult } from "@modelcontextprotocol/server"
import { McpServer } from "@modelcontextprotocol/server"
import type { Bridge } from "./bridge"
import { BridgeError, errorText, mapError } from "./errors"
import { MaxResultBytes, RateLimitPerMinute } from "./limits"
import { envelopeText } from "./scrub"
import { DataNotice, ReadTools, type ToolDef, type ToolOutput } from "./tools"
import { BridgeName, BridgeVersion } from "./version"

/** The server-level instructions: what this is, and the one rule about what it returns */
export const ServerInstructions =
  "N2Engine editor bridge (read-only tools): inspect the scene hierarchy, entities and their components, component schemas, assets, text assets, the console and screenshots of an N2Engine project. Start with n2_status. " +
  DataNotice +
  " Results are paged and size-limited: when a result has nextCursor, pass it as cursor to continue. Errors carry a stable code and advice."

export interface ServerOptions {
  /** Called with each failure's code (the bridge's log gets the rest) */
  onError?: (tool: string, error: BridgeError) => void
}

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
  const text = envelopeText(bridge.scrubber.str(out.summary, { maxChars: 600 }), out.source, structured)
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

/** One tool call: rate limit, run, map */
export async function callTool(bridge: Bridge, def: ToolDef, args: unknown, options: ServerOptions = {}): Promise<CallToolResult> {
  const wait = bridge.rateLimited()
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
    const out = await bridge.run((context) => def.handler(context, args as never), def.name)
    return successResult(out, bridge)
  } catch (e) {
    const error = mapError(e, { command: def.name }, bridge.scrubber)
    bridge.log(`${def.name} failed: ${error.code}${error.cause instanceof Error ? ` (${error.cause.message})` : ""}`)
    options.onError?.(def.name, error)
    return errorResult(error, bridge)
  }
}

/** A server with every tool registered; one per connection (serveStdio's factory calls this) */
export function createServer(bridge: Bridge, options: ServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: BridgeName, version: BridgeVersion },
    { capabilities: { tools: {} }, instructions: ServerInstructions }
  )
  for (const def of ReadTools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input as never,
        outputSchema: def.output as never,
        annotations: def.annotations,
      },
      (async (args: unknown) => callTool(bridge, def, args, options)) as never
    )
  }
  return server
}
