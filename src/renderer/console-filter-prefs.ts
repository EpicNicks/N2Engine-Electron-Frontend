// The console's filters kept per project in the preferences store (prefs.ts): levels, hidden sources, the text and its
// two toggles, and collapsing repeats. The store guards every access and debounces the writes.
import { effect } from "@preact/signals-core"
import type { ConsoleStore, LogLevel } from "./console-store"
import { MaxPatternLength } from "./console-filter"
import { PrefDef, PrefScopeView, definePref, isRecord, v } from "./prefs"

export interface ConsoleFilterPrefValue {
  levels: Record<LogLevel, boolean>
  /** Source ids switched off */
  hiddenSources: string[]
  search: string
  matchCase: boolean
  regex: boolean
  collapse: boolean
}

export const DefaultConsoleFilter: ConsoleFilterPrefValue = {
  levels: { info: true, warn: true, error: true },
  hiddenSources: [],
  search: "",
  matchCase: false,
  regex: false,
  collapse: false,
}

export const ConsoleFilterPref: PrefDef<ConsoleFilterPrefValue, "project"> = definePref({
  key: "console.filter",
  scope: "project",
  default: DefaultConsoleFilter,
  validate: (raw) => {
    if (!isRecord(raw)) return undefined
    // A field that is missing or wrong takes its default (an older or newer shape still gives a usable filter)
    const levels = isRecord(raw.levels) ? raw.levels : {}
    const flag = (value: unknown, fallback: boolean) => v.boolean(value) ?? fallback
    return {
      levels: {
        info: flag(levels.info, true),
        warn: flag(levels.warn, true),
        error: flag(levels.error, true),
      },
      hiddenSources: v.arrayOf(v.string(40), 32)(raw.hiddenSources) ?? [],
      search: v.string(MaxPatternLength)(raw.search) ?? "",
      matchCase: flag(raw.matchCase, false),
      // Never restored as on: a pattern that hangs the renderer would hang it again on every launch of the project
      regex: false,
      collapse: flag(raw.collapse, false),
    }
  },
})

/** Loads the project's saved filters into the console, then saves every change of them. Returns the detach. */
export function attachConsoleFilterPrefs(log: ConsoleStore, scope: PrefScopeView<"project">): () => void {
  log.applyFilterState(scope.get(ConsoleFilterPref))
  let first = true
  return effect(() => {
    const value = log.filterState.value
    if (first) {
      first = false
      return
    }
    scope.set(ConsoleFilterPref, value)
  })
}
