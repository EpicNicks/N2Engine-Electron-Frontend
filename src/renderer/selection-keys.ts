// The keys that act on the selected objects (delete, duplicate, copy, cut, paste), shared by the panels that show the
// selection: the hierarchy (its list has the focus) and the viewport (the view has the focus). Each panel has its own
// actions in its own keymap scope, so they can be rebound apart; what they do is the hierarchy state's same action on
// the same selection. No DOM: unit tested in Node.
import type { ActionHandler } from "./keymap"

/** What the keys call: the hierarchy state (hierarchy-state.ts) has all of it */
export interface SelectionEditor {
  /** Why nothing can be changed (a running game, a read-only host); null when it can */
  readonly readOnlyReason: { peek(): string | null }
  /** Whether the host can copy and paste objects (protocol 1.18.0) */
  readonly canCopyPaste: boolean
  deleteSelected(): Promise<unknown>
  duplicateSelected(): Promise<unknown>
  copySelected(): Promise<unknown>
  cutSelected(): Promise<unknown>
  pasteCopied(): Promise<unknown>
}

export type SelectionKeyScope = "hierarchy" | "viewport"

/** The action ids of each scope's selection keys (keymap.ts DefaultActions) */
export const SelectionActions: Readonly<Record<SelectionKeyScope, Readonly<Record<"delete" | "duplicate" | "copy" | "cut" | "paste", string>>>> = {
  hierarchy: {
    delete: "hierarchy.delete",
    duplicate: "hierarchy.duplicate",
    copy: "hierarchy.copy",
    cut: "hierarchy.cut",
    paste: "hierarchy.paste",
  },
  viewport: {
    delete: "viewport.delete",
    duplicate: "viewport.duplicate",
    copy: "viewport.copy",
    cut: "viewport.cut",
    paste: "viewport.paste",
  },
}

export interface SelectionKeyOptions {
  /** A failed action is shown (the page's error banner) */
  report(what: string, e: unknown): void
  /** The keys are someone else's now (a live game in the viewport takes them): they are left alone */
  passThrough?(): boolean
}

/**
 * The handlers for a scope's selection keys. A read-only editor takes the key and does nothing (the keymap prevents its
 * default); a held key would repeat delete or duplicate on whatever is selected next, so each acts once per press. A
 * host before protocol 1.18.0 can't copy: those keys are left alone (false), so the browser's own copy still works.
 */
export function selectionKeyHandlers(
  scope: SelectionKeyScope,
  editor: SelectionEditor,
  options: SelectionKeyOptions
): Record<string, ActionHandler> {
  const ids = SelectionActions[scope]
  const fail = (what: string) => (e: unknown) => options.report(what, e)
  const readOnly = () => editor.readOnlyReason.peek() !== null
  const passing = () => options.passThrough?.() === true
  return {
    [ids.delete]: (e) => {
      if (passing()) return false
      if (!readOnly() && !e.repeat) void editor.deleteSelected().catch(fail("Failed to delete"))
    },
    [ids.duplicate]: (e) => {
      if (passing()) return false
      if (!readOnly() && !e.repeat) void editor.duplicateSelected().catch(fail("Failed to duplicate"))
    },
    // Copying is allowed while the game runs (it changes nothing)
    [ids.copy]: (e) => {
      if (passing() || !editor.canCopyPaste) return false
      if (!e.repeat) void editor.copySelected().catch(fail("Failed to copy"))
    },
    [ids.cut]: (e) => {
      if (passing() || !editor.canCopyPaste) return false
      if (!readOnly() && !e.repeat) void editor.cutSelected().catch(fail("Failed to cut"))
    },
    [ids.paste]: (e) => {
      if (passing() || !editor.canCopyPaste) return false
      if (!readOnly() && !e.repeat) void editor.pasteCopied().catch(fail("Failed to paste"))
    },
  }
}
