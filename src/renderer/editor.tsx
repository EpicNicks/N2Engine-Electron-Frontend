// The editor once a project is open: the toolbar, then the panels in their regions (layout/layout-view.tsx), by default
// assets | viewport over the console and text files | hierarchy, inspector and engine, with splitters between them.
import { useEffect, useMemo } from "preact/hooks"
import { ConnectionLostNotice } from "./connection-notices"
import { TextEditor } from "./assets-panel"
import { editActions, editMenuItems, isMacPlatform, isTextEntry, runEditAction } from "./edit-actions"
import { isDirty } from "./assets-state"
import { globalActionHandlers } from "./global-actions"
import { keymap } from "./keymap"
import { useKeymapActions } from "./keymap-hooks"
import { appPrefs } from "./prefs"
import { attachConsoleFilterPrefs } from "./console-filter-prefs"
import { attachHierarchyFilterPrefs } from "./hierarchy-filter-prefs"
import { attachViewportSnapPrefs, attachViewportToolPrefs } from "./viewport-tool-prefs"
import { builtinPanels } from "./layout/builtin-panels"
import { LayoutController } from "./layout/layout-controller"
import { DynamicPrefix } from "./layout/layout-model"
import { DynamicTab, EditorLayout, WindowButton } from "./layout/layout-view"
import { LayoutPersistence } from "./layout/layout-storage"
import { basename } from "./paths"
import { MenuItem, confirmDialog, modalOpen, showContextMenu, useApp } from "./ui"
import { GameEndedMessage } from "../shared/api"
import { followScene } from "./scene-follow"

/** The badge that says nothing can be changed (the host is read-only, or the user is a viewer); nothing otherwise */
export function ReadOnlyBadge() {
  const { store } = useApp()
  const reason = store.hostReadOnlyReason.value
  if (reason === null) return null
  return (
    <span class="read-only-badge" role="status" title={`This editor can't change anything: ${reason}`}>
      Read-only
    </span>
  )
}

/** Who the host says is connected and in what role ("alice (editor)"); nothing on a host that names no user */
export function UserBadge() {
  const { store } = useApp()
  const user = store.hostUser.value
  const role = store.hostRole.value
  if (user === "" || role === null) return null
  return (
    <span class="user-badge" role="status" title={`Signed in to the host as ${user}, with the ${role} role`}>
      {user} ({role})
    </span>
  )
}

/** New, Open, Save and Save As for the loaded scene */
export function SceneButtons() {
  const { store, assets } = useApp()
  const busy = store.busy.value !== null
  const connected = store.connected.value
  const loaded = store.scene.value
  // A read-only host refuses all four (they make, load or write a scene): disabled, not hidden
  const hostReadOnly = store.hostReadOnly.value
  const readOnlyTip = hostReadOnly ? `Not available: ${store.hostReadOnlyReason.value}` : undefined
  // A scene command may have made a file (the host's assetsChanged follows too)
  const done = (result: unknown) => {
    if (result) assets.refresh().catch((e) => store.reportError("Failed to list the assets", e))
  }

  const open = (e: MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    e.stopPropagation()
    const scenes = assets.scenes.value
    const items: MenuItem[] =
      scenes.length === 0
        ? [{ label: "No scenes in the project", action: () => {}, disabled: true }]
        : scenes.map((path) => ({
            label: path.toLowerCase() === loaded?.path.toLowerCase() ? `${path} (open)` : path,
            action: () => void store.openScene(path),
          }))
    showContextMenu(rect.left, rect.bottom, items)
  }

  return (
    <>
      <button
        onClick={() => store.newScene().then(done)}
        disabled={busy || !connected || hostReadOnly}
        title={readOnlyTip ?? "Make a new empty scene"}
      >
        New scene
      </button>
      <button
        onClick={open}
        disabled={busy || !connected || hostReadOnly}
        title={readOnlyTip ?? "Open a scene of the project"}
      >
        Open scene
      </button>
      <button
        onClick={() => store.saveScene().then(done)}
        disabled={busy || !loaded || hostReadOnly}
        title={readOnlyTip ?? "Save the scene (Ctrl+S)"}
      >
        Save scene
      </button>
      <button
        class="secondary"
        onClick={() => store.saveSceneAs().then(done)}
        disabled={busy || !loaded || hostReadOnly}
        title={readOnlyTip ?? "Save the scene to another file"}
      >
        Save as...
      </button>
    </>
  )
}

const mac = isMacPlatform(navigator.userAgent)

