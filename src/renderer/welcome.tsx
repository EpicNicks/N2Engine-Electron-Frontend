// The welcome screen: open a project, create one (N2EditorHost --create, engine #75), reopen a recent one, and
// say where N2EditorHost is.
import { basename } from "./paths"
import { useApp } from "./ui"

function HostLocationLine() {
  const { store } = useApp()
  const location = store.hostLocation.value
  if (!location) return null

  let text: string
  if (location.path === null) {
    text = "N2EditorHost isn't set. Locate it to open projects, or start the editor with N2_EDITOR_HOST set."
  } else {
    const from = location.source === "env" ? " (from N2_EDITOR_HOST)" : ""
    text = location.problem ? `${location.problem}${from}` : `N2EditorHost: ${location.path}${from}`
  }
  const bad = location.path === null || location.problem !== null

  return (
    <div class={bad ? "host-location problem" : "host-location"}>
      <span title={location.path ?? undefined}>{text}</span>
      {location.source !== "env" && (
        <button class="link" onClick={() => store.locateHost()}>
          {location.path === null ? "Locate N2EditorHost..." : "Change..."}
        </button>
      )}
    </div>
  )
}

export function Welcome() {
  const { store } = useApp()
  const recent = store.recent.value
  const busy = store.busy.value !== null
  const hostUsable = store.hostLocation.value?.path != null && store.hostLocation.value.problem === null

  return (
    <div class="welcome-screen">
      <h1>N2Engine Editor</h1>
      <div class="actions">
        <button onClick={() => store.openProject()} disabled={busy || !hostUsable}>
          Open Project
        </button>
        <button
          onClick={() => store.createProject()}
          disabled={busy || !hostUsable}
          title="Runs N2EditorHost --create, which needs engine #75 (E3)"
        >
          Create New Project
        </button>
      </div>
      <p class="note">Creating a project needs an N2EditorHost with --create (engine #75, not merged yet).</p>
      <HostLocationLine />

      <div class="recent">
        <h3>Recent Projects</h3>
        {recent.length === 0 ? (
          <p class="empty">No recent projects</p>
        ) : (
          recent.map((projectPath) => (
            <div class="recent-item" key={projectPath}>
              <button
                class="recent-open"
                title={projectPath}
                disabled={busy || !hostUsable}
                onClick={() => store.openRecent(projectPath)}
              >
                <span class="recent-name">{basename(projectPath)}</span>
                <span class="recent-path">{projectPath}</span>
              </button>
              <button
                class="recent-remove"
                title="Remove from the list"
                aria-label={`Remove ${basename(projectPath)} from the list`}
                disabled={busy}
                onClick={() => store.removeRecent(projectPath)}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
