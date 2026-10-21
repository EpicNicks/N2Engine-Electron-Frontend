// The editor's view of the host's Lua editor extensions: what the host lists (ListEditorExtensions), the menu items
// it declared (GetEditorUi), and running an item. The host is the only place extension code runs; this holds data and
// shows it. Refetched when the connection changes and when the host says its extensions changed (extensionsChanged),
// so a reload or an extension that became faulted shows at once. No DOM: it is given the page's pieces or fakes, so it
// is unit tested in Node. Every string from an extension is untrusted: shown as text only.
import { batch, computed, effect, signal, type ReadonlySignal } from "@preact/signals-core"
import type { EngineApi, ServerInfo } from "../shared/api"
import {
  EditorExtensionsCapability,
  hasCapability,
  supportsInvokeMenuItem,
  type ExtensionMenuItem,
  type ExtensionResult,
  type ExtensionSummary,
  type ExtensionsInfo,
  type ExtensionsResult,
  type ExtensionsUi,
} from "../protocol/extensions"
import { buildToolsMenu, type MenuContext, type ToolsNode } from "./extension-menu"
import { runMenuItem, type RunDeps, type RunOutcome } from "./extension-actions"
import type { HostRole } from "./store"

/**
 * Why an extension's menu item can't be run right now, or null: the first of not connected, a refusal of writes (a
 * read-only host, a viewer, a play session), no scene, and the editor busy with something else
 */
export function runBlockedReason(editor: {
  connected: boolean
  hasScene: boolean
  busy: string | null
  readOnlyReason: string | null
}): string | null {
  if (!editor.connected) return "the editor is not connected to a host"
  if (editor.readOnlyReason !== null) return editor.readOnlyReason
  if (!editor.hasScene) return "no scene is open"
  if (editor.busy !== null) return `the editor is busy (${editor.busy})`
  return null
}

/** What the extensions state needs of the page: signals of the store and the panels, and the run's pieces */
export interface ExtensionsDeps {
  engine: Pick<EngineApi, "listEditorExtensions" | "getEditorUi" | "reloadEditorExtensions" | "invokeMenuItem">
  connected: ReadonlySignal<boolean>
  serverInfo: ReadonlySignal<ServerInfo | null>
  /** How many extensionsChanged events arrived (EditorStore.extensionsChangeCount) */
  changeCount: ReadonlySignal<number>
  role: ReadonlySignal<HostRole | null>
  /** Why nothing can be changed now, or null (EditorStore.readOnlyReason, a missing scene, a busy editor) */
  blockedReason: () => string | null
  openGroups: ReadonlySignal<number>
  selection: () => string[]
  componentsOf(id: string): readonly string[] | undefined
  /** The run's pieces (RunDeps) other than the ones this state supplies */
  run: Omit<RunDeps, "invoke" | "selection" | "blockedReason" | "setRunning" | "showResult" | "refreshUi" | "openGroups">
}

/**
 * Where the extensions stand, for the Tools button and the admin section:
 * - disconnected: no host;
 * - unsupported: the host predates editor extensions (no capability);
 * - loading: asking the host;
 * - disabled: the host has the feature but was not started with --editor-extensions;
 * - ready: extensions are on (the menu may be empty);
 * - error: the host could not be asked (loadError says why).
 */
export type ExtensionsStatus = "disconnected" | "unsupported" | "loading" | "disabled" | "ready" | "error"

/** What the last run said, for the notice under the toolbar */
export interface RunNotice {
  /** The item's title (untrusted text) */
  title: string
  message: string
  warnings: string[]
}

export class ExtensionsState {
  /** The host's list (null until asked, and when the host has no extension commands) */
  readonly info = signal<ExtensionsInfo | null>(null)
  /** The host's menu items (null when extensions are off or unknown) */
  readonly ui = signal<ExtensionsUi | null>(null)
  /** Why the host could not be asked, or null */
  readonly loadError = signal<string | null>(null)
  /** The id of the item that is running, or null (the host bounds the time: there is no cancel) */
  readonly running = signal<string | null>(null)
  /** The last item's result, until dismissed or the next run */
  readonly notice = signal<RunNotice | null>(null)
  /** Reload is running */
  readonly reloading = signal(false)
  /** Why the last Reload failed, or null */
  readonly reloadError = signal<string | null>(null)

  readonly hasCapability = computed(
    () => this.deps.connected.value && hasCapability(this.deps.serverInfo.value?.capabilities, EditorExtensionsCapability)
  )
  /** The host can run menu items (it speaks protocol 1.15.0 or later, with the capability) */
  readonly canInvoke = computed(() =>
    supportsInvokeMenuItem(this.deps.serverInfo.value?.capabilities, this.deps.serverInfo.value?.protocolVersion)
  )
  readonly status = computed<ExtensionsStatus>(() => {
    if (!this.deps.connected.value) return "disconnected"
    if (!this.hasCapability.value) return "unsupported"
    if (this.loadError.value !== null) return "error"
    const info = this.info.value
    if (info === null) return "loading"
    return info.enabled ? "ready" : "disabled"
  })
  /** The Tools menu is shown: the host has extensions on (hidden for an older host and for one without the flag) */
  readonly menuVisible = computed(() => this.status.value === "ready")
  /** The user is an admin (a host without roles counts as admin): Reload is theirs */
  readonly isAdmin = computed(() => this.deps.role.value === "admin")

