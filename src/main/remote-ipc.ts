// Remote engine mode's IPC (frontend issue #21): connect to a host through an SSH tunnel, or at its own address with
// TLS pinned by fingerprint, and the recent remotes. The settings are validated by ProjectSession (parseRemoteSettings,
// parseDirectRemoteSettings) before anything is started; the token goes from the page's form to the engine connection
// and is never returned, saved or logged.
import { IpcMain } from "electron"
import { fetchPeerFingerprint } from "../protocol/tls-pin"
import { Channels, PinInspection, RemoteSettings } from "../shared/api"
import { parseDirectRemoteSettings } from "./direct-remote"
import { EditorPage, handleResult } from "./ipc"
import { PinStore, inspectPin } from "./pin-store"
import { ProjectSession } from "./project-session"
import { RecentRemotes } from "./recent-remotes"

/** A token is a hex string of 64 characters for a launched host; this is generous for what a person pastes */
const MaxTokenLength = 1024

export function registerRemoteIpc(
  ipcMain: IpcMain,
  deps: {
    page: EditorPage
    session: ProjectSession
    recent: RecentRemotes
    pins: Pick<PinStore, "get" | "forget">
    /** The fingerprint of the certificate a host presents (default: a TLS handshake that sends nothing) */
    fetchFingerprint?: (host: string, port: number) => Promise<string>
  },
): void {
  const { page, session, recent, pins } = deps
  const fetchFingerprint = deps.fetchFingerprint ?? fetchPeerFingerprint
  const handle = (channel: string, handler: (...args: unknown[]) => unknown): void =>
    handleResult(ipcMain, channel, page, handler)

  handle(Channels.remoteConnect, (settings, token) => {
    if (typeof token !== "string" || token.length > MaxTokenLength) throw new Error("Invalid access token")
    return session.connectRemote(settings, token)
  })
  handle(Channels.remoteConnectDirect, (settings, token) => {
    if (typeof token !== "string" || token.length > MaxTokenLength) throw new Error("Invalid access token")
    return session.connectDirect(settings, token)
  })
  handle(Channels.remoteInspectDirect, async (host, port): Promise<PinInspection> => {
    // Validated like a connect (as a TLS one: there is nothing to inspect without TLS)
    const { host: name, port: number } = parseDirectRemoteSettings({ host, port, tls: true })
    return inspectPin(pins, name, number, await fetchFingerprint(name, number))
  })
  handle(Channels.remoteForgetPin, (host, port) => {
    const { host: name, port: number } = parseDirectRemoteSettings({ host, port, tls: true })
    pins.forget(name, number)
  })
  handle(Channels.remoteGetRecent, (): RemoteSettings[] => recent.list())
  handle(Channels.remoteRemoveRecent, (settings) => recent.remove(settings as RemoteSettings))
}
