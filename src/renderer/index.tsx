// The page's entry point (bundled by esbuild into dist/bundle/renderer.js). The page is sandboxed: window.engine
// (the engine connection), window.host (the project's editor host process) and window.project (projects and their
// files) are the typed IPC API the preload exposes (src/shared/api.ts); there is no Node here.
import { render } from "preact"
import { effect, untracked } from "@preact/signals-core"
import { AudioController } from "./audio-controller"
import { EditController } from "./edit-controller"
import { editActions } from "./edit-actions"
import { EditGroups } from "./edit-groups"
import { Editor } from "./editor"
import { HierarchyState } from "./hierarchy-state"
import { emptySelection } from "./hierarchy-tree"
import { moveIdsOf } from "./viewport-selection"
import { createPickBackend, hostHasPicking } from "./viewport-picking"
import { InspectorState } from "./inspector-state"
import { PlayController } from "./play-controller"
import { SceneState } from "./scene-state"
import { ViewportController } from "./viewport-controller"
import { EditorStore } from "./store"
import {
  AppContext,
  AppState,
  AutosaveDialog,
  ConfirmDialog,
  ContextMenu,
  PromptDialog,
  UnsavedDialog,
  autosaveDialog,
  confirmDialog,
  dismissAutosaveDialog,
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
      <AutosaveDialog />
      <ContextMenu />
    </AppContext.Provider>
  )
}

const store = new EditorStore({
  engine: window.engine,
  host: window.host,
  project: window.project,
  dialogs: { prompt, confirm: confirmDialog, unsaved: unsavedDialog, autosave: autosaveDialog, dismissAutosave: dismissAutosaveDialog },
})
// Edit groups make a drag, or an action on several objects, one undo step (a failure to end one is shown)
const groups = new EditGroups(window.engine, (what, e) => store.reportError(what, e))
const scene = new SceneState(window.engine, window.project)
const hierarchy = new HierarchyState(window.engine, {
  confirm: confirmDialog,
  // The hierarchy's primary selection is the inspector's object (and the viewport's gizmo)
  onPrimaryChange: (id) => scene.select(id).catch((e) => store.reportError("Failed to read the transform", e)),
  groups,
})
// The viewport: the editor camera, the translate gizmo (an edit group per drag), frame selected, click to select and
// the selection box (the engine's PickEntity and GetEntityBounds)
const viewport = new ViewportController({
  engine: window.engine,
  groups,
  picking: createPickBackend(window.engine),
  // No scene open, or a host from before protocol 1.8.0: a click asks nothing (and raises no error)
  canPick: () => store.scene.peek() !== null && hostHasPicking(store.serverInfo.peek()?.protocolVersion),
  onError: (what, e) => store.reportError(what, e),
  onNote: (message) => store.console.note("warn", message),
  canEdit: () => store.canEdit.peek(),
  selected: () => hierarchy.selection.peek().primary,
  // The gizmo moves the topmost of the selection (what is under a selected object moves with it), all in one group
  moveIds: () => moveIdsOf(hierarchy.tree.peek(), hierarchy.selection.peek()),
  selectionIds: () => [...hierarchy.selection.peek().ids],
  // A click in the viewport selects like a click on the hierarchy's row (Ctrl toggles, Shift extends)
  select: (id, modifiers) => hierarchy.pick(id, modifiers),
})
// Play mode: the game runs in a second host process; while it does, the scene is read-only and the viewport, the audio
// and the console are the game's
const play = new PlayController({
  api: window.play,
  setPlayMode: (reason) => store.setPlayMode(reason),
  canStart: () => store.connected.value && store.scene.value !== null && store.busy.value === null,
  addLog: (entries) => store.console.addEntries(entries),
  note: (level, message) => store.console.note(level, message),
  onError: (what, e) => store.reportError(what, e),
})
const app: AppState = {
  store,
  scene,
  hierarchy,
  viewport,
  inspector: new InspectorState(window.engine, window.project, {
    confirm: confirmDialog,
    // The file systems of Windows and macOS don't tell res:// paths apart by case
    caseInsensitivePaths: /Windows|Macintosh/i.test(navigator.userAgent),
    // An edit's refusal that arrives after the selection moved on: nobody is looking at the component any more
    onError: (what, e) => store.reportError(what, e),
    groups,
  }),
  audio: new AudioController(window.engine),
  play,
}

// Undo and redo (Edit menu, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y): the host's history, after the editor's own pending edits
editActions.value = new EditController({
  engine: window.engine,
  groups,
  history: store.history,
  enabled: () => store.canEdit.value,
  // What is on its way is sent, and what is running is waited for, before Undo ends the groups that are left
  settle: async () => {
    await app.hierarchy.renameSettled
    await app.hierarchy.actionSettled
    await app.inspector.flush()
    await app.inspector.gestureEnded
    // A gizmo drag in progress is finished first: Undo is refused while its group is open
    await app.viewport.endActiveDrag()
  },
  refreshHistory: () => store.refreshHistory(),
  syncAfterEdit: () => store.syncAfterEdit(),
  applyResult: (result) => store.applyEditResult(result),
})
// A play session makes the inspector read-only too (the host refuses edits then)
effect(() => app.inspector.setReadOnly(store.playMode.value))
effect(() => hierarchy.setReadOnly(store.playMode.value))
// The host ends the groups of a connection that closes (and at the next Hello): none is open on another connection
effect(() => {
  store.connected.value // what this runs on
  groups.reset()
})

// Closing or reloading the window with unsaved scene changes asks first (the main process shows the question)
window.addEventListener("beforeunload", (e) => {
  if (store.view.value === "editor" && store.sceneDirty.value) {
    e.preventDefault()
    e.returnValue = ""
  }
})

// The engine's audio plays while connected, and the game's while a game is live
effect(() => {
  if (store.connected.value) app.audio.start()
  else app.audio.stop()
})
effect(() => {
  const live = play.live.value
  untracked(() => app.audio.useGame(live ? window.play : null))
})

render(<App app={app} />, document.getElementById("app")!)
store.load()
