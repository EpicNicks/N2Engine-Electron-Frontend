// The console panel's state: the host's log lines, read with PollEvents through an EventPump, plus the editor's own
// messages (a host that exited, events that were dropped). No DOM, so it is unit tested in Node.
//
// The cursor follows the epoch rule (docs/logging-and-editor.html §events, event-pump.ts): the pump polls with the
// epoch and nextSeq of the last response, and a response in another epoch starts a new log. A newly launched host is
// a new log too: the cursor goes back to (0, 0) for it, so its events come from its start, startup lines included.
import { batch, computed, signal } from "@preact/signals-core"
import type { EditorEvent } from "../protocol/protocol.generated"
import { EventPump, EventPumpOptions, PollFunction, StartCursor, Timers } from "../protocol/event-pump"
import {
  ConsoleRow,
  ConsoleSourceRegistry,
  LineFilter,
  collapseRepeats,
  compileMatcher,
  consoleSources,
  Clock,
  TextFilter,
  TextResults,
  countLevels,
  countSources,
  filterEntries,
  plainRows,
} from "./console-filter"
import type { ConsoleFilterPrefValue } from "./console-filter-prefs"

export type LogLevel = "info" | "warn" | "error"

export interface ConsoleEntry {
  /** Unique within the console, for list keys */
  id: number
  level: LogLevel
  message: string
  /** Milliseconds since the Unix epoch */
  time: number
  /**
   * The id of a registered source (console-filter.ts consoleSources): "host" the edit host's log, "editor" the
   * editor's own note (a host session starting, events dropped, the host exiting), "game" the play child's log while a
   * game runs, and whatever a feature registers (an id that is not registered is shown as the host's)
   */
  source: string
}

/** How many entries the console keeps; the oldest go first */
export const DefaultMaxEntries = 5000

const Levels: readonly LogLevel[] = ["info", "warn", "error"]

/** The entries after the one with id afterId, up to the one with id upToId when given (see ConsoleStore.lastEntryId), at a level */
export function entriesAfter(
  entries: readonly ConsoleEntry[],
  afterId: number,
  level: LogLevel,
  upToId = Infinity
): ConsoleEntry[] {
  return entries.filter((entry) => entry.id > afterId && entry.id <= upToId && entry.level === level)
}

/** An event as a console entry: log events only (other kinds are for other panels), any unknown field defaulted */
export function entryFromEvent(event: EditorEvent): Omit<ConsoleEntry, "id"> | null {
  if (event.kind !== "log") return null
  const level = Levels.includes(event.level as LogLevel) ? (event.level as LogLevel) : "info"
  const message = typeof event.message === "string" ? event.message : ""
  const time = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : Date.now()
  return { level, message, time, source: "host" }
}

export interface ConsoleStoreOptions extends EventPumpOptions {
  maxEntries?: number
  /**
   * Called with each batch of events (log events too, in order), after the console took its entries. Also see
   * onReset: called when the numbering changes or events were dropped, so state built from events must be refetched.
   */
  onEvents?: (events: EditorEvent[]) => void
  /** The host's events may have been missed (dropped, or another host's log began): refetch state built from them */
  onMissedEvents?: () => void
  /** The current time, for the editor's own entries */
  now?: () => number
  /** The registry of sources (consoleSources by default) */
  sources?: ConsoleSourceRegistry
  /** A clock in milliseconds for the regex filter's step budget (performance.now by default) */
  clock?: Clock
  /**
   * How long the text filter waits after the last change of the text or its toggles before it is applied (the editor
   * uses FilterDebounceMs; 0, the default, applies every change at once). Uses `timers`.
   */
  filterDelayMs?: number
}

/**
 * The editor's wait before a changed text filter is applied: every change compiles a new matcher with full step
 * buckets, so typing a pattern into a full console of long lines would otherwise cost an update per keystroke
 */
export const FilterDebounceMs = 200

