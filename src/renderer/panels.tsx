// The editor's panels other than the hierarchy (hierarchy-panel.tsx) and the console: the project's files, the
// inspector (world transform), the engine's health and the script editor. F4-F6 rebuild them on the #6 protocol.
import { useEffect, useState } from "preact/hooks"
import type { EngineHealthResponse, Vec3 } from "../protocol/protocol.generated"
import type { FileInfo } from "../shared/api"
import { basename, extname, toResPath } from "./paths"
import { Empty, Panel, prompt, showContextMenu, useApp } from "./ui"

// ==================== Files ====================

function fileIcon(name: string): string {
  switch (extname(name)) {
    case ".lua":
      return "📜"
    case ".json":
      return "⚙️"
    case ".scene":
      return "🎬"
    default:
      return "📄"
  }
}

function FileNode({ node, depth }: { node: FileInfo; depth: number }) {
  const { store, scene } = useApp()
  const collapsed = scene.collapsed.value.has(node.path)
  const indent = { paddingLeft: `${depth * 12 + 6}px` }
  const fail = (what: string) => (e: unknown) => store.reportError(what, e)

  if (node.isDirectory) {
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      showContextMenu(e.clientX, e.clientY, [
        {
          label: "New Scene",
          action: async () => {
            if (!store.connected.value) return store.reportError("New scene", "Not connected to the editor host")
            // In the folder it was asked on, when that is inside assets
            const folder = toResPath(store.projectPath.value ?? "", node.path)
            const made = await store.newScene(folder ? `${folder.replace(/\/$/, "")}/Untitled.scene` : undefined)
            if (made) scene.refreshFiles().catch(fail("Failed to list files"))
          },
        },
        {
          label: "New Script",
          action: async () => {
            if (!store.connected.value) return store.reportError("New script", "Not connected to the editor host")
            const name = await prompt("New script", "NewScript")
            if (name) scene.createScript(node.path, name).catch(fail("Failed to create the script"))
          },
        },
      ])
    }
    return (
      <>
        <div
          class="file-item"
          style={indent}
          title={node.path}
          onClick={() => scene.toggleFolder(node.path)}
          onContextMenu={onContextMenu}
        >
          <span class="arrow">{collapsed ? "▸" : "▾"}</span>
          <span class="icon">📁</span>
          <span>{node.name}</span>
        </div>
        {!collapsed && node.children?.map((child) => <FileNode node={child} depth={depth + 1} key={child.path} />)}
      </>
    )
  }

  const ext = extname(node.name)
  const open = () => {
    if (ext === ".scene") {
      if (!store.connected.value) return store.reportError("Open scene", "Not connected to the editor host")
      const path = toResPath(store.projectPath.value ?? "", node.path)
      if (path === null)
        return store.reportError("Open scene", "Only scenes inside the project's assets folder can be opened")
      void store.openScene(path)
    } else if (ext === ".lua" || ext === ".json" || ext === ".txt") {
      scene.openScript(node.path).catch(fail("Failed to open the file"))
    }
  }
  return (
    <div class="file-item" style={indent} title={node.path} onClick={open}>
      <span class="arrow" />
      <span class="icon">{fileIcon(node.name)}</span>
      <span>{node.name}</span>
    </div>
  )
}

export function FilesPanel() {
  const { store, scene } = useApp()
  const files = scene.files.value
  return (
    <Panel
      title="Files"
      icon="📁"
      actions={
        <button onClick={() => scene.refreshFiles().catch((e) => store.reportError("Failed to list files", e))}>
          Refresh
        </button>
      }
    >
      <div class="file-tree">
        {files.length === 0 ? (
          <Empty>No files</Empty>
        ) : (
          files.map((node) => <FileNode node={node} depth={0} key={node.path} />)
        )}
      </div>
    </Panel>
  )
}

// ==================== Inspector ====================

function VectorRow(props: { label: string; value: Vec3; step: number; onChange: (value: Vec3) => void }) {
  return (
    <div class="inspector-row">
      <label>{props.label}</label>
      <div class="vector-inputs">
        {(["x", "y", "z"] as const).map((axis) => (
          <input
            key={axis}
            type="number"
            step={props.step}
            aria-label={`${props.label} ${axis}`}
            value={props.value[axis].toFixed(2)}
            onChange={(e) => {
              const n = parseFloat((e.currentTarget as HTMLInputElement).value)
              if (Number.isFinite(n)) props.onChange({ ...props.value, [axis]: n })
            }}
          />
        ))}
      </div>
    </div>
  )
}

