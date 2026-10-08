// The host's PollEvents events as typed values (protocol 1.3.0: sceneChanged, assetsChanged, projectChanged; the log
// events of 1.2.0 stay with the console). Events are plain JSON with the fields the protocol lists, and a client
// ignores kinds and keys it doesn't know, so parsing is lenient: a missing or mistyped field takes its default.
import type { EditorEvent } from "./protocol.generated"

/** The scene revision moved, a scene was saved, or another was loaded */
export interface SceneChangedEvent {
  kind: "sceneChanged"
  revision: number
  savedRevision: number
  /** The loaded scene's file (res://...); empty when it has none */
  path: string
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

/** The event as a state event, or null for a log event or a kind this editor doesn't know */
export function parseStateEvent(event: EditorEvent): StateEvent | null {
  switch (event.kind) {
    case "sceneChanged":
      return {
        kind: "sceneChanged",
        revision: count(event.revision),
        savedRevision: count(event.savedRevision),
        path: typeof event.path === "string" ? event.path : "",
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
