// The hierarchy panel's logic with no state and no DOM: the tree built from GetHierarchy's flat list, the rows the
// panel shows, the selection rules and where a drag may drop. Unit tested in Node.
import type { HierarchyNode } from "../protocol/protocol.generated"

/** The parent id of an object at the root of the scene (and the key of the roots' list) */
export const RootId = ""

export interface HierarchyTree {
  nodes: ReadonlyMap<string, HierarchyNode>
  /** Parent id (RootId for the scene's roots) to its children's ids, in sibling order */
  children: ReadonlyMap<string, readonly string[]>
  /** Each object's parent id as the tree has it (RootId for roots, and for an object whose parent isn't listed) */
  parents: ReadonlyMap<string, string>
  /** Every id, depth-first: a parent before its children, siblings in order */
  order: readonly string[]
}

/**
 * Builds the tree from GetHierarchy's nodes. The list is already depth-first, but siblings are ordered by their
 * `index` anyway (ties keep the list's order), an object whose parent isn't listed becomes a root, and a repeated id
 * is ignored, so a list that isn't what the protocol promises still gives a tree.
 */
export function buildTree(list: readonly HierarchyNode[]): HierarchyTree {
  const nodes = new Map<string, HierarchyNode>()
  for (const node of list) if (!nodes.has(node.id)) nodes.set(node.id, node)

  const grouped = new Map<string, HierarchyNode[]>()
  const parents = new Map<string, string>()
  for (const node of nodes.values()) {
    const parent = node.parentId !== node.id && nodes.has(node.parentId) ? node.parentId : RootId
    parents.set(node.id, parent)
    const siblings = grouped.get(parent)
    if (siblings) siblings.push(node)
    else grouped.set(parent, [node])
  }
  const children = new Map<string, readonly string[]>()
  for (const [parent, siblings] of grouped) {
    // Array.prototype.sort is stable
    children.set(
      parent,
      siblings.sort((a, b) => a.index - b.index).map((node) => node.id)
    )
  }

  const order: string[] = []
  const visit = (id: string): void => {
    order.push(id)
    for (const child of children.get(id) ?? []) visit(child)
  }
  for (const root of children.get(RootId) ?? []) visit(root)
  // A cycle (a parent chain that never reaches the roots) isn't reachable from them: it stays out of the tree
  return { nodes, children, parents, order }
}

export const childrenOf = (tree: HierarchyTree, id: string): readonly string[] => tree.children.get(id) ?? []

/** Whether id is under ancestorId (not the same object) */
export function isDescendant(tree: HierarchyTree, id: string, ancestorId: string): boolean {
  let current = tree.parents.get(id)
  for (let steps = 0; current !== undefined && current !== RootId && steps <= tree.nodes.size; steps++) {
    if (current === ancestorId) return true
    current = tree.parents.get(current)
  }
  return false
}

/** One line of the panel */
export interface Row {
  id: string
  depth: number
  hasChildren: boolean
  expanded: boolean
}

/** The rows the panel shows: the objects whose ancestors are all expanded, depth-first */
export function visibleRows(tree: HierarchyTree, expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = []
  const visit = (id: string, depth: number): void => {
    const kids = childrenOf(tree, id)
    const open = kids.length > 0 && expanded.has(id)
    rows.push({ id, depth, hasChildren: kids.length > 0, expanded: open })
    if (open) for (const kid of kids) visit(kid, depth + 1)
  }
  for (const root of childrenOf(tree, RootId)) visit(root, 0)
  return rows
}

/** The ids of id's ancestors, nearest first */
export function ancestorsOf(tree: HierarchyTree, id: string): string[] {
  const result: string[] = []
  let current = tree.parents.get(id)
  while (current !== undefined && current !== RootId && result.length <= tree.nodes.size) {
    result.push(current)
    current = tree.parents.get(current)
  }
  return result
}

