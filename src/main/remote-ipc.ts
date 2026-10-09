// Remote engine mode's IPC (frontend issue #21): connect to a host through an SSH tunnel, and the recent remotes. The
// settings are validated by ProjectSession (parseRemoteSettings) before anything is started; the token goes from the
// page's form to the engine connection and is never returned, saved or logged.
import { IpcMain } from "electron"
import { Channels, RemoteSettings } from "../shared/api"
import { EditorPage, handleResult } from "./ipc"
import { ProjectSession } from "./project-session"
import { RecentRemotes } from "./recent-remotes"

/** A token is a hex string of 64 characters for a launched host; this is generous for what a person pastes */
const MaxTokenLength = 1024

export function registerRemoteIpc(
  ipcMain: IpcMain,
  deps: { page: EditorPage; session: ProjectSession; recent: RecentRemotes },
): void {
  const { page, session, recent } = deps
  const handle = (channel: string, handler: (...args: unknown[]) => unknown): void =>
    handleResult(ipcMain, channel, page, handler)

  handle(Channels.remoteConnect, (settings, token) => {
    if (typeof token !== "string" || token.length > MaxTokenLength) throw new Error("Invalid access token")
    return session.connectRemote(settings, token)
  })
  handle(Channels.remoteGetRecent, (): RemoteSettings[] => recent.list())
  handle(Channels.remoteRemoveRecent, (settings) => recent.remove(settings as RemoteSettings))
}
