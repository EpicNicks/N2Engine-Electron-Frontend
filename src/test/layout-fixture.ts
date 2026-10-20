// A registry shaped like the editor's (the same regions, stacks and flags), without components, for the layout tests.
import { PanelRegistry } from "../renderer/layout/panel-registry"
import type { Layout } from "../renderer/layout/layout-model"

export function fixtureRegistry<C = unknown>(component: (id: string) => C = () => undefined as C): PanelRegistry<C> {
  const registry = new PanelRegistry<C>()
  const add = (id: string, region: "left" | "center" | "bottom" | "right", more: object = {}) =>
    registry.register({
      id,
      title: id[0].toUpperCase() + id.slice(1),
      component: component(id),
      defaultRegion: region,
      closable: true,
      singleton: true,
      ...more,
    })
  add("assets", "left")
  add("viewport", "center", { closable: false, unmountWhenHidden: true })
  add("console", "bottom", { tabBar: "always", unmountWhenHidden: true })
  add("hierarchy", "right", { defaultGroup: 0, sizing: { flex: "0 0 30%" } })
  add("inspector", "right", { defaultGroup: 1 })
  add("engine", "right", { defaultGroup: 2, sizing: { flex: "0 0 auto", maxHeight: "30%" } })
  return registry
}

/** Each region's stacks as lists of tab ids, to compare at a glance */
export function shape(layout: Layout): Record<string, string[][]> {
  const out: Record<string, string[][]> = {}
  for (const [region, value] of Object.entries(layout.regions)) out[region] = value.groups.map((g) => g.tabs)
  return out
}
