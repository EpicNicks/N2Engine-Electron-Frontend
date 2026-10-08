// The console panel: the host's log (PollEvents) and the editor's own notes, filtered by level and text
import { useLayoutEffect, useRef } from "preact/hooks"
import type { ConsoleEntry, LogLevel } from "./console-store"
import { Empty, useApp } from "./ui"

const LevelLabels: Record<LogLevel, string> = { info: "Info", warn: "Warnings", error: "Errors" }

function formatTime(time: number): string {
  const date = new Date(time)
  const pad = (n: number, width = 2) => String(n).padStart(width, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function Entry({ entry }: { entry: ConsoleEntry }) {
  return (
    <div class={`console-entry ${entry.level} from-${entry.source}`}>
      <span class="console-time">{formatTime(entry.time)}</span>
      <span class="console-message">{entry.message}</span>
    </div>
  )
}

export function ConsolePanel() {
  const { store } = useApp()
  const log = store.console
  const visible = log.visible.value
  const counts = log.counts.value
  const shown = log.shown.value

  // Stays at the bottom as lines arrive, unless scrolled up to read
  const list = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  useLayoutEffect(() => {
    if (atBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight
  }, [visible])

  return (
    <div class="console-panel">
      <div class="console-toolbar">
        {(Object.keys(LevelLabels) as LogLevel[]).map((level) => (
          <label class={`console-filter ${level}`} key={level}>
            <input type="checkbox" checked={shown[level]} onChange={() => log.toggleLevel(level)} />
            {LevelLabels[level]} ({counts[level]})
          </label>
        ))}
        <input
          class="console-search"
          type="search"
          placeholder="Filter"
          value={log.search.value}
          onInput={(e) => (log.search.value = (e.currentTarget as HTMLInputElement).value)}
        />
        <button class="secondary" onClick={() => log.clear()}>
          Clear
        </button>
      </div>
      <div
        class="console-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLDivElement
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
        }}
      >
        {visible.length === 0 ? (
          <Empty>{log.entries.value.length === 0 ? "No log lines yet" : "No lines match the filter"}</Empty>
        ) : (
          visible.map((entry) => <Entry entry={entry} key={entry.id} />)
        )}
      </div>
    </div>
  )
}
