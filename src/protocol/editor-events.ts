// The host's PollEvents events as typed values (protocol 1.3.0: sceneChanged, assetsChanged, projectChanged, with
// sceneChanged's entityIds and full since 1.4.0; the log events of 1.2.0 stay with the console). Events are plain
// JSON with the fields the protocol lists, and a client ignores kinds and keys it doesn't know, so parsing is
// lenient: a missing or mistyped field takes its default.
import type { EditorEvent } from "./protocol.generated"

/** The scene revision moved, a scene was saved, or another was loaded */
export interface SceneChangedEvent {
  kind: "sceneChanged"
  revision: number
  savedRevision: number
  /** The loaded scene's file (res://...); empty when it has none */
  path: string
  /**
   * The UUIDs of the objects whose GetEntity data the change touched (since 1.4.0): those it created, destroyed,
   * renamed, re-tagged or moved to another layer, and, with everything under them, those it reparented,
   * transformed, activated or deactivated; the copy and its subtree for a duplicate. The siblings whose index
   * shifted aren't listed: refetch GetHierarchy when the revision moved. null when the event lists none (a save, a
   * change that touched more than 256 objects, or a host before 1.4.0), which is not an empty list.
   */
  entityIds: string[] | null
  /** Another scene was loaded (OpenScene, NewScene, LoadScene): every id held is invalid, refetch everything */
  full: boolean
}

/** A RescanAssets found changes: asset paths (res://...) */
export interface AssetsChangedEvent {
  kind: "assetsChanged"
  added: string[]
  removed: string[]
  modified: string[]
}

/** project.n2proj was saved (SetProjectSettings, SetStartupScene, ...) */
export interface ProjectChangedEvent {
  kind: "projectChanged"
}

export type StateEvent = SceneChangedEvent | AssetsChangedEvent | ProjectChangedEvent

const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

/**
 * What a sceneChanged event means for the objects a panel shows, given the revision known before it (null when none
 * is): everything may have changed (full), or only these objects did (entityIds, to refetch with GetEntity; the
 * hierarchy is refetched when the revision moved), or nothing did (a save, or an event older than what is known).
 */
export function sceneChangeOf(event: SceneChangedEvent, knownRevision: number | null): SceneChange | null {
  if (event.full) return { full: true, entityIds: [] }
  if (event.entityIds !== null) return { full: false, entityIds: event.entityIds }
  // Neither: a save changes no object (the revision stays), a change of more than 256 objects moves it
  if (knownRevision !== null && event.revision <= knownRevision) return null
  return { full: true, entityIds: [] }
}

/** The scene objects a change touched: see EditorStore.lastSceneChange */
export interface SceneChange {
  /** Refetch everything: the entity ids are then empty */
  full: boolean
  entityIds: string[]
}

/** More ids than this in one merged change count as everything (a panel refetching them one by one would do worse) */
export const MaxMergedEntityIds = 1024

/** The two changes as one: everything if either is, else the union of their ids (past MaxMergedEntityIds: everything) */
export function mergeSceneChange(a: SceneChange | null, b: SceneChange): SceneChange {
  if (a === null) return b.entityIds.length > MaxMergedEntityIds ? { full: true, entityIds: [] } : b
  if (a.full || b.full) return { full: true, entityIds: [] }
  const ids = [...new Set([...a.entityIds, ...b.entityIds])]
  return ids.length > MaxMergedEntityIds ? { full: true, entityIds: [] } : { full: false, entityIds: ids }
}

/** The event as a state event, or null for a log event or a kind this editor doesn't know */
export function parseStateEvent(event: EditorEvent): StateEvent | null {
  switch (event.kind) {
    case "sceneChanged":
      return {
        kind: "sceneChanged",
        revision: count(event.revision),
        savedRevision: count(event.savedRevision),
        path: typeof event.path === "string" ? event.path : "",
        entityIds: Array.isArray(event.entityIds) ? strings(event.entityIds) : null,
        full: event.full === true,
      }
    case "assetsChanged":
      return {
        kind: "assetsChanged",
        added: strings(event.added),
        removed: strings(event.removed),
        modified: strings(event.modified),
      }
    case "projectChanged":
      return { kind: "projectChanged" }
    default:
      return null
  }
}

/** Whether a scene with these revisions has unsaved changes (it is saved exactly when they are equal) */
export const hasUnsavedChanges = (scene: { revision: number; savedRevision: number }): boolean =>
  scene.revision !== scene.savedRevision
