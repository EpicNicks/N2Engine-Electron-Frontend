// The Tools menu of the host's editor extensions, as data: the items GetEditorUi lists become nested groups by their
// path, and each item is enabled or disabled (with the reason) from what the editor knows now. Pure, so it is unit
// tested in Node. Every string here comes from project code (an extension's declaration): it is only ever shown as
// text, never as HTML.
import type { ExtensionMenuItem, ExtensionSummary, SelectionRule } from "../protocol/extensions"
import type { HostRole } from "./store"

/** The longest label or group name kept (the host's own limits are 100 and 64 bytes) */
export const MaxLabelLength = 100

/** The deepest nesting built (the host allows 6 path segments, the last of which is the item) */
export const MaxGroupDepth = 6

/** A control character in a label becomes "?" (the host already does this for what it logs) */
const Control = /[\u0000-\u001f\u007f]/g

export function clean(text: string): string {
  const flat = text.replace(Control, "?")
  return flat.length > MaxLabelLength ? flat.slice(0, MaxLabelLength) + "..." : flat
}

/**
 * An item's place in the menu: the groups above it (its path's folders, with a leading "Tools" dropped: the whole menu
 * is Tools) and its own label (its title, else the path's last segment, else its id). Empty segments are skipped, so
 * "Tools//Align/" and "Align" are the same place; a path with nothing in it puts the item at the top.
 */
export function placeOf(item: Pick<ExtensionMenuItem, "id" | "path" | "title">): { groups: string[]; label: string } {
  const segments = item.path
    .split("/")
    .map((segment) => clean(segment.trim()))
    .filter((segment) => segment !== "")
  if (segments.length > 1 && segments[0].toLowerCase() === "tools") segments.shift()
  const last = segments.pop()
  const title = clean(item.title.trim())
  const label = title !== "" ? title : (last ?? clean(item.id))
  return { groups: segments.slice(0, MaxGroupDepth), label }
}

/** What the menu needs to know to enable an item */
export interface MenuContext {
  /** The host's role for this user (null: not connected) */
  role: HostRole | null
  /** The host can run items at all (protocol 1.15.0 or later) */
  canInvoke: boolean
  /** Why nothing can be changed now (read-only host, viewer, play session, no scene, editor busy), or null */
  blockedReason: string | null
  /** Edit groups the editor has open (a drag in progress): the host refuses an item while one is */
  openGroups: number
  /** Another item is running */
  running: boolean
  /** The selected objects' ids */
  selection: readonly string[]
  /** An object's component type names, undefined for an object the editor does not know */
  componentsOf(id: string): readonly string[] | undefined
  /** The state of the extension an item belongs to, undefined when the editor does not know it */
  extensionOf(item: ExtensionMenuItem): ExtensionSummary | undefined
}

export interface Availability {
  enabled: boolean
  /** Why it is disabled (shown as the item's tooltip); null when enabled */
  reason: string | null
}

const SelectionReasons: Record<SelectionRule, string | null> = {
  any: null,
  nonEmpty: "Select at least one object first",
  one: "Select exactly one object first",
  none: "Deselect everything first",
}

/** Whether the selection satisfies a rule ("any" always does) */
export function selectionAllows(rule: SelectionRule, count: number): boolean {
  switch (rule) {
    case "nonEmpty":
      return count >= 1
    case "one":
      return count === 1
    case "none":
      return count === 0
    default:
      return true
  }
}

/**
 * Whether an item can be run now, and why not. The host decides in the end (it checks the role, the revision and its
 * own gates): this only keeps the editor from offering what would be refused. The first reason that applies is given.
 * enabledWhen.componentType means: every selected object has a component of that type (and something is selected).
 */
export function availabilityOf(item: ExtensionMenuItem, ctx: MenuContext): Availability {
  const no = (reason: string): Availability => ({ enabled: false, reason })
  if (!ctx.canInvoke) return no("This host is too old to run menu items (they need protocol 1.15.0)")
  const owner = ctx.extensionOf(item)
  if (owner !== undefined && owner.state !== "loaded") {
    return no(`The extension ${clean(owner.name)} is disabled until an admin reloads it (Project Settings, Extensions)`)
  }
  if (item.minRole === "admin" && ctx.role !== "admin") {
    return no(`This item needs the admin role${ctx.role === null ? "" : ` (you are signed in as ${ctx.role})`}`)
  }
  if (ctx.blockedReason !== null) return no(`Not available: ${ctx.blockedReason}`)
  if (ctx.openGroups > 0) return no("An edit is in progress: finish it first")
  if (ctx.running) return no("Another menu item is running")
  const rule = item.enabledWhen.selection
  const count = ctx.selection.length
  if (!selectionAllows(rule, count)) return no(SelectionReasons[rule] ?? "The selection does not fit this item")
  const type = item.enabledWhen.componentType
  if (type !== undefined && rule !== "none") {
    if (count === 0) return no(`Select an object with a ${clean(type)} component first`)
    const lacking = ctx.selection.some((id) => !(ctx.componentsOf(id) ?? []).includes(type))
    if (lacking) return no(`Every selected object needs a ${clean(type)} component`)
  }
  return { enabled: true, reason: null }
}

export interface ToolsLeaf extends Availability {
  kind: "item"
  item: ExtensionMenuItem
  label: string
}

export interface ToolsGroup {
  kind: "group"
  label: string
  children: ToolsNode[]
}

export type ToolsNode = ToolsLeaf | ToolsGroup

/**
 * The menu: groups in the order they first appear, items in the host's order inside them. Two items with one label are
 * two entries; a group and an item that share a name are two entries too (the item first, as it came). Nothing is
 * merged by guessing: ids are what name an item.
 */
export function buildToolsMenu(items: readonly ExtensionMenuItem[], ctx: MenuContext): ToolsNode[] {
  const root: ToolsNode[] = []
  for (const item of items) {
    const { groups, label } = placeOf(item)
    let level = root
    for (const name of groups) {
      let group = level.find((node): node is ToolsGroup => node.kind === "group" && node.label === name)
      if (!group) {
        group = { kind: "group", label: name, children: [] }
        level.push(group)
      }
      level = group.children
    }
    level.push({ kind: "item", item, label, ...availabilityOf(item, ctx) })
  }
  return root
}

/** How many items a menu holds, groups included in no count */
export function countItems(nodes: readonly ToolsNode[]): number {
  return nodes.reduce((sum, node) => sum + (node.kind === "item" ? 1 : countItems(node.children)), 0)
}
