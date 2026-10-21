// The history panel: the host's undo history, oldest first, with the initial state on top. Steps that are done are
// normal, undone ones dimmed, the state the scene is in marked. Clicking a row (or Enter on it) jumps there: as many
// undos or redos as it takes, one operation with progress and Cancel (HistoryModel.jumpTo, EditController.jumpTo).
// The host caps its history (200 steps, 128 MiB), so the list is at most that long and is not virtualised.
// Keys in the list: Up and Down move, Home and End go to the ends, Enter jumps, Escape cancels a running jump.
import type { ComponentChildren } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"
import { InitialLabel, formatBytes, rowsOf, totalBytes } from "./history-jump"
import { HistoryModel, historyModel } from "./history-state"
import { Empty, Panel } from "./ui"

export function HistoryPanel() {
  const model = historyModel.value
  if (model === null) return <HistoryShell>{<Empty>The history is not available</Empty>}</HistoryShell>
  return <HistoryView model={model} />
}

function HistoryShell(props: { children: ComponentChildren }) {
  return (
    <Panel title="History" icon="🕘" class="history-panel">
      {props.children}
    </Panel>
  )
}

export function HistoryView({ model }: { model: HistoryModel }) {
  // Reads and listens while shown; stops when closed (no listener outlives the panel)
  useEffect(() => model.start(), [model])

  const history = model.history.value
  const progress = model.progress.value
  const error = model.error.value
  const disabled = model.disabledReason.value
  const generation = model.generation.value
  const list = useRef<HTMLUListElement>(null)
  const [active, setActive] = useState<number | null>(null)

  const rows = history ? rowsOf(history) : []
  // The keyboard position starts on the current state, and goes back there when the rows were replaced
  useEffect(() => setActive(null), [generation])
  const activeIndex = Math.min(active ?? (history ? history.cursor : 0), Math.max(rows.length - 1, 0))

  const focusRow = (index: number) => {
    setActive(index)
    // The row takes the focus once it is drawn
    queueMicrotask(() => list.current?.querySelector<HTMLElement>(`[data-cursor="${index}"]`)?.focus())
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (progress) {
        e.preventDefault()
        model.cancel()
      }
      return
    }
    if (rows.length === 0 || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === "ArrowDown") focusRow(Math.min(activeIndex + 1, rows.length - 1))
    else if (e.key === "ArrowUp") focusRow(Math.max(activeIndex - 1, 0))
    else if (e.key === "Home") focusRow(0)
    else if (e.key === "End") focusRow(rows.length - 1)
    else if (e.key === "Enter" || e.key === " ") void model.jumpTo(rows[activeIndex].cursor)
    else return
    e.preventDefault()
  }

  let content
  if (history === null) content = <Empty>{error ? "" : "Loading..."}</Empty>
  else
    content = (
      <ul
        ref={list}
        class={`history-list${disabled ? " disabled" : ""}`}
        role="listbox"
        aria-label="Undo history"
        aria-disabled={disabled !== null}
        title={disabled ?? undefined}
        onKeyDown={onKeyDown}
      >
        {rows.map((row, i) => (
          <li
            key={row.cursor}
            role="option"
            data-cursor={row.cursor}
            aria-selected={row.current}
            aria-current={row.current ? "step" : undefined}
            tabIndex={i === activeIndex ? 0 : -1}
            class={`history-row ${row.state}${row.current ? " current" : ""}`}
            title={row.state === "initial" ? InitialLabel : `${row.label}: ${formatBytes(row.bytes)}`}
            onClick={() => {
              setActive(i)
              void model.jumpTo(row.cursor)
            }}
          >
            <span class="history-marker" aria-hidden="true">
              {row.current ? "▶" : ""}
            </span>
            <span class="history-label">{row.label}</span>
            {row.state !== "initial" && <span class="history-bytes">{formatBytes(row.bytes)}</span>}
          </li>
        ))}
      </ul>
    )

  return (
    <Panel
      title="History"
      icon="🕘"
      class="history-panel"
      actions={
        <button onClick={() => void model.refresh()} disabled={progress !== null}>
          Refresh
        </button>
      }
    >
      {progress && (
        <div class="history-progress" role="status">
          <span>
            {progress.cancelling ? "Stopping" : "Jumping"}
            {progress.total > 0 ? `: step ${progress.done} of ${progress.total}` : "..."}
          </span>
          <button onClick={() => model.cancel()} disabled={progress.cancelling}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <div class="history-error" role="alert">
          <span>{error}</span>
          <button class="secondary" onClick={() => model.dismissError()} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {disabled && !progress && <div class="history-note">{disabled}</div>}
      {content}
      {history && (
        <div class="history-footer">
          {history.entries.length === 0
            ? "No steps yet"
            : `${history.entries.length} steps, ${formatBytes(totalBytes(history))}`}
          <Revisions model={model} />
        </div>
      )}
    </Panel>
  )
}

function Revisions({ model }: { model: HistoryModel }) {
  const revisions = model.revisions.value
  if (!revisions) return null
  const dirty = revisions.revision !== revisions.savedRevision
  return (
    <span class="history-revisions">
      {" "}
      | revision {revisions.revision}, saved at {revisions.savedRevision}
      {dirty ? " (unsaved changes)" : ""}
    </span>
  )
}
