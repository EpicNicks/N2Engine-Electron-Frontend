import { computed, signal } from "@preact/signals-core"
import type { HostLaunchPreferences, HostPreferencesState, PreferencesApi } from "../shared/api"
import { parseHostLaunchPreferences } from "../shared/host-preferences"
import { type PrefsStore } from "./prefs"
import { DefaultViewportTool, ViewportToolPref, type ViewportToolPrefValue } from "./viewport-tool-prefs"

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export class PreferencesState {
  readonly host = signal<HostLaunchPreferences>({ hostPath: "", renderer: "", readyTimeoutMs: 30000 })
  readonly viewport = signal<ViewportToolPrefValue>(copy(DefaultViewportTool))
  readonly snapshot = signal<HostPreferencesState | null>(null)
  readonly loading = signal(true)
  readonly busy = signal(false)
  readonly error = signal<string | null>(null)
  readonly warning = signal<string | null>(null)
  private savedViewport = copy(this.viewport.peek())
  private generation = 0
  readonly dirty = computed(() => !!this.snapshot.value && (!same(this.host.value, this.snapshot.value.settings) || !same(this.viewport.value, this.savedViewport)))
  constructor(private readonly api: PreferencesApi, private readonly prefs: PrefsStore,
    private readonly applyViewport: (value: ViewportToolPrefValue) => void = () => {}) {
    this.viewport.value = copy(prefs.user.get(ViewportToolPref))
    this.savedViewport = copy(this.viewport.peek())
  }
  async load(): Promise<void> {
    const generation = ++this.generation
    this.loading.value = true; this.error.value = null
    try {
      const result = await this.api.getHost()
      if (generation !== this.generation) return
      this.snapshot.value = result; this.host.value = copy(result.settings)
    } catch (error) { if (generation === this.generation) this.error.value = String(error instanceof Error ? error.message : error) }
    finally { if (generation === this.generation) this.loading.value = false }
  }
  async browse(): Promise<void> {
    this.busy.value = true; this.error.value = null
    const generation = this.generation
    try {
      const path = await this.api.chooseHostPath()
      if (generation === this.generation && path !== null) this.host.value = { ...this.host.peek(), hostPath: path }
    } catch (error) { if (generation === this.generation) this.error.value = error instanceof Error ? error.message : String(error) }
    finally { if (generation === this.generation) this.busy.value = false }
  }
  async save(): Promise<boolean> {
    if (!this.snapshot.peek() || this.loading.peek() || this.busy.peek()) return false
    this.busy.value = true; this.error.value = null; this.warning.value = null
    const generation = this.generation
    try {
      const hostChanged = !same(this.host.peek(), this.snapshot.peek()!.settings)
      const value = hostChanged ? parseHostLaunchPreferences(this.host.peek()) : this.snapshot.peek()!.settings
      const viewportChanged = !same(this.viewport.peek(), this.savedViewport)
      const tool = copy(this.viewport.peek())
      if (!["none", "translate", "rotate", "scale"].includes(tool.mode) || !["world", "local"].includes(tool.space) || !["pivot", "center"].includes(tool.pivot))
        throw new Error("Choose a valid viewport tool, space and pivot")
      const result = hostChanged ? await this.api.saveHost(value) : this.snapshot.peek()!
      if (generation !== this.generation) return false
      this.snapshot.value = result; this.host.value = copy(result.settings)
      if (viewportChanged) this.prefs.user.set(ViewportToolPref, tool, { immediate: true })
      this.savedViewport = copy(tool); this.viewport.value = copy(tool)
      this.applyViewport(tool)
      if (viewportChanged && !this.prefs.user.isPersisted(ViewportToolPref)) {
        this.warning.value = "Launch preferences were accepted. Viewport preferences apply for this session, but local storage could not remember them."
        return false
      }
      return true
    } catch (error) { if (generation === this.generation) this.error.value = error instanceof Error ? error.message : String(error); return false }
    finally { if (generation === this.generation) this.busy.value = false }
  }
  dispose(): void { this.generation++ }
}