/** The ids with no ancestor among them (an object and its descendant selected: just the object), in tree order */
export function topLevel(tree: HierarchyTree, ids: ReadonlySet<string>): string[] {
  return tree.order.filter((id) => ids.has(id) && !ancestorsOf(tree, id).some((ancestor) => ids.has(ancestor)))
}

// ==================== Selection ====================

export interface Selection {
  ids: ReadonlySet<string>
  /** Where a shift-click's range starts */
  anchor: string | null
  /** The one the inspector shows: the one clicked last */
  primary: string | null
}

export const emptySelection: Selection = { ids: new Set(), anchor: null, primary: null }

export const selectOnly = (id: string): Selection => ({ ids: new Set([id]), anchor: id, primary: id })

export interface ClickModifiers {
  /** Ctrl (or Cmd): toggle the one clicked */
  toggle?: boolean
  /** Shift: everything between the anchor and the one clicked */
  range?: boolean
}

/** The selection after a click on a row; visibleIds are the rows shown, in order */
export function clickSelect(
  selection: Selection,
  visibleIds: readonly string[],
  id: string,
  modifiers: ClickModifiers = {}
): Selection {
  if (modifiers.range) {
    const from = selection.anchor !== null ? visibleIds.indexOf(selection.anchor) : -1
    const to = visibleIds.indexOf(id)
    if (from >= 0 && to >= 0) {
      const [first, last] = from <= to ? [from, to] : [to, from]
      return { ids: new Set(visibleIds.slice(first, last + 1)), anchor: selection.anchor, primary: id }
    }
    return selectOnly(id)
  }
  if (modifiers.toggle) {
    const ids = new Set(selection.ids)
    if (ids.delete(id)) {
      const primary = selection.primary === id ? ([...ids].pop() ?? null) : selection.primary
      return { ids, anchor: id, primary }
    }
    ids.add(id)
    return { ids, anchor: id, primary: id }
  }
  return selectOnly(id)
}

/** The selection for a right-click: kept when the row is in it, else just that row */
export const contextSelect = (selection: Selection, id: string): Selection =>
  selection.ids.has(id) ? selection : selectOnly(id)

/** The selection without the ids the tree no longer has (the same object when nothing changed) */
export function pruneSelection(selection: Selection, tree: HierarchyTree): Selection {
  const ids = new Set([...selection.ids].filter((id) => tree.nodes.has(id)))
  const anchor = selection.anchor !== null && tree.nodes.has(selection.anchor) ? selection.anchor : null
  let primary = selection.primary !== null && ids.has(selection.primary) ? selection.primary : null
  if (primary === null && ids.size > 0) primary = tree.order.filter((id) => ids.has(id)).pop()!
  if (ids.size === selection.ids.size && anchor === selection.anchor && primary === selection.primary) return selection
  return { ids, anchor, primary }
}

/**
 * The selection with each selected object that isn't shown (an ancestor is collapsed) replaced by its nearest ancestor
 * that is, so keys and commands never act on a row nobody sees (the same object when everything is shown)
 */
export function showSelection(selection: Selection, tree: HierarchyTree, shown: ReadonlySet<string>): Selection {
  const lift = (id: string | null): string | null => {
    let current = id
    for (let steps = 0; current !== null && !shown.has(current) && steps <= tree.nodes.size; steps++) {
      const parent = tree.parents.get(current)
      current = parent === undefined || parent === RootId ? null : parent
    }
    return current !== null && shown.has(current) ? current : null
  }
  const ids = new Set<string>()
  for (const id of selection.ids) {
    const lifted = lift(id)
    if (lifted !== null) ids.add(lifted)
  }
  const anchor = lift(selection.anchor)
  const primary = lift(selection.primary)
  const same = [...selection.ids].every((id) => ids.has(id)) && ids.size === selection.ids.size
  if (same && anchor === selection.anchor && primary === selection.primary) return selection
  return { ids, anchor, primary }
}