/** Play, Pause, Step and Stop (play mode: the game runs in a second host process) and what the game is doing */
function PlayButtons() {
  const { store, play } = useApp()
  const state = play.state.value
  const active = play.active.value
  const live = play.live.value
  const paused = play.paused.value
  const waiting = play.busy.value
  return (
    <>
      <button
        onClick={() => void play.start()}
        disabled={!play.canPlay.value}
        title={
          store.hostReadOnly.value
            ? `Not available: ${store.hostReadOnlyReason.value}`
            : store.remote.value
            ? "Play mode needs a local engine: it launches a second N2EditorHost on this machine, from the project's folder"
            : store.scene.value
            ? "Play the open scene as it is now, unsaved changes included, in a game of its own"
            : "Open a scene to play it"
        }
      >
        ▶ Play
      </button>
      <button
        class="secondary"
        onClick={() => void play.togglePause()}
        disabled={!live || waiting}
        title={paused ? "Resume the game" : "Pause the game"}
      >
        {paused ? "⏵ Resume" : "⏸ Pause"}
      </button>
      <button
        class="secondary"
        onClick={() => void play.step(1)}
        disabled={!paused || waiting}
        title="Run one frame of the paused game"
      >
        ⏭ Step
      </button>
      <button class="secondary" onClick={() => void play.stop()} disabled={!active && state.status === "stopped"} title="End the game">
        ⏹ Stop
      </button>
      {state.status !== "stopped" && (
        <span
          class={state.status === "exited" && state.message !== GameEndedMessage || state.status === "failed" ? "play-status warning" : "play-status"}
          title={state.message ?? undefined}
        >
          {play.text.value}
        </span>
      )}
    </>
  )
}

/** The Edit menu: Undo and Redo, once something registers them (edit-actions.ts); no button before */
function EditButton() {
  const { store } = useApp()
  const onError = (what: string, e: unknown) => store.reportError(what, e)
  // An autosave the user put off, or couldn't restore, can still be recovered from here
  const items: MenuItem[] = editMenuItems(editActions.value, onError, mac)
  if (items.length === 0) return null
  const outstanding = store.autosaveOutstanding.value
  const menuItems = (): MenuItem[] => [
    ...editMenuItems(editActions.value, onError, mac),
    ...(store.autosaveOutstanding.value
      ? [
          { separator: true } as MenuItem,
          {
            label: "Recover autosave...",
            action: () => void store.recoverAutosave(),
            disabled: !store.canWrite.value,
          },
        ]
      : []),
  ]
  return (
    <button
      class="secondary"
      title={outstanding ? "Undo and redo; an autosave is waiting for a decision" : "Undo and redo"}
      onClick={(e) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        e.stopPropagation()
        showContextMenu(rect.left, rect.bottom, menuItems())
      }}
    >
      {outstanding ? "Edit •" : "Edit"}
    </button>
  )
}

function Toolbar({ layout }: { layout: LayoutController }) {
  const { store, audio } = useApp()
  const host = store.host.value
  const busy = store.busy.value
  const running = host.status === "running" || host.status === "starting"
  const summary = store.hostSummary.value
  const info = store.serverInfo.value
  const title = info
    ? `N2Engine ${info.engineVersion}, protocol ${info.protocolVersion}` +
      (info.projectLoaded ? "" : " (the host has no project loaded)")
    : (host.message ?? "")

  return (
    <div class="toolbar">
      <span class="project-name" title={store.projectPath.value ?? undefined}>
        {store.projectName.value}
      </span>
      {store.scene.value && (
        <span
          class={store.sceneDirty.value ? "scene-name dirty" : "scene-name"}
          title={
            (store.scene.value.path || "The scene has no file yet") +
            (store.sceneDirty.value ? " (unsaved changes)" : "")
          }
        >
          {store.sceneLabel.value}
        </span>
      )}
      <UserBadge />
      <ReadOnlyBadge />
      <div class="separator" />
      <SceneButtons />
      <EditButton />
      <WindowButton controller={layout} />
      <div class="separator" />
      <PlayButtons />
      <div class="separator" />
      {/* A remote engine's host isn't the editor's to start, stop or restart: only the tunnel is */}
      {!store.remote.value && (
        <>
          <button onClick={() => store.restartHost()} disabled={busy !== null} title="Launch a new editor host">
            {running ? "Restart host" : "Start host"}
          </button>
          <button onClick={() => store.stopHost()} disabled={busy !== null || !running}>
            Stop host
          </button>
        </>
      )}
      <button
        class="secondary"
        onClick={() => store.closeProject()}
        disabled={busy !== null}
        title={store.remote.value ? "Closes the SSH tunnel; the remote host keeps running" : undefined}
      >
        {store.remote.value ? "Disconnect" : "Close project"}
      </button>
      <div class="separator" />
      <button onClick={() => audio.toggle()} title="Mute or unmute the engine's audio">
        {audio.buttonLabel.value}
      </button>
      <span class={audio.warning.value ? "audio-status warning" : "audio-status"} title={audio.status.value?.message}>
        {audio.text.value}
      </span>
      <span class={`status ${store.connected.value ? "connected" : host.status}`} title={title}>
        {busy ?? summary}
      </span>
    </div>
  )
}

