import type { AgentApi, EditMenuApi, PreferencesApi, EngineApi, HostApi, PlayApi, ProjectApi, RemoteApi, SystemClipboardApi } from "../shared/api"

// What the preload exposes (src/preload/preload.ts)
declare global {
  interface Window {
    preferences: PreferencesApi
    engine: EngineApi
    host: HostApi
    play: PlayApi
    project: ProjectApi
    remote: RemoteApi
    editMenu: EditMenuApi
    agent: AgentApi
    /** The system clipboard through the main process; absent outside Electron (system-clipboard.ts falls back) */
    systemClipboard?: SystemClipboardApi
  }
}
