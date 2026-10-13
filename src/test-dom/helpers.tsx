import "./setup"
import type { ComponentChildren } from "preact"
import { render, type RenderResult } from "@testing-library/preact"
import { AppContext, type AppState } from "../renderer/ui"

/** What a test provides: some members of some of the page's state objects, each with some of its members */
export type AppOverrides = { [K in keyof AppState]?: Partial<AppState[K]> }

/**
 * An object that throws when read for a member the test did not provide, so a component that reaches for state the
 * test did not set up fails loudly, naming it, instead of reading undefined. (Symbols and "then" are let through:
 * the runtime and assertion messages probe for them.)
 */
export function strict<T extends object>(label: string, provided: Partial<T>): T {
  return new Proxy(provided, {
    get(target, key, receiver) {
      if (typeof key === "symbol" || key === "then" || key in target) return Reflect.get(target, key, receiver)
      throw new Error(`The test did not provide ${label}.${key}`)
    },
  }) as T
}

/** The app state with only what the test provided, every member of it strict */
export function stubApp(overrides: AppOverrides): AppState {
  const parts: Record<string, unknown> = {}
  for (const [name, part] of Object.entries(overrides)) parts[name] = strict(name, part as object)
  return strict<AppState>("app", parts as Partial<AppState>)
}

/** Renders ui inside the page's AppContext, over the state the test provided */
export function renderWithApp(ui: ComponentChildren, overrides: AppOverrides = {}): RenderResult {
  return render(<AppContext.Provider value={stubApp(overrides)}>{ui}</AppContext.Provider>)
}
