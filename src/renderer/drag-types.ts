// What the panels put in a drag's dataTransfer, so the inspector's fields can tell what is being dragged over them
// (during a drag only the types are readable, not the data)

/** A file of the project dragged from the Files panel: its absolute path */
export const AssetDragType = "application/x-n2-asset"

/** An object dragged from the hierarchy: its id */
export const EntityDragType = "application/x-n2-entity"

/** Whether a drag carries the type (dataTransfer.types is a list of strings) */
export function dragHas(event: DragEvent, type: string): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes(type)
}
