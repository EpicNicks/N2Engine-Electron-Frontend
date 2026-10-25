// The hierarchy panel's state, as signals: the scene's objects (GetHierarchy), what is expanded, selected and being
// renamed, and the actions the panel offers. No DOM: it is given the page's engine API or a fake, so it is unit
// tested in Node. Every action sends its command and then reads the hierarchy again, because the siblings whose
// index shifted are only fresh in GetHierarchy; the failure of an action is thrown for the panel to show.
import { batch, computed, signal } from "@preact/signals-core"
import type { EngineApi } from "../shared/api"
import type { HierarchyResponse, Vec3 } from "../protocol/protocol.generated"
import { normalizePrefabPath } from "../protocol/prefab-assets"
import type { SceneChange } from "../protocol/editor-events"
import type { EditGroups } from "./edit-groups"
import { clipboardText, parseClipboardText } from "../protocol/entity-clipboard"
import {
  DropTarget,
  RootId,
  Selection,
  ancestorsOf,
  buildTree,
  childrenOf,
  clickSelect,
  FilterMode,
  filterHierarchy,
  filteredRows,
  parseQuery,
  contextSelect,
  emptySelection,
  planMoves,
  pruneSelection,
  selectOnly,
  showSelection,
  stepRow,
  topLevel,
  visibleRows,
  ClickModifiers,
} from "./hierarchy-tree"

type Engine = Pick<
  EngineApi,
  | "isConnected"
  | "getHierarchy"
  | "createEntityEx"
  | "setEntityParent"
  | "setEntityProperties"
  | "duplicateEntity"
  | "destroyEntity"
> &
  // Protocol 1.18.0: a host before it has neither (the copy and paste actions say so)
  Partial<Pick<EngineApi, "serializeEntities" | "instantiateEntities">> &
  // Protocol 1.19.0: a host before it has none of these (the prefab actions are not offered)
  Partial<Pick<EngineApi, "createPrefab" | "instantiatePrefab" | "applyPrefab" | "unpackPrefab">>

/** What the hierarchy needs to know of prefab assets (protocol 1.19.0); without it no prefab action is offered */
export interface PrefabOptions {
  /** Whether the host has the prefabAssets capability (a signal, so the panel follows a reconnect) */
  readonly enabled: { readonly value: boolean }
  /** The path of the prefab asset with this UUID in the assets listing; null when it is not listed */
  pathOf(uuid: string): string | null
  /** Whether the assets listing has a file at this path (a stale listing is caught by the host, which refuses an overwrite) */
  exists(path: string): boolean
  /** A prefab file was made or replaced: the assets panel lists again */
  changed(): void
}

/** What the state asks the user, and tells the rest of the page */
export interface HierarchyOptions {
  /** Whether the user agreed (the page's confirm dialog) */
  confirm(message: string, okLabel: string): Promise<boolean>
  /** The selection's primary object changed (the inspector shows it); null: none */
  onPrimaryChange?(id: string | null): void
  /**
   * Edit groups (protocol 1.6): an action that changes several objects is one undo step. Without it, each object's
   * change is a step of its own.
   */
  groups?: Pick<EditGroups, "within">
  /** The system clipboard as text; without it (or when it refuses) copy and paste go through the editor's own copy */
  clipboard?: { readText(): Promise<string>; writeText(text: string): Promise<void> }
  /** Prefab assets (protocol 1.19.0) */
  prefabs?: PrefabOptions
}

/** The objects the Create menu makes: a label and CreateEntityEx's preset */
export const CreatePresets: ReadonlyArray<{ label: string; preset: string }> = [
  { label: "Empty", preset: "" },
  { label: "Cube", preset: "Cube" },
  { label: "Sphere", preset: "Sphere" },
  { label: "Quad", preset: "Quad" },
  { label: "Directional Light", preset: "DirectionalLight" },
  { label: "Point Light", preset: "PointLight" },
  { label: "Spot Light", preset: "SpotLight" },
]

