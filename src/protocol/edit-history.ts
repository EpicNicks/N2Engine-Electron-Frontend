// Undo, redo, edit groups and autosave (protocol 1.6.0): the answers the host gives are validated before anything uses
// them, and the arguments the engine would refuse anyway are refused before a request is sent. The engine stays the
// authority: it decides what can be undone, and answers an Error when nothing can.
import type { AutosaveInfo, EditResultResponse, HistoryEntry, HistoryResponse } from "./protocol.generated"

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isUint32 = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff

function requireString(object: Record<string, unknown>, key: string, where: string): string {
  const value = object[key]
  if (typeof value !== "string") throw new Error(`${where}: ${key} must be a string`)
  return value
}

function requireBool(object: Record<string, unknown>, key: string, where: string): boolean {
  const value = object[key]
  if (typeof value !== "boolean") throw new Error(`${where}: ${key} must be a boolean`)
  return value
}

function requireUint32(object: Record<string, unknown>, key: string, where: string): number {
  const value = object[key]
  if (!isUint32(value)) throw new Error(`${where}: ${key} must be an unsigned 32-bit integer`)
  return value
}

/** What the host answers to Undo and Redo: the step's label, the new revisions, and what can still be undone or redone */
export function parseEditResult(value: unknown): EditResultResponse {
  if (!isObject(value)) throw new Error("The undo answer must be an object")
  const where = "The undo answer"
  return {
    label: requireString(value, "label", where),
    revision: requireUint32(value, "revision", where),
    canUndo: requireBool(value, "canUndo", where),
    canRedo: requireBool(value, "canRedo", where),
    savedRevision: requireUint32(value, "savedRevision", where),
  }
}

/** GetHistory's answer: every step oldest first, and the cursor (how many are done), which can't pass the steps */
export function parseHistory(value: unknown): HistoryResponse {
  if (!isObject(value)) throw new Error("The history must be an object")
  const where = "The history"
  const cursor = requireUint32(value, "cursor", where)
  if (!Array.isArray(value.entries)) throw new Error("The history's entries must be an array")
  const entries: HistoryEntry[] = value.entries.map((entry, i) => {
    if (!isObject(entry)) throw new Error(`The history's entry ${i} must be an object`)
    return {
      label: requireString(entry, "label", `The history's entry ${i}`),
      bytes: requireUint32(entry, "bytes", `The history's entry ${i}`),
    }
  })
  if (cursor > entries.length) throw new Error(`The history's cursor ${cursor} is past its ${entries.length} entries`)
  return { cursor, entries }
}

/** GetAutosave's answer: whether there is one and, when there is, where it is, how large and when it was written (Unix ms) */
export function parseAutosaveInfo(value: unknown): AutosaveInfo {
  if (!isObject(value)) throw new Error("The autosave info must be an object")
  const where = "The autosave info"
  const exists = requireBool(value, "exists", where)
  if (!exists) return { exists: false }
  const info: AutosaveInfo = { exists: true }
  if (value.path !== undefined) info.path = requireString(value, "path", where)
  for (const key of ["size", "modified"] as const) {
    if (value[key] === undefined) continue
    const number = value[key]
    // modified is Unix milliseconds: past 2^32, so not a uint32
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0) {
      throw new Error(`${where}: ${key} must be a non-negative number`)
    }
    info[key] = number
  }
  return info
}

/**
 * An edit group's label is text without NUL (the engine cuts it to 100 bytes, makes control characters ? and names an
 * empty one "Edit")
 */
export function checkEditGroupLabel(label: unknown): void {
  if (typeof label !== "string" || label.includes("\0")) throw new Error("label must be a string without NUL")
}

/** What the Edit menu needs to know: whether Undo and Redo can run now, and what they would undo and redo */
export interface HistoryStatus {
  canUndo: boolean
  canRedo: boolean
  /** The step Undo would undo; "" for none */
  label: string
  /** The step Redo would redo; "" for none */
  redoLabel: string
  undoCount: number
  redoCount: number
}

/** Nothing to undo or redo: a new connection, a new scene */
export const EmptyHistoryStatus: HistoryStatus = Object.freeze({
  canUndo: false,
  canRedo: false,
  label: "",
  redoLabel: "",
  undoCount: 0,
  redoCount: 0,
})

/** The status GetHistory's answer describes: the first cursor steps are done (the last of them is Undo's), the rest undone */
export function historyStatusOf(history: HistoryResponse): HistoryStatus {
  const { cursor, entries } = history
  return {
    canUndo: cursor > 0,
    canRedo: cursor < entries.length,
    label: cursor > 0 ? entries[cursor - 1].label : "",
    redoLabel: cursor < entries.length ? entries[cursor].label : "",
    undoCount: cursor,
    redoCount: entries.length - cursor,
  }
}
