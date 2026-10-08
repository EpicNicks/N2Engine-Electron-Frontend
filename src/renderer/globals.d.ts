import type { EditMenuApi, EngineApi, HostApi, ProjectApi } from "../shared/api"

// What the preload exposes (src/preload/preload.ts)
declare global {
  interface Window {
    engine: EngineApi
    host: HostApi
    project: ProjectApi
    editMenu: EditMenuApi
  }
}
