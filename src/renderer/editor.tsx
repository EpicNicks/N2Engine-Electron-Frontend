// The editor's layout once a project is open: the toolbar, then files | viewport over the console and scripts |
// hierarchy, inspector and engine, with splitters between them.
import { useEffect, useRef } from "preact/hooks"
import { signal } from "@preact/signals"
import { effect } from "@preact/signals-core"
import { ConsolePanel } from "./console-panel"
import { editActions, editMenuItems, editShortcutOf, isMacPlatform, isTextEntry, runEditAction } from "./edit-actions"
import { HierarchyPanel } from "./hierarchy-panel"
import { InspectorPanel } from "./inspector-panel"
import { EnginePanel, FilesPanel, ScriptEditor } from "./panels"
import { basename, toResPath } from "./paths"
import { MenuItem, Splitter, modalOpen, showContextMenu, useApp } from "./ui"
import type { FileInfo } from "../shared/api"
import { followScene } from "./scene-follow"
import { ViewportRenderer } from "./viewport-renderer"

// Panel sizes, in CSS pixels, kept for the session
const leftWidth = signal(220)
const rightWidth = signal(300)
const bottomHeight = signal(220)
/** The bottom panel's tab: the console, or an open script's path */
const bottomTab = signal<string>("console")

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** The scene files in a file tree, as res:// paths */
function sceneFiles(projectPath: string, files: readonly FileInfo[]): string[] {
  const found: string[] = []
  for (const file of files) {
    if (file.isDirectory) found.push(...sceneFiles(projectPath, file.children ?? []))
    else if (file.name.toLowerCase().endsWith(".scene")) {
      const path = toResPath(projectPath, file.path)
      if (path !== null) found.push(path)
    }
  }
  return found
}

/** New, Open, Save and Save As for the loaded scene */
function SceneButtons() {
  const { store, scene } = useApp()
  const busy = store.busy.value !== null
  const connected = store.connected.value
  const loaded = store.scene.value
  // A scene command may have made a file
  const done = (result: unknown) => {
    if (result) scene.refreshFiles().catch((e) => store.reportError("Failed to list files", e))
  }

  const open = (e: MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    e.stopPropagation()
    const scenes = sceneFiles(store.projectPath.value ?? "", scene.files.value)
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
      <button onClick={() => store.newScene().then(done)} disabled={busy || !connected} title="Make a new empty scene">
        New scene
      </button>
      <button onClick={open} disabled={busy || !connected} title="Open a scene of the project">
        Open scene
      </button>
      <button onClick={() => store.saveScene().then(done)} disabled={busy || !loaded} title="Save the scene (Ctrl+S)">
        Save scene
      </button>
      <button
        class="secondary"
        onClick={() => store.saveSceneAs().then(done)}
        disabled={busy || !loaded}
        title="Save the scene to another file"
      >
        Save as...
      </button>
    </>
  )
}

const mac = isMacPlatform(navigator.userAgent)

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
          { label: "Recover autosave...", action: () => void store.recoverAutosave() },
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

function Toolbar() {
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
      <div class="separator" />
      <SceneButtons />
      <EditButton />
      <div class="separator" />
      <button onClick={() => store.restartHost()} disabled={busy !== null} title="Launch a new editor host">
        {running ? "Restart host" : "Start host"}
      </button>
      <button onClick={() => store.stopHost()} disabled={busy !== null || !running}>
        Stop host
      </button>
      <button class="secondary" onClick={() => store.closeProject()} disabled={busy !== null}>
        Close project
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

function Viewport() {
  const { store } = useApp()
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    // A failed frame stops the loop until the next connection; usually the connection just dropped, so it's a
    // console line rather than an error banner
    const renderer = new ViewportRenderer(canvas.current!, container.current!, window.engine, (e) =>
      store.console.note("error", `Rendering stopped: ${e instanceof Error ? e.message : String(e)}`)
    )
    const stop = effect(() => {
      if (store.connected.value) renderer.start()
      else renderer.stop()
    })
    return () => {
      stop()
      renderer.dispose()
    }
  }, [])

  return (
    <div class="viewport-container" ref={container}>
      <canvas class="viewport" ref={canvas} width={800} height={600} />
      {!store.connected.value && <div class="viewport-overlay">{store.busy.value ?? store.hostSummary.value}</div>}
      {store.connected.value && !store.scene.value && (
        <div class="viewport-hint">No scene loaded: open one with Open scene, or make one with New scene</div>
      )}
    </div>
  )
}

