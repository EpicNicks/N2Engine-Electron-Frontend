// The switch and the banner of "Allow AI agent for this project" (MCP6).
import { agentModel } from "./agent-state"
import { useApp } from "./ui"

/**
 * The toolbar's switch. It is off by default and kept per project. It is disabled, with the reason as its tooltip, while it
 * cannot be turned on: no project, a remote engine, a read-only host, or a viewer's role (an AI agent could not change
 * anything the person could not, and the editor does not offer a way to try). A switch that is on can always be turned off.
 */
export function AgentToggle() {
  const { store } = useApp()
  const model = agentModel.value
  if (model === null) return null
  const state = model.state.value
  const readOnly = store.hostReadOnlyReason.value
  const reason = readOnly !== null ? `Not available: ${readOnly}` : !state.available ? `Not available: ${state.reason ?? "the editor can't offer it now"}` : null
  const disabled = model.busy.value || (reason !== null && !state.enabled)
  const title =
    reason !== null
      ? reason
      : state.enabled
        ? "An AI agent (n2-mcp --electron) can work in this project. Turn off to close the endpoint at once."
        : "Let an AI agent (n2-mcp --electron) work in this project. Its changes are undo steps labelled AI:, and anything irreversible asks you first."
  return (
    <label class="agent-toggle" title={title}>
      <input
        type="checkbox"
        aria-label="Allow AI agent for this project"
        checked={state.enabled}
        disabled={disabled}
        onChange={(e) => void model.setEnabled((e.currentTarget as HTMLInputElement).checked)}
      />
      <span>AI agent</span>
    </label>
  )
}

/** Under the toolbar, while an agent is attached: who is working, and the button that ends it (and revokes its secret) */
export function AgentBanner() {
  const model = agentModel.value
  if (model === null) return null
  const state = model.state.value
  if (!state.connected) return null
  return (
    <div class="agent-banner" role="status">
      <span>
        <b>AI agent connected.</b> Its changes are undo steps labelled "AI: ..." in the Edit menu, and anything that cannot be undone asks you first.
      </span>
      <button type="button" onClick={() => void model.disconnect()} disabled={model.busy.value}>
        Disconnect
      </button>
    </div>
  )
}
