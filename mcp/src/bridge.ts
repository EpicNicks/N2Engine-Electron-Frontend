// The bridge's core: one session with the host at a time, opened on the first tool call (not at startup: a client that
// probes with server/discover must not hold the host's one session, nor start a host), checked once for its role,
// and used by one tool call at a time (the host answers in order, and a screenshot's size is shared state).
//
// Failure handling is deliberately small: a call that finds no session opens one (and when the host is busy, waits
// busyWaitMs and tries once more); a call that the host doesn't answer within callTimeoutMs drops the session (a late
// answer would desync the request queue) and fails with `timeout`. The timed-out handler's context.signal is aborted
// (a play handler stops between steps and releases its input), and the next call waits for it to finish, at most one
// more callTimeoutMs, so two handlers never drive the game at once. Nothing reconnects in the background, and nothing
// loops.
import type { EngineClient } from "../../src/protocol/engine-client"
import { HostBusyError } from "../../src/protocol/engine-client"
import type { ComponentSchema, ProjectInfoResponse, ServerInfoResponse } from "../../src/protocol/protocol.generated"
import { BridgeAdvice, BridgeError, mapError, safeRole } from "./errors"
import { DefaultBusyWaitMs, DefaultCallTimeoutMs, MaxBusyWaitMs, RateLimitPerMinute } from "./limits"
import { RateLimiter } from "./ratelimit"
import { DefaultPolicy, type HostAccess, type Policy } from "./policy"
import type { Scrubber } from "./scrub"
import { SessionManager } from "./session"
import { PlayController, type PlayOptions } from "./play"
import type { HostConnector, HostLink } from "./host"

export interface BridgeOptions {
  connector: HostConnector
  scrubber: Scrubber
  /** Serve a host that gave this connection the admin role (default: refuse, design M5) */
  allowAdmin?: boolean
  /** The operator's write policy (flags); default: writes allowed, irreversible operations need the client's confirmation */
  policy?: Policy
  /** The agent sessions (journal, backups); default: new ones */
  sessions?: SessionManager
  busyWaitMs?: number
  callTimeoutMs?: number
  rateLimitPerMinute?: number
  /** The clock and sleep, for the tests */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** The bridge's stderr log (the scrubber is applied to every line) */
  log?: (message: string) => void
  /**
   * Play (design M9): the --launch backend's host, project and renderer, for a game of the bridge's own. Ignored by any
   * other backend, so a --connect bridge never has the play tools, whatever it is given.
   */
  play?: PlayOptions
}

/** What a tool handler gets: the open session and what was learned when it opened */
export interface HostContext {
  client: EngineClient
  info: ServerInfoResponse
  scrubber: Scrubber
  /** "launch", "connect" or "electron" */
  backend: string
  /** The project as the host reported it at connect (null when the host has none) */
  project: ProjectInfoResponse | null
  /** GetComponentTypes, asked once per session (the types never change while a host runs) */
  componentTypes(): Promise<ComponentSchema[]>
  /** What the tools remember for the length of this session with the host */
  session: SessionState
  /** The operator's write policy and the agent sessions (these outlive a connection to the host) */
  policy: Policy
  sessions: SessionManager
  allowAdmin: boolean
  /** Set by the server when an irreversible operation was allowed, for the journal */
  consent: "elicited" | "operator" | "native" | null
  /** The bridge's game (the --launch backend only), else null */
  play: PlayController | null
  /** Aborted when the bridge gives up on this call (callTimeoutMs): a long handler stops at its next check */
  signal: AbortSignal
}

export interface SessionState {
  /** The viewport size the bridge last set (the host's own default is 1280x720 until then) */
  viewport: { width: number; height: number } | null
}

