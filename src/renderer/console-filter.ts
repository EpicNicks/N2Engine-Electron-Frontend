// The console's filters with no state and no DOM: the source registry, the text matcher (plain or regular expression,
// with the ranges to highlight), filtering the lines and collapsing repeats. Unit tested in Node.
import type { ConsoleEntry, LogLevel } from "./console-store"
import { compileProgram, exec, UnsupportedPattern, type Program } from "./safe-regex"

// ==================== Sources ====================

/** Where a line came from, as a filter names it */
export interface ConsoleSource {
  id: string
  label: string
}

/**
 * The sources the console knows. The engine's log events carry no category or tag today (the roadmap's U20: a
 * category field is deferred), and its lines have no prefix convention to read one from, so a source is not guessed
 * from the text of a line: it is the one the line was added with (ConsoleEntry.source). A feature that adds lines
 * from another place registers its source once (E-X4: `consoleSources.register({ id: "extension", label: "Extension" })`)
 * and adds its entries with that id.
 */
export class ConsoleSourceRegistry {
  private readonly list: ConsoleSource[] = []

  constructor(initial: readonly ConsoleSource[] = []) {
    for (const source of initial) this.register(source)
  }

  /** Adds a source, or replaces the label of one with that id (so registering twice is harmless) */
  register(source: ConsoleSource): void {
    const at = this.list.findIndex((existing) => existing.id === source.id)
    if (at >= 0) this.list[at] = source
    else this.list.push(source)
  }

  /** The sources in registration order */
  all(): readonly ConsoleSource[] {
    return this.list
  }

  has(id: string): boolean {
    return this.list.some((source) => source.id === id)
  }
}

/** The source an entry counts as: its own when registered, else the host's (an unknown source is the engine's) */
export function sourceOf(registry: ConsoleSourceRegistry, entry: Pick<ConsoleEntry, "source">): string {
  return registry.has(entry.source) ? entry.source : "host"
}

/** The page's registry: the host's log, the game's, and the editor's own notes */
export const consoleSources = new ConsoleSourceRegistry([
  { id: "host", label: "Host" },
  { id: "game", label: "Game" },
  { id: "editor", label: "Editor" },
])

// ==================== The text filter ====================

/** What the text filter is */
export interface TextFilter {
  search: string
  matchCase: boolean
  regex: boolean
}

/** A pattern longer than this is refused (a regex this long is not a filter) */
export const MaxPatternLength = 200
/** A regex is tried on at most this much of a line (the matcher is linear in it, so a line costs a bounded amount) */
export const MaxRegexInput = 4096
/**
 * Highlighting runs the matcher once per match, and each run can look past the end of its match (a higher-priority
 * thread may still be alive), so finding every match of a line is not linear. After the first match, the steps for
 * one line's highlighting are capped at this many per character of the line; past it the matches found so far are the
 * highlight.
 */
export const HighlightStepsPerChar = 64
/**
 * The matcher is linear in a line, but thousands of lines of 4096 characters with a pattern of hundreds of steps add
 * up, and the log keeps arriving, so a matcher's work draws on two buckets of steps: one for testing the lines, one for
 * highlighting the rows, kept apart so that highlighting can never starve the filter. A bucket holds at most its size,
 * so the two sizes together (MaxUpdateSteps) are the most one update can spend however many passes it makes, and each
 * refills at its rate, so the two rates together (RegexStepsPerSecond) are the most the filter spends on average while
 * lines stream in. Testing that runs its bucket dry turns the regular expression off for the pattern
 * (TextMatcher.slow); highlighting that runs its bucket dry only stops marking. The numbers are justified in the README.
 */
export const MaxTestSteps = 15_000_000
/** The testing bucket's refill rate in steps per second */
export const TestStepsPerSecond = 3_000_000
/** The highlighting bucket's size (see MaxTestSteps) */
export const MaxHighlightSteps = 5_000_000
/** The highlighting bucket's refill rate in steps per second */
export const HighlightStepsPerSecond = 1_000_000
/** The most one update can spend: both buckets full */
export const MaxUpdateSteps = MaxTestSteps + MaxHighlightSteps
/** The most the filter spends per second on average: both refill rates */
export const RegexStepsPerSecond = TestStepsPerSecond + HighlightStepsPerSecond
/** The highlights remembered per matcher (a render asks again for every row; it is cleared when it is this full) */
const MaxRangeCache = 6000

/** Which of a list of lines pass the text filter: one result shared by the list and both kinds of count */
export interface TextResults {
  /** Whether the entry passes (asked only for the entries the results were made from) */
  passes(entry: ConsoleEntry): boolean
  /** The regular expression ran its testing bucket dry and is off for this pattern: every line passes */
  slow: boolean
}