export function InspectorPanel() {
  const { store, scene, hierarchy } = useApp()
  const selected = scene.selectedId.value
  const transform = scene.transform.value
  const entity = selected ? hierarchy.tree.value.nodes.get(selected) : undefined

  let content
  if (!selected || !store.connected.value) content = <Empty>Select an entity to inspect</Empty>
  else if (!transform && !scene.noTransform.value) content = <Empty>Loading...</Empty>
  else {
    const set = (change: Partial<NonNullable<typeof transform>>) =>
      transform &&
      scene.setTransform({ ...transform, ...change }).catch((e) => store.reportError("Failed to set the transform", e))
    const selectedCount = hierarchy.selection.value.ids.size
    content = (
      <>
        <div class="inspector-section">
          <h4>Entity</h4>
          <div class="inspector-row">
            <label>Name</label>
            <input type="text" value={entity?.name ?? ""} readOnly />
          </div>
        </div>
        {transform ? (
          <div class="inspector-section">
            <h4>Transform</h4>
            <VectorRow
              label="Position"
              value={transform.position}
              step={0.1}
              onChange={(position) => set({ position })}
            />
            <VectorRow
              label="Rotation"
              value={transform.rotation}
              step={1}
              onChange={(rotation) => set({ rotation })}
            />
            <VectorRow label="Scale" value={transform.scale} step={0.1} onChange={(scale) => set({ scale })} />
          </div>
        ) : (
          <Empty>This object has no transform</Empty>
        )}
        <button
          class="danger"
          onClick={() => hierarchy.deleteSelected().catch((e) => store.reportError("Failed to delete the entity", e))}
        >
          {selectedCount > 1 ? `Delete ${selectedCount} Selected` : "Delete Entity"}
        </button>
      </>
    )
  }
  return (
    <Panel title="Inspector" icon="⚙️" class="inspector-panel">
      {content}
    </Panel>
  )
}

// ==================== Engine health ====================

export function EnginePanel() {
  const { store } = useApp()
  const connected = store.connected.value
  const info = store.serverInfo.value
  const [health, setHealth] = useState<EngineHealthResponse | null>(null)
  const [failed, setFailed] = useState(false)

  const refresh = () =>
    window.engine.getEngineHealth().then(
      (h) => {
        setHealth(h)
        setFailed(false)
      },
      (e) => {
        console.error("Failed to get engine health:", e)
        setFailed(true)
      }
    )
  useEffect(() => {
    setHealth(null)
    if (connected) refresh()
  }, [connected])

  let content
  if (!connected) content = <Empty>Not connected</Empty>
  else if (failed) content = <Empty error>Failed to get engine health</Empty>
  else if (!health) content = <Empty>Loading...</Empty>
  else
    content = (
      <>
        {info && (
          <div class="health-item">
            N2Engine {info.engineVersion}, protocol {info.protocolVersion}
            {!info.projectLoaded && <div class="detail">The host has no project loaded</div>}
          </div>
        )}
        {!health.healthy && <Empty error>A subsystem failed</Empty>}
        {health.subsystems.map((subsystem) => (
          <div class="health-item" key={subsystem.name}>
            <span>{subsystem.name}</span>
            <span
              class={`state ${subsystem.state === "Running" ? "running" : subsystem.state === "Failed" ? "failed" : "other"}`}
            >
              {subsystem.state}
            </span>
            {subsystem.detail && <div class="detail">{subsystem.detail}</div>}
          </div>
        ))}
      </>
    )

  return (
    <Panel
      title="Engine"
      icon="🩺"
      class="engine-panel"
      actions={
        <button onClick={refresh} disabled={!connected}>
          Refresh
        </button>
      }
    >
      {content}
    </Panel>
  )
}

// ==================== Script editor ====================

export function ScriptEditor({ path }: { path: string }) {
  const { store, scene } = useApp()
  const tab = scene.scripts.value.find((t) => t.path === path)
  if (!tab) return null
  return (
    <textarea
      class="script-editor"
      spellcheck={false}
      value={tab.text}
      aria-label={basename(path)}
      onInput={(e) => scene.editScript(path, (e.currentTarget as HTMLTextAreaElement).value)}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
          e.preventDefault()
          scene.saveScript(path).catch((err) => store.reportError("Failed to save", err))
        }
      }}
    />
  )
}