function BottomPanel() {
  const { scene } = useApp()
  const scripts = scene.scripts.value
  const active = scene.activeScript.value
  // Opening a script shows it
  useEffect(() => {
    if (active) bottomTab.value = active
  }, [active])
  const tab =
    bottomTab.value === "console" || scripts.some((s) => s.path === bottomTab.value) ? bottomTab.value : "console"

  return (
    <div class="bottom-panel" style={{ height: `${bottomHeight.value}px` }}>
      <div class="tab-bar" role="tablist">
        <div
          class={tab === "console" ? "tab active" : "tab"}
          role="tab"
          aria-selected={tab === "console"}
          onClick={() => (bottomTab.value = "console")}
        >
          Console
        </div>
        {scripts.map((script) => (
          <div
            class={tab === script.path ? "tab active" : "tab"}
            role="tab"
            aria-selected={tab === script.path}
            title={script.path}
            key={script.path}
            onClick={() => {
              scene.activeScript.value = script.path
              bottomTab.value = script.path
            }}
          >
            <span>
              {basename(script.path)}
              {script.dirty ? " •" : ""}
            </span>
            <span
              class="close"
              aria-label={`Close ${basename(script.path)}`}
              onClick={(e) => {
                e.stopPropagation()
                scene.closeScript(script.path)
              }}
            >
              ×
            </span>
          </div>
        ))}
      </div>
      {tab === "console" ? <ConsolePanel /> : <ScriptEditor path={tab} />}
    </div>
  )
}

export function Editor() {
  const { store, scene, hierarchy, inspector } = useApp()

  // The panels follow the connection, the selection, the assets and the scene's changes (scene-follow.ts)
  useEffect(() => followScene({ store, scene, hierarchy, inspector }), [])
  // Ctrl+S saves the scene (the script editor handles the key first, for its file)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "s")
        return
      e.preventDefault()
      // Not under a dialog (its own field's key), and not twice at once
      if (modalOpen() || (e.target as HTMLElement | null)?.closest?.(".modal")) return
      if (!store.scene.value || store.busy.value !== null) return
      // A name or a value being typed is committed first, so the saved scene has it
      const target = e.target as HTMLElement | null
      if (target?.classList?.contains("hierarchy-rename") || target?.closest?.(".inspector-panel")) target.blur()
      // And what the inspector edited a moment ago is sent
      void hierarchy.renameSettled
        .then(() => inspector.flush())
        .then(() => store.saveScene())
        .then((saved) => saved && scene.refreshFiles().catch(() => {}))
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
  // Undo and redo (E6, edit-actions.ts): nothing is registered yet. A text field keeps its own undo.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const shortcut = editShortcutOf(e)
      const actions = editActions.value
      if (e.defaultPrevented || shortcut === null || actions === null || modalOpen()) return
      // Only a field that takes text has its own undo; a checkbox, a slider or a select hasn't
      if (isTextEntry(e.target as HTMLElement | null)) return
      e.preventDefault()
      // A held key repeats: one undo is running and one is waiting, which is enough
      if (e.repeat && actions.busy?.()) return
      void runEditAction(actions, shortcut, (what, err) => store.reportError(what, err))
    }
    window.addEventListener("keydown", onKeyDown)
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
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
  useEffect(() => {
    scene.refreshFiles().catch((e) => store.reportError("Failed to list files", e))
    return () => scene.resetProject()
  }, [store.projectPath.value])

  return (
    <div class="editor">
      <Toolbar />
      <div class="main-container">
        <aside class="left-panel" style={{ width: `${leftWidth.value}px` }}>
          <FilesPanel />
        </aside>
        <Splitter direction="vertical" onDrag={(dx) => (leftWidth.value = clamp(leftWidth.value + dx, 150, 500))} />
        <div class="center-panel">
          <Viewport />
          <Splitter
            direction="horizontal"
            onDrag={(dy) => (bottomHeight.value = clamp(bottomHeight.value - dy, 80, 700))}
          />
          <BottomPanel />
        </div>
        <Splitter direction="vertical" onDrag={(dx) => (rightWidth.value = clamp(rightWidth.value - dx, 200, 600))} />
        <aside class="right-panel" style={{ width: `${rightWidth.value}px` }}>
          <HierarchyPanel />
          <InspectorPanel />
          <EnginePanel />
        </aside>
      </div>
    </div>
  )
}