export class ConsoleStore {
  readonly entries = signal<readonly ConsoleEntry[]>([])
  /** Which levels are shown */
  readonly shown = signal<Record<LogLevel, boolean>>({ info: true, warn: true, error: true })
  /** Ids of the sources switched off (see consoleSources) */
  readonly hiddenSources = signal<ReadonlySet<string>>(new Set())
  /** Only entries containing this text are shown; "" shows all */
  readonly search = signal("")
  /** The text is matched with its case */
  readonly matchCase = signal(false)
  /** The text is a regular expression */
  readonly regex = signal(false)
  /** Consecutive identical lines are one row with a count */
  readonly collapse = signal(false)
  /** The text filter as typed */
  private readonly typedFilter = computed<TextFilter>(() => ({
    search: this.search.value,
    matchCase: this.matchCase.value,
    regex: this.regex.value,
  }))
  /** The text filter applied, filterDelayMs after the last change of the typed one (null: no delay, it is the typed one) */
  private readonly appliedFilter = signal<TextFilter | null>(null)
  /** The text filter, compiled once per applied change of the text or its toggles */
  readonly matcher = computed(() => compileMatcher(this.appliedFilter.value ?? this.typedFilter.value, this.clock))
  /**
   * The text filter's results for the lines: one pass per change of the lines or the matcher, shared by the list and
   * both kinds of count, so they always agree (a regular expression that runs out of steps is off for all of them)
   */
  readonly textResults = computed<TextResults>(() => this.matcher.value.testEntries(this.entries.value))
  /** The regular expression is too slow for the lines and is off (shown inline) */
  readonly regexSlow = computed(() => this.textResults.value.slow)
  private readonly lineFilter = computed<LineFilter>(() => ({
    hiddenSources: this.hiddenSources.value,
    text: this.textResults.value,
  }))
  /** The lines shown: the levels switched on, the sources switched on, matching the text */
  readonly visible = computed(() =>
    filterEntries(this.sources, this.entries.value, this.shown.value, this.lineFilter.value)
  )
  /** The rows shown: the visible lines, with repeats collapsed when that is on */
  readonly rows = computed<ConsoleRow[]>(() =>
    this.collapse.value ? collapseRepeats(this.visible.value) : plainRows(this.visible.value)
  )
  /** Lines per level among those passing the source and text filters (a level switched off still counts) */
  readonly counts = computed(() => countLevels(this.sources, this.entries.value, this.lineFilter.value))
  /** Lines per source among those passing the level and text filters (a source switched off still counts) */
  readonly sourceCounts = computed(() =>
    countSources(this.sources, this.entries.value, this.shown.value, this.textResults.value)
  )
  /** The filters as a value, for the preferences */
  readonly filterState = computed<ConsoleFilterPrefValue>(() => ({
    levels: { ...this.shown.value },
    hiddenSources: [...this.hiddenSources.value],
    search: this.search.value,
    matchCase: this.matchCase.value,
    regex: this.regex.value,
    collapse: this.collapse.value,
  }))

  /** The sources lines can have; a feature adds its own (the default is the page's registry) */
  readonly sources: ConsoleSourceRegistry

  private readonly pump: EventPump<EditorEvent>
  private readonly maxEntries: number
  private readonly now: () => number
  private readonly clock: Clock
  private readonly filterTimers: Timers
  private filterTimer: unknown = null
  private nextId = 1
  /** The host launch the pump's cursor belongs to */
  private launch: number | null = null

