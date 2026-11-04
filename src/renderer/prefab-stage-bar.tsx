// The prefab stage's bar (protocol 1.26.0), in the toolbar while a prefab is open: the breadcrumb back to the scene,
// Isolated / In Scene, Save and Close, the dirty dot, and what the host warns about (references it cleared, nested
// prefab links, the file changed elsewhere or deleted).
import { useApp } from "./ui"

export function PrefabStageBar() {
  const { store } = useApp()
  const stage = store.prefabStage.value
  if (!stage) return null
  const busy = store.busy.value !== null
  const readOnly = store.hostReadOnly.value
  const contextCapable = store.prefabStageContextAvailable.value
  const sceneName = stage.sceneName || "Untitled"
  const name = stage.name || stage.path
  const contextTip = !contextCapable
    ? "This host's renderer can't draw the scene around the prefab"
    : stage.contextAvailable
      ? "Show the prefab where its instance is in the scene, with the rest dimmed (its root's transform is locked)"
      : "No instance of the prefab is in the scene: it is shown at its own position, with the scene dimmed around it"
  const reload = async () => {
    // Reload = drop the stage's changes and open the file again
    const path = stage.path
    const mode = stage.mode
    if (!(await store.ensurePrefabStageClosed("reload it"))) return
    await store.openPrefabStage(path, mode)
  }

  return (
    <div class="prefab-stage-bar" role="toolbar" aria-label="Prefab stage">
      <nav class="breadcrumb" aria-label="Breadcrumb">
        <button
          class="link"
          onClick={() => void store.closePrefabStage()}
          disabled={busy}
          title={`Back to ${stage.scenePath || sceneName} (closes the prefab, asking about unsaved changes)`}
        >
          {sceneName}
        </button>
        <span class="crumb-separator">&gt;</span>
        <span class={stage.dirty ? "prefab-name dirty" : "prefab-name"} title={stage.path}>
          {name}
          {stage.dirty && <span class="dirty-dot" aria-label="unsaved changes"> ●</span>}
        </span>
      </nav>
      <div class="segmented" role="group" aria-label="Prefab view">
        <button
          class={stage.mode === "isolated" ? "selected" : "secondary"}
          aria-pressed={stage.mode === "isolated"}
          onClick={() => void store.setPrefabStageMode("isolated")}
          disabled={busy}
          title="The prefab alone"
        >
          Isolated
        </button>
        <button
          class={stage.mode === "context" ? "selected" : "secondary"}
          aria-pressed={stage.mode === "context"}
          onClick={() => void store.setPrefabStageMode("context")}
          disabled={busy || !contextCapable}
          title={contextTip}
        >
          In Scene
        </button>
      </div>
      <button
        onClick={() => void store.savePrefabStage()}
        disabled={busy || readOnly || stage.orphaned}
        title={stage.orphaned ? "The prefab's file was deleted: it can't be saved" : "Save the prefab (Ctrl+S)"}
      >
        Save prefab
      </button>
      <button class="secondary" onClick={() => void store.closePrefabStage()} disabled={busy} title="Back to the scene">
        Close
      </button>
      {stage.orphaned && (
        <span class="stage-notice warning" role="alert">
          The prefab's file was deleted: close it and discard the changes.
        </span>
      )}
      {!stage.orphaned && stage.externalChange && (
        <span class="stage-notice warning" role="alert">
          The file changed outside the editor.{" "}
          <button class="link" onClick={() => void reload()} disabled={busy}>
            Reload
          </button>{" "}
          (drops your changes) or keep editing: Save overwrites it.
        </span>
      )}
      {stage.warnings.length > 0 && (
        <span class="stage-notice" title={stage.warnings.join("\n")}>
          {stage.warnings.length === 1 ? stage.warnings[0] : `${stage.warnings.length} notes (hover)`}
        </span>
      )}
    </div>
  )
}
