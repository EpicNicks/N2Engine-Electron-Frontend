import type { IpcMain } from "electron"
import { Channels } from "../shared/api"
import type { HostSettings } from "./host-settings"
import { handleResult, type EditorPage } from "./ipc"

export function registerPreferencesIpc(ipc: IpcMain, deps: {
  page: EditorPage; settings: HostSettings; chooseHostPath(): Promise<string | null>
}): void {
  handleResult(ipc, Channels.preferencesGetHost, deps.page, () => deps.settings.preferences())
  handleResult(ipc, Channels.preferencesSaveHost, deps.page, value => deps.settings.savePreferences(value))
  handleResult(ipc, Channels.preferencesChooseHost, deps.page, () => deps.chooseHostPath())
}
