// How the viewport follows the editor's selection and the scene's changes: which objects the gizmo moves (the topmost
// of the selection), when its targets are read again, and when a drag in progress is abandoned. Signal effects, run
// untracked for what they call (see scene-follow.ts); no DOM, so it is unit tested with fakes.
import { effect, untracked } from "@preact/signals-core"
import type { ReadonlySignal } from "@preact/signals-core"
import type { SceneChange } from "../protocol/editor-events"
import { HierarchyTree, Selection, topLevel } from "./hierarchy-tree"

/** The objects a drag of the gizmo moves: the topmost of the selection (an object under a selected one moves with it) */
export const moveIdsOf = (tree: HierarchyTree, selection: Selection): string[] => topLevel(tree, selection.ids)

/** What the gizmo's targets were read for: the primary selection and the objects that move */
export const selectionKeyOf = (primary: string | null, moveIds: readonly string[]): string =>
  `${primary ?? ""}|${moveIds.join(",")}`

export interface ViewportFollowDeps {
  store: {
    connected: ReadonlySignal<boolean>
    sceneChangeCount: ReadonlySignal<number>
    lastSceneChange: ReadonlySignal<SceneChange | null>
    /** How many sceneChanged events the host flagged full (another scene was loaded): not a change too big to list */
    sceneReplacedCount: ReadonlySignal<number>
  }
  hierarchy: { selection: ReadonlySignal<Selection>; tree: ReadonlySignal<HierarchyTree> }
  viewport: {
    loadTarget(id: string | null, changed?: ReadonlySet<string> | null): Promise<void>
    objectsChanged(entityIds: readonly string[], full: boolean, replaced: boolean): void
  }
}

/**
 * Starts the effects: the gizmo's targets follow the selection (read again when its primary object or the objects that
 * move change, not on every refresh of the tree), and the scene's changes reach the viewport, with whether the host
 * said another scene was loaded. forget() makes the next selection read happen (a new connection).
 */
export function followViewportSelection({ store, hierarchy, viewport }: ViewportFollowDeps): {
  stop(): void
  forget(): void
} {
  let loaded = ""
  let seenReplaced = untracked(() => store.sceneReplacedCount.value)
  const stops = [
    effect(() => {
      const selection = hierarchy.selection.value
      const tree = hierarchy.tree.value // an object reparented under a selected one stops moving by itself
      untracked(() => {
        const key = selectionKeyOf(selection.primary, moveIdsOf(tree, selection))
        if (key === loaded) return
        loaded = key
        void viewport.loadTarget(store.connected.value ? selection.primary : null)
      })
    }),
    effect(() => {
      store.sceneChangeCount.value // what this runs on
      untracked(() => {
        const change = store.lastSceneChange.value
        const replaced = store.sceneReplacedCount.value !== seenReplaced
        seenReplaced = store.sceneReplacedCount.value
        if (change && store.connected.value) viewport.objectsChanged(change.entityIds, change.full, replaced)
      })
    }),
  ]
  return {
    stop: () => stops.forEach((stop) => stop()),
    forget: () => {
      loaded = ""
    },
  }
}
