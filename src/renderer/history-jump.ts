// The history panel's logic without a DOM: the rows a host history is shown as, the plan of a jump (how many undos or
// redos reach a step), and what changed between two reads of the history. The host owns the history (GetHistory:
// every step's label and size, and the cursor, how many are done); a jump is sequential Undo or Redo from the client
// (EditController.jumpTo), so nothing here asks the host for anything.
import type { HistoryResponse } from "../protocol/protocol.generated"

export type RowState = "initial" | "done" | "undone"

export interface HistoryRow {
  /** The cursor a jump to this row lands on: 0 is the initial state, n the state after the first n steps */
  cursor: number
  /** "Initial state" for the first row, else the step's label */
  label: string
  /** The step's memory in bytes; 0 for the initial state */
  bytes: number
  state: RowState
  /** The state the scene is in now: the last done step (or the initial state when none is done) */
  current: boolean
}

export const InitialLabel = "Initial state"

/** Rows oldest first, the initial state at the top; the steps after the cursor are undone (shown dimmed) */
export function rowsOf(history: HistoryResponse): HistoryRow[] {
  const rows: HistoryRow[] = [
    { cursor: 0, label: InitialLabel, bytes: 0, state: "initial", current: history.cursor === 0 },
  ]
  history.entries.forEach((entry, i) => {
    const cursor = i + 1
    rows.push({
      cursor,
      label: entry.label,
      bytes: entry.bytes,
      state: cursor <= history.cursor ? "done" : "undone",
      current: cursor === history.cursor,
    })
  })
  return rows
}

/** The memory of every step, in bytes */
export function totalBytes(history: HistoryResponse): number {
  return history.entries.reduce((sum, entry) => sum + entry.bytes, 0)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export type JumpPlan =
  | { kind: "none"; steps: 0 }
  | { kind: "undo"; steps: number }
  | { kind: "redo"; steps: number }

/** How to get from cursor to target in a history of total steps: target 0..total, else it is refused */
export function planJump(cursor: number, total: number, target: number): JumpPlan {
  if (![cursor, total, target].every((n) => Number.isInteger(n) && n >= 0) || cursor > total) {
    throw new Error("Invalid history position")
  }
  if (target > total) throw new Error(`Step ${target} is past the history's ${total} steps`)
  if (target === cursor) return { kind: "none", steps: 0 }
  return target < cursor ? { kind: "undo", steps: cursor - target } : { kind: "redo", steps: target - cursor }
}

export type HistoryChange = "same" | "cursor" | "extended" | "rewritten"

/**
 * What another read of the history changed: "same" (nothing), "cursor" (the same steps, a different cursor: an undo,
 * a redo or a jump), "extended" (the done steps are as they were and steps were added or dropped after them: a new
 * edit clears the redo steps and adds one), "rewritten" (a done step differs, or none was known: a scene was
 * opened, the history was capped at its oldest end, a step was merged into)
 */
export function diffHistory(prev: HistoryResponse | null, next: HistoryResponse): HistoryChange {
  if (prev === null) return "rewritten"
  const sameStep = (i: number) =>
    prev.entries[i] !== undefined &&
    next.entries[i] !== undefined &&
    prev.entries[i].label === next.entries[i].label &&
    prev.entries[i].bytes === next.entries[i].bytes
  const common = Math.min(prev.cursor, next.cursor)
  for (let i = 0; i < common; i++) if (!sameStep(i)) return "rewritten"
  const identical =
    prev.entries.length === next.entries.length && prev.entries.every((_, i) => sameStep(i))
  if (identical) return prev.cursor === next.cursor ? "same" : "cursor"
  return "extended"
}
