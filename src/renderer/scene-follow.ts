// How the editor's panels follow the host: the connection, the selection, the assets and the scene's changes. They are
// signal effects, and an effect runs again when a signal it READ changes, so everything these call (the panels' own
// actions read and write their own signals) runs untracked: an effect must run on what it is meant to run on, and on
// nothing else. (One of them once read the hierarchy's response and then replaced it, and so ran again on every answer,
// for ever.) No DOM, so it is unit tested with fakes.
import { effect, untracked } from "@preact/signals-core"
import type { EditorStore } from "./store"
import type { SceneState } from "./scene-state"
import type { HierarchyState } from "./hierarchy-state"
import type { InspectorState } from "./inspector-state"

export interface FollowDeps {
  store: Pick<
    EditorStore,
    "connected" | "sceneChangeCount" | "lastSceneChange" | "assetsChangeCount" | "newestSceneRevision" | "reportError"
  >
  scene: Pick<SceneState, "selectedId" | "reset" | "refreshTransform">
  hierarchy: Pick<HierarchyState, "reset" | "applyChange" | "tree">
  inspector: Pick<
    InspectorState,
    "reset" | "loadTypes" | "loadAssets" | "select" | "applyChange" | "refreshLuaFields"
  >
}

/** Starts the effects; returns what stops them */
export function followScene({ store, scene, hierarchy, inspector }: FollowDeps): () => void {
  const stops = [
    // The panels follow the connection: a new connection is a new host, with nothing loaded yet
    effect(() => {
      if (!store.connected.value) {
        untracked(() => {
          scene.reset()
          hierarchy.reset()
          inspector.reset()
        })
      } else {
        // The component types and the project's assets don't change while the host runs (the assets on a rescan)
        untracked(() => {
          void inspector.loadTypes()
          void inspector.loadAssets()
        })
      }
    }),

    // The inspector shows the selected object (the hierarchy's primary selection)
    effect(() => {
      const id = scene.selectedId.value
      if (!store.connected.peek()) return
      untracked(() => inspector.select(id)).catch((e) => store.reportError("Failed to read the object", e))
    }),

    // Assets were added, changed or removed: the asset names, and a script's fields
    effect(() => {
      store.assetsChangeCount.value // what this runs on
      if (!store.connected.peek()) return
      untracked(() => {
        void inspector.loadAssets()
        void inspector.refreshLuaFields()
      })
    }),

    // The hierarchy and the inspector follow the scene's changes (a connection is one too, so it is read on connecting)
    effect(() => {
      store.sceneChangeCount.value // what this runs on
      const change = store.lastSceneChange.peek()
      if (!change || !store.connected.peek()) return
      // The inspector's components may have changed (this includes the echoes of its own edits)
      untracked(() => inspector.applyChange(change)).catch((e) => store.reportError("Failed to read the object", e))
      untracked(() => hierarchy.applyChange(change, store.newestSceneRevision))
        .then(() => {
          // The object's transform may have changed: read it again
          const id = scene.selectedId.peek()
          // Not for an object that is gone: the hierarchy has dropped it from the selection by now
          if (id !== null && hierarchy.tree.peek().nodes.has(id) && (change.full || change.entityIds.includes(id))) {
            return scene.refreshTransform()
          }
        })
        .catch((e) => store.reportError("Failed to read the scene", e))
    }),
  ]
  return () => stops.forEach((stop) => stop())
}