export class HierarchyState {
  /** The last GetHierarchy answer; null when there is none (not connected, or no scene loaded) */
  readonly response = signal<HierarchyResponse | null>(null)
  readonly tree = computed(() => buildTree(this.response.value?.nodes ?? []))
  /** The objects whose children are shown */
  readonly expanded = signal<ReadonlySet<string>>(new Set())
  /** The search text (hierarchy-tree.ts parseQuery); "" shows the whole tree */
  readonly query = signal("")
  /** How a search's result is shown: the tree cut down to matches and ancestors, or a flat list */
  readonly filterMode = signal<FilterMode>("tree")
  /** The search's result over the current tree (inactive for an empty or all-ignored query) */
  readonly filter = computed(() => filterHierarchy(this.tree.value, parseQuery(this.query.value)))
  readonly rows = computed(() => {
    const filter = this.filter.value
    return filter.active
      ? filteredRows(this.tree.value, filter, this.filterMode.value)
      : visibleRows(this.tree.value, this.expanded.value)
  })
  readonly selection = signal<Selection>(emptySelection)
  /** The object whose name is being edited */
  readonly renaming = signal<string | null>(null)
  /** Why the hierarchy can't be changed (a game is running); null when it can */
  readonly readOnlyReason = signal<string | null>(null)
  readonly readOnly = computed(() => this.readOnlyReason.value !== null)

  /** The editor's own copy (the clipboard text), for when the system clipboard can't be read; null: none */
  private copied: string | null = null
  /** Counts reads, so a slow answer can't replace a newer one */
  private fetches = 0
  /** The newest read, which refresh() waits for */
  private latest: Promise<void> = Promise.resolve()
  /** An action that changes objects is running: another one (a key held down, a double click) waits its turn */
  private acting = false
  private renameDone: Promise<void> = Promise.resolve()
  /** The action that is running (a multi-delete, a move), settled whether it succeeds or fails */
  private actionDone: Promise<void> = Promise.resolve()

  constructor(
    private readonly engine: Engine,
    private readonly options: HierarchyOptions
  ) {}

  /**
   * Makes the hierarchy read-only (a game is running, with the reason to show) or editable again (null). Selecting and
   * expanding still work; what creates, renames, moves, duplicates or deletes is refused, and a rename in progress ends.
   */
  setReadOnly(reason: string | null): void {
    batch(() => {
      this.readOnlyReason.value = reason
      if (reason !== null) this.renaming.value = null
    })
  }

  /** Throws when the hierarchy is read-only: what changes objects asks first */
  private assertEditable(): void {
    const reason = this.readOnlyReason.value
    if (reason !== null) throw new Error(`The scene can't be changed while ${reason}`)
  }

  /** Everything is gone (disconnected, or another host) */
  reset(): void {
    this.fetches++
    batch(() => {
      this.response.value = null
      this.expanded.value = new Set()
      this.renaming.value = null
      this.setSelection(emptySelection)
    })
  }

  // ==================== Reading ====================

  /**
   * Reads the hierarchy, and resolves once the newest read has been applied (an action's own read may be overtaken by
   * one an event started: the caller then still sees the objects it made). A host that says there is no scene leaves
   * it empty; a read that failed for another reason (a dropped connection, say) keeps what is held, so the tree,
   * the selection and the expanded objects don't vanish for a moment.
   */
  async refresh(): Promise<void> {
    const run = this.read(++this.fetches)
    this.latest = run
    await run
    // Another read started meanwhile: its answer is the one to wait for
    for (let latest = this.latest; latest !== run; latest = this.latest) {
      await latest
      if (latest === this.latest) break
    }
  }

  private async read(fetch: number): Promise<void> {
    let response: HierarchyResponse | null
    if (!this.engine.isConnected()) return // reset() empties it when the connection is gone
    try {
      response = await this.engine.getHierarchy()
    } catch (e) {
      console.debug("GetHierarchy failed:", e)
      if (!/no scene/i.test(e instanceof Error ? e.message : String(e))) return
      response = null
    }
    if (fetch !== this.fetches) return
    batch(() => {
      this.response.value = response
      // What no longer exists can't stay selected, expanded or being renamed
      const tree = this.tree.value
      const expanded = [...this.expanded.value].filter((id) => tree.nodes.has(id))
      if (expanded.length !== this.expanded.value.size) this.expanded.value = new Set(expanded)
      this.setSelection(this.visible(pruneSelection(this.selection.value, tree), new Set(expanded)))
      if (this.renaming.value !== null && !tree.nodes.has(this.renaming.value)) this.renaming.value = null
    })
  }

  /** The selection with what is hidden under a collapsed object moved to that object */
  private visible(selection: Selection, expanded: ReadonlySet<string>): Selection {
    const tree = this.tree.value
    return showSelection(selection, tree, new Set(visibleRows(tree, expanded).map((row) => row.id)))
  }

