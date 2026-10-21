// At most N tool calls in any sliding window (design 4.5: 120 a minute). The clock is a parameter for the tests.

export class RateLimiter {
  private readonly times: number[] = []

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60000,
    private readonly now: () => number = Date.now
  ) {}

  /** Counts a call and returns 0, or, when the limit is reached, the whole seconds until a call would be let through (not counted) */
  take(): number {
    const now = this.now()
    while (this.times.length > 0 && now - this.times[0] >= this.windowMs) this.times.shift()
    if (this.times.length >= this.limit) {
      return Math.max(1, Math.ceil((this.times[0] + this.windowMs - now) / 1000))
    }
    this.times.push(now)
    return 0
  }
}
