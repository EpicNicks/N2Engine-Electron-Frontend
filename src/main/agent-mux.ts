// Shares the editor's one engine connection between the person and an AI agent (MCP6). Node only (no Electron), so it is
// unit tested.
//
// The person's own requests (everything the page sends through window.engine) go through `human`; the agent's go through
// `agent`. The rules:
//  - The person's requests run at once, as they always did, unless an agent job is running or an agent holds the lease.
//    Then they wait (a bounded queue) and run, all of them, as soon as the agent is done: between agent calls the person
//    always goes first.
//  - An agent job starts only when no request of the person is in flight or waiting. Before the first job of a turn the
//    page is asked to settle (`prepare`: its pending inspector edits are sent and its edit groups ended), and the person's
//    requests are let through during that, because settling is made of them. Agent jobs run one at a time, in order.
//  - A job can take the LEASE (an open edit group of the agent, a view the agent changed). While the agent holds it, the
//    person's requests keep waiting and the agent's next jobs start at once, with no new settling: the agent's group is
//    contiguous in the history and nothing of the person's lands inside it. A lease the agent leaves idle is ended after
//    leaseIdleMs (`expire` closes the groups and restores the view), and so is one whose agent disconnects.
//  - Every queue is bounded; a job that cannot start within waitMs fails with "busy".
export class MuxError extends Error {
  constructor(
    readonly code: "queueFull" | "busy" | "closed" | "prepareFailed",
    message: string
  ) {
    super(message)
    this.name = "MuxError"
  }
}

export interface Lease {
  /** Keep the lane for the agent after this job (an edit group or a changed view is open) */
  hold(): void
  /** Give the lane back after this job */
  release(): void
  readonly held: boolean
}

export interface MuxOptions {
  /** Settles the page's pending edits and ends its edit groups; rejects when it cannot */
  prepare(): Promise<void>
  /** Closes what the agent left open (its groups, its view); runs with the lane, when a lease is idle or the agent leaves */
  expire(): Promise<void>
  /** The lane went back to the person after agent work */
  released?(): void
  maxAgentQueue?: number
  maxHumanQueue?: number
  /** How long an agent job waits for the lane (default 30 s) */
  waitMs?: number
  /** How long the agent may leave the lane held without sending a request (default 5 s) */
  leaseIdleMs?: number
  log?(message: string): void
}

interface AgentJob {
  run(lease: Lease): Promise<unknown>
  resolve(value: unknown): void
  reject(error: unknown): void
  timer: ReturnType<typeof setTimeout> | undefined
}

interface HumanJob {
  run(): Promise<unknown>
  resolve(value: unknown): void
  reject(error: unknown): void
}

export class Multiplexer {
  private humanInflight = 0
  private readonly humanQueue: HumanJob[] = []
  private readonly agentQueue: AgentJob[] = []
  /** An agent job (or expire) is running, or the page is being settled for one */
  private agentActive = false
  /** The page is being settled: the person's requests pass, they are what settling is made of */
  private preparing = false
  private leaseHeld = false
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private drainWaiters: Array<() => void> = []

  constructor(private readonly options: MuxOptions) {}

  /** The agent holds the lane between its jobs */
  get leased(): boolean {
    return this.leaseHeld
  }

  /** For the tests and the status: how many requests wait */
  get waiting(): { human: number; agent: number } {
    return { human: this.humanQueue.length, agent: this.agentQueue.length }
  }

  /** A request of the person */
  human<T>(run: () => Promise<T>): Promise<T> {
    if (!this.agentBlocksHumans()) return this.startHuman(run)
    if (this.humanQueue.length >= (this.options.maxHumanQueue ?? 1024)) {
      return Promise.reject(new MuxError("queueFull", "Too many requests are waiting for the AI agent's call to finish"))
    }
    return new Promise<T>((resolve, reject) => {
      this.humanQueue.push({ run, resolve: resolve as (v: unknown) => void, reject })
    })
  }

