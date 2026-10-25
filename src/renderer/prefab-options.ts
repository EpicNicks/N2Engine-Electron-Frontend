// Joins the hierarchy's prefab actions (protocol 1.19.0) to the page: whether the host has the prefabAssets capability, and
// the assets panel's listing for the paths of prefabs and the files that would be replaced. No DOM: unit tested in Node.
import { computed } from "@preact/signals-core"
import { hasCapability } from "../protocol/extensions"
import { PrefabAssetsCapability, samePath } from "../protocol/prefab-assets"
import type { AssetListing } from "./asset-tree"
import type { PrefabOptions } from "./hierarchy-state"

/** The parts of the store this reads */
export interface PrefabHost {
  connected: { readonly value: boolean }
  serverInfo: { readonly value: { capabilities?: unknown } | null }
}

/** The parts of the assets state this reads */
export interface PrefabAssets {
  listing: { readonly value: AssetListing | null }
  refresh(): Promise<void>
}

/** Whether the connected host advertises prefabAssets (false when not connected) */
export function prefabAssetsEnabled(host: PrefabHost): { readonly value: boolean } {
  return computed(() => host.connected.value && hasCapability(host.serverInfo.value?.capabilities, PrefabAssetsCapability))
}

export function prefabOptions(
  host: PrefabHost,
  assets: PrefabAssets,
  options: { caseInsensitivePaths: boolean; onError: (what: string, e: unknown) => void }
): PrefabOptions {
  return {
    enabled: prefabAssetsEnabled(host),
    pathOf: (uuid) => assets.listing.value?.assets.find((asset) => asset.uuid.toLowerCase() === uuid.toLowerCase())?.path ?? null,
    exists: (path) =>
      assets.listing.value?.assets.some((asset) => samePath(asset.path, path, options.caseInsensitivePaths)) ?? false,
    changed: () => void assets.refresh().catch((e) => options.onError("Failed to list the assets", e)),
  }
}
