// The editor's layout as plain data: which panels sit in which of the four regions, as tabs of one or more stacks, and
// how big the side regions and the bottom one are. Every operation is a pure function that returns the new layout (or
// the same object when nothing changed), so the model is unit tested without a DOM. A layout read from storage is
// validated and migrated here (parseLayout) and never throws: what can't be used gives null and the default is shown.
import { PanelRegistry, RegionId, RegionIds, isRegionId } from "./panel-registry"

/** The version a layout is saved with; older ones are migrated (Migrations), newer ones are not read */
export const LayoutVersion = 1

/** Tab ids with this prefix are not panels but things open in the bottom region ("text:<path>" for a text file) */
export const DynamicPrefix = "text:"

export function isDynamicId(id: string): boolean {
  return id.startsWith(DynamicPrefix)
}

/** One stack: its tabs in order and the one shown */
export interface TabGroup {
  /**
   * Names the stack for as long as it exists ("s3"), so the view keeps a stack's panels mounted when closing or
   * moving a tab changes the stacks around it. Saved with the layout; a layout saved before stacks had ids gets them
   * when it is read (parseLayout), deterministically, so reading it again gives the same ids.
   */
  id: string
  tabs: string[]
  active: string
}

export interface RegionLayout {
  /** The stacks, top to bottom (the centre and the bottom one have one in the default layout; the right one has three) */
  groups: TabGroup[]
  /** Width (left, right) or height (bottom) in CSS pixels; the centre takes what is left, so its size is unused */
  size: number
}

export interface Layout {
  version: number
  regions: Record<RegionId, RegionLayout>
  /** The panels the user closed: a panel that is neither in a stack nor here is new, and is added where it starts */
  closed: string[]
}

export interface SizeLimit {
  min: number
  max: number
  initial: number
}

/** The limits the splitters always had */
export const SizeLimits: Readonly<Record<RegionId, SizeLimit>> = {
  left: { min: 150, max: 500, initial: 300 },
  center: { min: 0, max: 0, initial: 0 },
  bottom: { min: 80, max: 700, initial: 220 },
  right: { min: 200, max: 600, initial: 300 },
}

/** The smallest a region can be: its limit, or more when a panel in it asks for more (PanelDef.minSize) */
export function minimumSize(layout: Layout, registry: PanelRegistry, region: RegionId): number {
  const limit = SizeLimits[region]
  let min = limit.min
  for (const group of layout.regions[region]?.groups ?? []) {
    for (const id of group.tabs) min = Math.max(min, registry.get(id)?.minSize ?? 0)
  }
  return Math.min(min, limit.max)
}

export function clampSize(layout: Layout, registry: PanelRegistry, region: RegionId, size: number): number {
  if (region === "center") return 0
  const limit = SizeLimits[region]
  if (!Number.isFinite(size)) return limit.initial
  return Math.min(limit.max, Math.max(minimumSize(layout, registry, region), Math.round(size)))
}

// ==================== Stack ids ====================

/** The id a new stack gets: "s" and one more than the biggest number any stack of the layout has */
export function nextStackId(layout: Layout): string {
  let max = 0
  for (const region of RegionIds) {
    for (const group of layout.regions[region]?.groups ?? []) {
      const match = /^s(\d+)$/.exec(group.id)
      if (match) max = Math.max(max, Number(match[1]))
    }
  }
  return `s${max + 1}`
}

/** Adds a stack (with its own id) to the end of a region's stacks, or at an index; returns it */
function addGroup(layout: Layout, region: RegionId, tabs: string[], active: string, at?: number): TabGroup {
  const group: TabGroup = { id: nextStackId(layout), tabs, active }
  const groups = layout.regions[region].groups
  groups.splice(at ?? groups.length, 0, group)
  return group
}

// ==================== The default layout ====================

