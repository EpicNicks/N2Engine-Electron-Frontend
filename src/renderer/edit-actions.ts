// The Edit menu and its keyboard shortcuts, which the editor's undo and redo plug into.
//
// EXTENSION POINT FOR UNDO AND REDO (engine #78, phase E6): nothing registers actions yet, so there is no Edit menu
// button and the shortcuts do nothing. When the host has undo and redo, the page builds an EditActions from them and
// sets `editActions.value = actions`: the toolbar then shows an Edit button with these items (editMenuItems), and
// Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y call them (editor.tsx, via editShortcutOf) except while a text field has the focus,
// where the field's own undo is meant. Nothing else in the inspector or the hierarchy needs to change.
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

export interface EditMenuItem {
  label: string
  action: () => void
  disabled?: boolean
}

/** The Edit menu's items for the registered actions: none while there are none */
export function editMenuItems(actions: EditActions | null): EditMenuItem[] {
  if (actions === null) return []
  return [
    { label: "Undo (Ctrl+Z)", action: () => void actions.undo(), disabled: !actions.canUndo() },
    { label: "Redo (Ctrl+Shift+Z)", action: () => void actions.redo(), disabled: !actions.canRedo() },
  ]
}
