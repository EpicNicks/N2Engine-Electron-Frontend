// The project's assets as the host indexed them: one .meta per asset under .import/ (uuid, res:// path, resource type,
// and a model's sub-assets in customData.subAssets). The inspector's asset fields show an asset by its path and accept
// a file dropped from the Files panel, but the host's commands name assets only by UUID, and the protocol has no asset
// listing yet (the asset commands are phase E8), so the editor reads the index files itself. Read only, bounded, never
// through a link, and without blocking the main process (async, in small batches, with the parsed .meta files cached by
// their modification time). Node only (no Electron), so it is unit tested.
//
// The host keeps the .meta of a file that was deleted or moved (so a file put back gets its settings back), and its
// sub-asset index of a model that was changed since; an entry is listed only while the file is there, and a model's
// sub-assets only while the file is the one the index describes (customData.subAssetsSource).
import * as fs from "fs"
import * as path from "path"
import type { AssetEntry } from "../shared/api"

/** The folder under the project that holds the .meta files */
export const ImportFolder = ".import"

/** The project's assets folder (res://) */
export const AssetsFolder = "assets"

/** A .meta file is a few hundred bytes (a model's with its sub-asset index, a few hundred KB at most) */
export const MaxMetaBytes = 4 * 1024 * 1024
/** How many .meta files are read at most (more are ignored, so a runaway tree can't stall the main process) */
export const MaxMetaFiles = 100_000
/** How many bytes of .meta files are read in one listing, all together */
export const MaxTotalMetaBytes = 256 * 1024 * 1024
/** How many entries (files and sub-assets) are returned at most */
export const MaxAssetEntries = 200_000
/** How deep the .import tree is walked (it mirrors assets/, whose folders the editor lists 3 deep, but the host's go on) */
const MaxDepth = 32
/** How many files are looked at at once */
const Batch = 32

const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** What one .meta says */
export interface ParsedMeta {
  file: AssetEntry
  /** The file's size and whole-second modification time the sub-asset index was made from; null without one */
  source: { fileSize: number; lastModified: number } | null
  subAssets: AssetEntry[]
}

/** What a .meta's JSON describes, or null for a malformed one */
export function parseMeta(meta: unknown): ParsedMeta | null {
  if (!isObject(meta)) return null
  const { uuid, resourcePath, resourceType } = meta
  if (typeof uuid !== "string" || !UuidPattern.test(uuid)) return null
  if (typeof resourcePath !== "string" || !resourcePath.startsWith("res://")) return null
  const parsed: ParsedMeta = {
    file: {
      uuid: uuid.toLowerCase(),
      path: resourcePath,
      resourceType: typeof resourceType === "string" ? resourceType : "",
    },
    source: null,
    subAssets: [],
  }
  const customData = meta.customData
  if (!isObject(customData)) return parsed
  const source = customData.subAssetsSource
  if (isObject(source) && typeof source.fileSize === "number" && typeof source.lastModified === "number") {
    parsed.source = { fileSize: source.fileSize, lastModified: source.lastModified }
  }
  const subAssets = customData.subAssets
  if (isObject(subAssets)) {
    for (const [key, sub] of Object.entries(subAssets)) {
      if (!isObject(sub) || typeof sub.uuid !== "string" || !UuidPattern.test(sub.uuid)) continue
      if (typeof sub.type !== "string" || sub.type === "") continue
      parsed.subAssets.push({ uuid: sub.uuid.toLowerCase(), path: `${resourcePath}#${key}`, resourceType: sub.type })
    }
  }
  return parsed
}

/** The file of a res:// path under the project, or null for a path that leaves the assets folder */
export function assetFilePath(projectRoot: string, resourcePath: string): string | null {
  const relative = resourcePath.slice("res://".length)
  if (relative === "" || relative.includes("\0")) return null
  const assets = path.join(projectRoot, AssetsFolder)
  const file = path.resolve(assets, relative)
  const inside = path.relative(assets, file)
  return inside !== "" && !inside.startsWith("..") && !path.isAbsolute(inside) ? file : null
}