/** The row an arrow key moves to from `from` (the first or last when there is none): null when nothing is shown */
export function stepRow(visibleIds: readonly string[], from: string | null, delta: 1 | -1): string | null {
  if (visibleIds.length === 0) return null
  const index = from === null ? -1 : visibleIds.indexOf(from)
  if (index < 0) return delta > 0 ? visibleIds[0] : visibleIds[visibleIds.length - 1]
  return visibleIds[Math.min(visibleIds.length - 1, Math.max(0, index + delta))]
}

// ==================== Drag and drop ====================

/** Where on a row the pointer is: above it, below it, or on it (to become its child) */
export type DropPosition = "before" | "after" | "inside"

/** A place in the tree: under parentId (RootId: the scene), at index among the children shown there (-1: the end) */
export interface DropTarget {
  parentId: string
  index: number
}

/**
 * The place a drop over a row means; overId null is the empty space below the rows (the end of the roots). An
 * "after" on a row that is open, so with its children right below it, is the place before its first child, which is
 * where the line is drawn. null for an id the tree doesn't have.
 */
export function resolveDrop(
  tree: HierarchyTree,
  overId: string | null,
  position: DropPosition,
  expanded: ReadonlySet<string>
): DropTarget | null {
  if (overId === null) return { parentId: RootId, index: -1 }
  if (!tree.nodes.has(overId)) return null
  if (position === "inside") return { parentId: overId, index: -1 }
  const parentId = tree.parents.get(overId) ?? RootId
  if (position === "before") return { parentId, index: childrenOf(tree, parentId).indexOf(overId) }
  if (expanded.has(overId) && childrenOf(tree, overId).length > 0) return { parentId: overId, index: 0 }
  return { parentId, index: childrenOf(tree, parentId).indexOf(overId) + 1 }
}

/**
 * Whether the objects may be dropped there: not onto themselves or anything under them (the engine refuses that too),
 * and the parent must exist
 */
export function canDrop(tree: HierarchyTree, draggedIds: readonly string[], target: DropTarget): boolean {
  if (draggedIds.length === 0 || draggedIds.some((id) => !tree.nodes.has(id))) return false
  if (target.parentId === RootId) return true
  if (!tree.nodes.has(target.parentId)) return false
  return !draggedIds.some((id) => id === target.parentId || isDescendant(tree, target.parentId, id))
}

/** One SetEntityParent call */
export interface Move {
  entityId: string
  parentId: string
  /** The place the object takes among its new siblings once moved (-1: the last), as SetEntityParent takes it */
  siblingIndex: number
}

/**
 * The SetEntityParent calls that put the dragged objects (those whose ancestor isn't dragged too, in tree order) at
 * the target, in order; empty when it would change nothing, and null when the drop isn't allowed. SetEntityParent's
 * siblingIndex is the place the object ends up at, so the objects are placed one after another right before the first
 * sibling at or after the drop that isn't being moved.
 */
export function planMoves(tree: HierarchyTree, draggedIds: readonly string[], target: DropTarget): Move[] | null {
  if (!canDrop(tree, draggedIds, target)) return null
  const moving = topLevel(tree, new Set(draggedIds))
  const movingSet = new Set(moving)

  const siblings = [...childrenOf(tree, target.parentId)]
  const start = target.index < 0 ? siblings.length : Math.min(target.index, siblings.length)
  const before = siblings.slice(start).find((id) => !movingSet.has(id)) ?? null

  const moves: Move[] = []
  let list = siblings // what the engine's list of the target's children looks like before each move
  for (const id of moving) {
    const without = list.filter((sibling) => sibling !== id)
    const place = before === null ? without.length : without.indexOf(before)
    const next = [...without.slice(0, place), id, ...without.slice(place)]
    const unchanged = (tree.parents.get(id) ?? RootId) === target.parentId && list.indexOf(id) === place
    if (!unchanged) moves.push({ entityId: id, parentId: target.parentId, siblingIndex: before === null ? -1 : place })
    list = next
  }
  return moves
}
