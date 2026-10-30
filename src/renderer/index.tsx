import { PreferencesDialog } from "./preferences-dialog"
// The page's entry point (bundled by esbuild into dist/bundle/renderer.js). The page is sandboxed: window.engine
// (the engine connection), window.host (the project's editor host process) and window.project (projects and their
// files) are the typed IPC API the preload exposes (src/shared/api.ts); there is no Node here.
import { render } from "preact"
import { computed, effect, untracked } from "@preact/signals-core"
import { AudioController } from "./audio-controller"
import { AgentModel, agentModel } from "./agent-state"
import { AssetsState, isDirty } from "./assets-state"
import { assetEntriesOf, nameOf } from "./asset-tree"
import { EditController } from "./edit-controller"
import { editActions } from "./edit-actions"
import { HistoryModel, historyModel } from "./history-state"
import { EditGroups } from "./edit-groups"
import { Editor } from "./editor"
import { HierarchyState } from "./hierarchy-state"
import { prefabOptions } from "./prefab-options"
import { systemClipboardOf } from "./system-clipboard"
import { emptySelection } from "./hierarchy-tree"
import { moveIdsOf } from "./viewport-selection"
import { applyMarquee, marqueeCandidatesOf } from "./viewport-marquee"
import { hostHasEditorTooling } from "../protocol/editor-tooling"
import { createPickBackend, hostHasPicking } from "./viewport-picking"
import { InspectorState } from "./inspector-state"
import { PlayController } from "./play-controller"
import { SceneState } from "./scene-state"
import { ViewportController } from "./viewport-controller"
import { EditorStore } from "./store"
import { ExtensionsState, runBlockedReason } from "./extensions-state"
import { FormDialog } from "./form-dialog"
import { followWriteGuard } from "./write-guard"
import { ipcError } from "../shared/api"
import {
  AppContext,
  AppState,
  AutosaveDialog,
  ConfirmDialog,
  ContextMenu,
  ErrorBanner,
  PromptDialog,
  ShortcutsDialog,
  UnsavedDialog,
  autosaveDialog,
  confirmDialog,
  dismissAutosaveDialog,
  formDialog,
  prompt,
  unsavedDialog,
  useApp,
} from "./ui"
import { Welcome } from "./welcome"

// ErrorBanner (the last failure: a host's denial too, with its own message) is in ui.tsx, where the DOM tests reach it

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
      <FormDialog />
      <UnsavedDialog />
      <AutosaveDialog />
      <ShortcutsDialog />
      <PreferencesDialog onSaved={tool => {
        app.viewport.setMode(tool.mode); app.viewport.setSpace(tool.space); app.viewport.setPivot(tool.pivot)
        void app.store.refreshHostLocation()
      }} />
      <ContextMenu />
    </AppContext.Provider>
  )
}