/** The parsed .meta files already read, by the .meta's path, valid while its size and modification time are the same */
export type AssetIndexCache = Map<string, { mtimeMs: number; size: number; parsed: ParsedMeta | null }>

/** The entries of a .meta if the file it describes is there (and, for a model's sub-assets, is the one indexed) */
async function liveEntries(projectRoot: string, parsed: ParsedMeta): Promise<AssetEntry[]> {
  const file = assetFilePath(projectRoot, parsed.file.path)
  if (file === null) return []
  let stat: fs.Stats
  try {
    stat = await fs.promises.lstat(file)
  } catch {
    return [] // the host forgot it (deleted, moved), but kept its .meta
  }
  if (!stat.isFile()) return []
  const entries = [parsed.file]
  const source = parsed.source
  if (source && source.fileSize === stat.size && source.lastModified === Math.floor(stat.mtimeMs / 1000)) {
    entries.push(...parsed.subAssets)
  }
  return entries
}

/**
 * Every asset the project's .import folder describes whose file is there, sorted by path. A project without the folder
 * (the host hasn't opened it yet) has none. A .meta that can't be read or parsed, is too large, or is a link is
 * skipped; at most MaxMetaFiles are read, MaxTotalMetaBytes of them in all. Pass the same cache each time to read
 * only the .meta files that changed since.
 */
export async function readAssetIndex(
  projectRoot: string,
  cache: AssetIndexCache = new Map(),
  totalBudget = MaxTotalMetaBytes
): Promise<AssetEntry[]> {
  const root = path.join(projectRoot, ImportFolder)
  // The folder itself must not be a link (to somewhere else on the disk)
  try {
    if (!(await fs.promises.lstat(root)).isDirectory()) return []
  } catch {
    return []
  }

  const metas: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let children: fs.Dirent[]
    try {
      children = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return // not readable
    }
    for (const child of children) {
      if (metas.length >= MaxMetaFiles) return
      const full = path.join(dir, child.name)
      // Dirent says what the entry itself is: a link is neither a file nor a directory here, so it is never followed
      if (child.isDirectory()) {
        if (depth < MaxDepth) await walk(full, depth + 1)
      } else if (child.isFile() && child.name.toLowerCase().endsWith(".meta")) {
        metas.push(full)
      }
    }
  }
  await walk(root, 0)

  const seen = new Set(metas)
  for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key) // a .meta that is gone

  const budget = { bytes: totalBudget }
  const parsedMetas: Array<ParsedMeta | null> = new Array(metas.length).fill(null)
  for (let start = 0; start < metas.length; start += Batch) {
    await Promise.all(
      metas.slice(start, start + Batch).map(async (meta, i) => {
        try {
          const stat = await fs.promises.stat(meta)
          const cached = cache.get(meta)
          if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            parsedMetas[start + i] = cached.parsed
            return
          }
          if (stat.size > MaxMetaBytes || budget.bytes < stat.size) return
          budget.bytes -= stat.size
          const parsed = parseMeta(JSON.parse(await fs.promises.readFile(meta, "utf-8")))
          cache.set(meta, { mtimeMs: stat.mtimeMs, size: stat.size, parsed })
          parsedMetas[start + i] = parsed
        } catch {
          // unreadable or not JSON: the host regenerates a corrupt .meta
        }
      })
    )
  }

  const entries: AssetEntry[] = []
  for (let start = 0; start < parsedMetas.length && entries.length < MaxAssetEntries; start += Batch) {
    const live = await Promise.all(
      parsedMetas.slice(start, start + Batch).map((parsed) => (parsed ? liveEntries(projectRoot, parsed) : []))
    )
    for (const found of live) entries.push(...found)
  }
  return entries.slice(0, MaxAssetEntries).sort((a, b) => a.path.localeCompare(b.path) || a.uuid.localeCompare(b.uuid))
}