  /**
   * The scene changed (EditorStore.lastSceneChange): reads the hierarchy again unless it was read at or after the
   * newest revision any event named (newestRevision; null when unknown). Every change that touched an object moved
   * the revision, and only GetHierarchy has the new sibling indices, so the ids don't narrow the read: they tell the
   * caller which objects to read again (affects). A full change (another scene, or events were missed) keeps the
   * selection and the expanded objects that still exist; another scene's ids are mostly new, so it mostly empties.
   */
  async applyChange(change: SceneChange, newestRevision: number | null): Promise<void> {
    const current = this.response.value
    if (!change.full && newestRevision !== null && current !== null && current.revision >= newestRevision) return
    await this.refresh()
  }

  // ==================== Search ====================

  /** Sets the search text; "" (or only ignored tokens) shows the whole tree again. A rename in progress ends. */
  setQuery(text: string): void {
    if (text === this.query.value) return
    const wasFiltering = this.filtering
    batch(() => {
      this.query.value = text
      this.renaming.value = null
    })
    // A match picked in the search may lie under a collapsed parent: once the search ends, open the way to what is
    // selected so it still has a row (the expanded set itself is the user's and is untouched while searching)
    if (wasFiltering && !this.filtering) this.revealSelection()
  }

  private revealSelection(): void {
    for (const id of this.selection.value.ids) this.expandAncestors(id)
  }

  setFilterMode(mode: FilterMode): void {
    if (mode === this.filterMode.value) return
    batch(() => {
      this.filterMode.value = mode
      this.renaming.value = null
    })
  }

  /** Whether a search is narrowing the rows: drag-and-drop reparenting is off then (the places it names are not all shown) */
  get filtering(): boolean {
    return this.filter.value.active
  }

  /**
   * The selected objects the actions (delete, duplicate) work on: only those with a row shown. A search can hide a
   * selected object, and what nobody sees is never deleted or copied.
   */
  private actingIds(): ReadonlySet<string> {
    const ids = this.selection.value.ids
    if (!this.filtering) return ids
    const shown = new Set(this.rows.value.map((row) => row.id))
    return new Set([...ids].filter((id) => shown.has(id)))
  }

  // ==================== Selection and expansion ====================

  /** The object the inspector shows */
  get primaryId(): string | null {
    return this.selection.value.primary
  }

  setSelection(selection: Selection): void {
    const previous = this.selection.value.primary
    this.selection.value = selection
    if (selection.primary !== previous) this.options.onPrimaryChange?.(selection.primary)
  }

  /**
   * Selects these objects (an extension's menu item asked for it): the ones the tree has, with the way to them opened;
   * the last is the primary. Nothing changes when none of them is in the tree.
   */
  selectIds(ids: readonly string[]): void {
    const tree = this.tree.value
    const found = [...new Set(ids)].filter((id) => tree.nodes.has(id))
    if (found.length === 0) return
    batch(() => {
      for (const id of found) this.expandAncestors(id)
      this.setSelection({ ids: new Set(found), anchor: found[0], primary: found[found.length - 1] })
    })
  }

  click(id: string, modifiers: ClickModifiers = {}): void {
    this.setSelection(
      clickSelect(
        this.selection.value,
        this.rows.value.map((row) => row.id),
        id,
        modifiers
      )
    )
  }

  /**
   * A click in the viewport picked this object (null: empty space), with the modifier keys held. As in Unity's scene
   * view, Ctrl/Cmd and Shift both toggle the one picked object in the selection (there is no range in a 3D view: a
   * Shift range between the anchor and the object would select whatever lies between them in the hierarchy); without
   * either it selects just that object. Its ancestors are expanded so its row is shown. Empty space clears the
   * selection, unless Ctrl or Shift is held (a missed click doesn't lose it).
   */
  pick(id: string | null, modifiers: ClickModifiers = {}): void {
    if (id === null) {
      if (!modifiers.toggle && !modifiers.range) this.setSelection(emptySelection)
      return
    }
    this.expandAncestors(id)
    this.click(id, modifiers.toggle || modifiers.range ? { toggle: true } : {})
  }

  /** A right-click: keeps the selection when it holds the object, else selects just it */
  contextClick(id: string): void {
    this.setSelection(contextSelect(this.selection.value, id))
  }

  /** Selects one object and shows it: its ancestors are expanded */
  reveal(id: string): void {
    this.expandAncestors(id)
    this.setSelection(selectOnly(id))
  }

