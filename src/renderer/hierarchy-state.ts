// The hierarchy panel's state, as signals: the scene's objects (GetHierarchy), what is expanded, selected and being
// renamed, and the actions the panel offers. No DOM: it is given the page's engine API or a fake, so it is unit
// tested in Node. Every action sends its command and then reads the hierarchy again, because the siblings whose
// index shifted are only fresh in GetHierarchy; the failure of an action is thrown for the panel to show.
import { batch, computed, signal } from "@preact/signals-core"
import type { EngineApi } from "../shared/api"
import type { HierarchyResponse } from "../protocol/protocol.generated"
import type { SceneChange } from "../protocol/editor-events"
import type { EditGroups } from "./edit-groups"
import {
  DropTarget,
  RootId,
  Selection,
  ancestorsOf,
  buildTree,
  childrenOf,
  clickSelect,
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
>

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
  readonly rows = computed(() => visibleRows(this.tree.value, this.expanded.value))
  readonly selection = signal<Selection>(emptySelection)
  /** The object whose name is being edited */
  readonly renaming = signal<string | null>(null)

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
    if (!this.isShown(id) || childrenOf(this.tree.value, id).length === 0) return
    if (!this.expanded.value.has(id)) this.expand(id)
    else this.click(childrenOf(this.tree.value, id)[0])
  }

  /** Arrow left: closes the primary object, or goes to its parent when it is closed */
  collapsePrimary(): void {
    const id = this.primaryId
    if (!this.isShown(id)) return
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
    const id = await this.engine.createEntityEx("", parentId, -1, preset)
    await this.refresh() // the newest read: it has the new object, whichever read it was
    batch(() => {
      if (this.tree.value.nodes.has(id)) {
        this.reveal(id)
        this.renaming.value = id
      }
    })
    return id
  }

  beginRename(id: string | null = this.primaryId): void {
    if (this.isShown(id)) this.renaming.value = id
  }

  cancelRename(): void {
    this.renaming.value = null
  }

  /** Ends renaming: sets the name unless it is empty or the same */
  commitRename(id: string, name: string): Promise<void> {
    if (this.renaming.value === id) this.renaming.value = null
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
    await this.setProperties(id, { active })
  }

  /** Copies the selected objects, each right after its original, and selects the copies */
  duplicateSelected(): Promise<void> {
    return this.exclusive<void>(undefined, async () => {
      const ids = topLevel(this.tree.value, this.selection.value.ids)
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

  /**
   * Destroys the selected objects with what is under them, as one undo step. Asks first when that is more than one
   * object; resolves false when the user said no.
   */
  deleteSelected(): Promise<boolean> {
    return this.exclusive(false, async () => {
      const tree = this.tree.value
      const ids = topLevel(tree, this.selection.value.ids)
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
    return selection.ids.has(id) ? topLevel(this.tree.value, selection.ids) : [id]
  }

  private async setProperties(id: string, properties: { name: string } | { active: boolean }): Promise<void> {
    try {
      await this.engine.setEntityProperties(id, properties)
    } finally {
      await this.refresh()
    }
  }
}
