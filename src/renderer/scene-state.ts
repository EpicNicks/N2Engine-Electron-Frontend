// Which object the inspector shows: the hierarchy panel's primary selection drives it (see HierarchyState). The object's
// own data, its LOCAL transform included, is the inspector's (inspector-state.ts: GetEntity, SetLocalTransform); the
// scene and its objects are the store's (store.scene) and the hierarchy's (hierarchy-state.ts); the project's assets
// and text files are AssetsState's (assets-state.ts).
import { signal } from "@preact/signals-core"

export class SceneState {
  /** The selected object's id (the hierarchy's primary selection); null with none */
  readonly selectedId = signal<string | null>(null)

  /** Everything the engine holds is gone (disconnected, or another host) */
  reset(): void {
    this.selectedId.value = null
  }

  /** Forgets the project too (closed) */
  resetProject(): void {
    this.reset()
  }

  async select(entityId: string | null): Promise<void> {
    this.selectedId.value = entityId
  }
}
