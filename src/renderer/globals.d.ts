import type { EditMenuApi, EngineApi, HostApi, PlayApi, ProjectApi } from "../shared/api"

// What the preload exposes (src/preload/preload.ts)
declare global {
  interface Window {
    engine: EngineApi
    host: HostApi
    play: PlayApi
    project: ProjectApi
    editMenu: EditMenuApi
  }
}
