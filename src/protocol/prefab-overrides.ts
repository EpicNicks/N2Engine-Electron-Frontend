// Prefab links and their overrides (protocol 1.33.0 and 1.34.0). An instance of a prefab link is the prefab's objects
// with ids derived from the link, kept in step with the prefab: a change of the prefab reaches it, and what the
// instance changes is saved as its overrides. GetPrefabOverrides lists those changes (its outermost link's), and
// RevertPrefabOverrides and ApplyPrefabOverrides take entries of that list as targets. This turns the host's answer into
// rows the inspector shows, and names the targets the rows send back.
import type { PrefabLinkLevel, PrefabOverridesInfo } from "./protocol.generated"

/** The Hello capability of a host with prefab links, GetPrefabOverrides and RevertPrefabOverrides (1.33.0) */
export const PrefabNestingCapability = "prefabNesting"
/** The Hello capability of a host with ApplyPrefabOverrides, the override marks, Unpack completely and variants (1.34.0) */
export const PrefabOverridesApplyCapability = "prefabOverridesApply"

/** The lists of a link's changes, in the order GetPrefabOverrides gives them */
export const ChangeKinds = ["overrides", "removedObjects", "removedComponents", "addedComponents", "addedChildren"] as const
export type ChangeKind = (typeof ChangeKinds)[number]

/** A prefab an entry can be applied to: level 0 is the outermost instance's prefab, 1 the one of the link inside it... */
export interface ApplyLevel {
  level: number
  prefab: string
  path: string
}

/** One change of an instance, as the inspector lists it */
export interface OverrideRow {
  kind: ChangeKind
  /** What RevertPrefabOverrides and ApplyPrefabOverrides take to name exactly this change */
  target: Record<string, unknown>
  /** The scene object it is on (an override, an added component, the parent of an added child); null when gone or unknown */
  objectId: string | null
  /** The component of a component override */
  componentId: string | null
  /** An override's path ("name", "positionable.localScale", "scriptData.speed", a component value's key) */
  path: string | null
  /** The prefabs it can be applied to, outer to inner (empty from a host before 1.34.0) */
  levels: ApplyLevel[]
}

type Entry = Record<string, unknown>

const isObject = (value: unknown): value is Entry => typeof value === "object" && value !== null && !Array.isArray(value)

const stringOf = (value: unknown): string | null => (typeof value === "string" ? value : null)

/** The id an added component or child carries (its own data's uuid) */
function addedId(kind: ChangeKind, entry: Entry): string | null {
  if (kind === "addedChildren") return isObject(entry.object) ? stringOf(entry.object.uuid) : null
  if (kind === "addedComponents" && isObject(entry.component) && isObject(entry.component.data)) {
    return stringOf(entry.component.data.uuid)
  }
  return null
}

/** The target that names one entry of a change list, or null for an entry that can't be named */
export function targetOf(kind: ChangeKind, entry: unknown): Record<string, unknown> | null {
  switch (kind) {
    case "overrides": {
      if (!isObject(entry) || typeof entry.source !== "string" || typeof entry.path !== "string") return null
      const target: Record<string, unknown> = { source: entry.source, path: entry.path }
      if (typeof entry.component === "string") target.component = entry.component
      return target
    }
    case "removedObjects":
      return typeof entry === "string" ? { removedObject: entry } : null
    case "removedComponents":
      return typeof entry === "string" ? { removedComponent: entry } : null
    case "addedComponents": {
      const id = isObject(entry) ? addedId(kind, entry) : null
      return id === null ? null : { addedComponent: id }
    }
    case "addedChildren": {
      const id = isObject(entry) ? addedId(kind, entry) : null
      return id === null ? null : { addedChild: id }
    }
  }
}

function levelsOf(value: unknown): ApplyLevel[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isObject)
    .filter((l) => typeof l.level === "number" && typeof l.prefab === "string")
    .map((l) => ({ level: l.level as number, prefab: l.prefab as string, path: stringOf(l.path) ?? "" }))
}

