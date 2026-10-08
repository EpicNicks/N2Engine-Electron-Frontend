// The assets panel's state, as signals (protocol 1.9.0): the project's assets as the host lists them (ListAssets, read
// again when an assetsChanged event arrives), the selected asset's detail with its import settings (GetAssetInfo,
// SetImportSettings), and the text files open in the editor (ReadTextAsset, WriteTextAsset). The host owns the files:
// the editor reads and writes nothing itself. No DOM, so it is unit tested with a fake engine.
//
// What the editor never does: lose text. A save the host refuses leaves the text, and the tab says why; a file that
// changed on disk under unsaved edits is flagged, not overwritten by a reload.
import { batch, computed, signal } from "@preact/signals-core"
import type { AssetsChangedEvent } from "../protocol/editor-events"
import type { AssetDetails } from "../protocol/protocol.generated"
import type { EngineApi, JsonObject } from "../shared/api"
import {
  LineEnding,
  checkAssetName,
  checkScriptName,
  checkTextForWrite,
  detectLineEnding,
  importSettingsText,
  normalizeLineEndings,
  parseImportSettings,
  sameImportSettings,
  withLineEnding,
} from "./asset-edit"
import {
  AssetFilter,
  AssetListing,
  AssetRow,
  RootFolder,
  ancestorsOf,
  buildRows,
  childPath,
  noFilter,
  parentOf,
  typesOf,
} from "./asset-tree"

type Engine = Pick<
  EngineApi,
  | "listAssets"
  | "getAssetInfo"
  | "setImportSettings"
  | "readTextAsset"
  | "writeTextAsset"
  | "createScriptAsset"
  | "createFolder"
>

/** The host's log, for the errors a script's reload logs after it was written */
export interface LogMarks {
  /** The id of the newest console entry (0 for none): a mark to compare later entries with */
  mark(): number
  /** Reads the host's events now (the reload's errors arrive as log events) */
  poll(): Promise<void>
}

/** A text file open in the editor */
export interface TextTab {
  path: string
  /** What the editor holds, with LF line breaks (a textarea can't hold CRLF) */
  text: string
  /** What the host has: what was read, or last written, with LF line breaks */
  savedText: string
  /** The file's own line ending, put back on save so a CRLF file stays CRLF */
  lineEnding: LineEnding
  saving: boolean
  /** Why the last save failed (the host's words); null otherwise. The text is still here. */
  error: string | null
  /** The file was changed, or deleted, on disk while the tab had unsaved edits */
  external: "changed" | "removed" | null
  /** The console's newest entry before the last save: the error entries after it came from that save's reload */
  saveMark: number | null
  /** The console's newest entry after the save's log poll: the errors up to it are the save's (later ones aren't) */
  saveEnd: number | null
}

export const isDirty = (tab: TextTab): boolean => tab.text !== tab.savedText

/** The selected file's detail with the import settings being edited */
export interface AssetDetail {
  path: string
  /** What the host said; null until it answers (or when it refused) */
  info: AssetDetails | null
  /** The import settings text in the editor */
  settings: string
  /** The import settings as the host has them, as text */
  baseline: string
  /** What is wrong: the host refused the read or the change, or the text isn't valid settings */
  error: string | null
  saving: boolean
  /** The host's settings changed while these were being edited */
  outdated: boolean
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const isSceneAsset = (type: string, path: string): boolean => type === "Scene" || path.toLowerCase().endsWith(".scene")

export class AssetsState {
  /** The host's listing; null before the first answer (and while not connected) */
  readonly listing = signal<AssetListing | null>(null)
  /** Why the listing couldn't be read; null when it could */
  readonly listingError = signal<string | null>(null)
  /** The folders and models (by path) that are open in the tree */
  readonly open = signal<ReadonlySet<string>>(new Set())
  readonly filter = signal<AssetFilter>(noFilter)
  /** The selected row's path: a file, a folder or a model's part (path#key) */
  readonly selected = signal<string | null>(null)
  readonly detail = signal<AssetDetail | null>(null)

  readonly rows = computed<AssetRow[]>(() => {
    const listing = this.listing.value
    return listing ? buildRows(listing, this.open.value, this.filter.value) : []
  })
  readonly types = computed<string[]>(() => {
    const listing = this.listing.value
    return listing ? typesOf(listing) : []
  })
  /** The project's scenes (res:// paths), for the Open scene menu */
  readonly scenes = computed<string[]>(() =>
    (this.listing.value?.assets ?? []).filter((a) => isSceneAsset(a.type, a.path)).map((a) => a.path)
  )

  readonly tabs = signal<readonly TextTab[]>([])
  readonly activeTab = signal<string | null>(null)

