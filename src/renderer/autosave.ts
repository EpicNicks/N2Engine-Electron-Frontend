// The autosave recovery question (engine #78, protocol 1.6.0): when a scene is opened and the host finds an autosave
// left by a session that ended without saving it (a crash), the editor offers to restore it. Pure functions, so the
// wording and the decision are unit tested; the store asks and acts (EditorStore.checkAutosave).
import type { AutosaveInfo, SceneInfoResponse } from "../protocol/protocol.generated"
import { hasUnsavedChanges } from "../protocol/editor-events"

/** What the user decides: restore the autosave, discard it, or decide later (the host keeps it, and writes no new one) */
export type AutosaveChoice = "restore" | "discard" | "later"

/** A size as people read it: 512 B, 1.5 KB, 3.2 MB */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size"
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * Whether to offer the autosave: there is one, and the scene has no unsaved changes. A scene that has them is one this
 * host has been editing (a page that reloaded, say), and the autosave is the host's own copy of what the editor
 * already has; only the one found when the scene was opened is a recovery.
 */
export function shouldOfferAutosave(scene: SceneInfoResponse, info: AutosaveInfo): boolean {
  return info.exists && !hasUnsavedChanges(scene)
}

/** The question's text: which scene, when the autosave was written, how large, and what deciding later means */
export function describeAutosave(
  sceneName: string,
  info: AutosaveInfo,
  formatTime: (unixMilliseconds: number) => string = (ms) => new Date(ms).toLocaleString()
): string {
  const details: string[] = []
  if (info.modified !== undefined && Number.isFinite(info.modified)) details.push(`written ${formatTime(info.modified)}`)
  if (info.size !== undefined) details.push(formatBytes(info.size))
  return (
    `${sceneName || "Untitled"} has an autosave from a session that ended with unsaved changes` +
    (details.length > 0 ? ` (${details.join(", ")})` : "") +
    ".\n\nRestore it (one step, which Undo takes back), or discard it? " +
    "Until you decide, or save the scene, the editor host writes no new autosave of it."
  )
}

/** What identifies the loaded scene for "asked about this one already": its file and its UUID */
export const sceneKey = (scene: SceneInfoResponse): string => `${scene.uuid}|${scene.path}`
