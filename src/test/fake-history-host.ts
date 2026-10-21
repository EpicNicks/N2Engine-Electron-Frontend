// A fake edit backend for the history tests: a host whose history is a list of steps and a cursor, an EditController
// over it, and a HistoryModel over both. Undo and Redo move the cursor and answer like the engine; the test can make
// a step fail, change the history behind the editor's back (another client) and make the editor read-only.
import { signal } from "@preact/signals-core"
import type { EditResultResponse, HistoryEntry, HistoryResponse } from "../protocol/protocol.generated"
import { historyStatusOf, type HistoryStatus } from "../protocol/edit-history"
import { EditController } from "../renderer/edit-controller"
import { EditGroups } from "../renderer/edit-groups"
import { HistoryModel } from "../renderer/history-state"
import { FakeTimers } from "./fake-store-api"

export const entries = (...labels: string[]): HistoryEntry[] => labels.map((label) => ({ label, bytes: 100 }))

export function fakeHistoryHost(initial: HistoryResponse = { cursor: 0, entries: [] }) {
  let host: HistoryResponse = { cursor: initial.cursor, entries: [...initial.entries] }
  const log: string[] = []
  const history = signal<HistoryStatus>(historyStatusOf(host))
  const connected = signal(true)
  const scene = signal<{ revision: number; savedRevision: number } | null>({ revision: 1, savedRevision: 1 })
  const timers = new FakeTimers()
  const errors: string[] = []
  /** Undo or redo number n (1-based, counted over the whole test) refuses with this message */
  const failures = new Map<number, string>()
  let calls = 0
  /** Runs before each Undo or Redo is answered: a test changes the host or the editor here */
  let beforeStep: (n: number) => void = () => {}

  const answer = (label: string): EditResultResponse => ({
    label,
    revision: scene.value ? scene.value.revision + 1 : 1,
    canUndo: host.cursor > 0,
    canRedo: host.cursor < host.entries.length,
    savedRevision: 1,
  })
  const step = async (which: "undo" | "redo"): Promise<EditResultResponse> => {
    const n = ++calls
    beforeStep(n)
    log.push(which)
    const failure = failures.get(n)
    if (failure !== undefined) throw new Error(failure)
    if (which === "undo") {
      if (host.cursor === 0) throw new Error("Nothing to undo")
      host = { ...host, cursor: host.cursor - 1 }
    } else {
      if (host.cursor === host.entries.length) throw new Error("Nothing to redo")
      host = { ...host, cursor: host.cursor + 1 }
    }
    return answer(which)
  }

  const groups = new EditGroups({
    isConnected: () => true,
    beginEditGroup: async () => void log.push("begin"),
    endEditGroup: async () => void log.push("end"),
  })
  const canEdit = signal(true)
  const readOnlyReason = signal<string | null>(null)
  const controller = new EditController({
    engine: { undo: () => step("undo"), redo: () => step("redo") },
    groups,
    history,
    enabled: () => canEdit.value,
    settle: async () => void log.push("settle"),
    refreshHistory: async () => {
      log.push("refreshHistory")
      history.value = historyStatusOf(host)
    },
    syncAfterEdit: async () => {
      log.push("sync")
      history.value = historyStatusOf(host)
    },
    applyResult: (result) => {
      if (scene.value) scene.value = { revision: result.revision, savedRevision: result.savedRevision }
    },
  })
  const model = new HistoryModel({
    getHistory: async () => {
      log.push("getHistory")
      return { cursor: host.cursor, entries: [...host.entries] }
    },
    status: history,
    connected,
    readOnlyReason,
    canEdit,
    openGroups: groups.openCount,
    revisions: scene,
    jump: (target, options) => controller.jumpTo(target, options),
    timers,
  })
  return {
    host: () => host,
    log,
    errors,
    history,
    connected,
    canEdit,
    readOnlyReason,
    scene,
    timers,
    groups,
    controller,
    model,
    failures,
    setBeforeStep: (fn: (n: number) => void) => (beforeStep = fn),
    /** Another client edits: the host's history is replaced and its event reaches the editor */
    hostChanges: (next: HistoryResponse) => {
      host = { cursor: next.cursor, entries: [...next.entries] }
      history.value = historyStatusOf(host)
    },
  }
}

export const settleTasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