  /** Counts reads, so a slow answer can't replace a newer one */
  private reads = 0

  constructor(private readonly deps: ExtensionsDeps) {}

  /**
   * Follows the connection and the host's extensionsChanged events: fetches now and whenever either changes. Returns
   * the function that stops it.
   */
  start(): () => void {
    return effect(() => {
      this.deps.connected.value
      this.deps.serverInfo.value
      this.deps.changeCount.value
      void this.refresh()
    })
  }

  /** Asks the host for its extensions and menu; clears what is held when there is no connection or no such commands */
  async refresh(): Promise<void> {
    const read = ++this.reads
    if (!this.deps.connected.peek() || !this.hasCapability.peek()) {
      batch(() => {
        this.info.value = null
        this.ui.value = null
        this.loadError.value = null
      })
      return
    }
    const listed = await this.deps.engine.listEditorExtensions()
    if (read !== this.reads) return
    if (listed.status !== "ok") {
      batch(() => {
        this.info.value = null
        this.ui.value = null
        this.loadError.value = listed.status === "error" ? listed.message : null
      })
      return
    }
    let ui: ExtensionsUi | null = null
    let uiError: string | null = null
    if (listed.value.enabled) {
      const fetched = await this.deps.engine.getEditorUi()
      if (read !== this.reads) return
      if (fetched.status === "ok") ui = fetched.value
      else uiError = fetched.status === "error" ? fetched.message : "The host has no editor UI"
    }
    batch(() => {
      this.info.value = listed.value
      this.ui.value = ui
      this.loadError.value = uiError
    })
  }

  /** Forgets everything held (another connection) */
  reset(): void {
    this.reads++
    batch(() => {
      this.info.value = null
      this.ui.value = null
      this.loadError.value = null
      this.notice.value = null
      this.running.value = null
    })
  }

  /** The extension an item belongs to, found by id or (when unique) by name; undefined when the list doesn't say */
  extensionOf(item: ExtensionMenuItem): ExtensionSummary | undefined {
    const list = this.info.value?.extensions ?? []
    const byId = list.find((extension) => extension.id === item.extension)
    if (byId) return byId
    const byName = list.filter((extension) => extension.name === item.extension)
    return byName.length === 1 ? byName[0] : undefined
  }

  /** What availabilityOf needs, as the editor stands now */
  menuContext(): MenuContext {
    return {
      role: this.deps.role.value,
      canInvoke: this.canInvoke.value,
      blockedReason: this.deps.blockedReason(),
      openGroups: this.deps.openGroups.value,
      running: this.running.value !== null,
      selection: this.deps.selection(),
      componentsOf: (id) => this.deps.componentsOf(id),
      extensionOf: (item) => this.extensionOf(item),
    }
  }

  /** The Tools menu now (groups, items, each enabled or disabled with its reason) */
  menu(): ToolsNode[] {
    return buildToolsMenu(this.ui.value?.menuItems ?? [], this.menuContext())
  }

  /** The revision of the menu the page last built from (what a run sends as uiRevision) */
  get uiRevision(): number {
    return this.ui.value?.uiRevision ?? 0
  }

  /** Runs an item of the menu that was built at uiRevision; resolves with how it ended */
  run(item: ExtensionMenuItem, uiRevision: number): Promise<RunOutcome> {
    if (this.running.value !== null) return Promise.resolve("refused")
    const deps = this.deps
    return runMenuItem(item, uiRevision, {
      ...deps.run,
      invoke: (itemId, selection, params, revision) => deps.engine.invokeMenuItem(itemId, selection, params, revision),
      selection: deps.selection,
      blockedReason: deps.blockedReason,
      openGroups: () => deps.openGroups.peek(),
      setRunning: (id) => {
        this.running.value = id
      },
      showResult: (shown, result: ExtensionResult) => {
        this.notice.value = { title: shown.title, message: result.message, warnings: result.warnings }
      },
      refreshUi: () => this.refresh(),
    })
  }

  dismissNotice(): void {
    this.notice.value = null
  }

  /**
   * Loads every extension file again (the host's Admin command; another role is refused, and the page disables the
   * button). The list and the menu are read again; the host also pushes extensionsChanged.
   */
  async reload(): Promise<ExtensionsResult<ExtensionsInfo>> {
    this.reloading.value = true
    this.reloadError.value = null
    try {
      const result = await this.deps.engine.reloadEditorExtensions()
      if (result.status === "error") this.reloadError.value = result.message
      else if (result.status === "unsupported") this.reloadError.value = "This host has no editor extensions."
      await this.refresh()
      return result
    } finally {
      this.reloading.value = false
    }
  }
}
