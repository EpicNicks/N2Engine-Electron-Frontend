// The console panel's state: the host's log lines, read with PollEvents through an EventPump, plus the editor's own
// messages (a host that exited, events that were dropped). No DOM, so it is unit tested in Node.
//
// The cursor follows the epoch rule (docs/logging-and-editor.html §events, event-pump.ts): the pump polls with the
// epoch and nextSeq of the last response, and a response in another epoch starts a new log. A newly launched host is
// a new log too: the cursor goes back to (0, 0) for it, so its events come from its start, startup lines included.
import { computed, signal } from "@preact/signals-core"
import type { EditorEvent } from "../protocol/protocol.generated"
import { EventPump, EventPumpOptions, PollFunction, StartCursor } from "../protocol/event-pump"

export type LogLevel = "info" | "warn" | "error"

export interface ConsoleEntry {
  /** Unique within the console, for list keys */
  id: number
  level: LogLevel
  message: string
  /** Milliseconds since the Unix epoch */
  time: number
  /** The host's log, or the editor's own note (a host session starting, events dropped, the host exiting) */
  source: "host" | "editor"
}

/** How many entries the console keeps; the oldest go first */
export const DefaultMaxEntries = 5000

const Levels: readonly LogLevel[] = ["info", "warn", "error"]

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
  /** The current time, for the editor's own entries */
  now?: () => number
}

export class ConsoleStore {
  readonly entries = signal<readonly ConsoleEntry[]>([])
  /** Which levels are shown */
  readonly shown = signal<Record<LogLevel, boolean>>({ info: true, warn: true, error: true })
  /** Only entries containing this text (case-insensitive) are shown; "" shows all */
  readonly search = signal("")
  readonly visible = computed(() => {
    const shown = this.shown.value
    const search = this.search.value.toLowerCase()
    return this.entries.value.filter(
      (entry) => shown[entry.level] && (search === "" || entry.message.toLowerCase().includes(search)),
    )
  })
  readonly counts = computed(() => {
    const counts: Record<LogLevel, number> = { info: 0, warn: 0, error: 0 }
    for (const entry of this.entries.value) counts[entry.level]++
    return counts
  })

  private readonly pump: EventPump<EditorEvent>
  private readonly maxEntries: number
  private readonly now: () => number
  private nextId = 1
  /** The host launch the pump's cursor belongs to */
  private launch: number | null = null

  constructor(poll: PollFunction<EditorEvent>, options: ConsoleStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? DefaultMaxEntries
    this.now = options.now ?? Date.now
    this.pump = new EventPump(
      poll,
      {
        onEvents: (events) => this.receive(events),
        onDropped: (count) =>
          this.note(
            "warn",
            `${count} host log line${count === 1 ? " was" : "s were"} dropped before the editor read them`,
          ),
        onReset: () => this.note("info", "The host started a new log"),
        onError: (e) => console.warn("PollEvents failed:", e),
      },
      options,
    )
  }

  /** The cursor the next poll sends (the epoch rule) */
  get position() {
    return this.pump.position
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

  /** Adds the editor's own entry */
  note(level: LogLevel, message: string): void {
    this.append([{ level, message, time: this.now(), source: "editor" }])
  }

  toggleLevel(level: LogLevel): void {
    this.shown.value = { ...this.shown.value, [level]: !this.shown.value[level] }
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
