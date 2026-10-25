// The project settings panel: a list of sections on the left (whatever is in the section registry, in order), the
// selected section's form on the right, and under it Apply, Revert and Restore previous values, the host's refusal and
// the restart note. Edits are held per section and kept when the host refuses them. All the rules are in
// project-settings-state.ts; the forms are in project-settings-sections.tsx.
import { useEffect, useMemo, useState } from "preact/hooks"
import { NotInTheHistoryNote, ProjectSettingsModel } from "./project-settings-state"
import { settingsSections, type SectionComponent } from "./project-settings-sections"
import type { SectionRegistry, SettingsSectionDef } from "./project-settings-registry"
import { PhysicsBackendsModel } from "./physics-backends-state"
import { PhysicsBackendsCapability } from "../protocol/physics-backends"
import { hasCapability } from "../protocol/extensions"
import { computed } from "@preact/signals-core"
import { Empty, Panel, confirmDialog, useApp } from "./ui"

/** The registered panel: the model over the editor's store and the host's commands */
export function ProjectSettingsPanel() {
  const { store } = useApp()
  const model = useMemo(
    () =>
      new ProjectSettingsModel(
        {
          getProjectInfo: () => window.engine.getProjectInfo(),
          setProjectSettings: (patch) => window.engine.setProjectSettings(patch),
          setStartupScene: (path) => window.engine.setStartupScene(path),
          connected: store.connected,
          readOnlyReason: store.readOnlyReason,
          role: store.hostRole,
          projectChangeCount: store.projectChangeCount,
          confirm: confirmDialog,
          // A remote host is not ours to restart
          restartHost: store.remote.value ? null : () => store.restartHost(),
          physicsBackends: new PhysicsBackendsModel({
            getPhysicsBackends: () => window.engine.getPhysicsBackends(),
            setPhysicsBackend: (backend) => window.engine.setPhysicsBackend(backend),
            connected: store.connected,
            supported: computed(() => hasCapability(store.serverInfo.value?.capabilities, PhysicsBackendsCapability)),
            readOnlyReason: store.readOnlyReason,
          }),
        },
        settingsSections as SectionRegistry<unknown>
      ),
    [store, store.remote.value]
  )
  return <ProjectSettingsView model={model} />
}

type Def = SettingsSectionDef<SectionComponent>

export function ProjectSettingsView({ model }: { model: ProjectSettingsModel }) {
  // Reads and listens while shown; stops when closed
  useEffect(() => model.start(), [model])
  const defs = model.registry.list() as Def[]
  const [selected, setSelected] = useState<string | null>(null)
  const info = model.info.value
  const loadError = model.loadError.value
  const connected = model.isConnected
  const current = defs.find((d) => d.id === selected) ?? defs[0]

  let content
  if (!connected) content = <Empty>Not connected</Empty>
  else if (loadError) content = <Empty error>{`Failed to read the project settings: ${loadError}`}</Empty>
  else if (info === null || !current) content = <Empty>Loading...</Empty>
  else content = <SectionView key={current.id} model={model} def={current} />

  return (
    <Panel
      title="Project Settings"
      icon="🛠"
      class="project-settings-panel"
      actions={
        <button onClick={() => void model.refresh()} disabled={!connected || model.applying.value !== null}>
          Refresh
        </button>
      }
    >
      <div class="ps-layout">
        <nav class="ps-list" aria-label="Settings sections">
          {defs.map((def) => {
            const dirty = info !== null && model.isDirty(def.id)
            const locked = info !== null && connected && model.disabledReason(def.id) !== null
            return (
              <button
                key={def.id}
                type="button"
                class={`ps-item${def.id === current?.id ? " selected" : ""}`}
                aria-current={def.id === current?.id ? "page" : undefined}
                onClick={() => setSelected(def.id)}
              >
                <span class="ps-item-title">{def.title}</span>
                {dirty && (
                  <span class="ps-dirty" title="Unsaved changes" aria-label="Unsaved changes">
                    ●
                  </span>
                )}
                {locked && !dirty && (
                  <span class="ps-lock" title={model.disabledReason(def.id) ?? undefined} aria-label="Read-only">
                    🔒
                  </span>
                )}
              </button>
            )
          })}
        </nav>
        <div class="ps-body">{content}</div>
      </div>
      <div class="ps-footer">{NotInTheHistoryNote}</div>
    </Panel>
  )
}

function SectionView({ model, def }: { model: ProjectSettingsModel; def: Def }) {
  const Component = def.component
  const reason = model.disabledReason(def.id)
  return (
    <section class="ps-section" aria-label={def.title}>
      <h3>{def.title}</h3>
      {reason && (
        <div class="ps-note" role="status">
          {reason}
        </div>
      )}
      <Component model={model} def={def} />
      {def.logic && <SectionFooter model={model} def={def} />}
    </section>
  )
}

function SectionFooter({ model, def }: { model: ProjectSettingsModel; def: Def }) {
  const built = model.built(def.id)
  const dirty = built.changed.length > 0
  const invalid = Object.keys(built.errors).length > 0
  const busy = model.applying.value !== null
  const writable = model.disabledReason(def.id) === null
  const error = model.errors.value[def.id]
  const pending = model.restartPending.value[def.id] ?? []
  return (
    <div class="ps-actions">
      {error && (
        <div class="ps-host-error" role="alert">
          <b>The host refused it; your edits are kept.</b> <pre>{error}</pre>
        </div>
      )}
      {pending.length > 0 && (
        <div class="ps-restart" role="status">
          Saved. Takes effect after the host restarts: {pending.join(", ")}.{" "}
          {model.canRestartHost && (
            <button type="button" onClick={() => void model.restartHost()}>
              Restart host
            </button>
          )}
        </div>
      )}
      <div class="ps-buttons">
        <button type="button" onClick={() => void model.apply(def.id)} disabled={!writable || busy || !dirty || invalid}>
          {model.applying.value === def.id ? "Applying..." : "Apply"}
        </button>
        <button type="button" class="secondary" onClick={() => model.revert(def.id)} disabled={busy || !dirty}>
          Revert
        </button>
        {def.logic?.textOf && (
          <button
            type="button"
            class="secondary"
            onClick={() => model.restorePrevious(def.id)}
            disabled={!writable || busy || !model.hasPrevious(def.id)}
            title="Loads the values from before the last Apply; Apply again to save them"
          >
            Restore previous values
          </button>
        )}
      </div>
    </div>
  )
}
