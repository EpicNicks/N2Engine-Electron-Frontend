// The editor's layout once a project is open: the toolbar, then files | viewport over the console and scripts |
// hierarchy, inspector and engine, with splitters between them.
import { useEffect, useRef } from "preact/hooks"
import { signal } from "@preact/signals"
import { effect } from "@preact/signals-core"
import { ConsolePanel } from "./console-panel"
import { EnginePanel, FilesPanel, HierarchyPanel, InspectorPanel, ScriptEditor } from "./panels"
import { basename } from "./paths"
import { Splitter, useApp } from "./ui"
import { ViewportRenderer } from "./viewport-renderer"

// Panel sizes, in CSS pixels, kept for the session
const leftWidth = signal(220)
const rightWidth = signal(300)
const bottomHeight = signal(220)
/** The bottom panel's tab: the console, or an open script's path */
const bottomTab = signal<string>("console")

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

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
  const { store, scene } = useApp()
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
      {store.connected.value && !scene.sceneName.value && (
        <div class="viewport-hint">No scene loaded: open a .scene file from Files</div>
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
  const { store, scene } = useApp()

  // The panels follow the connection: a new connection is a new host, with nothing loaded yet
  useEffect(
    () =>
      effect(() => {
        if (store.connected.value) {
          scene.refreshScene().catch((e) => store.reportError("Failed to read the scene", e))
        } else {
          scene.reset()
        }
      }),
    []
  )
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
