// What the editor's global shortcuts do (the keymap's file.save, edit.undo and edit.redo): registered by the editor
// (editor.tsx) for as long as it is open. Kept apart from the component so a test can drive them with fakes.
import { editActions, runEditAction } from "./edit-actions"
import type { ActionHandler } from "./keymap"

/** The parts of the page's state the global shortcuts use */
export interface GlobalActionDeps {
  store: {
    scene: { value: unknown }
    busy: { value: unknown }
    saveScene(): Promise<unknown>
    reportError(what: string, error: unknown): void
  }
  hierarchy: { renameSettled: Promise<unknown> }
  inspector: { flush(): Promise<unknown> | void }
  assets: { refresh(): Promise<unknown> }
}

export function globalActionHandlers(deps: GlobalActionDeps): Record<"file.save" | "edit.undo" | "edit.redo", ActionHandler> {
  const { store, hierarchy, inspector, assets } = deps

  /** Runs undo or redo for a key press: false (not taken) while nothing is registered */
  const runEdit = (which: "undo" | "redo", e: KeyboardEvent): boolean | void => {
    const actions = editActions.value
    if (actions === null) return false
    // A held key repeats: one undo is running and one is waiting, which is enough
    if (e.repeat && actions.busy?.()) return
    void runEditAction(actions, which, (what, err) => store.reportError(what, err))
  }

  return {
    // Ctrl+S saves the scene (the text editor and the import settings have their own, which come first in their scope)
    "file.save": (e) => {
      const target = e.target as HTMLElement | null
      // Not under a dialog (its own field's key)
      if (target?.closest?.(".modal")) return
      // Not twice at once
      if (!store.scene.value || store.busy.value !== null) return
      // A name or a value being typed is committed first, so the saved scene has it
      if (target?.classList?.contains("hierarchy-rename") || target?.closest?.(".inspector-panel")) target.blur()
      // And what the inspector edited a moment ago is sent
      void hierarchy.renameSettled
        .then(() => inspector.flush())
        .then(() => store.saveScene())
        .then((saved) => saved && assets.refresh().catch(() => {}))
    },
    // Undo and redo (E6, edit-actions.ts): nothing is registered yet. A text field keeps its own undo (the keymap
    // doesn't fire these while one has the focus).
    "edit.undo": (e) => runEdit("undo", e),
    "edit.redo": (e) => runEdit("redo", e),
  }
}
