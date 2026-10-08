// The page's entry point (bundled by esbuild into dist/bundle/renderer.js). The page is sandboxed: window.engine
// (the engine connection), window.host (the project's editor host process) and window.project (projects and their
// files) are the typed IPC API the preload exposes (src/shared/api.ts); there is no Node here.
import { render } from "preact"
import { effect } from "@preact/signals-core"
import { AudioController } from "./audio-controller"
import { Editor } from "./editor"
import { SceneState } from "./scene-state"
import { EditorStore } from "./store"
import { AppContext, AppState, ContextMenu, PromptDialog, useApp } from "./ui"
import { Welcome } from "./welcome"

function ErrorBanner() {
  const { store } = useApp()
  const error = store.error.value
  if (!error) return null
  return (
    <div class="error-banner" role="alert">
      <pre>{error}</pre>
      <button class="secondary" onClick={() => store.dismissError()} aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}

function BusyOverlay() {
  const { store } = useApp()
  // Only on the welcome screen: the editor shows it in the toolbar and the viewport
  if (store.view.value !== "welcome" || !store.busy.value) return null
  return (
    <div class="busy-overlay" aria-live="polite">
      <div class="busy-box">{store.busy.value}</div>
    </div>
  )
}

function App({ app }: { app: AppState }) {
  return (
    <AppContext.Provider value={app}>
      {app.store.view.value === "welcome" ? <Welcome /> : <Editor />}
      <ErrorBanner />
      <BusyOverlay />
      <PromptDialog />
      <ContextMenu />
    </AppContext.Provider>
  )
}

const store = new EditorStore({ engine: window.engine, host: window.host, project: window.project })
const app: AppState = {
  store,
  scene: new SceneState(window.engine, window.project),
  audio: new AudioController(window.engine),
}

// The engine's audio plays while connected
effect(() => {
  if (store.connected.value) app.audio.start()
  else app.audio.stop()
})

render(<App app={app} />, document.getElementById("app")!)
store.load()
