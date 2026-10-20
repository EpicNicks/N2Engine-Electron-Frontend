// The console's filters with no state and no DOM: the source registry, the text matcher (plain or regular expression,
// with the ranges to highlight), filtering the lines and collapsing repeats. Unit tested in Node.
import type { ConsoleEntry, LogLevel } from "./console-store"

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
/** A regex is tried on at most this much of a line, so a pattern that backtracks badly costs a bounded amount */
export const MaxRegexInput = 4096

export interface TextMatcher {
  /** Whether the line passes (everything passes when there is no text, or when the regex is not valid) */
  test(message: string): boolean
  /** [start, end) ranges of the matches in the message, in order, for highlighting; none without text */
  ranges(message: string): Array<[number, number]>
  /** Why the regular expression isn't valid (shown inline); null when it is, or when regex is off */
  error: string | null
  /** The filter does something */
  active: boolean
}

const passAll: TextMatcher = { test: () => true, ranges: () => [], error: null, active: false }

export function compileMatcher(filter: TextFilter): TextMatcher {
  const { search, matchCase, regex } = filter
  if (search === "") return passAll
  if (!regex) {
    const fold = (text: string) => (matchCase ? text : text.toLowerCase())
    const needle = fold(search)
    return {
      test: (message) => fold(message).includes(needle),
      ranges(message) {
        const hay = fold(message)
        const out: Array<[number, number]> = []
        for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
          out.push([at, at + needle.length])
        }
        return out
      },
      error: null,
      active: true,
    }
  }
  let pattern: RegExp
  try {
    if (search.length > MaxPatternLength) throw new Error(`The pattern is longer than ${MaxPatternLength} characters`)
    pattern = new RegExp(search, matchCase ? "g" : "gi")
  } catch (e) {
    // Half-typed patterns are normal: they filter nothing (the list doesn't flash empty) and the reason shows inline
    return { ...passAll, error: e instanceof Error ? e.message : String(e) }
  }
  const limited = (message: string) => (message.length > MaxRegexInput ? message.slice(0, MaxRegexInput) : message)
  return {
    test(message) {
      pattern.lastIndex = 0
      return pattern.test(limited(message))
    },
    ranges(message) {
      const text = limited(message)
      const out: Array<[number, number]> = []
      pattern.lastIndex = 0
      for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
        if (m[0].length === 0) pattern.lastIndex++ // an empty match must not loop
        else out.push([m.index, m.index + m[0].length])
      }
      return out
    },
    error: null,
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
  matcher: TextMatcher
}

/** Whether the line passes the source and text filters (not the levels) */
export function passesLine(registry: ConsoleSourceRegistry, entry: ConsoleEntry, filter: LineFilter): boolean {
  return !filter.hiddenSources.has(sourceOf(registry, entry)) && filter.matcher.test(entry.message)
}

/** The lines with their levels shown, passing the source and text filters; one pass */
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
