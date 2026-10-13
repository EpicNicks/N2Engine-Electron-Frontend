import "./setup"
import type { ComponentChildren } from "preact"
import { render, type RenderResult } from "@testing-library/preact"
import { AppContext, type AppState } from "../renderer/ui"
import { EditorStore } from "../renderer/store"
import { FakeApi, FakeTimers, fakeStoreApi } from "../test/fake-store-api"

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

/** A real EditorStore over the shared fake page API, and the fake and timers behind it */
export interface StoreHarness {
  api: FakeApi
  store: EditorStore
  timers: FakeTimers
}

/**
 * Renders ui over a REAL EditorStore built on fakeStoreApi() (src/test/fake-store-api.ts), so the store's signals
 * drive the DOM and its actions reach the fake API, where the test can read the calls. `setup` shapes the fake before
 * the store loads (its recent lists, the host's location); the store is loaded (recent projects, recent remotes, the
 * host's location) before the first render. Other state the component reads can be added with `overrides`.
 */
export async function renderWithStore(
  ui: ComponentChildren,
  setup: (api: FakeApi) => void = () => {},
  overrides: AppOverrides = {}
): Promise<RenderResult & StoreHarness> {
  const api = fakeStoreApi()
  setup(api)
  const timers = new FakeTimers()
  const store = new EditorStore(api, { timers, now: () => 0 })
  await store.load()
  const result = renderWithApp(ui, { ...overrides, store })
  return Object.assign(result, { api, store, timers })
}
