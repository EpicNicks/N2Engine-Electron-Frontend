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
