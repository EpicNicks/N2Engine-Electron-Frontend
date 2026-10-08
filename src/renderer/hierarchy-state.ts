// The hierarchy panel's state, as signals: the scene's objects (GetHierarchy), what is expanded, selected and being
// renamed, and the actions the panel offers. No DOM: it is given the page's engine API or a fake, so it is unit
// tested in Node. Every action sends its command and then reads the hierarchy again, because the siblings whose
// index shifted are only fresh in GetHierarchy; the failure of an action is thrown for the panel to show.
import { batch, computed, signal } from "@preact/signals-core"
import type { EngineApi } from "../shared/api"
import type { HierarchyResponse } from "../protocol/protocol.generated"
import type { SceneChange } from "../protocol/editor-events"
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

  /** Reads the hierarchy; a scene-less host or a dropped connection leaves it empty */
  async refresh(): Promise<void> {
    const fetch = ++this.fetches
    let response: HierarchyResponse | null = null
    if (this.engine.isConnected()) {
      try {
        response = await this.engine.getHierarchy()
      } catch (e) {
        // An error answer means no scene; a dropped connection is reported elsewhere
        console.debug("GetHierarchy failed:", e)
      }
    }
    if (fetch !== this.fetches) return
    batch(() => {
      this.response.value = response
      // What no longer exists can't stay selected, expanded or being renamed
      const tree = this.tree.value
      this.setSelection(pruneSelection(this.selection.value, tree))
      const expanded = [...this.expanded.value].filter((id) => tree.nodes.has(id))
      if (expanded.length !== this.expanded.value.size) this.expanded.value = new Set(expanded)
      if (this.renaming.value !== null && !tree.nodes.has(this.renaming.value)) this.renaming.value = null
    })
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
    if (!expanded.delete(id)) expanded.add(id)
    this.expanded.value = expanded
  }

  expand(id: string): void {
    if (!this.expanded.value.has(id)) this.expanded.value = new Set([...this.expanded.value, id])
  }

  /** Arrow right: opens the primary object, or goes to its first child when it is open */
  expandPrimary(): void {
    const id = this.primaryId
    if (id === null || childrenOf(this.tree.value, id).length === 0) return
    if (!this.expanded.value.has(id)) this.expand(id)
    else this.click(childrenOf(this.tree.value, id)[0])
  }

  /** Arrow left: closes the primary object, or goes to its parent when it is closed */
  collapsePrimary(): void {
    const id = this.primaryId
    if (id === null) return
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
    await this.refresh()
    batch(() => {
      if (this.tree.value.nodes.has(id)) {
        this.reveal(id)
        this.renaming.value = id
      }
    })
    return id
  }

  beginRename(id: string | null = this.primaryId): void {
    if (id !== null && this.tree.value.nodes.has(id)) this.renaming.value = id
  }

  cancelRename(): void {
    this.renaming.value = null
  }

  /** Ends renaming: sets the name unless it is empty or the same */
  async commitRename(id: string, name: string): Promise<void> {
    if (this.renaming.value === id) this.renaming.value = null
    const trimmed = name.trim()
    if (trimmed === "" || trimmed === this.tree.value.nodes.get(id)?.name) return
    await this.setProperties(id, { name: trimmed })
  }

  async setActive(id: string, active: boolean): Promise<void> {
    await this.setProperties(id, { active })
  }

  /** Copies the selected objects, each right after its original, and selects the copies */
  async duplicateSelected(): Promise<void> {
    const ids = topLevel(this.tree.value, this.selection.value.ids)
    if (ids.length === 0) return
    const copies: string[] = []
    try {
      for (const id of ids) copies.push(await this.engine.duplicateEntity(id))
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
  }

  /**
   * Destroys the selected objects with what is under them. Asks first when that is more than one object (there is no
   * undo yet); resolves false when the user said no.
   */
  async deleteSelected(): Promise<boolean> {
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
      for (const id of ids) await this.engine.destroyEntity(id)
    } finally {
      await this.refresh()
    }
    return true
  }

  /**
   * Moves the objects (the selection's top-level ones when the dragged object is selected; see dragIds) to the
   * target, keeping where they are in the world. Resolves false when the drop isn't allowed or changes nothing.
   */
  async move(draggedIds: readonly string[], target: DropTarget): Promise<boolean> {
    const moves = planMoves(this.tree.value, draggedIds, target)
    if (moves === null || moves.length === 0) return false
    try {
      for (const move of moves) {
        await this.engine.setEntityParent(move.entityId, move.parentId, move.siblingIndex, true)
      }
    } finally {
      await this.refresh()
    }
    if (target.parentId !== RootId) this.expand(target.parentId)
    return true
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
