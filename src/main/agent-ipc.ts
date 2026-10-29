// The Electron side of "Allow AI agent for this project" (MCP6): the page's switch and banner (Channels.agent*), the native
// confirmation dialog for the irreversible tier, and the request to the page to settle before an agent's call. The logic is
// in agent-controller.ts, agent-endpoint.ts and agent-mux.ts (Node only, tested); this file only connects them to Electron.
import { BrowserWindow, IpcMain, dialog } from "electron"
import { Channels } from "../shared/api"
import type { AgentController } from "./agent-controller"
import type { ConfirmRequest } from "./agent-endpoint"
import type { PrepareChannel } from "./agent-prepare"
import { EditorPage, handleResult } from "./ipc"

export interface AgentIpcDeps {
  page: EditorPage
  getWindow: () => BrowserWindow | null
  controller: AgentController
  prepare: PrepareChannel
}

/**
 * The question to the person, as a dialog of the main process (the page cannot answer it, and neither can the agent). Deny is
 * the default button and what Escape, closing the dialog and an aborted dialog (no answer in time) do.
 */
export async function confirmAgentOperation(window: BrowserWindow | null, request: ConfirmRequest, signal: AbortSignal): Promise<boolean> {
  const options = {
    type: "warning" as const,
    buttons: ["Allow", "Deny"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "AI agent request",
    message: `An AI agent wants to: ${request.message}`,
    detail: request.detail,
    signal,
  }
  window?.flashFrame(true)
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  return result.response === 0
}

export function registerAgentIpc(ipcMain: IpcMain, deps: AgentIpcDeps): void {
  const { page, controller, prepare } = deps
  const handle = (channel: string, handler: (...args: unknown[]) => unknown): void => handleResult(ipcMain, channel, page, handler)
  handle(Channels.agentGetState, () => controller.current)
  handle(Channels.agentSetEnabled, (enabled) => {
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean")
    return controller.setEnabled(enabled)
  })
  handle(Channels.agentDisconnect, () => controller.disconnectAgent())
  handle(Channels.agentPrepared, (id, error) => prepare.answer(id, error))
}
