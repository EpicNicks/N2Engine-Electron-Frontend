import type { EditMenuApi, PreferencesApi, EngineApi, HostApi, PlayApi, ProjectApi, RemoteApi } from "../shared/api"

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
  }
}
