// Where the layout is kept: per project, plus a user-level default that new projects start from, in the editor's
// preferences (prefs.ts: per machine, in the page's localStorage; nothing about the layout leaves it). Every access is
// guarded by the store: storage can be missing, full or blocked, and then the layout simply isn't remembered.
//
// The stored layout is the layout model's own JSON (layout-model.ts), unchanged from before the preferences store: a
// project's layout is the project-scope pref "layout", the default for new projects the user-scope pref "layout.default".
// Release 1 of the layout (F1) kept them under "n2.layout.project.<projectId>" and "n2.layout.user", as bare layouts;
// those entries are still READ when the preference has no value yet (so nobody loses a saved layout), are never written,
// and are removed when the layout is reset or forgotten. The fallback is dropped one release after this one.
import { Layout, parseLayout, serializeLayout } from "./layout-model"
import { PanelRegistry } from "./panel-registry"
import { KeyValueStore, PrefDef, PrefsStore, v, definePref } from "../prefs"

// The store's building blocks moved to prefs.ts; kept importable from here
export type { KeyValueStore } from "../prefs"
export { browserStore } from "../prefs"

/** What F1 kept the user's default layout under (read as a fallback only) */
export const UserLayoutKey = "n2.layout.user"
/** What F1 kept a project's layout under, with the project's id after it (read as a fallback only) */
export const ProjectLayoutKeyPrefix = "n2.layout.project."

export function projectLayoutKey(projectId: string): string {
  return `${ProjectLayoutKeyPrefix}${projectId}`
}

/** A saved layout is any JSON object here; parseLayout (which knows the registry) validates what is inside */
export const ProjectLayoutPref: PrefDef<Record<string, unknown> | null, "project"> = definePref({
  key: "layout",
  scope: "project",
  default: null,
  validate: v.object,
  legacyKey: (projectId) => projectLayoutKey(projectId ?? ""),
})

export const UserLayoutPref: PrefDef<Record<string, unknown> | null, "user"> = definePref({
  key: "layout.default",
  scope: "user",
  default: null,
  validate: v.object,
  legacyKey: () => UserLayoutKey,
})

/** Reads, writes and clears layouts; reads validate (parseLayout), so what comes back is always safe to show */
export class LayoutPersistence {
  private readonly prefs: PrefsStore

  /** `store` is the page's preferences, or (a test) a key-value store to make preferences over */
  constructor(
    store: PrefsStore | KeyValueStore,
    private readonly registry: PanelRegistry
  ) {
    this.prefs = store instanceof PrefsStore ? store : new PrefsStore(store)
  }

  private parse(raw: Record<string, unknown> | null): Layout | null {
    if (raw === null) return null
    try {
      return parseLayout(raw, this.registry)
    } catch {
      return null
    }
  }

  loadProject(projectId: string): Layout | null {
    return this.parse(this.prefs.project(projectId).get(ProjectLayoutPref))
  }

  saveProject(projectId: string, layout: Layout): void {
    // At once: the controller has already waited (its own debounce), and the window may be closing
    this.prefs.project(projectId).set(ProjectLayoutPref, { ...serializeLayout(layout) }, { immediate: true })
  }

  /** Forgets the project's layout: the user default (or the default) applies again */
  clearProject(projectId: string): void {
    this.prefs.project(projectId).remove(ProjectLayoutPref, { immediate: true })
  }

  loadUserDefault(): Layout | null {
    return this.parse(this.prefs.user.get(UserLayoutPref))
  }

  saveUserDefault(layout: Layout): void {
    this.prefs.user.set(UserLayoutPref, { ...serializeLayout(layout) }, { immediate: true })
  }

  clearUserDefault(): void {
    this.prefs.user.remove(UserLayoutPref, { immediate: true })
  }
}
