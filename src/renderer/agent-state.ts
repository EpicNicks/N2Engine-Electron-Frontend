// The page's side of "Allow AI agent for this project" (MCP6): the endpoint's state as the main process reports it, and the two
// actions (the switch, and the banner's Disconnect). The endpoint itself is in the main process (src/main/agent-endpoint.ts);
// the page never holds the agent's secret.
import { signal, type Signal } from "@preact/signals-core"
import type { AgentApi, AgentState } from "../shared/api"

export class AgentModel {
  readonly state: Signal<AgentState>
  /** A switch or a disconnect is on its way */
  readonly busy = signal(false)

  constructor(
    private readonly api: Pick<AgentApi, "state" | "onStateChange" | "setEnabled" | "disconnect">,
    private readonly onError: (what: string, e: unknown) => void
  ) {
    this.state = signal<AgentState>(api.state())
    api.onStateChange((state) => {
      this.state.value = state
    })
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.busy.value = true
    try {
      this.state.value = await this.api.setEnabled(enabled)
    } catch (e) {
      this.onError(enabled ? "Failed to allow the AI agent" : "Failed to stop the AI agent", e)
    } finally {
      this.busy.value = false
    }
  }

  async disconnect(): Promise<void> {
    this.busy.value = true
    try {
      this.state.value = await this.api.disconnect()
    } catch (e) {
      this.onError("Failed to disconnect the AI agent", e)
    } finally {
      this.busy.value = false
    }
  }
}

/** The page's model, set by index.tsx; null where there is none (a test, a preload without window.agent) */
export const agentModel = signal<AgentModel | null>(null)