  /** Arrow up or down: the next row (with shift, extending the selection) */
  step(delta: 1 | -1, extend = false): void {
    const ids = this.rows.value.map((row) => row.id)
    const to = stepRow(ids, this.primaryId, delta)
    if (to !== null) this.click(to, { range: extend })
  }

  toggleExpanded(id: string): void {
    const expanded = new Set(this.expanded.value)
    const collapsing = expanded.delete(id)
    if (!collapsing) expanded.add(id)
    batch(() => {
      this.expanded.value = expanded
      // What was selected under it is hidden now: the selection goes to it
      if (collapsing) this.setSelection(this.visible(this.selection.value, expanded))
    })
  }

  /** Whether the object has a row shown (the keys act on those only) */
  private isShown(id: string | null): id is string {
    return id !== null && this.rows.value.some((row) => row.id === id)
  }

  expand(id: string): void {
    if (!this.expanded.value.has(id)) this.expanded.value = new Set([...this.expanded.value, id])
  }

  /** Arrow right: opens the primary object, or goes to its first child when it is open */
  expandPrimary(): void {
    const id = this.primaryId
    if (this.filtering) {
      // A search opens every ancestor of a match itself: Right goes to the first child that is shown
      const rows = this.rows.value
      const at = rows.findIndex((row) => row.id === id)
      if (at >= 0 && rows[at].hasChildren) this.click(rows[at + 1].id)
      return
    }
    if (!this.isShown(id) || childrenOf(this.tree.value, id).length === 0) return
    if (!this.expanded.value.has(id)) this.expand(id)
    else this.click(childrenOf(this.tree.value, id)[0])
  }

  /** Arrow left: closes the primary object, or goes to its parent when it is closed */
  collapsePrimary(): void {
    const id = this.primaryId
    if (!this.isShown(id)) return
    if (this.filtering) {
      // Nothing closes under a search; Left goes to the parent when it has a row
      const parent = this.tree.value.parents.get(id)
      if (parent !== undefined && parent !== RootId && this.isShown(parent)) this.click(parent)
      return
    }
    if (this.expanded.value.has(id) && childrenOf(this.tree.value, id).length > 0) this.toggleExpanded(id)
    else {
      const parent = this.tree.value.parents.get(id)
      if (parent !== undefined && parent !== RootId) this.click(parent)
    }
  }

  /** Expands every ancestor of the object, so its row is shown */
  expandAncestors(id: string): void {
    const missing = ancestorsOf(this.tree.value, id).filter((ancestor) => !this.expanded.value.has(ancestor))
    if (missing.length > 0) this.expanded.value = new Set([...this.expanded.value, ...missing])
  }

  // ==================== Actions ====================

  /**
   * Makes an object from a preset (see CreatePresets) as the last child of parentId (RootId: a root of the scene),
   * selects it and starts renaming it
   */
  async create(preset: string, parentId: string = RootId): Promise<string> {
    this.assertEditable()
    const id = await this.engine.createEntityEx("", parentId, -1, preset)
    await this.refresh() // the newest read: it has the new object, whichever read it was
    batch(() => {
      if (this.tree.value.nodes.has(id)) {
        // The new object may not match the search: the search ends so the object is shown, to be renamed
        this.query.value = ""
        this.reveal(id)
        this.renaming.value = id
      }
    })
    return id
  }

  beginRename(id: string | null = this.primaryId): void {
    if (this.isShown(id) && !this.readOnly.value) this.renaming.value = id
  }

  cancelRename(): void {
    this.renaming.value = null
  }

  /** Ends renaming: sets the name unless it is empty or the same */
  commitRename(id: string, name: string): Promise<void> {
    if (this.renaming.value === id) this.renaming.value = null
    // A rename that was typed when the game started is dropped, not an error to show
    if (this.readOnly.value) return Promise.resolve()
    const trimmed = name.trim()
    if (trimmed === "" || trimmed === this.tree.value.nodes.get(id)?.name) return Promise.resolve()
    const done = this.setProperties(id, { name: trimmed })
    this.renameDone = done.catch(() => {})
    return done
  }

  /** Resolves when the action that is running (several objects deleted, duplicated or moved) is done: Undo waits for it */
  get actionSettled(): Promise<void> {
    return this.actionDone
  }