const store = new EditorStore({
  engine: window.engine,
  host: window.host,
  project: window.project,
  remote: window.remote,
  dialogs: { prompt, confirm: confirmDialog, unsaved: unsavedDialog, autosave: autosaveDialog, dismissAutosave: dismissAutosaveDialog },
})
// Edit groups make a drag, or an action on several objects, one undo step (a failure to end one is shown)
const groups = new EditGroups(window.engine, (what, e) => store.reportError(what, e))
const scene = new SceneState()
// The assets panel: the host's listing, import settings and text files (a save's reload errors are read from the log)
const assets = new AssetsState(
  window.engine,
  { mark: () => store.console.lastEntryId, poll: () => store.console.pollNow() },
  (what, e) => store.reportError(what, e),
  // The host refuses the asset writers during a play session, and always when it is read-only
  () => store.readOnlyReason.peek(),
  // Previews need GetAssetPreview (protocol 1.17.0)
  () => store.connected.peek() && hostHasEditorTooling(store.serverInfo.peek()?.protocolVersion)
)
const hierarchy = new HierarchyState(window.engine, {
  confirm: confirmDialog,
  // The hierarchy's primary selection is the inspector's object (and the viewport's gizmo)
  onPrimaryChange: (id) => scene.select(id).catch((e) => store.reportError("Failed to select the object", e)),
  groups,
  // Copy and paste also go through the system clipboard, so a paste can come from another window or project (in Electron
  // through the main process: the page's navigator.clipboard is refused there)
  clipboard: systemClipboardOf(window),
  // Prefab assets (protocol 1.19.0): offered when the host has the prefabAssets capability
  prefabs: prefabOptions(store, assets, {
    // The file systems of Windows and macOS don't tell res:// paths apart by case
    caseInsensitivePaths: /Windows|Macintosh/i.test(navigator.userAgent),
    onError: (what, e) => store.reportError(what, e),
  }),
})
// The viewport: the editor camera, the translate gizmo (an edit group per drag), frame selected, click to select and
// the selection box (the engine's PickEntity and GetEntityBounds)
const viewport = new ViewportController({
  engine: window.engine,
  groups,
  picking: createPickBackend(window.engine),
  // No scene open, or a host from before protocol 1.8.0: a click asks nothing (and raises no error)
  // Wireframe is for the editor view: a host from before protocol 1.17.0 has no such command
  canViewOptions: () => store.connected.peek() && hostHasEditorTooling(store.serverInfo.peek()?.protocolVersion),
  canPick: () => store.scene.peek() !== null && hostHasPicking(store.serverInfo.peek()?.protocolVersion),
  onError: (what, e) => store.reportError(what, e),
  onNote: (message) => store.console.note("warn", message),
  canEdit: () => store.canEdit.peek(),
  sceneKey: () => store.scene.peek()?.uuid ?? "",
  selected: () => hierarchy.selection.peek().primary,
  // The gizmo moves the topmost of the selection (what is under a selected object moves with it), all in one group
  moveIds: () => moveIdsOf(hierarchy.tree.peek(), hierarchy.selection.peek()),
  selectionIds: () => [...hierarchy.selection.peek().ids],
  // A click in the viewport selects like a click on the hierarchy's row (Ctrl toggles, Shift extends)
  select: (id, modifiers) => hierarchy.pick(id, modifiers),
  // A marquee over the view: the hierarchy's active objects as the host last listed them, and the selection they change
  marqueeCandidates: () => {
    const response = hierarchy.response.peek()
    return response ? { revision: response.revision, ids: marqueeCandidatesOf(hierarchy.tree.peek()) } : null
  },
  selectMany: (ids, op) => applyMarquee(hierarchy, ids, op),
})
// Play mode: the game runs in a second host process; while it does, the scene is read-only and the viewport, the audio
// and the console are the game's
const play = new PlayController({
  api: window.play,
  stats: store.clientStats,
  setPlayMode: (reason) => store.setPlayMode(reason),
  // As Ctrl+S does: a rename and the inspector's debounced edits are sent first, so the game is of the latest
  settle: async () => {
    await hierarchy.renameSettled
    await app.inspector.flush()
  },
  // Not on a remote engine: a game is a second host process on this machine
  canStart: () => !store.remote.value && !store.hostReadOnly.value && store.connected.value && store.scene.value !== null && store.busy.value === null,
  addLog: (entries) => store.console.addEntries(entries),
  note: (level, message) => store.console.note(level, message),
  onError: (what, e) => store.reportError(what, e),
})
store.unsavedFiles = () => assets.tabs.value.filter(isDirty).map((tab) => nameOf(tab.path))

// What is on its way is sent, and what is running is waited for, before an undo or an extension's menu item runs
const settleEdits = async () => {
  await hierarchy.renameSettled
  await hierarchy.actionSettled
  await app.inspector.flush()
  await app.inspector.gestureEnded
  // A gizmo drag in progress is finished first: the host refuses Undo, Redo and menu items while its group is open
  await app.viewport.endActiveDrag()
}

