// The asset commands' answers (protocol 1.9.0: ListAssets, GetAssetInfo): validated before anything uses them. The
// engine stays the authority on paths and types; this only makes sure what arrives has the shape the panel reads.
import type { AssetDetails, AssetInfo, AssetListResponse, SubAssetInfo } from "./protocol.generated"

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function requireString(object: Record<string, unknown>, key: string, where: string): string {
  const value = object[key]
  if (typeof value !== "string") throw new Error(`${where}: ${key} must be a string`)
  return value
}

/** A byte count or a Unix-millisecond time: a non-negative finite number (past 2^32 for a time, so not a uint32) */
function requireCount(object: Record<string, unknown>, key: string, where: string): number {
  const value = object[key]
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${where}: ${key} must be a non-negative number`)
  }
  return value
}

function parseSubAssets(value: unknown, where: string): SubAssetInfo[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`${where}: subAssets must be an array`)
  return value.map((item, i) => {
    const at = `${where}: sub-asset ${i}`
    if (!isObject(item)) throw new Error(`${at} must be an object`)
    return {
      key: requireString(item, "key", at),
      uuid: requireString(item, "uuid", at),
      type: requireString(item, "type", at),
    }
  })
}

/** One AssetInfo (an item of ListAssets's assets): path, uuid, type, size, modified and the sub-assets a file has */
export function parseAssetInfo(value: unknown, where = "The asset"): AssetInfo {
  if (!isObject(value)) throw new Error(`${where} must be an object`)
  const info: AssetInfo = {
    path: requireString(value, "path", where),
    uuid: requireString(value, "uuid", where),
    type: requireString(value, "type", where),
    size: requireCount(value, "size", where),
    modified: requireCount(value, "modified", where),
  }
  const subAssets = parseSubAssets(value.subAssets, where)
  if (subAssets) info.subAssets = subAssets
  return info
}

/** ListAssets's answer: the subfolders (res:// paths) and the assets, as the host sorted them */
export function parseAssetList(value: unknown): AssetListResponse {
  if (!isObject(value)) throw new Error("The asset list must be an object")
  if (!Array.isArray(value.folders)) throw new Error("The asset list's folders must be an array")
  if (!Array.isArray(value.assets)) throw new Error("The asset list's assets must be an array")
  const folders = value.folders.map((folder, i) => {
    if (typeof folder !== "string") throw new Error(`The asset list's folder ${i} must be a string`)
    return folder
  })
  return { folders, assets: value.assets.map((asset, i) => parseAssetInfo(asset, `The asset list's item ${i}`)) }
}

/** GetAssetInfo's answer: an AssetInfo with the import settings (customData, an object) and whether it is loaded */
export function parseAssetDetails(value: unknown): AssetDetails {
  const where = "The asset details"
  const info = parseAssetInfo(value, where)
  const record = value as Record<string, unknown>
  const customData = record.customData ?? {}
  if (!isObject(customData)) throw new Error(`${where}: customData must be an object`)
  if (typeof record.loaded !== "boolean") throw new Error(`${where}: loaded must be a boolean`)
  return { ...info, customData, loaded: record.loaded }
}