  /** Resolves when the last rename has been sent and read back (Ctrl+S waits for it) */
  get renameSettled(): Promise<void> {
    return this.renameDone
  }

  /** Runs the work as one undo step when it changes more than one object (one change is a step already) */
  private grouped<T>(label: string, objects: number, work: () => Promise<T>): Promise<T> {
    const groups = this.options.groups
    return groups && objects > 1 ? groups.within(`${label} ${objects} objects`, work) : work()
  }

  /** Runs an action unless another one is running (resolves with `otherwise` then) */
  private async exclusive<T>(otherwise: T, action: () => Promise<T>): Promise<T> {
    if (this.acting) return otherwise
    this.acting = true
    const run = action()
    this.actionDone = run.then(
      () => undefined,
      () => undefined
    )
    try {
      return await run
    } finally {
      this.acting = false
    }
  }

  async setActive(id: string, active: boolean): Promise<void> {
    this.assertEditable()
    await this.setProperties(id, { active })
  }

  /** Copies the selected objects, each right after its original, and selects the copies */
  duplicateSelected(): Promise<void> {
    return this.exclusive<void>(undefined, async () => {
      this.assertEditable()
      const ids = topLevel(this.tree.value, this.actingIds())
      if (ids.length === 0) return
      const copies: string[] = []
      try {
        await this.grouped("Duplicate", ids.length, async () => {
          for (const id of ids) copies.push(await this.engine.duplicateEntity(id))
        })
      } finally {
        await this.refresh()
        const tree = this.tree.value
        const found = copies.filter((id) => tree.nodes.has(id))
        if (found.length > 0) {
          batch(() => {
            for (const id of found) this.expandAncestors(id)
            this.setSelection({ ids: new Set(found), anchor: found[0], primary: found[found.length - 1] })
          })
        }
      }
    })
  }

  /** Whether the host can copy and paste objects (protocol 1.18.0) */
  get canCopyPaste(): boolean {
    return typeof this.engine.serializeEntities === "function" && typeof this.engine.instantiateEntities === "function"
  }

  /** Asks the host for the selected objects (the topmost, with what is under them) as the clipboard text */
  private async serializeSelection(): Promise<string | null> {
    if (!this.canCopyPaste) throw new Error("This editor host can't copy objects (it needs protocol 1.18.0)")
    const ids = topLevel(this.tree.value, this.actingIds())
    if (ids.length === 0) return null
    return clipboardText(await this.engine.serializeEntities!(ids))
  }

  /** Keeps the text as the editor's own copy and puts it on the system clipboard (which may refuse: the copy stays) */
  private async store(text: string): Promise<void> {
    this.copied = text
    try {
      await this.options.clipboard?.writeText(text)
    } catch {
      // the editor's own copy still pastes within this window
    }
  }

  /** Copies the selected objects with what is under them; resolves false when nothing is selected. Allowed during play. */
  copySelected(): Promise<boolean> {
    return this.exclusive(false, async () => {
      const text = await this.serializeSelection()
      if (text === null) return false
      await this.store(text)
      return true
    })
  }

  /** Copies the selected objects, then destroys them, as one undo step; nothing is destroyed unless the copy was made */
  cutSelected(): Promise<boolean> {
    return this.exclusive(false, async () => {
      this.assertEditable()
      const ids = topLevel(this.tree.value, this.actingIds())
      const text = await this.serializeSelection()
      if (text === null) return false
      await this.store(text)
      try {
        await this.grouped("Cut", ids.length, async () => {
          for (const id of ids) await this.engine.destroyEntity(id)
        })
      } finally {
        await this.refresh()
      }
      return true
    })
  }

  /** The clipboard text to paste: the system clipboard's when it is ours; the editor's own copy when it can't be read */
  private async clipboardToPaste(): Promise<string | null> {
    if (this.options.clipboard) {
      try {
        return parseClipboardText(await this.options.clipboard.readText())
      } catch {
        // unreadable: the editor's own copy
      }
    }
    return parseClipboardText(this.copied)
  }

