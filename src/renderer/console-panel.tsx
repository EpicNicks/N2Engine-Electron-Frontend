// The console panel: the host's log (PollEvents) and the editor's own notes, filtered by level, source and text, with
// repeated lines collapsed on request. The logic is in console-store.ts and console-filter.ts (tested in Node).
import { useLayoutEffect, useRef } from "preact/hooks"
import { ConsoleRow, TextMatcher, highlightPieces } from "./console-filter"
import type { LogLevel } from "./console-store"
import { Empty, useApp } from "./ui"

const LevelLabels: Record<LogLevel, string> = { info: "Info", warn: "Warnings", error: "Errors" }

function formatTime(time: number): string {
  const date = new Date(time)
  const pad = (n: number, width = 2) => String(n).padStart(width, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function Message({ text, matcher }: { text: string; matcher: TextMatcher }) {
  const ranges = matcher.active ? matcher.ranges(text) : []
  if (ranges.length === 0) return <>{text}</>
  return (
    <>
      {highlightPieces(text, ranges).map((piece, i) => (piece.match ? <mark key={i}>{piece.text}</mark> : piece.text))}
    </>
  )
}

function Entry({ row, matcher }: { row: ConsoleRow; matcher: TextMatcher }) {
  const { entry, count } = row
  return (
    <div class={`console-entry ${entry.level} from-${entry.source}`}>
      <span class="console-time">{formatTime(entry.time)}</span>
      <span class="console-message">
        <Message text={entry.message} matcher={matcher} />
      </span>
      {count > 1 && (
        <span class="console-count" title={`${count} identical lines, the last at ${formatTime(row.lastTime)}`}>
          {count}
        </span>
      )}
    </div>
  )
}

export function ConsolePanel() {
  const { store } = useApp()
  const log = store.console
  const rows = log.rows.value
  const counts = log.counts.value
  const shown = log.shown.value
  const hidden = log.hiddenSources.value
  const sourceCounts = log.sourceCounts.value
  const matcher = log.matcher.value

  // Stays at the bottom as lines arrive, unless scrolled up to read
  const list = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  useLayoutEffect(() => {
    if (atBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight
  }, [rows])

  return (
    <div class="console-panel" data-keymap-scope="console">
      <div class="console-toolbar">
        {(Object.keys(LevelLabels) as LogLevel[]).map((level) => (
          <label class={`console-filter ${level}`} key={level}>
            <input type="checkbox" checked={shown[level]} onChange={() => log.toggleLevel(level)} />
            {LevelLabels[level]} ({counts[level]})
          </label>
        ))}
        <span class="console-sources" role="group" aria-label="Sources">
          {log.sources.all().map((source) => (
            <label class="console-filter source" key={source.id}>
              <input type="checkbox" checked={!hidden.has(source.id)} onChange={() => log.toggleSource(source.id)} />
              {source.label} ({sourceCounts[source.id] ?? 0})
            </label>
          ))}
        </span>
        <input
          class={matcher.error ? "console-search invalid" : "console-search"}
          type="search"
          placeholder={log.regex.value ? "Filter (regex)" : "Filter"}
          aria-label="Filter"
          aria-invalid={matcher.error !== null}
          maxLength={200}
          value={log.search.value}
          onInput={(e) => (log.search.value = (e.currentTarget as HTMLInputElement).value)}
        />
        <button
          class={log.matchCase.value ? "secondary toggle on" : "secondary toggle"}
          aria-pressed={log.matchCase.value}
          title="Match case"
          onClick={() => (log.matchCase.value = !log.matchCase.value)}
        >
          Aa
        </button>
        <button
          class={log.regex.value ? "secondary toggle on" : "secondary toggle"}
          aria-pressed={log.regex.value}
          title="Regular expression"
          onClick={() => (log.regex.value = !log.regex.value)}
        >
          .*
        </button>
        <button
          class={log.collapse.value ? "secondary toggle on" : "secondary toggle"}
          aria-pressed={log.collapse.value}
          title="Collapse identical lines that follow each other, with a count"
          onClick={() => (log.collapse.value = !log.collapse.value)}
        >
          Collapse
        </button>
        <button class="secondary" onClick={() => log.clear()}>
          Clear
        </button>
      </div>
      {matcher.error !== null && (
        <div class="console-regex-error" role="alert">
          Not a valid pattern, so nothing is filtered: {matcher.error}
        </div>
      )}
      <div
        class="console-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLDivElement
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
        }}
      >
        {rows.length === 0 ? (
          <Empty>{log.entries.value.length === 0 ? "No log lines yet" : "No lines match the filter"}</Empty>
        ) : (
          rows.map((row) => <Entry row={row} matcher={matcher} key={row.entry.id} />)
        )}
      </div>
    </div>
  )
}