/** The arrangement the editor always had: the registry's panels in their default regions and stacks */
export function defaultLayout(registry: PanelRegistry): Layout {
  const regions = {} as Record<RegionId, RegionLayout>
  const layout: Layout = { version: LayoutVersion, regions, closed: [] }
  for (const region of RegionIds) {
    const byGroup = new Map<number, string[]>()
    for (const def of registry.defaultsOf(region)) {
      const key = def.defaultGroup ?? 0
      byGroup.set(key, [...(byGroup.get(key) ?? []), def.id])
    }
    regions[region] = { groups: [], size: SizeLimits[region].initial }
    for (const [, tabs] of [...byGroup.entries()].sort((a, b) => a[0] - b[0])) addGroup(layout, region, tabs, tabs[0])
  }
  return layout
}

function cloneLayout(layout: Layout): Layout {
  const regions = {} as Record<RegionId, RegionLayout>
  for (const region of RegionIds) {
    const source = layout.regions[region]
    regions[region] = {
      groups: source.groups.map((g) => ({ id: g.id, tabs: [...g.tabs], active: g.active })),
      size: source.size,
    }
  }
  return { version: layout.version, regions, closed: [...layout.closed] }
}

export function layoutsEqual(a: Layout, b: Layout): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// ==================== Reading ====================

/** Where a tab is */
export interface TabLocation {
  region: RegionId
  /** The stack's index in the region */
  group: number
  /** The tab's index in the stack */
  index: number
}

export function locate(layout: Layout, id: string): TabLocation | null {
  for (const region of RegionIds) {
    const groups = layout.regions[region].groups
    for (let group = 0; group < groups.length; group++) {
      const index = groups[group].tabs.indexOf(id)
      if (index >= 0) return { region, group, index }
    }
  }
  return null
}

/** The panels that are shown somewhere (text files and other dynamic tabs are not panels) */
export function openPanelIds(layout: Layout): string[] {
  const ids: string[] = []
  for (const region of RegionIds) {
    for (const group of layout.regions[region].groups) ids.push(...group.tabs.filter((t) => !isDynamicId(t)))
  }
  return ids
}

// ==================== Validation and migration ====================

/** A step from one version's saved data to the next one's, by the version it reads; none yet (version 1 is the first) */
export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>
export const Migrations: Readonly<Record<number, Migration>> = {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The layout a saved value stands for, made safe: unknown panels and duplicates dropped, empty stacks removed, a stack's
 * shown tab one of its tabs, sizes within their limits, panels that are neither placed nor closed (new in this version
 * of the editor) put where they start, and a panel that can't be closed shown again. Null when the value isn't a layout
 * of a version this editor reads (corrupt, or saved by a newer editor): the caller shows the default. Never throws.
 */
export function parseLayout(
  raw: unknown,
  registry: PanelRegistry,
  migrations: Readonly<Record<number, Migration>> = Migrations,
  /** The version to migrate to (a test of the steps uses another one) */
  target: number = LayoutVersion
): Layout | null {
  try {
    if (!isRecord(raw)) return null
    let value: Record<string, unknown> = raw
    const declared = value.version
    if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 1 || declared > target) return null
    let version: number = declared
    while (version < target) {
      const step: Migration | undefined = migrations[version]
      if (!step) return null
      value = step(value)
      const next: unknown = value.version
      if (typeof next !== "number" || next <= version) return null
      version = next
    }
    const regionsRaw = value.regions
    if (!isRecord(regionsRaw)) return null

    const layout = defaultLayout(registry)
    const seen = new Set<string>()
    const ids = new Set<string>()
    const sizes = {} as Record<RegionId, unknown>
    for (const region of RegionIds) {
      const entry = regionsRaw[region]
      const groups: TabGroup[] = []
      if (isRecord(entry)) {
        sizes[region] = entry.size
        if (Array.isArray(entry.groups)) {
          for (const g of entry.groups) {
            if (!isRecord(g) || !Array.isArray(g.tabs)) continue
            const tabs: string[] = []
            for (const id of g.tabs) {
              if (typeof id !== "string" || !registry.has(id) || seen.has(id)) continue
              seen.add(id)
              tabs.push(id)
            }
            if (tabs.length === 0) continue
            // The stack's saved id when it is usable and not another's; else none yet (given below)
            const saved = typeof g.id === "string" && /^[0-9a-zA-Z-]{1,32}$/.test(g.id) && !ids.has(g.id) ? g.id : ""
            if (saved) ids.add(saved)
            groups.push({
              id: saved,
              tabs,
              active: typeof g.active === "string" && tabs.includes(g.active) ? g.active : tabs[0],
            })
          }
        }
      }
      layout.regions[region] = { groups, size: SizeLimits[region].initial }
    }

    // A layout saved before stacks had ids (or with a bad id): ids in reading order, after the ones it has
    for (const region of RegionIds) {
      for (const group of layout.regions[region].groups) if (group.id === "") group.id = nextStackId(layout)
    }

    const closed: string[] = []
    if (Array.isArray(value.closed)) {
      for (const id of value.closed) {
        if (typeof id === "string" && registry.get(id)?.closable && !seen.has(id) && !closed.includes(id)) closed.push(id)
      }
    }
    layout.closed = closed
    // New panels, and any that can't be closed, where they start
    for (const def of registry.list()) {
      if (seen.has(def.id) || closed.includes(def.id)) continue
      placeAtDefault(layout, registry, def.id)
    }
    // Sizes last: a region's least size depends on the panels in it
    for (const region of RegionIds) {
      const size = sizes[region]
      layout.regions[region].size = clampSize(layout, registry, region, typeof size === "number" ? size : NaN)
    }
    return layout
  } catch {
    return null
  }
}

