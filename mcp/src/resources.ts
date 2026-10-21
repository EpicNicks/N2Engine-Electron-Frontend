// Resources and subscriptions (MCP3, design 3.6). Tools stay primary (a client may never show resources to the model);
// the resources are the same reads, addressable by URI, and a client can subscribe to be told when one changes.
//
// Reading a resource runs the matching read tool's handler, so its content is exactly as bounded, scrubbed and
// data-marked as that tool's result: the text is the summary and the data inside an <n2-data ... untrusted> envelope
// that the data cannot close. Reads are rate limited with the tool calls.
//
// Subscriptions: resources/subscribe (2025-11-25) and subscriptions/listen (2026-07-28, served by the SDK's stdio entry,
// which this module watches through a transport tap) together watch at most limits.MaxWatchedUris URIs. While at least one
// is watched, the host's events are polled with the frontend's EventPump (a cursor, nothing queued) and each event marks
// the URIs it changes; a notification carries only the URI (never host text), the same URI is announced once per poll,
// and n2://console at most once a second. When nothing is watched the pump stops and the host is not polled.
import type { JSONRPCMessage, McpServer, Transport, TransportSendOptions } from "@modelcontextprotocol/server"
import { ProtocolError, ProtocolErrorCode, ResourceTemplate, SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/server"
import { EventPump, type Timers } from "../../src/protocol/event-pump"
import type { EditorEvent } from "../../src/protocol/protocol.generated"
import type { Bridge } from "./bridge"
import { BridgeError, errorText, mapError } from "./errors"
import * as limits from "./limits"
import type { Policy } from "./policy"
import { renderOutput } from "./server"
import { DataNotice, ReadTools, idText, type ToolOutput } from "./tools"

export const ResourceUri = {
  project: "n2://project",
  scene: "n2://scene",
  hierarchy: "n2://scene/hierarchy",
  console: "n2://console",
  history: "n2://history",
  componentTypes: "n2://component-types",
} as const

export const EntityTemplate = "n2://entity/{uuid}"
export const AssetTemplate = "n2://asset/{+path}"

const EntityPrefix = "n2://entity/"
const AssetPrefix = "n2://asset/"

/** A watchable URI: one of the fixed ones, an entity URI with a UUID, or a text asset's URI */
export function parseResourceUri(uri: string): { kind: "fixed" } | { kind: "entity"; id: string } | { kind: "asset"; path: string } | null {
  if (typeof uri !== "string" || uri.length > 1100) return null
  if ((Object.values(ResourceUri) as string[]).includes(uri)) return { kind: "fixed" }
  if (uri.startsWith(EntityPrefix)) {
    const id = uri.slice(EntityPrefix.length)
    return idText.safeParse(id).success ? { kind: "entity", id } : null
  }
  if (uri.startsWith(AssetPrefix)) {
    let path: string
    try {
      path = decodeURIComponent(uri.slice(AssetPrefix.length))
    } catch {
      return null
    }
    if (path === "" || path.length > 1024 || /[\u0000-\u001f\u007f]/.test(path)) return null
    return { kind: "asset", path: `res://${path}` }
  }
  return null
}

/** The read tool whose data a resource serves: --disable-tools for that tool turns the resource off too */
const FixedResourceTool: Record<string, string> = {
  [ResourceUri.project]: "n2_get_project_info",
  [ResourceUri.scene]: "n2_status",
  [ResourceUri.hierarchy]: "n2_get_hierarchy",
  [ResourceUri.console]: "n2_get_console",
  [ResourceUri.history]: "n2_status",
  [ResourceUri.componentTypes]: "n2_get_component_types",
}
const EntityTool = "n2_get_entity"
const AssetTool = "n2_read_text_asset"

/** The read tool a resource URI stands for, or null when the URI is not one of this server's */
export function resourceTool(uri: string): string | null {
  const parsed = parseResourceUri(uri)
  if (parsed === null) return null
  if (parsed.kind === "entity") return EntityTool
  if (parsed.kind === "asset") return AssetTool
  return FixedResourceTool[uri] ?? null
}

/** Whether a URI is a resource this server serves under the operator's policy (its read tool is not disabled) */
export function resourceAllowed(policy: Policy, uri: string): boolean {
  const name = resourceTool(uri)
  return name !== null && !policy.disabledTools.has(name)
}

/** Something the server sends a resources/updated for (a connected McpServer) */
type Sink = (uri: string) => void

export interface WatchOptions {
  intervalMs?: number
  retryMs?: number
  debounceMs?: number
  timers?: Timers
}

/**
 * The URIs one client connection watches, and the event pump that runs while there are any. One per connection: the
 * stdio entry's listen streams and the pinned server's resources/subscribe both land here.
 */
export class ResourceWatch {
  private readonly subscribed = new Set<string>()
  private readonly listens = new Map<string | number, string[]>()
  private readonly sinks = new Set<Sink>()
  private pump: EventPump<EditorEvent> | null = null
  private consoleTimer: unknown = null
  private consoleAt = 0
  private disposed = false
  private readonly timers: Timers

  constructor(
    private readonly bridge: Bridge,
    private readonly options: WatchOptions = {}
  ) {
    this.timers = options.timers ?? { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }
  }

  /** Every URI watched now (resources/subscribe and the open listen streams) */
  watched(): Set<string> {
    const all = new Set(this.subscribed)
    for (const uris of this.listens.values()) for (const u of uris) all.add(u)
    return all
  }

  /** Whether the host is being polled (for the tests and the log) */
  get polling(): boolean {
    return this.pump !== null
  }

  addSink(sink: Sink): () => void {
    this.sinks.add(sink)
    return () => this.sinks.delete(sink)
  }

  /** resources/subscribe: an unknown URI and one past the limit are refused */
  subscribe(uri: string): void {
    if (!resourceAllowed(this.bridge.policy, uri)) throw new BridgeError("invalid_argument", "That is not a resource of this server.", "Use a URI from resources/list or resources/templates/list.")
    if (!this.watched().has(uri) && this.watched().size >= limits.MaxWatchedUris) {
      throw new BridgeError("budget_exceeded", `At most ${limits.MaxWatchedUris} resources can be watched at once.`, "Unsubscribe from one first.")
    }
    this.subscribed.add(uri)
    this.update()
  }

  unsubscribe(uri: string): void {
    this.subscribed.delete(uri)
    this.update()
  }

  /** A subscriptions/listen stream the SDK acknowledged: its valid URIs, as many as the limit leaves room for */
  listenOpened(id: string | number, uris: unknown): void {
    if (this.listens.size >= limits.MaxListenSubscriptions && !this.listens.has(id)) {
      this.bridge.log("a subscriptions/listen stream past the limit watches nothing")
      return
    }
    const kept: string[] = []
    const room = new Set(this.watched())
    for (const uri of Array.isArray(uris) ? uris : []) {
      if (typeof uri !== "string" || !resourceAllowed(this.bridge.policy, uri) || kept.includes(uri)) continue
      if (!room.has(uri)) {
        if (room.size >= limits.MaxWatchedUris) {
          this.bridge.log(`a subscriptions/listen stream asked for more than ${limits.MaxWatchedUris} resources; the rest are not watched`)
          break
        }
        room.add(uri)
      }
      kept.push(uri)
    }
    this.listens.set(id, kept)
    this.update()
  }

  listenClosed(id: string | number): void {
    if (this.listens.delete(id)) this.update()
  }

  /**
   * The transport the stdio entry serves, watched: an acknowledged subscriptions/listen opens a watch with the URIs the
   * SDK honoured; a cancel or the stream's graceful end closes it; the connection closing ends them all.
   */
  tap(inner: Transport): Transport {
    return new TappedTransport(inner, this)
  }

  private update(): void {
    if (this.disposed) return
    const any = this.watched().size > 0
    if (any && this.pump === null) {
      let primed = false
      const pump = new EventPump<EditorEvent>(
        async (epoch, after, max) => {
          // The first poll only finds the newest seq: what happened before the watch began is not a change to announce
          const batch = await this.bridge.run((ctx) => ctx.client.pollEvents(epoch, after, primed ? max : 0), "PollEvents")
          primed = true
          return batch
        },
        {
          onEvents: (events) => this.onEvents(events),
          onDropped: () => this.announce(this.watched()),
          onReset: () => this.announce(this.watched()),
          onError: (e) => this.bridge.log(`watching resources: polling failed (${mapError(e, { command: "PollEvents" }, this.bridge.scrubber).code})`),
        },
        { intervalMs: this.options.intervalMs ?? limits.WatchPollMs, errorRetryMs: this.options.retryMs ?? limits.WatchRetryMs, maxEvents: 1024, timers: this.timers }
      )
      this.pump = pump
      pump.start()
    } else if (!any && this.pump !== null) {
      this.pump.stop()
      this.pump = null
      this.cancelConsole()
    }
  }

  /** The URIs a batch of host events changed, each once */
  private onEvents(events: EditorEvent[]): void {
    const watched = this.watched()
    const changed = new Set<string>()
    let log = false
    const mark = (uri: string): void => {
      if (watched.has(uri)) changed.add(uri)
    }
    for (const e of events) {
      switch (e.kind) {
        case "log":
          log = true
          break
        case "sceneChanged": {
          mark(ResourceUri.scene)
          mark(ResourceUri.hierarchy)
          const ids = Array.isArray(e.entityIds) && e.full !== true ? new Set(e.entityIds) : null
          for (const uri of watched) {
            const parsed = parseResourceUri(uri)
            if (parsed?.kind === "entity" && (ids === null || ids.has(parsed.id))) changed.add(uri)
          }
          break
        }
        case "historyChanged":
          mark(ResourceUri.history)
          break
        case "projectChanged":
          mark(ResourceUri.project)
          break
        case "assetsChanged": {
          const paths = new Set([...(e.added ?? []), ...(e.removed ?? []), ...(e.modified ?? [])])
          for (const uri of watched) {
            const parsed = parseResourceUri(uri)
            if (parsed?.kind === "asset" && paths.has(parsed.path)) changed.add(uri)
          }
          break
        }
        default:
          break
      }
    }
    this.announce(changed)
    if (log && watched.has(ResourceUri.console)) this.consoleChanged()
  }

  /** n2://console: at most once per debounce period, the last one after the quiet period */
  private consoleChanged(): void {
    if (this.consoleTimer !== null) return
    const debounce = this.options.debounceMs ?? limits.ConsoleDebounceMs
    const wait = Math.max(0, this.consoleAt + debounce - Date.now())
    this.consoleTimer = this.timers.setTimeout(() => {
      this.consoleTimer = null
      this.consoleAt = Date.now()
      if (this.watched().has(ResourceUri.console)) this.announce(new Set([ResourceUri.console]))
    }, wait)
  }

  private cancelConsole(): void {
    if (this.consoleTimer !== null) {
      this.timers.clearTimeout(this.consoleTimer)
      this.consoleTimer = null
    }
  }

  private announce(uris: Iterable<string>): void {
    for (const uri of uris) {
      for (const sink of this.sinks) {
        try {
          sink(uri)
        } catch {
          // a closed server: nothing to tell
        }
      }
    }
  }

  /** Every listen stream ended (the connection closed) */
  listensEnded(): void {
    if (this.listens.size === 0) return
    this.listens.clear()
    this.update()
  }

  dispose(): void {
    this.disposed = true
    this.pump?.stop()
    this.pump = null
    this.cancelConsole()
    this.subscribed.clear()
    this.listens.clear()
    this.sinks.clear()
  }
}

/** A transport that tells the watch about listen streams: everything else passes through unchanged */
class TappedTransport implements Transport {
  private messageHandler: Transport["onmessage"]
  private closeHandler: Transport["onclose"]

  constructor(
    private readonly inner: Transport,
    private readonly watch: ResourceWatch
  ) {}

  start(): Promise<void> {
    return this.inner.start()
  }

  close(): Promise<void> {
    return this.inner.close()
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    try {
      this.outbound(message)
    } catch {
      // watching must never break the connection
    }
    return this.inner.send(message, options)
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId
  }

  get onerror(): Transport["onerror"] {
    return this.inner.onerror
  }

  set onerror(handler: Transport["onerror"]) {
    this.inner.onerror = handler
  }

  get onclose(): Transport["onclose"] {
    return this.closeHandler
  }

  set onclose(handler: Transport["onclose"]) {
    this.closeHandler = handler
    this.inner.onclose = () => {
      this.watch.listensEnded()
      handler?.()
    }
  }

  get onmessage(): Transport["onmessage"] {
    return this.messageHandler
  }

  set onmessage(handler: Transport["onmessage"]) {
    this.messageHandler = handler
    this.inner.onmessage = (message, extra) => {
      try {
        this.inbound(message)
      } catch {
        // as above
      }
      handler?.(message, extra)
    }
  }

  private inbound(message: JSONRPCMessage): void {
    const m = message as { method?: unknown; params?: { requestId?: unknown } }
    if (m.method === "notifications/cancelled" && (typeof m.params?.requestId === "string" || typeof m.params?.requestId === "number")) {
      this.watch.listenClosed(m.params.requestId)
    }
  }

  private outbound(message: JSONRPCMessage): void {
    const m = message as { method?: unknown; id?: unknown; params?: Record<string, unknown>; result?: Record<string, unknown> }
    if (m.method === "notifications/subscriptions/acknowledged") {
      const id = (m.params?._meta as Record<string, unknown> | undefined)?.[SUBSCRIPTION_ID_META_KEY]
      if (typeof id === "string" || typeof id === "number") {
        const filter = m.params?.notifications as { resourceSubscriptions?: unknown } | undefined
        this.watch.listenOpened(id, filter?.resourceSubscriptions)
      }
      return
    }
    // The server's graceful end of a listen stream: its (empty) result, stamped with the subscription id
    const ended = (m.result?._meta as Record<string, unknown> | undefined)?.[SUBSCRIPTION_ID_META_KEY]
    if (m.id !== undefined && (typeof ended === "string" || typeof ended === "number")) this.watch.listenClosed(ended)
  }
}

// ===== the resources =====

/** Runs a read tool's handler by name (its arguments are already well formed) */
function readTool(name: string): (typeof ReadTools)[number] {
  const def = ReadTools.find((t) => t.name === name)
  if (!def) throw new Error(`no read tool ${name}`)
  return def
}

/** The bridge's failure as a JSON-RPC error: the same scrubbed text a tool's error result has */
function readFailure(error: BridgeError, bridge: Bridge): ProtocolError {
  return new ProtocolError(error.code === "invalid_argument" ? ProtocolErrorCode.InvalidParams : ProtocolErrorCode.InternalError, errorText(error, bridge.scrubber), { n2ErrorCode: error.code })
}

async function readResource(bridge: Bridge, uri: string, produce: (ctx: Parameters<Parameters<Bridge["run"]>[0]>[0]) => Promise<ToolOutput>) {
  const wait = bridge.rateLimited()
  if (wait > 0) {
    throw readFailure(new BridgeError("rate_limited", `More than ${limits.RateLimitPerMinute} calls in a minute.`, `Wait ${wait} s before reading again.`), bridge)
  }
  let out: ToolOutput
  try {
    out = await bridge.run(produce, `resources/read`)
  } catch (e) {
    const error = mapError(e, { command: "resources/read" }, bridge.scrubber)
    bridge.log(`resources/read failed: ${error.code}`)
    throw readFailure(error, bridge)
  }
  const rendered = renderOutput(out, bridge)
  if (rendered instanceof BridgeError) throw readFailure(rendered, bridge)
  return {
    contents: [{ uri, mimeType: "text/plain", text: rendered.text }],
    _meta: { "n2/untrusted": out.untrusted, "n2/source": out.source, "n2/truncated": out.truncated === true },
  }
}

const Notice = ` The text is a one-line summary and the data in an <n2-data ... untrusted> envelope. ${DataNotice}`

const sceneResource = async (ctx: Parameters<Parameters<Bridge["run"]>[0]>[0]): Promise<ToolOutput> => {
  const s = ctx.scrubber
  const scene = await ctx.client.getOpenScene()
  const dirty = scene.revision !== scene.savedRevision
  return {
    source: "scene",
    untrusted: true,
    summary: `The open scene${dirty ? " (unsaved changes)" : ""}.`,
    data: { path: s.str(scene.path, { maxChars: 512 }), name: s.name(scene.name), uuid: s.name(scene.uuid, 64), revision: scene.revision, savedRevision: scene.savedRevision, dirty },
  }
}

const historyResource = async (ctx: Parameters<Parameters<Bridge["run"]>[0]>[0]): Promise<ToolOutput> => {
  const s = ctx.scrubber
  const h = await ctx.client.getHistory()
  const entries = h.entries.slice(-50).map((e) => s.name(e.label, 120))
  return {
    source: "host",
    untrusted: true,
    summary: `${h.cursor} undo step(s) done, ${Math.max(0, h.entries.length - h.cursor)} undone.`,
    data: {
      undoSteps: h.cursor,
      redoSteps: Math.max(0, h.entries.length - h.cursor),
      nextUndoLabel: h.cursor > 0 ? s.name(h.entries[h.cursor - 1].label, 120) : "",
      nextRedoLabel: h.cursor < h.entries.length ? s.name(h.entries[h.cursor].label, 120) : "",
      labels: entries,
    },
    truncated: h.entries.length > 50,
  }
}

/** Registers the resources on a server and connects it to the connection's watch (resources/subscribe, notifications) */
export function registerResources(server: McpServer, bridge: Bridge, watch: ResourceWatch): () => void {
  const fixed: Array<{ name: string; uri: string; title: string; description: string; read: (ctx: Parameters<Parameters<Bridge["run"]>[0]>[0]) => Promise<ToolOutput>; ttlMs?: number }> = [
    { name: "project", uri: ResourceUri.project, title: "Project", description: "The project as n2_get_project_info returns it (no host paths). Updated when project.n2proj is saved.", read: (ctx) => readTool("n2_get_project_info").handler(ctx, {} as never, {}) },
    { name: "scene", uri: ResourceUri.scene, title: "Open scene", description: "The open scene's path, name, revision and whether it has unsaved changes. Updated on every scene change.", read: sceneResource },
    { name: "hierarchy", uri: ResourceUri.hierarchy, title: "Scene hierarchy", description: "The first page of n2_get_hierarchy. Updated on every scene change.", read: (ctx) => readTool("n2_get_hierarchy").handler(ctx, {} as never, {}) },
    { name: "console", uri: ResourceUri.console, title: "Console", description: `The last ${limits.ConsoleResourceLines} log lines, as n2_get_console returns them. Updated at most once a second while lines arrive.`, read: (ctx) => readTool("n2_get_console").handler(ctx, { limit: limits.ConsoleResourceLines } as never, {}) },
    { name: "history", uri: ResourceUri.history, title: "Undo history", description: "The undo history: steps done and undone and the last 50 labels. Updated when a step is recorded, undone or redone.", read: historyResource },
    { name: "component-types", uri: ResourceUri.componentTypes, title: "Component types", description: "The component types the host can create, as n2_get_component_types returns them. They never change while a host runs.", read: (ctx) => readTool("n2_get_component_types").handler(ctx, {} as never, {}), ttlMs: 60000 },
  ]
  // A resource whose read tool the operator disabled (--disable-tools) is not served: the flag narrows both
  const allowed = (uri: string): boolean => resourceAllowed(bridge.policy, uri)
  for (const r of fixed) {
    if (!allowed(r.uri)) continue
    server.registerResource(
      r.name,
      r.uri,
      { title: r.title, description: r.description + Notice, mimeType: "text/plain", cacheHint: { ttlMs: r.ttlMs ?? 0, cacheScope: "private" } },
      async () => readResource(bridge, r.uri, r.read)
    )
  }
  if (!bridge.policy.disabledTools.has(EntityTool)) server.registerResource(
    "entity",
    new ResourceTemplate(EntityTemplate, { list: undefined }),
    { title: "Entity", description: "One entity as n2_get_entity returns it, by UUID. Updated when a scene change touches it (or the whole scene changed)." + Notice, mimeType: "text/plain", cacheHint: { ttlMs: 0, cacheScope: "private" } },
    async (uri) => {
      const parsed = parseResourceUri(uri.toString())
      if (parsed?.kind !== "entity") throw readFailure(new BridgeError("invalid_argument", "That is not an entity UUID.", "Use an id from n2_get_hierarchy."), bridge)
      return readResource(bridge, uri.toString(), (ctx) => readTool("n2_get_entity").handler(ctx, { entityId: parsed.id } as never, {}))
    }
  )
  if (!bridge.policy.disabledTools.has(AssetTool)) server.registerResource(
    "asset",
    new ResourceTemplate(AssetTemplate, { list: undefined }),
    { title: "Text asset", description: "A text asset's first 32 KB as n2_read_text_asset returns it: n2://asset/scripts/Player.lua is res://scripts/Player.lua. Updated when the host reports the file changed." + Notice, mimeType: "text/plain", cacheHint: { ttlMs: 0, cacheScope: "private" } },
    async (uri) => {
      const parsed = parseResourceUri(uri.toString())
      if (parsed?.kind !== "asset") throw readFailure(new BridgeError("invalid_argument", "That is not a text asset's URI.", "Use n2://asset/<path inside the assets folder>."), bridge)
      return readResource(bridge, uri.toString(), (ctx) => readTool("n2_read_text_asset").handler(ctx, { path: parsed.path } as never, {}))
    }
  )

  // resources/subscribe (2025-11-25); a 2026-07-28 client uses subscriptions/listen, which the stdio entry serves
  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } })
  const handle = (fn: (uri: string) => void) => async (request: { params: { uri: string } }) => {
    try {
      fn(request.params.uri)
    } catch (e) {
      throw readFailure(mapError(e, { command: "resources/subscribe" }, bridge.scrubber), bridge)
    }
    return {}
  }
  const inner = server.server as unknown as { setRequestHandler(method: string, handler: (request: { params: { uri: string } }) => Promise<object>): void }
  inner.setRequestHandler("resources/subscribe", handle((uri) => watch.subscribe(uri)))
  inner.setRequestHandler("resources/unsubscribe", handle((uri) => watch.unsubscribe(uri)))
  return watch.addSink((uri) => {
    if (server.isConnected()) void server.server.sendResourceUpdated({ uri }).catch(() => undefined)
  })
}
