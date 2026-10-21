// The console panel's state: the host's log lines, read with PollEvents through an EventPump, plus the editor's own
// messages (a host that exited, events that were dropped). No DOM, so it is unit tested in Node.
//
// The cursor follows the epoch rule (docs/logging-and-editor.html §events, event-pump.ts): the pump polls with the
// epoch and nextSeq of the last response, and a response in another epoch starts a new log. A newly launched host is
// a new log too: the cursor goes back to (0, 0) for it, so its events come from its start, startup lines included.
import { batch, computed, signal } from "@preact/signals-core"
import type { EditorEvent } from "../protocol/protocol.generated"
import { EventPump, EventPumpOptions, PollFunction, StartCursor } from "../protocol/event-pump"
import { parseExtensionOutput } from "../protocol/extension-output"
import {
  ConsoleRow,
  ConsoleSourceRegistry,
  LineFilter,
  collapseRepeats,
  compileMatcher,
  consoleSources,
  countLevels,
  filterEntries,
  plainRows,
  sourceOf,
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

/** How many mirrored extension lines are remembered for dropping (the host's log line may come in a later poll) */
const MaxMirrors = 200

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
}

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
  /** The text filter, compiled once per change of the text or its toggles */
  readonly matcher = computed(() =>
    compileMatcher({ search: this.search.value, matchCase: this.matchCase.value, regex: this.regex.value })
  )
  private readonly lineFilter = computed<LineFilter>(() => ({
    hiddenSources: this.hiddenSources.value,
    matcher: this.matcher.value,
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
  readonly sourceCounts = computed(() => {
    const counts: Record<string, number> = {}
    const shown = this.shown.value
    const matcher = this.matcher.value
    for (const entry of this.entries.value) {
      if (!shown[entry.level] || !matcher.test(entry.message)) continue
      const id = sourceOf(this.sources, entry)
      counts[id] = (counts[id] ?? 0) + 1
    }
    return counts
  })
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
  private nextId = 1
  /** The log lines the host mirrors an extensionOutput event as, still waiting to be dropped (see receive) */
  private readonly mirrors: string[] = []
  /** The host launch the pump's cursor belongs to */
  private launch: number | null = null

  constructor(poll: PollFunction<EditorEvent>, options: ConsoleStoreOptions = {}) {
    const { onEvents, onMissedEvents, maxEntries, now, sources, ...pumpOptions } = options
    this.sources = sources ?? consoleSources
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
  }

  private receive(events: EditorEvent[]): void {
    const entries: Array<Omit<ConsoleEntry, "id">> = []
    // The host also logs each extension line as an Admin log line "extension <name>: <text>" (for clients that predate
    // extensionOutput): the Extension entry stands in for that line, so it is not shown twice
    for (const event of events) {
      const line = parseExtensionOutput(event)
      if (line) this.mirrors.push(`extension ${line.extension}: ${line.message}`)
    }
    if (this.mirrors.length > MaxMirrors) this.mirrors.splice(0, this.mirrors.length - MaxMirrors)
    for (const event of events) {
      const line = parseExtensionOutput(event)
      if (line) {
        // Untrusted text, kept as text: the panel renders it as a text node
        entries.push({
          level: line.level,
          message: `[${line.extension}] ${line.message}`,
          time: line.time > 0 ? line.time : this.now(),
          source: "extension",
        })
        continue
      }
      const entry = entryFromEvent(event)
      if (!entry) continue
      const mirrored = this.mirrors.indexOf(entry.message)
      if (mirrored >= 0) {
        this.mirrors.splice(mirrored, 1)
        continue
      }
      entries.push(entry)
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
