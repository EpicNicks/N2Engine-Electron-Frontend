// The welcome screen, in two modes. Local engine: open a project, create one (N2EditorHost --create, engine #90),
// reopen a recent one, and say where N2EditorHost is. Remote engine (frontend issue #21): connect to a host that is
// already running, through an SSH tunnel the editor opens (user@host, ports, identity file and the access token).
import { useState } from "preact/hooks"
import type { RemoteSettings } from "../shared/api"
import { basename } from "./paths"
import { useApp } from "./ui"

function HostLocationLine() {
  const { store } = useApp()
  const location = store.hostLocation.value
  if (!location) return null

  let text: string
  if (location.path === null) {
    text = "N2EditorHost isn't set. Locate it to open projects, or start the editor with N2ENGINE_HOST set."
  } else {
    const from = location.source === "env" ? " (from N2ENGINE_HOST)" : ""
    text = location.problem ? `${location.problem}${from}` : `N2EditorHost: ${location.path}${from}`
  }
  const bad = location.path === null || location.problem !== null

  return (
    <div class={bad ? "host-location problem" : "host-location"}>
      <span title={location.path ?? undefined}>{text}</span>
      <button class="link" onClick={() => store.locateHost()}>
        {location.source === "setting" ? "Change..." : "Locate N2EditorHost..."}
      </button>
    </div>
  )
}

function describeSaved(settings: RemoteSettings): string {
  const ssh = settings.sshPort ? ` (ssh port ${settings.sshPort})` : ""
  return `${settings.target}, host port ${settings.hostPort}${ssh}`
}

/** The remote engine's connection form. The token is asked each time: it lives in this form until Connect, and is never saved. */
function RemoteForm() {
  const { store } = useApp()
  const busy = store.busy.value !== null
  const [target, setTarget] = useState("")
  const [sshPort, setSshPort] = useState("")
  const [identityFile, setIdentityFile] = useState("")
  const [hostPort, setHostPort] = useState("")
  const [token, setToken] = useState("")
  const recent = store.recentRemotes.value

  const port = (text: string): number | undefined => (text.trim() === "" ? undefined : Number(text.trim()))
  const ready = target.trim() !== "" && hostPort.trim() !== "" && token !== ""
  const fill = (settings: RemoteSettings) => {
    setTarget(settings.target)
    setSshPort(settings.sshPort ? String(settings.sshPort) : "")
    setIdentityFile(settings.identityFile ?? "")
    setHostPort(String(settings.hostPort))
  }
  const connect = async () => {
    const settings = {
      target: target.trim(),
      sshPort: port(sshPort),
      identityFile: identityFile.trim() || undefined,
      hostPort: port(hostPort),
    }
    const secret = token
    // Out of the form at once: a failed attempt asks for it again, and nothing keeps it
    setToken("")
    await store.connectRemote(settings as RemoteSettings, secret)
  }

  return (
    <form
      class="remote-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && !busy) void connect()
      }}
    >
      <label>
        SSH address
        <input
          type="text"
          placeholder="user@host"
          value={target}
          onInput={(e) => setTarget(e.currentTarget.value)}
          disabled={busy}
          autocomplete="off"
          spellcheck={false}
        />
      </label>
      <div class="remote-row">
        <label>
          SSH port
          <input
            type="text"
            inputMode="numeric"
            placeholder="22"
            value={sshPort}
            onInput={(e) => setSshPort(e.currentTarget.value)}
            disabled={busy}
          />
        </label>
        <label>
          Host's editor port
          <input
            type="text"
            inputMode="numeric"
            placeholder="the --port N2EditorHost was started with"
            value={hostPort}
            onInput={(e) => setHostPort(e.currentTarget.value)}
            disabled={busy}
          />
        </label>
      </div>
      <label>
        Identity file (optional: the ssh agent and default keys are used without one)
        <input
          type="text"
          placeholder="~/.ssh/id_ed25519"
          value={identityFile}
          onInput={(e) => setIdentityFile(e.currentTarget.value)}
          disabled={busy}
          autocomplete="off"
          spellcheck={false}
        />
      </label>
      <label>
        Access token
        <input
          type="password"
          placeholder="the host's N2_EDITOR_TOKEN"
          value={token}
          onInput={(e) => setToken(e.currentTarget.value)}
          disabled={busy}
          autocomplete="off"
        />
      </label>
      <button type="submit" disabled={busy || !ready}>
        Connect
      </button>
      <p class="note">
        Needs the system's ssh, with a key that needs no passphrase prompt (or an agent) and the host already trusted:
        ssh runs non-interactively. The editor works on the project the host has open. Play mode isn't available.
      </p>
      {recent.length > 0 && (
        <div class="recent">
          <h3>Recent Remotes</h3>
          {recent.map((settings) => (
            <div class="recent-item" key={`${settings.target}:${settings.sshPort ?? ""}:${settings.hostPort}`}>
              <button
                class="recent-open"
                title={settings.identityFile}
                disabled={busy}
                onClick={() => fill(settings)}
                type="button"
              >
                <span class="recent-name">{settings.target}</span>
                <span class="recent-path">{describeSaved(settings)}</span>
              </button>
              <button
                class="recent-remove"
                type="button"
                title="Remove from the list"
                aria-label={`Remove ${settings.target} from the list`}
                disabled={busy}
                onClick={() => store.removeRecentRemote(settings)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </form>
  )
}

function ModeSwitch() {
  const { store } = useApp()
  const mode = store.welcomeMode.value
  const busy = store.busy.value !== null
  return (
    <div class="mode-switch" role="tablist">
      <button
        role="tab"
        aria-selected={mode === "local"}
        class={mode === "local" ? "active" : ""}
        disabled={busy}
        onClick={() => (store.welcomeMode.value = "local")}
      >
        Local engine (exe)
      </button>
      <button
        role="tab"
        aria-selected={mode === "remote"}
        class={mode === "remote" ? "active" : ""}
        disabled={busy}
        onClick={() => (store.welcomeMode.value = "remote")}
      >
        Remote engine
      </button>
    </div>
  )
}

export function Welcome() {
  const { store } = useApp()
  if (store.welcomeMode.value === "remote") {
    return (
      <div class="welcome-screen">
        <h1>N2Engine Editor</h1>
        <ModeSwitch />
        <RemoteForm />
      </div>
    )
  }
  const recent = store.recent.value
  const busy = store.busy.value !== null
  const hostUsable = store.hostLocation.value?.path != null && store.hostLocation.value.problem === null
  const createUnavailable = store.createUnavailable.value

  return (
    <div class="welcome-screen">
      <h1>N2Engine Editor</h1>
      <ModeSwitch />
      <div class="actions">
        <button onClick={() => store.openProject()} disabled={busy || !hostUsable}>
          Open Project
        </button>
        <button
          onClick={() => store.createProject()}
          disabled={busy || createUnavailable !== null}
          title={createUnavailable ?? "Makes a folder a project with N2EditorHost --create"}
        >
          Create New Project
        </button>
      </div>
      {hostUsable && createUnavailable && <p class="note">{createUnavailable}.</p>}
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