  /**
   * Pastes the copied objects right after the selected one (under the same parent), or last in the scene when nothing
   * is selected, as one undo step, and selects them. Resolves false when there is nothing of ours to paste.
   */
  pasteCopied(): Promise<boolean> {
    return this.exclusive(false, async () => {
      this.assertEditable()
      if (!this.canCopyPaste) throw new Error("This editor host can't paste objects (it needs protocol 1.18.0)")
      const json = await this.clipboardToPaste()
      if (json === null) return false
      const tree = this.tree.value
      const anchor = topLevel(tree, this.actingIds()).pop()
      const parentId = anchor === undefined ? RootId : (tree.parents.get(anchor) ?? RootId)
      const siblingIndex = anchor === undefined ? -1 : childrenOf(tree, parentId).indexOf(anchor) + 1
      let created: string[] = []
      try {
        // References to objects outside the copy are kept when the open scene has them (the host checks)
        created = await this.engine.instantiateEntities!(json, parentId, siblingIndex, true)
      } finally {
        await this.refresh()
      }
      const found = created.filter((id) => this.tree.value.nodes.has(id))
      if (found.length > 0) {
        batch(() => {
          for (const id of found) this.expandAncestors(id)
          this.setSelection({ ids: new Set(found), anchor: found[0], primary: found[found.length - 1] })
        })
      }
      return true
    })
  }

  // ==================== Prefabs (protocol 1.19.0) ====================

  /** Whether the host has prefab assets and this editor was given the listing to work with them */
  get canPrefabs(): boolean {
    const prefabs = this.options.prefabs
    return (
      !!prefabs &&
      prefabs.enabled.value &&
      typeof this.engine.createPrefab === "function" &&
      typeof this.engine.instantiatePrefab === "function" &&
      typeof this.engine.applyPrefab === "function" &&
      typeof this.engine.unpackPrefab === "function"
    )
  }

  private assertPrefabs(): PrefabOptions {
    const prefabs = this.options.prefabs
    if (!prefabs || !this.canPrefabs) throw new Error("This editor host has no prefab assets (it needs protocol 1.19.0)")
    return prefabs
  }

  /** The asset UUID of the prefab the object is linked to (an instance's root); null when it is not linked */
  prefabOf(id: string): string | null {
    return this.tree.value.nodes.get(id)?.prefab || null
  }

  /**
   * Makes prefab instances (copies with a link) under the target: parent and place as a drag's drop names them, the
   * prefabs one after another in the order given, as one undo step when there are several. With a position (a drop on
   * the viewport) each root is put there in the world. The new roots are selected. Resolves false when nothing was
   * made (a search is narrowing the rows, or a place that does not exist); a refusal is thrown.
   */
  instantiatePrefabs(uuids: readonly string[], target: DropTarget, position?: Vec3): Promise<boolean> {
    return this.exclusive(false, async () => {
      this.assertEditable()
      this.assertPrefabs()
      // A drop on the hierarchy names a place among rows a search hides (like a move); a drop on the viewport (with a
      // position) and the menu go to the end of the scene's roots, which a search does not change
      if (uuids.length === 0 || (this.filtering && position === undefined && !(target.parentId === RootId && target.index < 0))) {
        return false
      }
      if (target.parentId !== RootId && !this.tree.value.nodes.has(target.parentId)) return false
      const created: string[] = []
      try {
        await this.grouped("Instantiate", uuids.length, async () => {
          for (let i = 0; i < uuids.length; i++) {
            // Each root goes right after the one before it; -1 is the last place, which stays the last
            const index = target.index < 0 ? -1 : target.index + i
            created.push(
              await this.engine.instantiatePrefab!(
                uuids[i],
                target.parentId,
                index,
                position !== undefined,
                position ?? { x: 0, y: 0, z: 0 }
              )
            )
          }
        })
      } finally {
        await this.refresh()
        const tree = this.tree.value
        const found = created.filter((id) => tree.nodes.has(id))
        if (found.length > 0) {
          batch(() => {
            if (target.parentId !== RootId) this.expand(target.parentId)
            for (const id of found) this.expandAncestors(id)
            this.setSelection({ ids: new Set(found), anchor: found[0], primary: found[found.length - 1] })
          })
        }
      }
      return created.length > 0
    })
  }