export interface TextMatcher {
  /** Whether the line passes (everything passes when there is no text, when the regex is not valid, or when it is slow) */
  test(message: string): boolean
  /**
   * Tests the lines once for the list and the counts together. A line this matcher has tested is remembered, so only
   * new lines cost steps; if the testing bucket runs dry part way the matcher turns slow and every line passes.
   */
  testEntries(entries: readonly ConsoleEntry[]): TextResults
  /** [start, end) ranges of the matches in the message, in order, for highlighting; none without text */
  ranges(message: string): Array<[number, number]>
  /** Why the regular expression isn't valid (shown inline); null when it is, or when regex is off */
  error: string | null
  /** The regular expression ran its testing bucket dry and is off for this pattern (editing the pattern tries again) */
  readonly slow: boolean
  /** The matcher steps spent so far (the buckets bound it; for tests) */
  readonly spent: number
  /** The filter does something */
  active: boolean
}

/** A clock in milliseconds (performance.now by default; tests pass their own) */
export type Clock = () => number

/** Steps to spend: full when made, refilled for the time since it was last drawn on, never over full */
class StepBucket {
  left: number
  private filled: number
  constructor(
    private readonly size: number,
    private readonly perSecond: number,
    private readonly clock: Clock
  ) {
    this.left = size
    this.filled = clock()
  }
  refill(): void {
    const now = this.clock()
    if (now > this.filled) this.left = Math.min(this.size, this.left + ((now - this.filled) * this.perSecond) / 1000)
    this.filled = now
  }
}

const allPass: TextResults = { passes: () => true, slow: false }
const slowResults: TextResults = { passes: () => true, slow: true }

const passAll: TextMatcher = {
  test: () => true,
  testEntries: () => allPass,
  ranges: () => [],
  error: null,
  slow: false,
  spent: 0,
  active: false,
}

export function compileMatcher(filter: TextFilter, clock: Clock = () => performance.now()): TextMatcher {
  const { search, matchCase, regex } = filter
  if (search === "") return passAll
  if (!regex) {
    const fold = (text: string) => (matchCase ? text : text.toLowerCase())
    const needle = fold(search)
    const test = (message: string) => fold(message).includes(needle)
    return {
      test,
      testEntries: () => ({ passes: (entry) => test(entry.message), slow: false }),
      ranges(message) {
        const hay = fold(message)
        const out: Array<[number, number]> = []
        for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
          out.push([at, at + needle.length])
        }
        return out
      },
      error: null,
      slow: false,
      spent: 0,
      active: true,
    }
  }
  let program: Program
  try {
    if (search.length > MaxPatternLength) throw new Error(`The pattern is longer than ${MaxPatternLength} characters`)
    // The engine's RegExp only checks the syntax (compiling runs no match, so it cannot hang) and gives its message;
    // the matching is the linear-time matcher's, which has no backtracking to blow up (safe-regex.ts)
    new RegExp(search, matchCase ? "" : "i")
    program = compileProgram(search, !matchCase)
  } catch (e) {
    // Half-typed patterns are normal: they filter nothing (the list doesn't flash empty) and the reason shows inline
    const reason = e instanceof UnsupportedPattern ? `Not supported in the filter: ${e.message}` : e instanceof Error ? e.message : String(e)
    return { ...passAll, error: reason }
  }
  const limited = (message: string) => (message.length > MaxRegexInput ? message.slice(0, MaxRegexInput) : message)
  let slow = false
  let spent = 0
  const testing = new StepBucket(MaxTestSteps, TestStepsPerSecond, clock)
  const highlighting = new StepBucket(MaxHighlightSteps, HighlightStepsPerSecond, clock)
  let cache = new Map<string, Array<[number, number]>>()
  const tested = new WeakMap<ConsoleEntry, boolean>()
  // One run of the matcher with at most `allowed` steps, taken from the bucket; dry when it ran out
  const run = (bucket: StepBucket, text: string, from: number, firstOnly: boolean, allowed: number) => {
    const cap = Math.max(0, Math.floor(allowed))
    const budget = { left: cap }
    const m = exec(program, text, from, firstOnly, budget)
    const used = cap - Math.max(budget.left, 0)
    spent += used
    bucket.left -= used
    return { m, used, dry: budget.left < 0 }
  }
  // Tests one line; null when the testing bucket ran dry (the matcher is slow from then on)
  const testOne = (message: string): boolean | null => {
    const r = run(testing, limited(message), 0, true, testing.left)
    if (!r.dry) return r.m !== null
    slow = true
    cache = new Map()
    return null
  }
  return {
    test(message) {
      if (slow) return true
      testing.refill()
      return testOne(message) ?? true
    },
    testEntries(entries) {
      if (slow) return slowResults
      testing.refill()
      for (const entry of entries) {
        if (tested.has(entry)) continue
        const passes = testOne(entry.message)
        if (passes === null) return slowResults
        tested.set(entry, passes)
      }
      return { passes: (entry) => tested.get(entry) ?? true, slow: false }
    },
    ranges(message) {
      if (slow) return []
      const hit = cache.get(message)
      if (hit) return hit
      highlighting.refill()
      const text = limited(message)
      const out: Array<[number, number]> = []
      let line = Infinity // the first match is limited by the bucket only, the rest by the line too
      let final = true // false when the bucket cut the line short: it is asked again on a later render
      for (let from = 0; from <= text.length; ) {
        const r = run(highlighting, text, from, false, Math.min(highlighting.left, line))
        line = line === Infinity ? HighlightStepsPerChar * (text.length + 1) - r.used : line - r.used
        if (r.dry) {
          final = highlighting.left > 0
          break
        }
        const m = r.m
        if (m === null) break
        if (m[1] === m[0]) from = m[0] + 1 // an empty match is not highlighted and must not loop
        else {
          out.push(m)
          from = m[1]
        }
      }
      if (final) {
        if (cache.size >= MaxRangeCache) cache = new Map()
        cache.set(message, out)
      }
      return out
    },
    error: null,
    get slow() {
      return slow
    },
    get spent() {
      return spent
    },
    active: true,
  }
}

