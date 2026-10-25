// Prefab assets (protocol 1.19.0: CreatePrefab, InstantiatePrefab, ApplyPrefab, UnpackPrefab). A prefab is a copy with a
// link: an instance is ordinary objects whose root remembers the prefab's asset UUID, and nothing keeps the two in step
// (changing a prefab does not change instances already in a scene). The host checks the commands; this holds the names
// the editor needs and the path rules it applies first, so a typo is caught before a request is sent.

/** The Hello capability of a host with the four prefab commands */
export const PrefabAssetsCapability = "prefabAssets"

/** The resource type ListAssets gives a .prefab file */
export const PrefabResourceType = "Prefab"

export const PrefabExtension = ".prefab"

/** The folder a prefab goes in unless the user picks another */
export const DefaultPrefabFolder = "res://prefabs"

/** The words the UI uses about what a prefab is (v1), so the limits are never a surprise */
export const PrefabCopyNotice =
  "A prefab is a copy with a link: changing the prefab does not update objects already in a scene."

/** The longest path the editor sends (the host has its own limits) */
export const MaxPrefabPathLength = 260

/** A file name for an object's name: characters a file name may not have become "_"; "Prefab" for nothing left */
export function prefabFileName(objectName: string): string {
  const cleaned = objectName
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
  return cleaned === "" ? "Prefab" : cleaned
}

/** The path the Create Prefab prompt starts with: res://prefabs/<name>.prefab */
export function defaultPrefabPath(objectName: string, folder: string = DefaultPrefabFolder): string {
  const base = folder.replace(/\/+$/, "")
  return `${base}/${prefabFileName(objectName)}${PrefabExtension}`
}

/** The path a prefab made from a dragged object has in the folder (the folder is "res://" or "res://dir") */
export function prefabPathIn(folder: string, objectName: string): string {
  const base = folder === "res://" ? "res:/" : folder.replace(/\/+$/, "")
  return `${base}/${prefabFileName(objectName)}${PrefabExtension}`
}

/**
 * What the user typed as a prefab's path, made into a res:// path ending in .prefab (res:// and the extension are put
 * on when missing; surrounding spaces and a leading slash go), and the reason it can't be one: null error when it can.
 */
export function normalizePrefabPath(text: string): { path: string; error: null } | { path: null; error: string } {
  let path = text.trim()
  if (path === "") return { path: null, error: "Enter a path for the prefab" }
  if (path.includes("\\")) return { path: null, error: "Use / in the path, not \\" }
  if (!path.toLowerCase().startsWith("res://")) path = `res://${path.replace(/^\/+/, "")}`
  const rest = path.slice("res://".length)
  if (rest === "" || rest.endsWith("/")) return { path: null, error: "The path must name a file" }
  if (/(^|\/)\.\.?(\/|$)/.test(rest)) return { path: null, error: "The path can't contain . or .. parts" }
  if (/\/\//.test(rest)) return { path: null, error: "The path can't contain empty folder names" }
  if (/[:*?"<>|\u0000-\u001f]/.test(rest)) return { path: null, error: "The path has a character a file name can't have" }
  if (!path.toLowerCase().endsWith(PrefabExtension)) path += PrefabExtension
  if (path.slice("res://".length).toLowerCase() === PrefabExtension) {
    return { path: null, error: "The path must name a file" }
  }
  if (path.length > MaxPrefabPathLength) return { path: null, error: "The path is too long" }
  return { path, error: null }
}

/** Whether two res:// paths are the same file (Windows and macOS file systems don't tell case apart) */
export function samePath(a: string, b: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b
}
