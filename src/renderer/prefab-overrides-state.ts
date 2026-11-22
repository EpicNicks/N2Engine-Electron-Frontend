// The inspected object's prefab overrides (protocol 1.33.0 and 1.34.0): what the prefab instance it is in changes, read
// with GetPrefabOverrides, and the Revert and Apply actions on chosen changes. The inspector reads it again whenever it
// reads the object. No DOM: unit tested in Node.
import { computed, signal } from "@preact/signals-core"
import type { PrefabOverridesInfo } from "../protocol/protocol.generated"
import type { EngineApi } from "../shared/api"
import { OverrideRow, linkPathOf, overrideRows, prefabLabel } from "../protocol/prefab-overrides"
import { errorTextOf } from "../shared/api"

export type PrefabOverridesEngine = Partial<Pick<EngineApi, "getPrefabOverrides" | "revertPrefabOverrides" | "applyPrefabOverrides">>

export interface PrefabOverridesOptions {
  /** Whether the user agreed (the page's confirm dialog) */
  confirm(message: string, okLabel: string): Promise<boolean>
  /** The scene changed (a revert or an apply): the inspector reads the object again */
  changed?(): void
}

/** "Apply All" (every change of the instance), or the rows chosen */
export type OverrideChoice = readonly OverrideRow[] | "all"

export class PrefabOverridesState {
  /** The overrides of the outermost instance the inspected object is in; null for none (or not read) */
  readonly info = signal<PrefabOverridesInfo | null>(null)
  /** Why they couldn't be read, or null */
  readonly problem = signal<string | null>(null)
  readonly rows = computed<readonly OverrideRow[]>(() => {
    const info = this.info.value
    return info === null ? [] : overrideRows(info)
  })
  /** The links the object is in, outer to inner (from a 1.34.0 host; empty before) */
  readonly linkPath = computed(() => {
    const info = this.info.value
    return info === null ? [] : linkPathOf(info)
  })
  /** The object the info is for */
  private entityId: string | null = null
  private reads = 0

  constructor(
    private readonly engine: PrefabOverridesEngine,
    private readonly options: PrefabOverridesOptions
  ) {}

  /** Whether the host has GetPrefabOverrides and RevertPrefabOverrides (1.33.0) */
  get canRead(): boolean {
    return typeof this.engine.getPrefabOverrides === "function" && typeof this.engine.revertPrefabOverrides === "function"
  }

  /** Whether chosen changes can be applied to a prefab (1.34.0: the host gives each its levels) */
  get canApply(): boolean {
    return typeof this.engine.applyPrefabOverrides === "function" && this.info.value?.applyTo !== undefined
  }

  /** Reads the overrides of the instance the object is in; null (or an object in no instance) clears them */
  async load(entityId: string | null): Promise<void> {
    const read = ++this.reads
    this.entityId = entityId
    if (entityId === null || !this.canRead) {
      this.info.value = null
      this.problem.value = null
      return
    }
    try {
      const info = await this.engine.getPrefabOverrides!(entityId)
      if (read !== this.reads) return
      this.info.value = info
      this.problem.value = null
    } catch (e) {
      if (read !== this.reads) return
      this.info.value = null
      this.problem.value = errorTextOf(e)
    }
  }

  /** Reverts the rows (or everything) as one undo step */
  async revert(choice: OverrideChoice): Promise<void> {
    const entityId = this.entityId
    if (entityId === null || !this.canRead) return
    const targets = choice === "all" ? [{ all: true }] : choice.map((row) => row.target)
    if (targets.length === 0) return
    await this.engine.revertPrefabOverrides!(entityId, targets)
    await this.after(entityId)
  }

  /**
   * Writes the rows (or everything) into the prefab at level of the link path (-1: each to the innermost prefab that holds
   * it), after the user agrees: the file is replaced, and Undo takes back only the scene's update. Resolves false when the
   * user said no.
   */
  async apply(choice: OverrideChoice, level: number): Promise<boolean> {
    const entityId = this.entityId
    if (entityId === null || !this.canApply) return false
    const rows = choice === "all" ? this.rows.value : choice
    if (rows.length === 0) return false
    const where =
      level < 0
        ? "the innermost prefab that holds each"
        : prefabLabel(rows[0].levels.find((l) => l.level === level) ?? this.linkPath.value[level] ?? { prefab: "the prefab", path: "" })
    const what = choice === "all" ? "every override of this instance" : rows.length === 1 ? "this override" : `${rows.length} overrides`
    if (
      !(await this.options.confirm(
        `Apply ${what} to ${where}? The prefab file is written and Undo does not bring it back. Every instance of it is updated.`,
        "Apply"
      ))
    ) {
      return false
    }
    const targets = choice === "all" ? [{ all: true }] : choice.map((row) => row.target)
    await this.engine.applyPrefabOverrides!(entityId, targets, level)
    await this.after(entityId)
    return true
  }

  private async after(entityId: string): Promise<void> {
    this.options.changed?.()
    if (this.entityId === entityId) await this.load(entityId)
  }
}