/** A message cut at the ranges: pieces with whether each is a match, for rendering a highlight */
export function highlightPieces(
  message: string,
  ranges: ReadonlyArray<[number, number]>
): Array<{ text: string; match: boolean }> {
  const pieces: Array<{ text: string; match: boolean }> = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start > at) pieces.push({ text: message.slice(at, start), match: false })
    pieces.push({ text: message.slice(start, end), match: true })
    at = end
  }
  if (at < message.length) pieces.push({ text: message.slice(at), match: false })
  return pieces
}

// ==================== Filtering and collapsing ====================

/** The filters that pick lines (the levels are applied separately) */
export interface LineFilter {
  hiddenSources: ReadonlySet<string>
  /** The text filter's results for the lines (TextMatcher.testEntries), shared by the list and the counts */
  text: TextResults
}

/** Whether the line passes the source and text filters (not the levels) */
export function passesLine(registry: ConsoleSourceRegistry, entry: ConsoleEntry, filter: LineFilter): boolean {
  return !filter.hiddenSources.has(sourceOf(registry, entry)) && filter.text.passes(entry)
}

/** The lines with their levels shown, passing the source and text filters */
export function filterEntries(
  registry: ConsoleSourceRegistry,
  entries: readonly ConsoleEntry[],
  shown: Readonly<Record<LogLevel, boolean>>,
  filter: LineFilter
): ConsoleEntry[] {
  return entries.filter((entry) => shown[entry.level] && passesLine(registry, entry, filter))
}

/**
 * How many lines each level has among those that pass the source and text filters (the level toggles don't count, so a
 * level that is switched off still says how many lines it would add). Lines, not rows: collapsing doesn't change it.
 */
export function countLevels(
  registry: ConsoleSourceRegistry,
  entries: readonly ConsoleEntry[],
  filter: LineFilter
): Record<LogLevel, number> {
  const counts: Record<LogLevel, number> = { info: 0, warn: 0, error: 0 }
  for (const entry of entries) if (passesLine(registry, entry, filter)) counts[entry.level]++
  return counts
}

/** Lines per source among those passing the level and text filters (a source switched off still counts) */
export function countSources(
  registry: ConsoleSourceRegistry,
  entries: readonly ConsoleEntry[],
  shown: Readonly<Record<LogLevel, boolean>>,
  text: TextResults
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of entries) {
    if (!shown[entry.level] || !text.passes(entry)) continue
    const id = sourceOf(registry, entry)
    counts[id] = (counts[id] ?? 0) + 1
  }
  return counts
}

/** One row of the list: a line, and how many identical lines in a row it stands for */
export interface ConsoleRow {
  /** The first of the repeated lines (its id is the row's key, which stays the same as the count grows) */
  entry: ConsoleEntry
  count: number
  /** The time of the last of them */
  lastTime: number
}

/** Rows without collapsing: one per line */
export const plainRows = (entries: readonly ConsoleEntry[]): ConsoleRow[] =>
  entries.map((entry) => ({ entry, count: 1, lastTime: entry.time }))

/**
 * Consecutive lines with the same level, source and text become one row with a count. "Consecutive" is among the
 * lines shown, so a line a filter hides doesn't split a run.
 */
export function collapseRepeats(entries: readonly ConsoleEntry[]): ConsoleRow[] {
  const rows: ConsoleRow[] = []
  for (const entry of entries) {
    const last = rows[rows.length - 1]
    if (
      last &&
      last.entry.level === entry.level &&
      last.entry.source === entry.source &&
      last.entry.message === entry.message
    ) {
      last.count++
      last.lastTime = entry.time
    } else rows.push({ entry, count: 1, lastTime: entry.time })
  }
  return rows
}