/** The layout as it is saved: no dynamic tabs (text files), a shown tab that is a tab, no empty stack */
export function serializeLayout(layout: Layout): Layout {
  const out = cloneLayout(layout)
  for (const region of RegionIds) {
    const groups: TabGroup[] = []
    for (const group of out.regions[region].groups) {
      const tabs = group.tabs.filter((t) => !isDynamicId(t))
      if (tabs.length > 0) groups.push({ id: group.id, tabs, active: tabs.includes(group.active) ? group.active : tabs[0] })
    }
    out.regions[region].groups = groups
  }
  return out
}

// ==================== Operations ====================

/** A place to put a tab: a region (its first stack, or a new one when it has none) or one of its stacks, before a tab */
export interface MoveTarget {
  region: RegionId
  /** The stack's index in the region; omitted: the region's first stack */
  group?: number
  /** Put it before this tab of the stack; omitted: at the end */
  before?: string
}

/** Takes a tab out of its stack; the stack goes when it is empty, and a shown tab gives way to its left neighbour */
function removeTab(layout: Layout, at: TabLocation): void {
  const groups = layout.regions[at.region].groups
  const group = groups[at.group]
  const [id] = group.tabs.splice(at.index, 1)
  if (group.tabs.length === 0) groups.splice(at.group, 1)
  else if (group.active === id) group.active = group.tabs[Math.max(0, at.index - 1)]
}

/** Puts a tab that is in no stack where its panel starts (a region that starts stacked gets a new stack, the others a tab) */
function placeAtDefault(layout: Layout, registry: PanelRegistry, id: string): void {
  const def = registry.get(id)
  if (!def) return
  const region = layout.regions[def.defaultRegion]
  if (region.groups.length === 0) {
    addGroup(layout, def.defaultRegion, [id], id)
  } else if (registry.defaultGroupCount(def.defaultRegion) > 1) {
    // Above the first stack that holds a panel which starts below this one, else at the end
    const mine = def.defaultGroup ?? 0
    const below = region.groups.findIndex((group) =>
      group.tabs.some((t) => {
        const other = registry.get(t)
        return other !== undefined && other.defaultRegion === def.defaultRegion && (other.defaultGroup ?? 0) > mine
      })
    )
    addGroup(layout, def.defaultRegion, [id], id, below < 0 ? region.groups.length : below)
  } else {
    region.groups[0].tabs.push(id)
    region.groups[0].active = id
  }
}

