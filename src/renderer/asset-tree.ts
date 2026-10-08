// The assets panel's listing as rows: the folders and assets ListAssets answers (recursively, all at once) as a tree
// that is opened and closed, or as a flat list while a filter is on. res:// paths: the root is "res://", a folder is
// res://scenes (no trailing slash), a file res://scenes/Main.scene, and a model's part res://models/robot.glb#mesh/Body.
// No DOM, so it is unit tested in Node.
import type { AssetInfo, AssetListResponse, SubAssetInfo } from "../protocol/protocol.generated"
import type { AssetEntry } from "../shared/api"

export const RootFolder = "res://"

/** What ListAssets answered: the subfolders (empty ones too) and the assets */
export type AssetListing = AssetListResponse

/** The text after the last slash (the name of a folder or a file); a model part's key is not a path */
export function nameOf(path: string): string {
  const trimmed = path.endsWith("/") && path !== RootFolder ? path.slice(0, -1) : path
  return trimmed.slice(trimmed.lastIndexOf("/") + 1)
}

/** The folder a path is in; the root's parent is the root */
export function parentOf(path: string): string {
  const hash = path.indexOf("#")
  const file = hash < 0 ? path : path.slice(0, hash)
  const slash = file.lastIndexOf("/")
  if (slash < RootFolder.length) return RootFolder
  return file.slice(0, slash)
}

/** The res:// path of a name inside a folder */
export function childPath(folder: string, name: string): string {
  return folder === RootFolder || folder === "" ? `${RootFolder}${name}` : `${folder.replace(/\/$/, "")}/${name}`
}

/** A model's part as an asset: path#key */
export const subAssetPath = (parent: AssetInfo, sub: SubAssetInfo): string => `${parent.path}#${sub.key}`

export type AssetRow =
  | { kind: "folder"; path: string; name: string; depth: number; open: boolean; items: number }
  | { kind: "asset"; asset: AssetInfo; path: string; name: string; depth: number; open: boolean; parts: number }
  | { kind: "sub"; parent: AssetInfo; sub: SubAssetInfo; path: string; name: string; depth: number }

export interface AssetFilter {
  /** Matches a path or a UUID, in any case; "" matches all */
  text: string
  /** Only this resource type; "" for all */
  type: string
}

export const noFilter: AssetFilter = { text: "", type: "" }

export const isFiltering = (filter: AssetFilter): boolean => filter.text.trim() !== "" || filter.type !== ""

/** Every resource type in the listing (a model's parts too), sorted, for the filter's choices */
export function typesOf(listing: AssetListing): string[] {
  const types = new Set<string>()
  for (const asset of listing.assets) {
    if (asset.type) types.add(asset.type)
    for (const sub of asset.subAssets ?? []) if (sub.type) types.add(sub.type)
  }
  return [...types].sort((a, b) => a.localeCompare(b))
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true })

/**
 * The rows to show. Without a filter: the tree, a folder's contents (subfolders first, then files) only while it is in
 * open (a path in the set is open; the root always is); a model's parts follow it when it is open too. With a filter:
 * the matching assets and parts as one flat list sorted by path.
 */
export function buildRows(listing: AssetListing, open: ReadonlySet<string>, filter: AssetFilter = noFilter): AssetRow[] {
  if (isFiltering(filter)) return filterRows(listing, filter)

  // Folders the listing names, and those only a path implies, each with its direct children
  const folders = new Map<string, { folders: Set<string>; assets: AssetInfo[] }>()
  const folderOf = (path: string) => {
    let entry = folders.get(path)
    if (!entry) {
      entry = { folders: new Set(), assets: [] }
      folders.set(path, entry)
      if (path !== RootFolder) folderOf(parentOf(path)).folders.add(path)
    }
    return entry
  }
  folderOf(RootFolder)
  for (const folder of listing.folders) folderOf(folder.replace(/\/$/, "") || RootFolder)
  for (const asset of listing.assets) folderOf(parentOf(asset.path)).assets.push(asset)

  const count = (path: string): number => {
    const entry = folders.get(path)!
    let total = entry.assets.length
    for (const child of entry.folders) total += count(child)
    return total
  }

  const rows: AssetRow[] = []
  const walk = (path: string, depth: number) => {
    const entry = folders.get(path)!
    const subfolders = [...entry.folders].map((p) => ({ path: p, name: nameOf(p) })).sort(byName)
    for (const folder of subfolders) {
      const isOpen = open.has(folder.path)
      rows.push({ kind: "folder", path: folder.path, name: folder.name, depth, open: isOpen, items: count(folder.path) })
      if (isOpen) walk(folder.path, depth + 1)
    }
    const files = entry.assets.map((asset) => ({ asset, name: nameOf(asset.path) })).sort(byName)
    for (const { asset, name } of files) {
      const parts = asset.subAssets?.length ?? 0
      const isOpen = parts > 0 && open.has(asset.path)
      rows.push({ kind: "asset", asset, path: asset.path, name, depth, open: isOpen, parts })
      if (isOpen) {
        for (const sub of asset.subAssets ?? []) {
          rows.push({ kind: "sub", parent: asset, sub, path: subAssetPath(asset, sub), name: sub.key, depth: depth + 1 })
        }
      }
    }
  }
  walk(RootFolder, 0)
  return rows
}

function filterRows(listing: AssetListing, filter: AssetFilter): AssetRow[] {
  const text = filter.text.trim().toLowerCase()
  const matches = (path: string, uuid: string, type: string) =>
    (filter.type === "" || type === filter.type) &&
    (text === "" || path.toLowerCase().includes(text) || uuid.toLowerCase().includes(text))
  const rows: AssetRow[] = []
  for (const asset of listing.assets) {
    if (matches(asset.path, asset.uuid, asset.type)) {
      rows.push({
        kind: "asset",
        asset,
        path: asset.path,
        name: asset.path.slice("res://".length),
        depth: 0,
        open: false,
        parts: 0,
      })
    }
    for (const sub of asset.subAssets ?? []) {
      const path = subAssetPath(asset, sub)
      if (matches(path, sub.uuid, sub.type)) {
        rows.push({ kind: "sub", parent: asset, sub, path, name: path.slice("res://".length), depth: 0 })
      }
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}

/** The folders that hold a path, outermost first (the ones to open to show it) */
export function ancestorsOf(path: string): string[] {
  const found: string[] = []
  for (let folder = parentOf(path); folder !== RootFolder; folder = parentOf(folder)) found.unshift(folder)
  return found
}

/** Every file and part of the listing as the entries the inspector's asset fields choose from */
export function assetEntriesOf(listing: AssetListing): AssetEntry[] {
  const entries: AssetEntry[] = []
  for (const asset of listing.assets) {
    entries.push({ uuid: asset.uuid.toLowerCase(), path: asset.path, resourceType: asset.type })
    for (const sub of asset.subAssets ?? []) {
      entries.push({ uuid: sub.uuid.toLowerCase(), path: subAssetPath(asset, sub), resourceType: sub.type })
    }
  }
  return entries
}

/** A byte count for a person: 512 B, 1.5 KB, 3.2 MB */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ""
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** A modification time (Unix milliseconds) as a date and time; "" for none */
export function formatModified(modified: number): string {
  if (!Number.isFinite(modified) || modified <= 0) return ""
  const date = new Date(modified)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The first group of a UUID: enough to tell assets apart in a list (the full one is in the detail and the tooltip) */
export const shortUuid = (uuid: string): string => uuid.slice(0, 8)
