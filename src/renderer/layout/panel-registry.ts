// The panels the editor can show: what each one is called, which region it starts in and what may be done with it.
// Framework-free (the component is whatever the page puts there), so the layout model and its tests need no DOM.

/** The four places a panel can be: assets on the left, the viewport in the centre, the console and text files at the bottom */
export type RegionId = "left" | "center" | "bottom" | "right"

export const RegionIds: readonly RegionId[] = ["left", "center", "bottom", "right"]

export const RegionTitles: Readonly<Record<RegionId, string>> = {
  left: "Left",
  center: "Centre",
  bottom: "Bottom",
  right: "Right",
}

export function isRegionId(value: unknown): value is RegionId {
  return typeof value === "string" && (RegionIds as readonly string[]).includes(value)
}

/** How much room a panel's stack takes in a region that stacks several (the right one): a CSS flex shorthand */
export interface StackSizing {
  flex: string
  /** A CSS max-height, such as "30%" */
  maxHeight?: string
}

/** The default share of a stack: equal with the others */
export const DefaultSizing: StackSizing = { flex: "1 1 0%" }

export interface PanelDef<C = unknown> {
  /** Stable: it is what a saved layout names, so a renamed panel loses its place */
  id: string
  title: string
  icon?: string
  component: C
  defaultRegion: RegionId
  /**
   * Which of the region's default stacks it starts in (0 is the first; a region whose panels share one number shows
   * them as tabs of one stack, different numbers stack them one under the other)
   */
  defaultGroup?: number
  /** Whether it can be closed (and opened again from the Window menu); a panel that can't is always shown */
  closable: boolean
  /** One instance only. Panels with several instances are not supported yet: register() refuses false */
  singleton: boolean
  /** The least size, in CSS pixels, of the region it is in (width for the left and right, height for the bottom) */
  minSize?: number
  /**
   * When its stack shows a tab bar: "auto" (default) only when the stack has more than one tab (a panel with a header of
   * its own, or the viewport, is alone without one), "always" even for one tab (the console, as it always had one)
   */
  tabBar?: "auto" | "always"
  /** Not rendered while another tab of its stack is shown (a panel with a loop to stop); otherwise hidden but mounted */
  unmountWhenHidden?: boolean
  /** The share of its stack when it is the one shown */
  sizing?: StackSizing
}

export class PanelRegistry<C = unknown> {
  private readonly defs = new Map<string, PanelDef<C>>()

  register(def: PanelDef<C>): void {
    if (def.id === "" || def.id.includes(":")) throw new Error(`Invalid panel id "${def.id}"`)
    if (this.defs.has(def.id)) throw new Error(`Panel "${def.id}" is already registered`)
    if (!def.singleton) throw new Error(`Panel "${def.id}": only singleton panels are supported`)
    if (!isRegionId(def.defaultRegion)) throw new Error(`Panel "${def.id}": unknown region "${def.defaultRegion}"`)
    this.defs.set(def.id, def)
  }

  get(id: string): PanelDef<C> | undefined {
    return this.defs.get(id)
  }

  has(id: string): boolean {
    return this.defs.has(id)
  }

  /** In the order they were registered */
  list(): PanelDef<C>[] {
    return [...this.defs.values()]
  }

  /** The panels that start in a region, in registration order */
  defaultsOf(region: RegionId): PanelDef<C>[] {
    return this.list().filter((d) => d.defaultRegion === region)
  }

  /** How many stacks a region starts with (the right one has three) */
  defaultGroupCount(region: RegionId): number {
    return new Set(this.defaultsOf(region).map((d) => d.defaultGroup ?? 0)).size
  }
}
