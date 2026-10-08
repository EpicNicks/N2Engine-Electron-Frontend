// The page's entry point (bundled by esbuild into dist/bundle/renderer.js). The page is sandboxed: window.engine
// (the engine connection), window.host (the project's editor host process) and window.project (projects and their
// files) are the typed IPC API the preload exposes (src/shared/api.ts); there is no Node here.
import { render } from "preact"
import { effect } from "@preact/signals-core"
import { AudioController } from "./audio-controller"
import { Editor } from "./editor"
import { HierarchyState } from "./hierarchy-state"
import { InspectorState } from "./inspector-state"
import { SceneState } from "./scene-state"
import { EditorStore } from "./store"
import {
  AppContext,
  AppState,
  ConfirmDialog,
  ContextMenu,
  PromptDialog,
  UnsavedDialog,
  confirmDialog,
  prompt,
  unsavedDialog,
  useApp,
} from "./ui"
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
      <ConfirmDialog />
      <UnsavedDialog />
      <ContextMenu />
    </AppContext.Provider>
  )
}

const store = new EditorStore({
  engine: window.engine,
  host: window.host,
  project: window.project,
  dialogs: { prompt, confirm: confirmDialog, unsaved: unsavedDialog },
})
const scene = new SceneState(window.engine, window.project)
const app: AppState = {
  store,
  scene,
  // The hierarchy's primary selection is the inspector's object
  hierarchy: new HierarchyState(window.engine, {
    confirm: confirmDialog,
    onPrimaryChange: (id) => scene.select(id).catch((e) => store.reportError("Failed to read the transform", e)),
  }),
  inspector: new InspectorState(window.engine, window.project, {
    confirm: confirmDialog,
    // The file systems of Windows and macOS don't tell res:// paths apart by case
    caseInsensitivePaths: /Windows|Macintosh/i.test(navigator.userAgent),
    // An edit's refusal that arrives after the selection moved on: nobody is looking at the component any more
    onError: (what, e) => store.reportError(what, e),
  }),
  audio: new AudioController(window.engine),
}

// Closing or reloading the window with unsaved scene changes asks first (the main process shows the question)
window.addEventListener("beforeunload", (e) => {
  if (store.view.value === "editor" && store.sceneDirty.value) {
    e.preventDefault()
    e.returnValue = ""
  }
})

// The engine's audio plays while connected
effect(() => {
  if (store.connected.value) app.audio.start()
  else app.audio.stop()
})

render(<App app={app} />, document.getElementById("app")!)
store.load()
