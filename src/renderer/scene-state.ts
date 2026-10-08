// What the inspector shows, as signals: the selected object and its transform (the hierarchy panel's selection drives
// it: see HierarchyState). The scene and its objects are the store's (store.scene) and the hierarchy's
// (hierarchy-state.ts); the project's assets and text files are AssetsState's (assets-state.ts).
import { batch, signal } from "@preact/signals-core"
import type { EngineApi } from "../shared/api"
import type { Vec3 } from "../protocol/protocol.generated"

export interface Transform {
  position: Vec3
  rotation: Vec3
  scale: Vec3
}

type Engine = Pick<EngineApi, "getEntityTransform" | "setEntityTransform">

export class SceneState {
  /** The selected object's id (the hierarchy's primary selection); null with none */
  readonly selectedId = signal<string | null>(null)
  /** The selected entity's world transform; null while loading or with nothing selected */
  readonly transform = signal<Transform | null>(null)
  /** The selected object has no transform (CreateEntity's objects, or one that is gone): GetEntityTransform refused */
  readonly noTransform = signal(false)
  /** Counts setTransform calls, so a read that started before one can't replace its value */
  private edits = 0
  /** setTransform calls still waiting for the engine */
  private pendingEdits = 0

  constructor(private readonly engine: Engine) {}

  /** Everything the engine holds is gone (disconnected, or another host) */
  reset(): void {
    batch(() => {
      this.selectedId.value = null
      this.transform.value = null
      this.noTransform.value = false
    })
  }

  /** Forgets the project too (closed) */
  resetProject(): void {
    this.reset()
  }

  // ==================== Selection ====================

  async select(entityId: string | null): Promise<void> {
    batch(() => {
      this.selectedId.value = entityId
      this.transform.value = null
      this.noTransform.value = false
    })
    if (!entityId) return
    await this.readTransform(entityId)
  }

  /**
   * Reads the selected object's transform again (it changed), keeping the old one shown meanwhile. Not while an edit
   * of it is on its way (the value shown is the edit), and an edit made during the read wins over its answer.
   */
  async refreshTransform(): Promise<void> {
    const id = this.selectedId.value
    if (!id || this.pendingEdits > 0) return
    await this.readTransform(id)
  }

  private async readTransform(id: string): Promise<void> {
    const edits = this.edits
    try {
      const transform = await this.engine.getEntityTransform(id)
      if (this.selectedId.value === id && edits === this.edits) {
        batch(() => {
          this.transform.value = transform
          this.noTransform.value = false
        })
      }
    } catch (e) {
      // An object with no transform (or one destroyed meanwhile) is shown without one, not as a failure
      console.debug("GetEntityTransform failed:", e)
      if (this.selectedId.value === id && this.transform.value === null) this.noTransform.value = true
    }
  }

  /** Shows the new transform at once; if the engine refuses it, the inspector goes back to the one before */
  async setTransform(transform: Transform): Promise<void> {
    const id = this.selectedId.value
    if (!id) return
    const previous = this.transform.value
    this.edits++
    this.pendingEdits++
    this.transform.value = transform
    try {
      await this.engine.setEntityTransform(id, transform.position, transform.rotation, transform.scale)
    } catch (e) {
      // Unless something newer replaced it meanwhile (another edit, or another selection)
      if (this.selectedId.value === id && this.transform.value === transform) this.transform.value = previous
      throw e
    } finally {
      this.pendingEdits--
    }
  }
}