export class Bridge {
  private link: (HostLink & { closedByHost: boolean; project: ProjectInfoResponse | null; types: ComponentSchema[] | null; session: SessionState }) | null = null
  private refused: BridgeError | null = null
  /** The host closed the last session by itself (not the bridge): with `yield`, a person took the host. Cleared on connect. */
  private endedByHost = false
  /** Consecutive busy answers, for the growing wait before a retry; cleared on connect */
  private busyStreak = 0
  private tail: Promise<unknown> = Promise.resolve()
  private readonly limiter: RateLimiter
  readonly scrubber: Scrubber
  private readonly sleep: (ms: number) => Promise<void>
  readonly policy: Policy
  readonly sessions: SessionManager
  /** What the last host connection reported (null before the first one): the write tools' listing depends on it */
  private access: HostAccess | null = null
  private readonly connectListeners = new Set<(access: HostAccess) => void>()
  /** The game of the --launch backend; null for any other backend */
  readonly play: PlayController | null

  constructor(private readonly options: BridgeOptions) {
    this.scrubber = options.scrubber
    this.policy = options.policy ?? DefaultPolicy
    this.sessions = options.sessions ?? new SessionManager({ maxWrites: this.policy.maxWrites })
    this.limiter = new RateLimiter(options.rateLimitPerMinute ?? RateLimitPerMinute, 60000, options.now)
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.play = options.play && options.connector.kind === "launch" ? new PlayController(options.play, this.scrubber, (m) => this.log(m)) : null
  }

  get backend(): string {
    return this.options.connector.kind
  }

  /** The host asks the person about irreversible operations itself (the --electron backend) */
  get confirmsNatively(): boolean {
    return this.options.connector.confirmsNatively === true
  }

  get allowAdmin(): boolean {
    return this.options.allowAdmin === true
  }

  /** The role and read-only flag the host last reported, or null before the first connection */
  get hostAccess(): HostAccess | null {
    return this.access
  }

  /** Calls fn with the access each time a host connection opens (the server lists the write tools from it); returns the remover */
  onConnect(fn: (access: HostAccess) => void): () => void {
    this.connectListeners.add(fn)
    return () => this.connectListeners.delete(fn)
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
    // A timed-out handler may still be running: the queue moves on only when it has finished (bounded)
    let abandoned: Promise<unknown> = Promise.resolve()
    const onAbandon = (p: Promise<unknown>): void => {
      abandoned = p
    }
    const result = this.tail.then(
      () => this.execute(fn, command, onAbandon),
      () => this.execute(fn, command, onAbandon)
    )
    this.tail = result.then(
      () => abandoned,
      () => abandoned
    )
    return result
  }

