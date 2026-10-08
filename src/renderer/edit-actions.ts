// The Edit menu and its keyboard shortcuts, which the editor's undo and redo plug into.
//
// The page registers the host's undo and redo (engine #78, phase E6; EditController in edit-controller.ts, set up in
// index.tsx) by setting `editActions.value = actions`: the toolbar then shows an Edit button with these items
// (editMenuItems), and Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y call them (editor.tsx, via editShortcutOf) except while a text
// field has the focus (isTextEntry), where the field's own undo is meant. Nothing registered: no button, and the keys
// do nothing.
import { signal } from "@preact/signals-core"

/** What undo and redo do, and whether they can right now */
export interface EditActions {
  undo(): Promise<void> | void
  redo(): Promise<void> | void
  canUndo(): boolean
  canRedo(): boolean
  /** What Undo would undo ("Create Cube"), for the menu; "" or absent for none */
  undoLabel?(): string
  /** What Redo would redo; "" or absent for none */
  redoLabel?(): string
}

/** The registered actions; null until the page registers them */
export const editActions = signal<EditActions | null>(null)

export type EditShortcut = "undo" | "redo"

/** The shortcut a key press is: Ctrl (or Cmd) Z, Ctrl Shift Z or Ctrl Y; null for any other */
export function editShortcutOf(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}): EditShortcut | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null
  const key = e.key.toLowerCase()
  if (key === "z") return e.shiftKey ? "redo" : "undo"
  if (key === "y" && !e.shiftKey) return "redo"
  return null
}

/** Runs undo or redo, whether it throws or rejects: a failure goes to onError, never unhandled */
export async function runEditAction(
  actions: EditActions,
  which: EditShortcut,
  onError: (what: string, error: unknown) => void
): Promise<void> {
  try {
    await (which === "undo" ? actions.undo() : actions.redo())
  } catch (e) {
    onError(`Failed to ${which}`, e)
  }
}

/** What a focused element is, as far as keys are concerned (an Element has these) */
export interface FocusedElement {
  tagName?: string
  type?: string
  isContentEditable?: boolean
}

/** Input types that take typed text, and so have an undo of their own */
const TextInputTypes = new Set(["", "text", "search", "number", "password", "email", "url", "tel"])

/**
 * Whether the focused element is one where Ctrl+Z means the text's own undo: a text-like input, a text area, or
 * editable content. A checkbox, a range, a colour, a select or a button isn't: the editor's undo is meant there.
 */
export function isTextEntry(element: FocusedElement | null | undefined): boolean {
  if (!element) return false
  if (element.isContentEditable) return true
  const tag = element.tagName?.toLowerCase()
  if (tag === "textarea") return true
  return tag === "input" && TextInputTypes.has((element.type ?? "").toLowerCase())
}

export interface EditMenuItem {
  label: string
  action: () => void
  disabled?: boolean
}

/** The Edit menu's items for the registered actions: none while there are none. A failure goes to onError. */
export function editMenuItems(
  actions: EditActions | null,
  onError: (what: string, error: unknown) => void
): EditMenuItem[] {
  if (actions === null) return []
  const canUndo = actions.canUndo()
  const canRedo = actions.canRedo()
  // The step's label only while there is a step: a stale one would name what can't be done
  const undoLabel = canUndo ? (actions.undoLabel?.() ?? "") : ""
  const redoLabel = canRedo ? (actions.redoLabel?.() ?? "") : ""
  return [
    {
      label: `Undo${undoLabel ? ` ${undoLabel}` : ""} (Ctrl+Z)`,
      action: () => void runEditAction(actions, "undo", onError),
      disabled: !canUndo,
    },
    {
      label: `Redo${redoLabel ? ` ${redoLabel}` : ""} (Ctrl+Shift+Z)`,
      action: () => void runEditAction(actions, "redo", onError),
      disabled: !canRedo,
    },
  ]
}
