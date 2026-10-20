// How the editor waits for a host that is serving another session (ErrorCoded busy, protocol 1.13): a capped
// exponential backoff with jitter, for a bounded time. No DOM, no timers of its own: the store schedules.

/** The first wait */
export const BackoffBaseMilliseconds = 1000
/** No wait is longer than this */
export const BackoffCapMilliseconds = 15000
/** After this long without getting in, the editor stops retrying by itself and offers a Retry button */
export const GiveUpAfterMilliseconds = 120000

/**
 * The wait before retry number attempt (0 for the first): 1 s, 2 s, 4 s, 8 s, then 15 s, each cut by up to half at
 * random (random() is in [0, 1)), so clients that were turned away together do not come back together.
 */
export function backoffDelayMilliseconds(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BackoffCapMilliseconds, BackoffBaseMilliseconds * 2 ** Math.max(0, attempt))
  return Math.round(ceiling * (0.5 + 0.5 * random()))
}

/** What the connect screen shows while a busy host is retried; null in the store when nothing is */
export type BusyRetryState =
  /** The host's last answer was busy; the next try is delayMs away (attempt counts the tries made so far) */
  | { phase: "waiting"; message: string; attempt: number; delayMs: number }
  /** A try is in flight */
  | { phase: "trying"; message: string; attempt: number }
  /** The time ran out; Retry starts over */
  | { phase: "gaveUp"; message: string; attempt: number }

/** setTimeout, clearTimeout, the clock and the dice, injectable for tests */
export interface ConnectRetryOptions {
  timers?: { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
  now?: () => number
  random?: () => number
  giveUpAfterMs?: number
}
