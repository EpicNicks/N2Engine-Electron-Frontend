// The sections of the project settings panel, as a registry: the panel lists whatever is registered, in order, so a
// section is ONE register() call and the panel's own code never changes. Framework-free (the component is whatever the
// page puts there), like the panel registry (layout/panel-registry.ts).
//
// THE EXTENSION POINT (Network from B11, Editor Extensions from E-X4): a later change adds its section with
//
//     settingsSections.register({
//       id: "network", title: "Network", order: 70,
//       component: NetworkSection,                    // gets { model, def }; reads model.settings.value, model.canWrite(id)
//       logic: { build: ({ settings, edits }) => ... }, // optional: with it the panel adds Apply, Revert, the host's
//     })                                                // error and the restart note under the component
//
// The component keeps its drafts in the model (model.setEdit(id, key, text), model.edits.value[id]); logic.build turns
// the settings and the drafts into a minimal merge patch (BuiltSection), and the model sends it through the same
// guarded path as every section (read-only, the admin-only determinism block, host errors kept with the edits). A
// section that is not a settings form (the Extensions list) registers without logic and does what it likes.
import type { ProjectInfoResponse } from "../protocol/protocol.generated"
import type { HostRole } from "./store"
import type { BuiltSection, Edits, JsonObject } from "./project-settings-schema"

/** What logic.build sees */
export interface SectionBuildContext {
  /** The project's settings object as the host last answered it ({} when it has none) */
  settings: JsonObject
  /** The user's unsent edits of this section, by edit key (text) */
  edits: Edits
  /** The role is admin (a host without roles counts as admin) */
  isAdmin: boolean
  /** The whole GetProjectInfo answer (the scene list and the startup scene are in it) */
  info: ProjectInfoResponse
}

export interface SectionLogic {
  /** The minimal patch of the edits, their errors and which fields changed */
  build(ctx: SectionBuildContext): BuiltSection
  /**
   * The text an edit key has for the given settings: what "Restore previous values" puts back after an Apply. Without
   * it the section has no such button.
   */
  textOf?(ctx: Pick<SectionBuildContext, "settings" | "info">, key: string): string
  /** When set, Apply asks this first (the Raw section: it writes blocks the editor knows nothing about) */
  confirm?: { message: string; okLabel: string }
}

/** What requires() sees */
export interface SectionGate {
  role: HostRole | null
  isAdmin: boolean
  /** The host refused a determinism change with forbidden on this connection */
  determinismDenied: boolean
}

export interface SettingsSectionDef<C = unknown> {
  /** Stable: unique across sections */
  id: string
  title: string
  /** Sorted ascending; the built-in sections use 10, 20, ... so a later one can sit between */
  order: number
  component: C
  logic?: SectionLogic
  /** Why this section can't be changed by this user (beyond the panel's read-only), or null. It stays visible, read-only. */
  requires?(gate: SectionGate): string | null
}

export class SectionRegistry<C = unknown> {
  private readonly defs = new Map<string, SettingsSectionDef<C>>()

  /** Adds a section; a second one with the same id is a programming error */
  register(def: SettingsSectionDef<C>): void {
    if (this.defs.has(def.id)) throw new Error(`The settings section ${def.id} is already registered`)
    this.defs.set(def.id, def)
  }

  get(id: string): SettingsSectionDef<C> | undefined {
    return this.defs.get(id)
  }

  /** In display order (ties in the order they were registered) */
  list(): SettingsSectionDef<C>[] {
    return [...this.defs.values()].sort((a, b) => a.order - b.order)
  }
}
