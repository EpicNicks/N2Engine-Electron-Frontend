// The project's assets as the host indexed them: one .meta per asset under .import/ (uuid, res:// path, resource type,
// and a model's sub-assets in customData.subAssets). The inspector's asset fields show an asset by its path and accept
// a file dropped from the Files panel, but the host's commands name assets only by UUID, and the protocol has no asset
// listing yet (the asset commands are phase E8), so the editor reads the index files itself. Read only, bounded, and
// never through a link. Node only (no Electron), so it is unit tested.
import * as fs from "fs"
import * as path from "path"
import type { AssetEntry } from "../shared/api"

/** The folder under the project that holds the .meta files */
export const ImportFolder = ".import"

/** A .meta file is a few hundred bytes (a model's with its sub-asset index, a few hundred KB at most) */
export const MaxMetaBytes = 4 * 1024 * 1024
/** How many .meta files are read at most (more are ignored, so a runaway tree can't stall the main process) */
export const MaxMetaFiles = 100_000
/** How many entries (files and sub-assets) are returned at most */
export const MaxAssetEntries = 200_000
/** How deep the .import tree is walked (it mirrors assets/, whose folders the editor lists 3 deep, but the host's go on) */
const MaxDepth = 32

const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The entries one .meta's JSON describes: the file itself, then its sub-assets; none for a malformed one */
export function entriesOfMeta(meta: unknown): AssetEntry[] {
  if (!isObject(meta)) return []
  const { uuid, resourcePath, resourceType } = meta
  if (typeof uuid !== "string" || !UuidPattern.test(uuid)) return []
  if (typeof resourcePath !== "string" || !resourcePath.startsWith("res://")) return []
  const entries: AssetEntry[] = [
    { uuid: uuid.toLowerCase(), path: resourcePath, resourceType: typeof resourceType === "string" ? resourceType : "" },
  ]
  const customData = meta.customData
  const subAssets = isObject(customData) ? customData.subAssets : undefined
  if (isObject(subAssets)) {
    for (const [key, sub] of Object.entries(subAssets)) {
      if (!isObject(sub) || typeof sub.uuid !== "string" || !UuidPattern.test(sub.uuid)) continue
      if (typeof sub.type !== "string" || sub.type === "") continue
      entries.push({ uuid: sub.uuid.toLowerCase(), path: `${resourcePath}#${key}`, resourceType: sub.type })
    }
  }
  return entries
}

/**
 * Every asset the project's .import folder describes, sorted by path. A project without the folder (the host hasn't
 * opened it yet) has none. A .meta that can't be read or parsed, is too large, or is a link is skipped.
 */
export function readAssetIndex(projectRoot: string): AssetEntry[] {
  const entries: AssetEntry[] = []
  const root = path.join(projectRoot, ImportFolder)
  const budget = { files: MaxMetaFiles }

  const walk = (dir: string, depth: number): void => {
    let children: fs.Dirent[]
    try {
      children = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // no such folder, or not readable
    }
    for (const child of children) {
      if (entries.length >= MaxAssetEntries || budget.files <= 0) return
      const full = path.join(dir, child.name)
      // Dirent says what the entry itself is: a link is neither a file nor a directory here, so it is never followed
      if (child.isDirectory()) {
        if (depth < MaxDepth) walk(full, depth + 1)
      } else if (child.isFile() && child.name.toLowerCase().endsWith(".meta")) {
        budget.files--
        try {
          if (fs.statSync(full).size > MaxMetaBytes) continue
          entries.push(...entriesOfMeta(JSON.parse(fs.readFileSync(full, "utf-8"))))
        } catch {
          // unreadable or not JSON: the host regenerates a corrupt .meta
        }
      }
    }
  }

  // The folder itself must not be a link (to somewhere else on the disk)
  try {
    if (!fs.lstatSync(root).isDirectory()) return []
  } catch {
    return []
  }
  walk(root, 0)
  return entries.slice(0, MaxAssetEntries).sort((a, b) => a.path.localeCompare(b.path) || a.uuid.localeCompare(b.uuid))
}
