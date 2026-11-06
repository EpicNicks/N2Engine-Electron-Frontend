// The prefab stage (protocol 1.26.0): a prefab opened for editing as a scene of its own, with the open scene parked by
// the host. PrefabStageInfo as a typed value: parsing is lenient (a missing or mistyped field takes its default), as for
// the events, since a client ignores keys it doesn't know.

/** Isolated: the prefab alone. Context ("In Scene"): shown inside the parked scene, which is drawn dimmed */
export type PrefabStageMode = "isolated" | "context"

/** Hello's capabilities: the stage commands, and the In Scene mode's dimmed drawing */
export const PrefabStageCapability = "prefabStage"
export const PrefabStageContextCapability = "prefabStageContext"

/** An open stage, as the host reports it (closed is null) */
export interface PrefabStage {
  prefabUuid: string
  /** The prefab file (res://...); it follows the UUID when the file is moved */
  path: string
  /** The prefab's name, as its file has it */
  name: string
  mode: PrefabStageMode
  /** Unsaved changes (the stage's revision is not its saved one) */
  dirty: boolean
  revision: number
  savedRevision: number
  /** The instance of the prefab in the parked scene the stage is shown at (In Scene); null for none */
  anchorEntityId: string | null
  /** Whether the parked scene has an instance of the prefab */
  contextAvailable: boolean
  /** In Scene: the root's transform can't be changed */
  rootLocked: boolean
  /** The parked scene, for the breadcrumb */
  sceneName: string
  scenePath: string
  /** What the host found when opening (references it cleared, nested prefab links) */
  warnings: string[]
  /** The file was changed by something else than this stage's Save */
  externalChange: boolean
  /** The file was deleted: Save is refused */
  orphaned: boolean
}

const bool = (value: unknown): boolean => value === true
const text = (value: unknown): string => (typeof value === "string" ? value : "")
const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0

/** A PrefabStageInfo (GetPrefabStage, the stage commands, the prefabStageChanged event) as a stage; null when closed */
export function parsePrefabStageInfo(value: unknown): PrefabStage | null {
  if (typeof value !== "object" || value === null) return null
  const info = value as Record<string, unknown>
  if (info.open !== true) return null
  return {
    prefabUuid: text(info.prefabUuid),
    path: text(info.path),
    name: text(info.name),
    mode: info.mode === "context" ? "context" : "isolated",
    dirty: bool(info.dirty),
    revision: count(info.revision),
    savedRevision: count(info.savedRevision),
    anchorEntityId: typeof info.anchorEntityId === "string" && info.anchorEntityId !== "" ? info.anchorEntityId : null,
    contextAvailable: bool(info.contextAvailable),
    rootLocked: bool(info.rootLocked),
    sceneName: text(info.sceneName),
    scenePath: text(info.scenePath),
    warnings: Array.isArray(info.warnings) ? info.warnings.filter((w): w is string => typeof w === "string") : [],
    externalChange: bool(info.externalChange),
    orphaned: bool(info.orphaned),
  }
}

/** Whether a path names a prefab asset (what the Assets panel opens in the stage on a double click) */
export const isPrefabPath = (path: string): boolean => /\.prefab$/i.test(path)