  /**
   * Writes the object, with what is under it, as a prefab file at the path (a res:// path, or text that becomes one) and
   * links the object to it. When the listing has a file there the user is asked before it is replaced. Resolves the
   * file's path and UUID, or null when the user said no. The host refuses it in a play session (and so does this).
   */
  createPrefab(id: string, pathText: string): Promise<{ path: string; uuid: string } | null> {
    return this.exclusive<{ path: string; uuid: string } | null>(null, async () => {
      this.assertEditable()
      const prefabs = this.assertPrefabs()
      const node = this.tree.value.nodes.get(id)
      if (!node) return null
      const normal = normalizePrefabPath(pathText)
      if (normal.path === null) throw new Error(normal.error)
      const overwrite = prefabs.exists(normal.path)
      if (
        overwrite &&
        !(await this.options.confirm(
          `Replace ${normal.path} with '${node.name}'? Objects already made from that prefab are not updated.`,
          "Replace"
        ))
      ) {
        return null
      }
      try {
        return await this.engine.createPrefab!(id, normal.path, overwrite)
      } finally {
        // The object is linked to the file now: its row shows it
        await this.refresh()
        prefabs.changed()
      }
    })
  }

  /**
   * Writes the object back to the prefab it is linked to, after the user agrees (the file is overwritten and instances
   * already in scenes are not updated). Resolves false when the user said no or the object is not linked.
   */
  applyPrefab(id: string): Promise<boolean> {
    return this.exclusive(false, async () => {
      this.assertEditable()
      const prefabs = this.assertPrefabs()
      const uuid = this.prefabOf(id)
      const node = this.tree.value.nodes.get(id)
      if (uuid === null || !node) return false
      const path = prefabs.pathOf(uuid) ?? "the prefab"
      if (
        !(await this.options.confirm(
          `Overwrite ${path} with '${node.name}'? The file is replaced and Undo does not bring it back. Objects already made from the prefab are not updated.`,
          "Apply"
        ))
      ) {
        return false
      }
      try {
        await this.engine.applyPrefab!(id)
      } finally {
        prefabs.changed()
      }
      return true
    })
  }

  /** Clears the object's link to its prefab (one undo step); the object, what is under it and the file stay */
  unpackPrefab(id: string): Promise<boolean> {
    return this.exclusive(false, async () => {
      this.assertEditable()
      this.assertPrefabs()
      if (this.prefabOf(id) === null) return false
      try {
        await this.engine.unpackPrefab!(id)
      } finally {
        await this.refresh()
      }
      return true
    })
  }

  /**
   * Destroys the selected objects with what is under them, as one undo step. Asks first when that is more than one
   * object; resolves false when the user said no.
   */
  deleteSelected(): Promise<boolean> {
    return this.exclusive(false, async () => {
      this.assertEditable()
      const tree = this.tree.value
      const ids = topLevel(tree, this.actingIds())
      if (ids.length === 0) return false
      const count = tree.order.filter(
        (id) => ids.includes(id) || ancestorsOf(tree, id).some((a) => ids.includes(a))
      ).length
      if (count > 1) {
        const names = ids.map((id) => `'${tree.nodes.get(id)?.name ?? id}'`).join(", ")
        const what = count === ids.length ? names : `${names} and everything under ${ids.length === 1 ? "it" : "them"}`
        if (!(await this.options.confirm(`Delete ${what} (${count} objects)?`, "Delete"))) return false
      }
      try {
        await this.grouped("Delete", ids.length, async () => {
          for (const id of ids) await this.engine.destroyEntity(id)
        })
      } finally {
        await this.refresh()
      }
      return true
    })
  }

  /**
   * Moves the objects (the selection's top-level ones when the dragged object is selected; see dragIds) to the
   * target, keeping where they are in the world. Resolves false when the drop isn't allowed or changes nothing.
   */
  move(draggedIds: readonly string[], target: DropTarget): Promise<boolean> {
    return this.exclusive(false, async () => {
      this.assertEditable()
      if (this.filtering) return false // the drop places a search hides are not all shown: no reparenting under a search
      const moves = planMoves(this.tree.value, draggedIds, target)
      if (moves === null || moves.length === 0) return false
      try {
        await this.grouped("Move", moves.length, async () => {
          for (const move of moves) {
            await this.engine.setEntityParent(move.entityId, move.parentId, move.siblingIndex, true)
          }
        })
      } finally {
        await this.refresh()
      }
      if (target.parentId !== RootId) this.expand(target.parentId)
      return true
    })
  }

  /** What a drag that starts on the object carries: the selection when it holds the object, else just the object */
  dragIds(id: string): string[] {
    const selection = this.selection.value
    return selection.ids.has(id) ? topLevel(this.tree.value, this.actingIds()) : [id]
  }

  private async setProperties(id: string, properties: { name: string } | { active: boolean }): Promise<void> {
    try {
      await this.engine.setEntityProperties(id, properties)
    } finally {
      await this.refresh()
    }
  }
}
