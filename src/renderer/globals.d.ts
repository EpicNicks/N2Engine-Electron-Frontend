import type { EngineApi, ProjectApi } from "../shared/api"

// What the preload exposes (src/preload/preload.ts)
declare global {
  interface Window {
    engine: EngineApi
    project: ProjectApi
  }
}