  /** A job of the agent. It gets a Lease to keep the lane with. */
  agent<T>(run: (lease: Lease) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new MuxError("closed", "The AI agent's connection is closed"))
    if (this.agentQueue.length >= (this.options.maxAgentQueue ?? 8)) {
      return Promise.reject(new MuxError("queueFull", "Too many AI agent requests are waiting"))
    }
    return new Promise<T>((resolve, reject) => {
      const job: AgentJob = { run: run as AgentJob["run"], resolve: resolve as (v: unknown) => void, reject, timer: undefined }
      job.timer = setTimeout(() => {
        const at = this.agentQueue.indexOf(job)
        if (at < 0) return
        this.agentQueue.splice(at, 1)
        reject(new MuxError("busy", "The editor stayed busy with the person's own work"))
      }, this.options.waitMs ?? 30000)
      job.timer.unref?.()
      this.agentQueue.push(job)
      this.clearIdle()
      this.pump()
    })
  }

  /**
   * The agent is gone: waiting jobs fail, and a held lease is ended (expire runs, then the person's waiting requests do).
   * New agent jobs are refused until open() is called.
   */
  async close(): Promise<void> {
    this.closed = true
    for (const job of this.agentQueue.splice(0)) {
      clearTimeout(job.timer)
      job.reject(new MuxError("closed", "The AI agent's connection is closed"))
    }
    this.clearIdle()
    if (this.leaseHeld && !this.agentActive) await this.expireNow()
    // A job still running ends by itself; the lease it holds is ended below
    await this.whenIdle()
    if (this.leaseHeld) await this.expireNow()
  }

  open(): void {
    this.closed = false
  }

  // ---- internals

  private agentBlocksHumans(): boolean {
    return (this.agentActive && !this.preparing) || this.leaseHeld
  }

  private startHuman<T>(run: () => Promise<T>): Promise<T> {
    this.humanInflight++
    let result: Promise<T>
    try {
      result = run()
    } catch (e) {
      result = Promise.reject(e)
    }
    return result.finally(() => {
      this.humanInflight--
      this.pump()
      if (this.humanInflight === 0) this.flushDrain()
    })
  }

  private flushDrain(): void {
    for (const w of this.drainWaiters.splice(0)) w()
  }

  private humansDrained(): Promise<void> {
    if (this.humanInflight === 0) return Promise.resolve()
    return new Promise((resolve) => this.drainWaiters.push(resolve))
  }

  private whenIdle(): Promise<void> {
    if (!this.agentActive) return Promise.resolve()
    return new Promise((resolve) => {
      const check = (): void => {
        if (!this.agentActive) resolve()
        else setTimeout(check, 5)
      }
      check()
    })
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private armIdle(): void {
    this.clearIdle()
    if (!this.leaseHeld) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.leaseHeld && !this.agentActive && this.agentQueue.length === 0) {
        this.options.log?.("the AI agent left an edit group or view open; ending it")
        void this.expireNow()
      }
    }, this.options.leaseIdleMs ?? 5000)
    this.idleTimer.unref?.()
  }

  private async expireNow(): Promise<void> {
    if (this.agentActive) return
    this.agentActive = true
    try {
      await this.options.expire()
    } catch (e) {
      this.options.log?.(`ending the AI agent's open work failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      this.leaseHeld = false
      this.agentActive = false
      this.options.released?.()
      this.pump()
    }
  }

  private pump(): void {
    if (this.agentActive) return
    // The person goes first: everything that waited for the agent runs now
    if (!this.leaseHeld && this.humanQueue.length > 0) {
      for (const job of this.humanQueue.splice(0)) {
        this.startHuman(job.run).then(job.resolve, job.reject)
      }
    }
    if (this.agentQueue.length === 0) return
    if (!this.leaseHeld && (this.humanInflight > 0 || this.humanQueue.length > 0)) return
    const job = this.agentQueue.shift()!
    clearTimeout(job.timer)
    void this.execute(job)
  }

  private async execute(job: AgentJob): Promise<void> {
    this.agentActive = true
    const wasLeased = this.leaseHeld
    let hold = wasLeased
    const lease: Lease = {
      hold: () => {
        hold = true
      },
      release: () => {
        hold = false
      },
      get held() {
        return hold
      },
    }
    try {
      if (!wasLeased) {
        this.preparing = true
        try {
          await this.options.prepare()
        } catch (e) {
          throw new MuxError("prepareFailed", `The editor could not settle its own edits first: ${e instanceof Error ? e.message : String(e)}`)
        } finally {
          this.preparing = false
        }
        // Whatever the person sent while the page was settling finishes before the agent's call starts
        await this.humansDrained()
      }
      job.resolve(await job.run(lease))
    } catch (e) {
      job.reject(e)
    } finally {
      this.leaseHeld = hold
      this.agentActive = false
      if (!hold) this.options.released?.()
      this.armIdle()
      this.pump()
    }
  }
}