  private async execute<T>(fn: (context: HostContext) => Promise<T>, command: string | undefined, onAbandon: (settled: Promise<unknown>) => void): Promise<T> {
    const link = await this.ensureLink()
    const abort = new AbortController()
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
      policy: this.policy,
      sessions: this.sessions,
      allowAdmin: this.allowAdmin,
      consent: null,
      play: this.play,
      signal: abort.signal,
    }
    const timeoutMs = this.options.callTimeoutMs ?? DefaultCallTimeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    let work: Promise<T> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort()
        if (work !== null) onAbandon(settledWithin(work, timeoutMs))
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
      work = fn(context)
      return await Promise.race([work, timeout])
    } catch (e) {
      // The host closed the session under a yielding bridge: a person arrived. Say so, not "connection dropped".
      if (this.options.connector.yields === true && link.closedByHost && !(e instanceof BridgeError)) {
        this.log("the host ended the session (a person or another client that does not yield connected); the bridge yields")
        throw new BridgeError("busy", "The host ended the bridge's session (most likely a person, or another client that does not yield, took the host).", BridgeAdvice.yieldPreempted, undefined, e)
      }
      throw mapError(e, { role: safeRole(link.info.role), command }, this.scrubber)
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
      // Busy: the person's editor (or another agent) holds the host. Wait once, then say so. The wait doubles with each
      // busy answer in a row (up to MaxBusyWaitMs), so a bridge that yields does not knock on a busy host at a steady pace.
      const base = Math.min(this.options.busyWaitMs ?? DefaultBusyWaitMs, MaxBusyWaitMs)
      const wait = Math.min(base * 2 ** Math.min(this.busyStreak, 10), MaxBusyWaitMs)
      this.busyStreak++
      this.log(`the host is busy; waiting ${wait} ms for one more try`)
      await this.sleep(wait)
      try {
        opened = await this.connectOnce()
      } catch (again) {
        if (again instanceof HostBusyError) this.busyStreak++
        throw this.logged(again)
      }
    }
    this.busyStreak = 0
    this.endedByHost = false
    // Only a viewer or an editor is served. An admin (every right, and it would preempt a person's session) is refused, and
    // so is a host that reports no known role: its rights can't be known, so they are taken to be an admin's.
    const role = safeRole(opened.info.role)
    if (role !== "viewer" && role !== "editor" && !this.options.allowAdmin) {
      opened.client.close()
      this.refused = new BridgeError(
        "admin_refused",
        role === "admin"
          ? "The host gave the bridge the admin role, which it refuses to serve."
          : "The host did not report a viewer or editor role for the bridge, which it refuses to serve.",
        BridgeAdvice.admin
      )
      this.log(`refusing to serve: the host gave this connection ${role === "admin" ? "the admin role" : "no viewer or editor role"} (start the bridge with --allow-admin to allow it)`)
      throw this.refused
    }
    let project: ProjectInfoResponse | null = null
    try {
      const ms = this.options.callTimeoutMs ?? DefaultCallTimeoutMs
      let timer: ReturnType<typeof setTimeout> | undefined
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BridgeError("timeout", `The host did not answer within ${Math.round(ms / 1000)} s.`, BridgeAdvice.timeout)), ms)
      })
      try {
        project = await Promise.race([opened.client.getProjectInfo(), stalled])
      } finally {
        clearTimeout(timer)
      }
      this.scrubber.setRoots(project.rootPath, project.userDataPath)
    } catch (e) {
      if (e instanceof BridgeError && e.code === "timeout") {
        opened.client.close()
        throw e
      }
      // A host without a project has none to describe; the tools say so
    }
    const link = Object.assign(opened, { project, types: null as ComponentSchema[] | null, session: { viewport: null } as SessionState, closedByHost: false })
    opened.client.onClose(() => {
      if (this.link === link) {
        // Not closed by the bridge (dropLink and dispose clear this.link first): the host or the network ended it
        this.link = null
        link.closedByHost = true
        this.endedByHost = true
      }
    })
    this.link = link
    this.access = { role: safeRole(opened.info.role), readOnly: opened.info.readOnly }
    for (const listener of this.connectListeners) {
      try {
        listener(this.access)
      } catch {
        // a listener must not break the connection
      }
    }
    this.log(`connected to the ${this.options.connector.kind} host (protocol ${opened.info.protocolVersion}, role ${opened.info.role}${opened.info.readOnly ? ", read-only" : ""})`)
    return link
  }

  private connectOnce(): Promise<HostLink> {
    return this.options.connector.connect()
  }

  /** Logs a failure's cause (scrubbed) and returns its BridgeError */
  private logged(error: unknown): BridgeError {
    const mapped = this.mapConnectError(error)
    const cause = mapped.cause instanceof Error ? mapped.cause.message : mapped.cause === undefined ? "" : String(mapped.cause)
    this.log(`connecting failed: ${mapped.code}${cause ? ` (${cause})` : ""}`)
    return mapped
  }

  /** A failure to open a session; a busy host reads differently to a bridge that yields */
  private mapConnectError(error: unknown): BridgeError {
    if (error instanceof HostBusyError && this.options.connector.yields === true) {
      const holder = error.holderRole ? ` (${/^[aeiou]/.test(error.holderRole) ? "an" : "a"} ${error.holderRole} session)` : ""
      const earlier = this.endedByHost ? " The host ended the bridge's earlier session for it." : ""
      return new BridgeError(
        "busy",
        `The host is serving a human or another session${holder}; the bridge yields to humans and does not take the host.${earlier}`,
        BridgeAdvice.yieldBusy,
        undefined,
        error
      )
    }
    return mapError(error, {}, this.scrubber)
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
    this.play?.dispose()
    this.options.connector.dispose()
    this.sessions.dispose()
  }
}

/** Resolves when p settles or after ms, whichever is first (the timer does not keep the process alive) */
function settledWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    p.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      () => {
        clearTimeout(timer)
        resolve()
      }
    )
  })
}
