// The hierarchy search kept per project in the preferences store (prefs.ts): the text and how the result is shown. The
// store debounces the writes, and every access is guarded, so a blocked storage just means nothing is remembered.
import { effect } from "@preact/signals-core"
import type { HierarchyState } from "./hierarchy-state"
import type { FilterMode } from "./hierarchy-tree"
import { PrefDef, PrefScopeView, definePref, isRecord, v } from "./prefs"

export interface HierarchyFilterPrefValue {
  query: string
  mode: FilterMode
}

export const MaxQueryLength = 200

export const HierarchyFilterPref: PrefDef<HierarchyFilterPrefValue, "project"> = definePref({
  key: "hierarchy.filter",
  scope: "project",
  default: { query: "", mode: "tree" },
  validate: (raw) => {
    if (!isRecord(raw)) return undefined
    const query = v.string(MaxQueryLength)(raw.query)
    const mode = v.oneOf<FilterMode>(["tree", "list"])(raw.mode)
    return query === undefined || mode === undefined ? undefined : { query, mode }
  },
})

/**
 * Loads the project's saved search into the state, then saves every change of it (debounced by the store). Returns the
 * detach. An empty search with the default mode is removed rather than stored.
 */
export function attachHierarchyFilterPrefs(state: HierarchyState, scope: PrefScopeView<"project">): () => void {
  const saved = scope.get(HierarchyFilterPref)
  state.setQuery(saved.query)
  state.setFilterMode(saved.mode)
  let first = true
  const stop = effect(() => {
    const value: HierarchyFilterPrefValue = { query: state.query.value.slice(0, MaxQueryLength), mode: state.filterMode.value }
    if (first) {
      first = false
      return
    }
    if (value.query === "" && value.mode === "tree") scope.remove(HierarchyFilterPref)
    else scope.set(HierarchyFilterPref, value)
  })
  return stop
}