  constructor(poll: PollFunction<EditorEvent>, options: ConsoleStoreOptions = {}) {
    const { onEvents, onMissedEvents, maxEntries, now, sources, clock, filterDelayMs, ...pumpOptions } = options
    this.sources = sources ?? consoleSources
    this.clock = clock ?? (() => performance.now())
    this.filterTimers = pumpOptions.timers ?? {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    if (filterDelayMs !== undefined && filterDelayMs > 0) {
      this.appliedFilter.value = this.typedFilter.peek()
      // Every change restarts the wait; clearing the text applies at once (that costs nothing)
      this.typedFilter.subscribe((filter) => {
        if (filter === this.appliedFilter.peek()) return
        this.cancelFilterTimer()
        if (filter.search === "") this.appliedFilter.value = filter
        else
          this.filterTimer = this.filterTimers.setTimeout(() => {
            this.filterTimer = null
            this.appliedFilter.value = this.typedFilter.peek()
          }, filterDelayMs)
      })
    }
    this.maxEntries = maxEntries ?? DefaultMaxEntries
    this.now = now ?? Date.now
    this.pump = new EventPump(
      poll,
      {
        onEvents: (events) => {
          this.receive(events)
          onEvents?.(events)
        },
        onDropped: (count) => {
          this.note("warn", `${count} host event${count === 1 ? " was" : "s were"} dropped before the editor read them`)
          onMissedEvents?.()
        },
        onReset: () => {
          this.note("info", "The host started a new log")
          onMissedEvents?.()
        },
        onError: (e) => console.warn("PollEvents failed:", e),
      },
      pumpOptions
    )
  }

  /** The cursor the next poll sends (the epoch rule) */
  get position() {
    return this.pump.position
  }

  /** The id of the newest entry ever added (0 for none), even if it has been cleared or dropped: a mark for entriesAfter */
  get lastEntryId(): number {
    return this.nextId - 1
  }

  get isPolling(): boolean {
    return this.pump.isRunning
  }

  /**
   * Starts polling the connected host. launch identifies the host process (HostState.launch): a new one starts from
   * (0, 0), so its whole retained log is read; the same one carries on from where polling stopped.
   */
  connect(launch: number): void {
    if (launch !== this.launch) {
      this.launch = launch
      this.pump.start(StartCursor)
    } else {
      this.pump.start(this.pump.position)
    }
  }

  /** Stops polling (the connection closed); the cursor is kept */
  disconnect(): void {
    this.pump.stop()
  }

  /** Polls now, for example right after a command that logs */
  pollNow(): Promise<void> {
    return this.pump.pollNow()
  }

  /** Empties the console (the host keeps its log; nothing is read again) */
  clear(): void {
    this.entries.value = []
  }

  /** Adds entries from elsewhere (the play child's log lines) */
  addEntries(entries: Array<Omit<ConsoleEntry, "id">>): void {
    this.append(entries)
  }

  /** Adds the editor's own entry */
  note(level: LogLevel, message: string): void {
    this.append([{ level, message, time: this.now(), source: "editor" }])
  }

  toggleLevel(level: LogLevel): void {
    this.shown.value = { ...this.shown.value, [level]: !this.shown.value[level] }
  }

  toggleSource(id: string): void {
    const hidden = new Set(this.hiddenSources.value)
    if (!hidden.delete(id)) hidden.add(id)
    this.hiddenSources.value = hidden
  }

  /** Sets every filter at once (the project's saved ones); a source id that is not registered (yet) is kept */
  applyFilterState(state: ConsoleFilterPrefValue): void {
    batch(() => {
      this.shown.value = { ...state.levels }
      this.hiddenSources.value = new Set(state.hiddenSources)
      this.search.value = state.search
      this.matchCase.value = state.matchCase
      this.regex.value = state.regex
      this.collapse.value = state.collapse
    })
    this.flushFilter()
  }

  /** Applies the typed text filter now, without waiting for the delay (filterDelayMs) */
  flushFilter(): void {
    this.cancelFilterTimer()
    if (this.appliedFilter.peek() !== null) this.appliedFilter.value = this.typedFilter.peek()
  }

  private cancelFilterTimer(): void {
    if (this.filterTimer !== null) this.filterTimers.clearTimeout(this.filterTimer)
    this.filterTimer = null
  }

  private receive(events: EditorEvent[]): void {
    const entries: Array<Omit<ConsoleEntry, "id">> = []
    for (const event of events) {
      const entry = entryFromEvent(event)
      if (entry) entries.push(entry)
    }
    this.append(entries)
  }

  private append(added: Array<Omit<ConsoleEntry, "id">>): void {
    if (added.length === 0) return
    const withIds = added.map((entry) => ({ ...entry, id: this.nextId++ }))
    const all = [...this.entries.value, ...withIds]
    this.entries.value = all.length > this.maxEntries ? all.slice(all.length - this.maxEntries) : all
  }
}