// The host's Lua editor extensions: the Tools menu, running an item (one undo step) and the admin list. The code runs on
// the host; the page only shows its data.
const extensions = new ExtensionsState({
  engine: window.engine,
  connected: store.connected,
  serverInfo: store.serverInfo,
  changeCount: store.extensionsChangeCount,
  role: store.hostRole,
  blockedReason: () =>
    runBlockedReason({
      connected: store.connected.peek(),
      hasScene: store.scene.peek() !== null,
      busy: store.busy.peek(),
      readOnlyReason: store.readOnlyReason.peek(),
    }),
  openGroups: groups.openCount,
  selection: () => [...hierarchy.selection.peek().ids],
  componentsOf: (id) => hierarchy.tree.peek().nodes.get(id)?.components,
  run: {
    settle: settleEdits,
    closeGroups: () => groups.closeAll(),
    confirm: confirmDialog,
    askForm: async (item) => (item.form === undefined ? {} : formDialog(item.title, item.form, "Run")),
    syncAfterEdit: () => store.syncAfterEdit(),
    applyEdit: (edit) => store.applyEditResult(edit),
    // The objects an item made are in the hierarchy only once it has been read again
    applySelection: async (ids) => {
      await hierarchy.refresh()
      hierarchy.selectIds(ids)
    },
    note: (level, message) => store.console.note(level, message),
    // A refusal carries the host's code, so a readOnly one also marks the host read-only, as every other denial does
    fail: (what, message, code) => store.reportError(`Tools, ${what}`, ipcError({ error: message, code })),
  },
})
const app: AppState = {
  store,
  scene,
  assets,
  hierarchy,
  viewport,
  // The asset fields choose from the assets panel's listing (the host's ListAssets), parts of models included
  inspector: new InspectorState(
    window.engine,
    { listAssets: async () => assetEntriesOf(await assets.current()) },
    {
      confirm: confirmDialog,
      // The file systems of Windows and macOS don't tell res:// paths apart by case
      caseInsensitivePaths: /Windows|Macintosh/i.test(navigator.userAgent),
      // An edit's refusal that arrives after the selection moved on: nobody is looking at the component any more
      onError: (what, e) => store.reportError(what, e),
      groups,
      // A refusal in the middle of an edit of several objects takes the edit back, as the Undo menu would
      undo: () => editController.undo(),
    }
  ),
  audio: new AudioController(window.engine),
  play,
  extensions,
}

// Undo and redo (Edit menu, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y): the host's history, after the editor's own pending edits
const editController = new EditController({
  engine: window.engine,
  groups,
  history: store.history,
  enabled: () => store.canEdit.value,
  // What is on its way is sent, and what is running is waited for, before Undo ends the groups that are left
  settle: settleEdits,
  refreshHistory: () => store.refreshHistory(),
  syncAfterEdit: () => store.syncAfterEdit(),
  applyResult: (result) => store.applyEditResult(result),
})
editActions.value = editController
// The history panel: the host's history with jumps (sequential undo and redo)
historyModel.value = new HistoryModel({
  getHistory: () => window.engine.getHistory(),
  status: store.history,
  connected: store.connected,
  readOnlyReason: store.readOnlyReason,
  canEdit: store.canEdit,
  openGroups: groups.openCount,
  revisions: computed(() => store.scene.value),
  jump: (target, options) => editController.jumpTo(target, options),
  timers: window,
})
// An AI agent working through the editor (MCP6): before its first call the page settles as for Undo, and after its changes
// it looks at the host again; the switch and the banner are in the toolbar. The Edit menu (macOS) names the steps.
agentModel.value = new AgentModel(window.agent, (what, e) => store.reportError(what, e))
window.agent.onBeforeCall(async () => {
  await settleEdits()
  await groups.closeAll()
})
window.agent.onAfterCall(() => {
  store.syncAfterEdit().catch((e) => store.reportError("Failed to look at the AI agent's changes", e))
})
effect(() => {
  const status = store.history.value
  window.editMenu
    .setLabels({ undo: status.canUndo ? status.label : "", redo: status.canRedo ? status.redoLabel : "" })
    .catch((e) => console.error("Failed to update the Edit menu:", e))
})
// A play session, or a read-only host, makes the inspector and the hierarchy read-only (the host refuses edits)
followWriteGuard(store, { inspector: app.inspector, hierarchy })
// The extension list and the Tools menu follow the connection and the host's extensionsChanged events
extensions.start()
// The host ends the groups of a connection that closes (and at the next Hello): none is open on another connection
effect(() => {
  store.connected.value // what this runs on
  groups.reset()
})

// Closing or reloading the window with unsaved scene changes asks first (the main process shows the question)
window.addEventListener("beforeunload", (e) => {
  if (store.view.value === "editor" && (store.sceneDirty.value || store.unsavedFiles().length > 0)) {
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