/** Moves a shown tab to another place (another region, another stack, another position); the same layout when nothing changes */
export function movePanel(layout: Layout, registry: PanelRegistry, id: string, target: MoveTarget): Layout {
  if (!isRegionId(target.region)) return layout
  if (!registry.has(id) && !isDynamicId(id)) return layout
  const from = locate(layout, id)
  if (!from || target.before === id) return layout
  if (target.group === undefined && from.region === target.region) return layout
  if (target.group !== undefined && !layout.regions[target.region].groups[target.group]) return layout

  const next = cloneLayout(layout)
  const fromGroup = next.regions[from.region].groups[from.group]
  const region = next.regions[target.region]
  let dest: TabGroup | undefined = target.group === undefined ? region.groups[0] : region.groups[target.group]
  fromGroup.tabs.splice(from.index, 1)
  if (!dest) dest = addGroup(next, target.region, [], id)
  const before = target.before === undefined ? -1 : dest.tabs.indexOf(target.before)
  if (before < 0) dest.tabs.push(id)
  else dest.tabs.splice(before, 0, id)
  dest.active = id
  if (fromGroup !== dest) {
    if (fromGroup.tabs.length === 0) next.regions[from.region].groups.splice(from.group, 1)
    else if (fromGroup.active === id) fromGroup.active = fromGroup.tabs[Math.max(0, from.index - 1)]
  }
  return layoutsEqual(layout, next) ? layout : next
}

/** Closes a panel (when it can be closed): it can be opened again from the Window menu */
export function closePanel(layout: Layout, registry: PanelRegistry, id: string): Layout {
  if (!registry.get(id)?.closable) return layout
  const at = locate(layout, id)
  if (!at) return layout
  const next = cloneLayout(layout)
  removeTab(next, at)
  if (!next.closed.includes(id)) next.closed.push(id)
  return next
}

/** Shows a panel: switches to its tab when it is shown, otherwise puts it where it starts */
export function openPanel(layout: Layout, registry: PanelRegistry, id: string): Layout {
  if (!registry.has(id)) return layout
  if (locate(layout, id)) return activatePanel(layout, id)
  const next = cloneLayout(layout)
  next.closed = next.closed.filter((c) => c !== id)
  placeAtDefault(next, registry, id)
  return next
}

/** Switches the stack a tab is in to that tab */
export function activatePanel(layout: Layout, id: string): Layout {
  const at = locate(layout, id)
  if (!at || layout.regions[at.region].groups[at.group].active === id) return layout
  const next = cloneLayout(layout)
  next.regions[at.region].groups[at.group].active = id
  return next
}

/** Resizes a region (within its limits) */
export function setRegionSize(layout: Layout, registry: PanelRegistry, region: RegionId, size: number): Layout {
  const clamped = clampSize(layout, registry, region, size)
  if (region === "center" || layout.regions[region].size === clamped) return layout
  const next = cloneLayout(layout)
  next.regions[region].size = clamped
  return next
}

/** Opens a dynamic tab (a text file) in the bottom region's first stack and shows it; shows it when it is open already */
export function openDynamic(layout: Layout, id: string): Layout {
  if (locate(layout, id)) return activatePanel(layout, id)
  const next = cloneLayout(layout)
  const bottom = next.regions.bottom
  if (bottom.groups.length === 0) addGroup(next, "bottom", [id], id)
  else {
    bottom.groups[0].tabs.push(id)
    bottom.groups[0].active = id
  }
  return next
}

export function closeDynamic(layout: Layout, id: string): Layout {
  const at = locate(layout, id)
  if (!at) return layout
  const next = cloneLayout(layout)
  removeTab(next, at)
  return next
}

/** Makes the dynamic tabs exactly the ids (the open text files): the others are closed, the missing ones opened, in order */
export function syncDynamic(layout: Layout, ids: readonly string[]): Layout {
  let next = layout
  for (const region of RegionIds) {
    for (const group of layout.regions[region]?.groups ?? []) {
      for (const tab of group.tabs) if (isDynamicId(tab) && !ids.includes(tab)) next = closeDynamic(next, tab)
    }
  }
  for (const id of ids) if (!locate(next, id)) next = openDynamic(next, id)
  return next
}
