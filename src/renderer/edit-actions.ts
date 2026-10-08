// The Edit menu and its keyboard shortcuts, which the editor's undo and redo plug into.
//
// EXTENSION POINT FOR UNDO AND REDO (engine #78, phase E6): nothing registers actions yet, so there is no Edit menu
// button and the shortcuts do nothing. When the host has undo and redo, the page builds an EditActions from them and
// sets `editActions.value = actions`: the toolbar then shows an Edit button with these items (editMenuItems), and
// Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y call them (editor.tsx, via editShortcutOf) except while a text field has the focus
// (isTextEntry), where the field's own undo is meant. Nothing else in the inspector or the hierarchy needs to change.
import { signal } from "@preact/signals-core"

/** What undo and redo do, and whether they can right now */
export interface EditActions {
  undo(): Promise<void> | void
  redo(): Promise<void> | void
  canUndo(): boolean
  canRedo(): boolean
}

/** The registered actions; null until undo and redo exist (E6) */
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
  return [
    { label: "Undo (Ctrl+Z)", action: () => void runEditAction(actions, "undo", onError), disabled: !actions.canUndo() },
    {
      label: "Redo (Ctrl+Shift+Z)",
      action: () => void runEditAction(actions, "redo", onError),
      disabled: !actions.canRedo(),
    },
  ]
}