export function Editor() {
  const { store, scene, hierarchy, inspector, assets, viewport } = useApp()

  // The panels follow the connection, the selection, the assets and the scene's changes (scene-follow.ts)
  useEffect(() => followScene({ store, scene, hierarchy, inspector, assets }), [])
  // The one keyboard dispatcher (keymap.ts), over the document; what the keys do is registered by the actions' owners
  // (here the scene's save, undo and redo; the panels register their own). A dialog open stops every shortcut.
  useEffect(() => {
    keymap.setMac(isMacPlatform(navigator.userAgent))
    const detachPrefs = keymap.attachPrefs(appPrefs().user)
    // The viewport's tool, space and pivot are remembered per user (the snap settings per project, below)
    const detachTool = attachViewportToolPrefs(viewport, appPrefs().user)
    const detach = keymap.install(document, { isModalOpen: modalOpen })
    return () => {
      detach()
      detachPrefs()
      detachTool()
    }
  }, [])
  useKeymapActions(globalActionHandlers({ store, hierarchy, inspector, assets }))
  useEffect(() => {
    // macOS: the application menu's Undo and Redo (the menu owns Cmd+Z there); a text field keeps its own undo
    window.editMenu.onCommand((command) => {
      const actions = editActions.value
      if (modalOpen()) return
      if (isTextEntry(document.activeElement as HTMLElement | null)) {
        document.execCommand(command)
      } else if (actions !== null) {
        void runEditAction(actions, command, (what, err) => store.reportError(what, err))
      }
    })
  }, [])
  useEffect(() => {
    return () => {
      scene.resetProject()
      assets.resetProject()
    }
  }, [store.projectPath.value])

  // The layout: where the panels are, remembered per project (layout/). The project's id comes from the host.
  const layout = useMemo(() => {
    const registry = builtinPanels()
    return new LayoutController(registry, new LayoutPersistence(appPrefs(), registry))
  }, [])
  useEffect(() => () => layout.dispose(), [layout])
  // The window closing or reloading does not unmount the tree: save what is waiting then
  useEffect(() => layout.flushOnUnload(window), [layout])
  useEffect(() => appPrefs().flushOnUnload(window), [])
  const connected = store.connected.value
  useEffect(() => {
    if (!connected) return
    let stale = false
    let detachFilters = () => {}
    window.engine.getProjectInfo().then(
      (info) => {
        if (stale || !isStorageKeyPart(info.project.projectId)) return
        layout.setProject(info.project.projectId)
        // The hierarchy search and the console's filters are remembered per project too
        const scope = appPrefs().project(info.project.projectId)
        const detachHierarchy = attachHierarchyFilterPrefs(hierarchy, scope)
        const detachConsole = attachConsoleFilterPrefs(store.console, scope)
        const detachSnap = attachViewportSnapPrefs(viewport, scope)
        detachFilters = () => {
          detachHierarchy()
          detachConsole()
          detachSnap()
        }
      },
      // Without the id the layout is the user default's and isn't remembered for this project
      (e) => console.error("Failed to get the project's id for the layout:", e)
    )
    return () => {
      stale = true
      detachFilters()
    }
  }, [connected, store.projectPath.value])

  // The open text files are tabs of the bottom region: opening one shows it, and closing the last unsaved one asks first
  const scripts = assets.tabs.value
  const activeScript = assets.activeTab.value
  const dynamic = scripts.map(
    (script): DynamicTab => ({
      id: DynamicPrefix + script.path,
      label: basename(script.path),
      title: script.path,
      dirty: isDirty(script),
      render: () => <TextEditor path={script.path} />,
      // Unsaved text is never closed without asking
      close: async () => {
        const tab = assets.tabs.value.find((t) => t.path === script.path)
        if (tab && isDirty(tab) && !(await confirmDialog(`${basename(script.path)} has unsaved changes.`, "Close without saving"))) {
          return
        }
        assets.closeText(script.path)
      },
      activate: () => {
        assets.activeTab.value = script.path
      },
    })
  )
  const dynamicKey = JSON.stringify(dynamic.map((t) => t.id))
  useEffect(() => layout.setDynamicTabs(dynamic.map((t) => t.id)), [dynamicKey])
  useEffect(() => {
    if (activeScript) layout.showDynamic(DynamicPrefix + activeScript)
  }, [activeScript])

  return (
    <div class="editor">
      <Toolbar layout={layout} />
      <ConnectionLostNotice />
      <EditorLayout controller={layout} dynamic={new Map(dynamic.map((t) => [t.id, t]))} />
    </div>
  )
}

/** A project id is a UUID; anything else isn't used to name a stored layout */
function isStorageKeyPart(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-zA-Z-]{1,64}$/.test(id)
}