/** Every change of the instance as a row, in the host's order; entries that can't be named are left out */
export function overrideRows(info: PrefabOverridesInfo): OverrideRow[] {
  const rows: OverrideRow[] = []
  const applyTo = isObject(info.applyTo) ? info.applyTo : {}
  for (const kind of ChangeKinds) {
    const list: unknown[] = Array.isArray(info[kind]) ? (info[kind] as unknown[]) : []
    const levels: unknown[] = Array.isArray(applyTo[kind]) ? (applyTo[kind] as unknown[]) : []
    list.forEach((entry, i) => {
      const target = targetOf(kind, entry)
      if (target === null) return
      const object = isObject(entry) ? entry : {}
      rows.push({
        kind,
        target,
        objectId: stringOf(object.objectId),
        componentId: kind === "overrides" ? stringOf(object.componentId) : kind === "addedComponents" ? addedId(kind, object) : null,
        path: kind === "overrides" ? stringOf(object.path) : null,
        levels: levelsOf(levels[i]),
      })
    })
  }
  return rows
}

/** Whether a path names the field or something inside it: "speed" covers "speed" and "speed.x" */
const covers = (path: string, field: string): boolean => path === field || path.startsWith(`${field}.`)

/**
 * Whether a field of a component (or the object) differs from the prefab, from GetEntity's overrides list (1.34.0): the
 * list holds a value's key, or "scriptData.<field>" for a script's field, or a deeper path inside either
 */
export function isFieldOverridden(overrides: readonly string[] | undefined, field: string): boolean {
  if (!overrides || overrides.length === 0) return false
  return overrides.some((path) => covers(path, field) || covers(path, `scriptData.${field}`))
}

/** The rows of a field of one object (componentId null: the object's own field), for its Revert and Apply menu */
export function rowsForField(rows: readonly OverrideRow[], objectId: string, componentId: string | null, field: string): OverrideRow[] {
  return rows.filter(
    (row) =>
      row.kind === "overrides" &&
      row.objectId === objectId &&
      row.componentId === componentId &&
      row.path !== null &&
      (covers(row.path, field) || covers(row.path, `scriptData.${field}`))
  )
}

/** The levels every one of the rows can be applied to (the ones they share), outer to inner */
export function sharedLevels(rows: readonly OverrideRow[]): ApplyLevel[] {
  if (rows.length === 0) return []
  return rows[0].levels.filter((level) => rows.every((row) => row.levels.some((l) => l.level === level.level && l.prefab === level.prefab)))
}

/** A prefab's file name for a label ("res://props/Crate.prefab" -> "Crate.prefab"), or its UUID when it has no path */
export function prefabLabel(level: { prefab: string; path: string }): string {
  if (level.path === "") return level.prefab
  const slash = level.path.lastIndexOf("/")
  return slash < 0 ? level.path : level.path.slice(slash + 1)
}

/** What a row says, given the names of the scene's objects and components */
export function describeRow(
  row: OverrideRow,
  names: { object(id: string): string | null; component(id: string): string | null }
): string {
  const object = row.objectId !== null ? (names.object(row.objectId) ?? "an object") : "an object"
  switch (row.kind) {
    case "overrides": {
      const component = row.componentId !== null ? names.component(row.componentId) : null
      return `${object}: ${component !== null ? `${component} ` : ""}${row.path ?? ""}`
    }
    case "removedObjects":
      return "Removed an object of the prefab"
    case "removedComponents":
      return "Removed a component of the prefab"
    case "addedComponents":
      return `${object}: added ${row.componentId !== null ? (names.component(row.componentId) ?? "a component") : "a component"}`
    case "addedChildren":
      return `Added ${names.object(String(row.target.addedChild)) ?? "an object"} under ${object}`
  }
}

/** The links an object is in, outer to inner (GetPrefabOverrides' linkPath; empty from a host before 1.34.0) */
export function linkPathOf(info: PrefabOverridesInfo): PrefabLinkLevel[] {
  return Array.isArray(info.linkPath) ? info.linkPath.filter((l) => typeof l.prefab === "string" && typeof l.rootId === "string") : []
}
