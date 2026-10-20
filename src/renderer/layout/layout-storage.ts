// Where the layout is kept: per project, plus a user-level default that new projects start from, in the page's
// localStorage (per machine; nothing about the layout leaves it). Every access is guarded: storage can be missing,
// full or blocked, and then the layout simply isn't remembered. Behind a small key-value interface so the editor's
// preferences store (F2) can take over the keys without the layout code changing.
import { Layout, parseLayout, serializeLayout } from "./layout-model"
import { PanelRegistry } from "./panel-registry"

/** The least a store has to do; every method may fail without the caller noticing (reads give null) */
export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

/** The page's localStorage, guarded; reads give null and writes do nothing when it is unavailable */
export function browserStore(): KeyValueStore {
  const storage = (): Storage | null => {
    try {
      return typeof localStorage === "undefined" ? null : localStorage
    } catch {
      return null
    }
  }
  return {
    get(key) {
      try {
        return storage()?.getItem(key) ?? null
      } catch {
        return null
      }
    },
    set(key, value) {
      try {
        storage()?.setItem(key, value)
      } catch {
        // not remembered; the layout still applies for this session
      }
    },
    remove(key) {
      try {
        storage()?.removeItem(key)
      } catch {
        // nothing to remove, or nothing that can be
      }
    },
  }
}

export const UserLayoutKey = "n2.layout.user"
export const ProjectLayoutKeyPrefix = "n2.layout.project."

export function projectLayoutKey(projectId: string): string {
  return `${ProjectLayoutKeyPrefix}${projectId}`
}

/** Reads, writes and clears layouts; reads validate (parseLayout), so what comes back is always safe to show */
export class LayoutPersistence {
  constructor(
    private readonly store: KeyValueStore,
    private readonly registry: PanelRegistry
  ) {}

  private read(key: string): Layout | null {
    let text: string | null
    try {
      text = this.store.get(key)
    } catch {
      return null
    }
    if (text === null) return null
    try {
      return parseLayout(JSON.parse(text), this.registry)
    } catch {
      return null
    }
  }

  private write(key: string, layout: Layout): void {
    try {
      this.store.set(key, JSON.stringify(serializeLayout(layout)))
    } catch {
      // not remembered
    }
  }

  loadProject(projectId: string): Layout | null {
    return this.read(projectLayoutKey(projectId))
  }

  saveProject(projectId: string, layout: Layout): void {
    this.write(projectLayoutKey(projectId), layout)
  }

  /** Forgets the project's layout: the user default (or the default) applies again */
  clearProject(projectId: string): void {
    try {
      this.store.remove(projectLayoutKey(projectId))
    } catch {
      // nothing to forget
    }
  }

  loadUserDefault(): Layout | null {
    return this.read(UserLayoutKey)
  }

  saveUserDefault(layout: Layout): void {
    this.write(UserLayoutKey, layout)
  }

  clearUserDefault(): void {
    try {
      this.store.remove(UserLayoutKey)
    } catch {
      // nothing to forget
    }
  }
}
