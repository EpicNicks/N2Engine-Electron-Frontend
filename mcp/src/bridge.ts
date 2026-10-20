// The bridge's core: one session with the host at a time, opened on the first tool call (not at startup: a client that
// probes with server/discover must not hold the host's one session, nor start a host), checked once for its role,
// and used by one tool call at a time (the host answers in order, and a screenshot's size is shared state).
//
// Failure handling is deliberately small: a call that finds no session opens one (and when the host is busy, waits
// busyWaitMs and tries once more); a call that the host doesn't answer within callTimeoutMs drops the session (a late
// answer would desync the request queue) and fails with `timeout`. Nothing reconnects in the background, and nothing
// loops.
import type { EngineClient } from "../../src/protocol/engine-client"
import { HostBusyError } from "../../src/protocol/engine-client"
import type { ComponentSchema, ProjectInfoResponse, ServerInfoResponse } from "../../src/protocol/protocol.generated"
import { BridgeAdvice, BridgeError, mapError } from "./errors"
import { DefaultBusyWaitMs, DefaultCallTimeoutMs, MaxBusyWaitMs, RateLimitPerMinute } from "./limits"
import { RateLimiter } from "./ratelimit"
import type { Scrubber } from "./scrub"
import type { HostConnector, HostLink } from "./host"

export interface BridgeOptions {
  connector: HostConnector
  scrubber: Scrubber
  /** Serve a host that gave this connection the admin role (default: refuse, design M5) */
  allowAdmin?: boolean
  busyWaitMs?: number
  callTimeoutMs?: number
  rateLimitPerMinute?: number
  /** The clock and sleep, for the tests */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** The bridge's stderr log (the scrubber is applied to every line) */
  log?: (message: string) => void
}

/** What a tool handler gets: the open session and what was learned when it opened */
export interface HostContext {
  client: EngineClient
  info: ServerInfoResponse
  scrubber: Scrubber
  /** "launch" or "connect" */
  backend: string
  /** The project as the host reported it at connect (null when the host has none) */
  project: ProjectInfoResponse | null
  /** GetComponentTypes, asked once per session (the types never change while a host runs) */
  componentTypes(): Promise<ComponentSchema[]>
  /** What the tools remember for the length of this session with the host */
  session: SessionState
}

export interface SessionState {
  /** The viewport size the bridge last set (the host's own default is 1280x720 until then) */
  viewport: { width: number; height: number } | null
}

export class Bridge {
  private link: (HostLink & { project: ProjectInfoResponse | null; types: ComponentSchema[] | null; session: SessionState }) | null = null
  private refused: BridgeError | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private readonly limiter: RateLimiter
  readonly scrubber: Scrubber
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: BridgeOptions) {
    this.scrubber = options.scrubber
    this.limiter = new RateLimiter(options.rateLimitPerMinute ?? RateLimitPerMinute, 60000, options.now)
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  get backend(): string {
    return this.options.connector.kind
  }

  /** Seconds to wait when the rate limit is reached (the call is not let through), else 0 */
  rateLimited(): number {
    return this.limiter.take()
  }

  /** A line for the bridge's stderr log (scrubbed) */
  log(message: string): void {
    this.options.log?.(this.scrubber.message(message, 500))
  }

  /** Runs fn with the session, alone: after every earlier call has finished */
  run<T>(fn: (context: HostContext) => Promise<T>, command?: string): Promise<T> {
    const result = this.tail.then(
      () => this.execute(fn, command),
      () => this.execute(fn, command)
    )
    this.tail = result.catch(() => undefined)
    return result
  }

  private async execute<T>(fn: (context: HostContext) => Promise<T>, command?: string): Promise<T> {
    const link = await this.ensureLink()
    const context: HostContext = {
      client: link.client,
      info: link.info,
      scrubber: this.scrubber,
      backend: this.options.connector.kind,
      project: link.project,
      componentTypes: async () => {
        link.types ??= await link.client.getComponentTypes()
        return link.types
      },
      session: link.session,
    }
    const timeoutMs = this.options.callTimeoutMs ?? DefaultCallTimeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.dropLink(link)
        reject(
          new BridgeError(
            "timeout",
            `The host did not answer within ${Math.round(timeoutMs / 1000)} s.`,
            BridgeAdvice.timeout
          )
        )
      }, timeoutMs)
    })
    try {
      return await Promise.race([fn(context), timeout])
    } catch (e) {
      throw mapError(e, { role: link.info.role, command }, this.scrubber)
    } finally {
      clearTimeout(timer)
    }
  }

  private dropLink(link: HostLink): void {
    if (this.link === link) this.link = null
    link.client.close()
  }

  private async ensureLink(): Promise<NonNullable<Bridge["link"]>> {
    if (this.refused) throw this.refused
    if (this.link && this.link.client.isConnected) return this.link
    this.link = null
    let opened: HostLink
    try {
      opened = await this.connectOnce()
    } catch (e) {
      if (!(e instanceof HostBusyError)) throw this.logged(e)
      // Busy: the person's editor (or another agent) holds the host. Wait once, then say so.
      const wait = Math.min(this.options.busyWaitMs ?? DefaultBusyWaitMs, MaxBusyWaitMs)
      this.log(`the host is busy; waiting ${wait} ms for one more try`)
      await this.sleep(wait)
      try {
        opened = await this.connectOnce()
      } catch (again) {
        throw this.logged(again)
      }
    }
    if (opened.info.role === "admin" && !this.options.allowAdmin) {
      opened.client.close()
      this.refused = new BridgeError(
        "admin_refused",
        "The host gave the bridge the admin role, which it refuses to serve.",
        BridgeAdvice.admin
      )
      this.log("refusing to serve: the host gave this connection the admin role (start the bridge with --allow-admin to allow it)")
      throw this.refused
    }
    let project: ProjectInfoResponse | null = null
    try {
      project = await opened.client.getProjectInfo()
      this.scrubber.setRoots(project.rootPath, project.userDataPath)
    } catch {
      // A host without a project has none to describe; the tools say so
    }
    const link = Object.assign(opened, { project, types: null as ComponentSchema[] | null, session: { viewport: null } as SessionState })
    opened.client.onClose(() => {
      if (this.link === link) this.link = null
    })
    this.link = link
    this.log(`connected to the ${this.options.connector.kind} host (protocol ${opened.info.protocolVersion}, role ${opened.info.role}${opened.info.readOnly ? ", read-only" : ""})`)
    return link
  }

  private connectOnce(): Promise<HostLink> {
    return this.options.connector.connect()
  }

  /** Logs a failure's cause (scrubbed) and returns its BridgeError */
  private logged(error: unknown): BridgeError {
    const mapped = mapError(error, {}, this.scrubber)
    const cause = mapped.cause instanceof Error ? mapped.cause.message : mapped.cause === undefined ? "" : String(mapped.cause)
    this.log(`connecting failed: ${mapped.code}${cause ? ` (${cause})` : ""}`)
    return mapped
  }

  /** Closes the session and ends what the connector started. Safe to call twice. */
  dispose(): void {
    const link = this.link
    this.link = null
    try {
      link?.client.close()
    } catch {
      // closing is best effort
    }
    this.options.connector.dispose()
  }
}
