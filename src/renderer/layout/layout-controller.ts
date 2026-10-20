// The layout the editor shows, as a signal, and what keeps it: every change goes through the pure operations of
// layout-model.ts, is saved (debounced) under the open project's id, and can be reset. The project's id is known only
// once the host has answered GetProjectInfo, so until then the layout starts from the user default (or the built-in one)
// and is saved the moment the id arrives. Framework-free apart from the signals, so it is tested without a DOM.
import { Signal, signal } from "@preact/signals-core"
import {
  Layout,
  MoveTarget,
  activatePanel,
  closeDynamic,
  closePanel,
  defaultLayout,
  movePanel,
  openDynamic,
  openPanel,
  serializeLayout,
  setRegionSize,
  syncDynamic,
} from "./layout-model"
import { LayoutPersistence } from "./layout-storage"
import { PanelRegistry, RegionId } from "./panel-registry"

/** After the last change, wait this long before saving (a splitter drag changes the size on every pointer move) */
export const SaveDelayMilliseconds = 400

/** How the controller waits: a function that runs a callback later and returns how to cancel it (setTimeout by default) */
export type Schedule = (callback: () => void, milliseconds: number) => () => void

const defaultSchedule: Schedule = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds)
  return () => clearTimeout(timer)
}

export class LayoutController {
  readonly layout: Signal<Layout>
  /** The tab being dragged, for the drop zones that show while it is (not saved) */
  readonly dragging = signal<string | null>(null)
  /** The drop zone the drag is over (not saved) */
  readonly dropHover = signal<string | null>(null)
  /** Whether the user has saved a default layout for new projects */
  readonly hasUserDefault: Signal<boolean>

  private projectId: string | null = null
  private dynamicIds: string[] = []
  private lastSaved: string | null = null
  private cancelSave: (() => void) | null = null
  private readonly startJson: string
  private disposed = false

  constructor(
    readonly registry: PanelRegistry,
    private readonly persistence: LayoutPersistence,
    private readonly schedule: Schedule = defaultSchedule
  ) {
    const user = persistence.loadUserDefault()
    this.hasUserDefault = signal(user !== null)
    this.layout = signal(user ?? defaultLayout(registry))
    this.startJson = this.json()
  }

  // ---- Which project ----

  /**
   * The open project's id (GetProjectInfo.project.projectId), once known, or null when the project is closed: a pending
   * save goes to the project it belongs to first, then the new project's saved layout (if it has one) is shown
   */
  setProject(projectId: string | null): void {
    if (projectId === this.projectId) return
    this.flush()
    const previous = this.projectId
    this.projectId = projectId
    this.lastSaved = null
    if (projectId === null) return
    const stored = this.persistence.loadProject(projectId)
    if (stored) {
      this.replace(stored)
      this.lastSaved = JSON.stringify(serializeLayout(stored))
    } else if (previous !== null) {
      // Another project without a layout of its own doesn't inherit the last one's
      this.replace(this.persistence.loadUserDefault() ?? defaultLayout(this.registry))
      this.lastSaved = this.json()
    } else if (this.json() !== this.startJson) {
      // Arranged before the id arrived: that arrangement is the project's
      this.scheduleSave()
    } else {
      // What is shown is what a project without a layout starts with: nothing to save until the user changes it
      this.lastSaved = this.json()
    }
  }

  // ---- Operations ----

  move(id: string, target: MoveTarget): void {
    this.update(movePanel(this.layout.peek(), this.registry, id, target))
  }

  close(id: string): void {
    const layout = this.layout.peek()
    this.update(this.registry.has(id) ? closePanel(layout, this.registry, id) : closeDynamic(layout, id))
  }

  /** Shows the panel: its tab when it is shown, else where it starts */
  open(id: string): void {
    this.update(openPanel(this.layout.peek(), this.registry, id))
  }

  activate(id: string): void {
    this.update(activatePanel(this.layout.peek(), id))
  }

  setSize(region: RegionId, size: number): void {
    this.update(setRegionSize(this.layout.peek(), this.registry, region, size))
  }

  /** The tabs that aren't panels (the open text files), by id, in order; they come back after a layout is replaced */
  setDynamicTabs(ids: readonly string[]): void {
    this.dynamicIds = [...ids]
    this.update(syncDynamic(this.layout.peek(), this.dynamicIds))
  }

  /** Shows a dynamic tab, opening it if it isn't (a text file just opened) */
  showDynamic(id: string): void {
    this.update(openDynamic(this.layout.peek(), id))
  }

  /** Forgets the project's layout and shows the user default, or the built-in layout when there is none */
  reset(): void {
    if (this.projectId !== null) this.persistence.clearProject(this.projectId)
    this.lastSaved = null
    this.cancelPending()
    this.replace(this.persistence.loadUserDefault() ?? defaultLayout(this.registry))
    // Cleared, so what is shown is what the project starts with again
    this.lastSaved = this.json()
  }

  /** Makes the layout the one new projects (and Reset layout) start from */
  saveAsUserDefault(): void {
    this.persistence.saveUserDefault(this.layout.peek())
    this.hasUserDefault.value = true
  }

  forgetUserDefault(): void {
    this.persistence.clearUserDefault()
    this.hasUserDefault.value = false
  }

  // ---- Saving ----

  private update(next: Layout): void {
    if (next === this.layout.peek()) return
    this.layout.value = next
    this.scheduleSave()
  }

  /** Shows a layout without saving it (it came from storage, or it is the default after a reset) */
  private replace(next: Layout): void {
    this.layout.value = syncDynamic(next, this.dynamicIds)
  }

  private scheduleSave(): void {
    if (this.projectId === null || this.disposed) return
    // Only what is saved counts: opening a text file changes the layout but not what is remembered
    if (this.json() === this.lastSaved) return this.cancelPending()
    this.cancelPending()
    this.cancelSave = this.schedule(() => {
      this.cancelSave = null
      this.save()
    }, SaveDelayMilliseconds)
  }

  private json(): string {
    return JSON.stringify(serializeLayout(this.layout.peek()))
  }

  private save(): void {
    if (this.projectId === null) return
    this.lastSaved = this.json()
    this.persistence.saveProject(this.projectId, this.layout.peek())
  }

  private cancelPending(): void {
    this.cancelSave?.()
    this.cancelSave = null
  }

  /** Saves a change that is waiting for its delay now */
  flush(): void {
    if (this.cancelSave === null) return
    this.cancelPending()
    this.save()
  }

  /** Saves what is waiting and stops: the editor is closing (or another project is opening) */
  dispose(): void {
    this.flush()
    this.disposed = true
  }
}
