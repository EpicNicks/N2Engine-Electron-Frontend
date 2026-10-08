// What the panels put in a drag's dataTransfer, so the inspector's fields can tell what is being dragged over them
// (during a drag only the types are readable, not the data)
import type { AssetEntry } from "../shared/api"


/** An asset dragged from the Assets panel: {uuid, path, type} as JSON (see assetDragData) */
export const AssetDragType = "application/x-n2-asset"

/** An object dragged from the hierarchy: its id */
export const EntityDragType = "application/x-n2-entity"

/** What a drag of an asset carries: enough to fill an asset field, which checks the type and takes the UUID */
export function assetDragData(asset: AssetEntry): string {
  return JSON.stringify({ uuid: asset.uuid, path: asset.path, type: asset.resourceType })
}

const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The asset a drag carried (assetDragData), or null for anything else: the data comes from a drop, so it is checked */
export function parseAssetDrag(data: string): AssetEntry | null {
  try {
    const value: unknown = JSON.parse(data)
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null
    const { uuid, path, type } = value as Record<string, unknown>
    if (typeof uuid !== "string" || !UuidPattern.test(uuid)) return null
    if (typeof path !== "string" || typeof type !== "string") return null
    return { uuid: uuid.toLowerCase(), path, resourceType: type }
  } catch {
    return null
  }
}

/** Whether a drag carries the type (dataTransfer.types is a list of strings) */
export function dragHas(event: DragEvent, type: string): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes(type)
}

/**
 * What a drag may do (dataTransfer.effectAllowed) and what a drop target asks for (dropEffect) must agree, or the browser
 * never fires the drop. A hierarchy row is moved within the hierarchy and copied onto a field, so it allows both; a file
 * is only copied. A field asks for a copy.
 */
export const EntityDragEffect = "copyMove"
export const AssetDragEffect = "copy"
export const FieldDropEffect = "copy"

/** Whether a drop with dropEffect is allowed by a drag's effectAllowed (the HTML drag-and-drop rules) */
export function effectAllows(effectAllowed: string, dropEffect: "copy" | "move" | "link"): boolean {
  const allowed = effectAllowed.toLowerCase()
  return allowed === "all" || allowed === "uninitialized" || allowed.includes(dropEffect)
}