  /** Counts connections and project changes: an answer that began before one is dropped */
  private generation = 0
  private refreshing: Promise<void> | null = null
  private refreshAgain = false
  private detailReads = 0
  private readonly saves = new Map<string, Promise<boolean>>()

  constructor(
    private readonly engine: Engine,
    private readonly log: LogMarks | null = null,
    private readonly onError: (what: string, e: unknown) => void = () => {},
    /** Why the assets can't be changed now (a play session: the host refuses its writers); null when they can */
    private readonly editBlocked: () => string | null = () => null
  ) {}

  private blockedReason(): string | null {
    const reason = this.editBlocked()
    return reason === null ? null : `The assets can't be changed now: ${reason}`
  }

  /** The connection ended (or another host's began): what the host listed is gone, the open files stay with their text */
  reset(): void {
    this.generation++
    batch(() => {
      this.listing.value = null
      this.listingError.value = null
      this.selected.value = null
      this.detail.value = null
    })
  }

  /** Another project, or none: everything goes, the open files too */
  resetProject(): void {
    this.reset()
    batch(() => {
      this.open.value = new Set()
      this.filter.value = noFilter
      this.tabs.value = []
      this.activeTab.value = null
    })
  }

  // ==================== Listing ====================

  /** Reads the whole listing again; calls made while one is on its way share a following read */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true
      return this.refreshing
    }
    const run = async () => {
      do {
        this.refreshAgain = false
        const generation = this.generation
        try {
          const listing = await this.engine.listAssets("", true)
          if (generation !== this.generation) continue
          batch(() => {
            this.listing.value = listing
            this.listingError.value = null
          })
          await this.reconcileSelection()
        } catch (e) {
          if (generation !== this.generation) continue
          this.listingError.value = messageOf(e)
          console.error("Failed to list the assets:", e)
        }
      } while (this.refreshAgain)
    }
    const running = run().finally(() => {
      this.refreshing = null
    })
    this.refreshing = running
    return running
  }

  /**
   * The listing as it is after the read that is on its way (none: one is started), for panels that need the listing
   * without asking the host again; throws what went wrong when there is none
   */
  async current(): Promise<AssetListing> {
    await (this.refreshing ?? this.refresh())
    const listing = this.listing.value
    if (!listing) throw new Error(this.listingError.value ?? "The assets haven't been listed")
    return listing
  }

  /** The listing changed: the selection goes if its asset is gone, else its detail is read again */
  private async reconcileSelection(): Promise<void> {
    const selected = this.selected.value
    const listing = this.listing.value
    if (selected === null || !listing) return
    if (this.hasPath(listing, selected)) {
      if (this.fileOf(listing, selected)) await this.readDetail(selected)
    } else {
      batch(() => {
        this.selected.value = null
        this.detail.value = null
      })
    }
  }

  private fileOf(listing: AssetListing, path: string) {
    return listing.assets.find((asset) => asset.path === path)
  }

  /** Whether the path is a file, a model's part or a folder of the listing */
  private hasPath(listing: AssetListing, path: string): boolean {
    if (path === RootFolder || listing.folders.includes(path) || this.fileOf(listing, path)) return true
    const hash = path.indexOf("#")
    if (hash < 0) return listing.assets.some((asset) => parentOf(asset.path) === path || asset.path.startsWith(`${path}/`))
    const parent = this.fileOf(listing, path.slice(0, hash))
    const key = path.slice(hash + 1)
    return parent?.subAssets?.some((sub) => sub.key === key) ?? false
  }

  toggle(path: string): void {
    const open = new Set(this.open.value)
    if (!open.delete(path)) open.add(path)
    this.open.value = open
  }

  /** Opens the folders above a path, so its row shows */
  reveal(path: string): void {
    const open = new Set(this.open.value)
    for (const folder of ancestorsOf(path)) open.add(folder)
    this.open.value = open
  }

  setFilter(filter: Partial<AssetFilter>): void {
    this.filter.value = { ...this.filter.value, ...filter }
  }

  // ==================== Selection and import settings ====================

  /** Selects a row; a file's detail is read from the host */
  async select(path: string | null): Promise<void> {
    if (path === this.selected.value) return
    batch(() => {
      this.selected.value = path
      this.detail.value = null
    })
    const listing = this.listing.value
    if (path !== null && listing && this.fileOf(listing, path)) await this.readDetail(path)
  }

  /**
   * Reads the file's detail. Import settings being edited are kept (and flagged when the host's changed meanwhile),
   * so an assetsChanged event never takes a person's edit away.
   */
  private async readDetail(path: string): Promise<void> {
    const read = ++this.detailReads
    const generation = this.generation
    const current = () => read === this.detailReads && generation === this.generation && this.selected.value === path
    let info: AssetDetails
    try {
      info = await this.engine.getAssetInfo(path)
    } catch (e) {
      if (!current()) return
      const kept = this.detail.value?.path === path ? this.detail.value : null
      // The settings are on their way: their own read follows
      if (kept?.saving) return
      this.detail.value = {
        path,
        info: kept?.info ?? null,
        settings: kept?.settings ?? "",
        baseline: kept?.baseline ?? "",
        error: messageOf(e),
        saving: false,
        outdated: kept?.outdated ?? false,
      }
      return
    }
    if (!current()) return
    const baseline = importSettingsText(info.customData)
    const kept = this.detail.value?.path === path ? this.detail.value : null
    // An answer that began before Apply must not replace what is being sent (applySettings reads again afterwards)
    if (kept?.saving) return
    if (kept && kept.settings !== kept.baseline) {
      // Edited: keep the text, say when the host's moved on
      const changed = !sameImportSettings(kept.baseline, baseline)
      this.detail.value = { ...kept, info, baseline, outdated: kept.outdated || changed, error: kept.error }
    } else {
      this.detail.value = { path, info, settings: baseline, baseline, error: null, saving: false, outdated: false }
    }
  }

  /** The import settings text was edited */
  editSettings(settings: string): void {
    const detail = this.detail.value
    if (detail) this.detail.value = { ...detail, settings, error: null }
  }

  /** Back to the host's settings */
  revertSettings(): void {
    const detail = this.detail.value
    if (detail) this.detail.value = { ...detail, settings: detail.baseline, error: null, outdated: false }
  }

  /** Sends the import settings text; false (with the reason in the detail) when it isn't valid or the host refuses it */
  async applySettings(): Promise<boolean> {
    const detail = this.detail.value
    if (!detail || detail.saving) return false
    const blocked = this.blockedReason()
    if (blocked) {
      this.detail.value = { ...detail, error: blocked }
      return false
    }
    const checked = parseImportSettings(detail.settings)
    if (!checked.ok) {
      this.detail.value = { ...detail, error: checked.error }
      return false
    }
    const { path } = detail
    const sent = detail.settings
    this.detail.value = { ...detail, saving: true, error: null }
    try {
      await this.engine.setImportSettings(path, checked.value as JsonObject)
    } catch (e) {
      const now = this.detail.value
      if (now && now.path === path) this.detail.value = { ...now, saving: false, error: messageOf(e) }
      return false
    }
    const now = this.detail.value
    // What was sent is what the host has now (the host's own text of it follows from the read)
    if (now && now.path === path) {
      this.detail.value = { ...now, saving: false, baseline: sent, settings: now.settings === sent ? sent : now.settings, outdated: false }
    }
    await this.readDetail(path)
    return true
  }

  // ==================== Making things ====================

  /** Makes a folder inside a folder (res://...); answers its path. Throws the host's refusal. */
  async createFolder(parent: string, name: string): Promise<string> {
    const blocked = this.blockedReason()
    if (blocked) throw new Error(blocked)
    const checked = checkAssetName(name.trim())
    if (!checked.ok) throw new Error(checked.error)
    const path = childPath(parent, checked.value)
    await this.engine.createFolder(path)
    this.reveal(path)
    this.open.value = new Set(this.open.value).add(parent)
    await this.refresh()
    await this.select(path)
    return path
  }

  /**
   * Makes a script from the engine's template inside a folder, selects it and opens it in the editor; answers its path
   * as the host spells it. Throws the host's refusal (an existing file at the path, a bad name).
   */
  async createScript(parent: string, name: string): Promise<string> {
    const blocked = this.blockedReason()
    if (blocked) throw new Error(blocked)
    const checked = checkScriptName(name)
    if (!checked.ok) throw new Error(checked.error)
    const created = await this.engine.createScriptAsset(childPath(parent, checked.value), "")
    this.reveal(created.path)
    await this.refresh()
    await this.select(created.path)
    try {
      await this.openText(created.path)
    } catch (e) {
      // The script is made; only showing it failed
      this.onError("Failed to open the new script", e)
    }
    return created.path
  }

  // ==================== Text files ====================

  private patchTab(path: string, change: Partial<TextTab>): void {
    this.tabs.value = this.tabs.value.map((tab) => (tab.path === path ? { ...tab, ...change } : tab))
  }

  private tab(path: string): TextTab | undefined {
    return this.tabs.value.find((tab) => tab.path === path)
  }

  /** Opens a text file in the editor (or shows its tab); throws the host's refusal (not text, too large, gone) */
  async openText(path: string): Promise<void> {
    if (!this.tab(path)) {
      const generation = this.generation
      const disk = await this.engine.readTextAsset(path)
      if (generation !== this.generation) return
      const text = normalizeLineEndings(disk)
      // Opened twice at once: the first tab stays
      if (!this.tab(path)) {
        this.tabs.value = [
          ...this.tabs.value,
          {
            path,
            text,
            savedText: text,
            lineEnding: detectLineEnding(disk),
            saving: false,
            error: null,
            external: null,
            saveMark: null,
            saveEnd: null,
          },
        ]
      }
    }
    this.activeTab.value = path
  }

  editText(path: string, text: string): void {
    this.patchTab(path, { text })
  }

  /**
   * Writes the tab's text. True when the host has it now. False when it was refused or couldn't be written: the text
   * stays in the tab (dirty), with the host's words in its error. A script the host reloads that fails is not a
   * refusal: the write succeeded, and the error is in the log (see the tab's saveMark).
   */
  saveText(path: string): Promise<boolean> {
    // One write at a time per file, in the order asked
    const previous = this.saves.get(path) ?? Promise.resolve(true)
    const next = previous.then(() => this.writeTab(path))
    this.saves.set(path, next)
    void next.finally(() => {
      if (this.saves.get(path) === next) this.saves.delete(path)
    })
    return next
  }

  private async writeTab(path: string): Promise<boolean> {
    const tab = this.tab(path)
    if (!tab) return false
    const blocked = this.blockedReason()
    if (blocked) {
      this.patchTab(path, { error: blocked })
      return false
    }
    const text = tab.text
    const onDisk = withLineEnding(text, tab.lineEnding)
    const checked = checkTextForWrite(onDisk)
    if (!checked.ok) {
      this.patchTab(path, { error: checked.error })
      return false
    }
    const mark = this.log?.mark() ?? null
    this.patchTab(path, { saving: true, error: null })
    try {
      await this.engine.writeTextAsset(path, onDisk)
    } catch (e) {
      this.patchTab(path, { saving: false, error: messageOf(e) })
      return false
    }
    // Text typed while it was being written stays, dirty
    this.patchTab(path, { saving: false, savedText: text, error: null, external: null, saveMark: mark, saveEnd: null })
    // The reload's errors are log events
    await this.log?.poll().catch((e) => console.debug("Polling the log after a save failed:", e))
    // The errors up to here are this save's; a later one is not blamed on it
    if (this.log) this.patchTab(path, { saveEnd: this.log.mark() })
    return true
  }

  /** Throws away the tab's edits and reads the file again */
  async reloadText(path: string): Promise<void> {
    const disk = await this.engine.readTextAsset(path)
    const text = normalizeLineEndings(disk)
    this.patchTab(path, { text, savedText: text, lineEnding: detectLineEnding(disk), error: null, external: null })
  }

  closeText(path: string): void {
    const remaining = this.tabs.value.filter((tab) => tab.path !== path)
    batch(() => {
      this.tabs.value = remaining
      if (this.activeTab.value === path) this.activeTab.value = remaining[0]?.path ?? null
    })
  }

  // ==================== Following the host ====================

  /**
   * The host's assets changed (an assetsChanged event; null when events were missed, so anything may have): lists
   * again, and brings the open files up to date. A file with no unsaved edits shows what is on disk now; one with
   * edits is flagged, and keeps them.
   */
  async onAssetsChanged(event: AssetsChangedEvent | null): Promise<void> {
    const refreshed = this.refresh()
    const touched = event ? new Set([...event.modified, ...event.added, ...event.removed]) : null
    const removed = new Set(event?.removed ?? [])
    const tabs = this.tabs.value.filter((tab) => touched === null || touched.has(tab.path))
    await Promise.all([refreshed, ...tabs.map((tab) => this.syncTab(tab.path, removed.has(tab.path)))])
  }

  private async syncTab(path: string, removed: boolean): Promise<void> {
    let raw: string
    try {
      raw = await this.engine.readTextAsset(path)
    } catch (e) {
      // Gone (or no longer readable): the text stays, flagged when it isn't what the host had
      if (removed && this.tab(path)) this.patchTab(path, { external: "removed" })
      else console.debug("Reading a changed file failed:", e)
      return
    }
    const disk = normalizeLineEndings(raw)
    const tab = this.tab(path)
    if (!tab || tab.saving) return
    if (disk === tab.savedText) {
      // Only the line endings may differ (the file was converted outside): a file with no edits follows it
      const ending = detectLineEnding(raw)
      const clean = tab.text === tab.savedText
      if (tab.external !== null || (clean && ending !== tab.lineEnding)) {
        this.patchTab(path, { external: null, ...(clean ? { lineEnding: ending } : {}) })
      }
      return
    }
    if (tab.text === tab.savedText) {
      this.patchTab(path, { text: disk, savedText: disk, lineEnding: detectLineEnding(raw), error: null, external: null })
    } else {
      this.patchTab(path, { external: "changed" })
    }
  }
}
