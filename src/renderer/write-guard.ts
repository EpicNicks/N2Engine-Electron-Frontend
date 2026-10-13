// What turns every write affordance off at once: the store's readOnlyReason (a play session, or a host started with
// --read-only) is pushed into the panels that hold their own edit state. The widgets that only read the store
// (canWrite, canEdit, hostReadOnly) follow it without this. No DOM: unit tested in Node.
import { effect } from "@preact/signals-core"
import type { EditorStore } from "./store"

/** A panel that can be made read-only, with the reason to show (null: editable again) */
export interface ReadOnlyPanel {
  setReadOnly(reason: string | null): void
}

/** Keeps the panels' read-only state equal to the store's reason; returns what stops it */
export function followWriteGuard(
  store: Pick<EditorStore, "readOnlyReason">,
  panels: { inspector: ReadOnlyPanel; hierarchy: ReadOnlyPanel }
): () => void {
  return effect(() => {
    const reason = store.readOnlyReason.value
    panels.inspector.setReadOnly(reason)
    panels.hierarchy.setReadOnly(reason)
  })
}
