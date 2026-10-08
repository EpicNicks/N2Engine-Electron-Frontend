// The Assets panel (protocol 1.9.0): the project's folders and assets as the host lists them, with their types and UUIDs;
// drag an asset onto an asset field of the inspector; make folders and scripts; read and edit an asset's import
// settings; and the text editor for scripts and other text files (bottom panel tabs). All state is in AssetsState.
import { entriesAfter } from "./console-store"
import { AssetDragEffect, AssetDragType, assetDragData } from "./drag-types"
import { isTextAssetPath } from "./asset-edit"
import { AssetRow, RootFolder, formatModified, formatSize, isFiltering, nameOf, parentOf, shortUuid } from "./asset-tree"
import { isDirty } from "./assets-state"
import { AppState, Empty, MenuItem, Panel, prompt, showContextMenu, useApp } from "./ui"

/** A glyph for a resource type (the host's names) */
function typeIcon(type: string, name: string): string {
  switch (type) {
    case "LuaScript":
      return "📜"
    case "Scene":
      return "🎬"
    case "Texture":
      return "🖼️"
    case "Model":
    case "Mesh":
      return "🧊"
    case "Material":
      return "🎨"
    case "AudioClip":
      return "🔊"
    case "Font":
      return "🔤"
    default:
      return isTextAssetPath(name) ? "📄" : "▫️"
  }
}

// ==================== Making things ====================

/** Asks for a name and makes a folder in a folder; the host's refusal is shown */
async function newFolder(app: AppState, parent: string): Promise<void> {
  const { store, assets } = app
  if (!store.connected.value) return store.reportError("New folder", "Not connected to the editor host")
  const name = await prompt("New folder", "NewFolder")
  if (name) assets.createFolder(parent, name).catch((e) => store.reportError("Failed to create the folder", e))
}

async function newScript(app: AppState, parent: string): Promise<void> {
  const { store, assets } = app
  if (!store.connected.value) return store.reportError("New script", "Not connected to the editor host")
  const name = await prompt("New script", "NewScript")
  if (name) assets.createScript(parent, name).catch((e) => store.reportError("Failed to create the script", e))
}

async function newScene(app: AppState, parent: string): Promise<void> {
  const { store, assets } = app
  if (!store.connected.value) return store.reportError("New scene", "Not connected to the editor host")
  const made = await store.newScene(`${parent === RootFolder ? RootFolder : `${parent}/`}Untitled.scene`)
  if (made) assets.refresh().catch((e) => store.reportError("Failed to list the assets", e))
}

function copyText(app: AppState, text: string): void {
  navigator.clipboard?.writeText(text).catch((e) => app.store.reportError("Failed to copy", e))
}

function folderMenu(app: AppState, folder: string): MenuItem[] {
  return [
    { label: "New Folder...", action: () => void newFolder(app, folder) },
    { label: "New Script...", action: () => void newScript(app, folder) },
    { label: "New Scene...", action: () => void newScene(app, folder) },
  ]
}

function assetMenu(app: AppState, row: Extract<AssetRow, { kind: "asset" | "sub" }>, open: () => void): MenuItem[] {
  const uuid = row.kind === "asset" ? row.asset.uuid : row.sub.uuid
  const items: MenuItem[] = []
  const isScene = row.path.toLowerCase().endsWith(".scene")
  if (row.kind === "asset" && (isScene || isTextAssetPath(row.path))) {
    items.push({ label: isScene ? "Open Scene" : "Open", action: open })
  }
  items.push({ label: "Copy Path", action: () => copyText(app, row.path) })
  items.push({ label: "Copy UUID", action: () => copyText(app, uuid) })
  return items
}

function RowView({ row }: { row: AssetRow }) {
  const app = useApp()
  const { store, assets } = app
  const selected = assets.selected.value === row.path
  const indent = { paddingLeft: `${row.depth * 12 + 4}px` }
  const fail = (what: string) => (e: unknown) => store.reportError(what, e)

  if (row.kind === "folder") {
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      void assets.select(row.path)
      showContextMenu(e.clientX, e.clientY, folderMenu(app, row.path))
    }
    return (
      <div
        class={selected ? "asset-row selected" : "asset-row"}
        style={indent}
        title={row.path}
        onClick={() => {
          void assets.select(row.path)
          assets.toggle(row.path)
        }}
        onContextMenu={onContextMenu}
      >
        <span class="arrow">{row.open ? "▾" : "▸"}</span>
        <span class="icon">📁</span>
        <span class="asset-name">{row.name}</span>
        <span class="asset-meta">{row.items}</span>
      </div>
    )
  }

  const entry =
    row.kind === "asset"
      ? { uuid: row.asset.uuid, path: row.asset.path, resourceType: row.asset.type }
      : { uuid: row.sub.uuid, path: row.path, resourceType: row.sub.type }
  const type = entry.resourceType
  const open = () => {
    if (row.kind !== "asset") return
    if (type === "Scene" || row.path.toLowerCase().endsWith(".scene")) {
      if (!store.connected.value) return store.reportError("Open scene", "Not connected to the editor host")
      void store.openScene(row.path)
    } else if (isTextAssetPath(row.path)) {
      assets.openText(row.path).catch(fail("Failed to open the file"))
    }
  }
  return (
    <div
      class={selected ? "asset-row selected" : "asset-row"}
      style={indent}
      title={`${row.path}\n${type || "Unknown"}\n${entry.uuid}`}
      onClick={() => void assets.select(row.path)}
      onDblClick={open}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void assets.select(row.path)
        showContextMenu(e.clientX, e.clientY, assetMenu(app, row, open))
      }}
      // An asset field of the inspector takes it, if it holds that type
      draggable
      onDragStart={(e) => {
        if (!e.dataTransfer) return
        e.dataTransfer.effectAllowed = AssetDragEffect
        e.dataTransfer.setData(AssetDragType, assetDragData(entry))
        e.dataTransfer.setData("text/plain", row.path)
      }}
    >
      {row.kind === "asset" && row.parts > 0 ? (
        <span
          class="arrow"
          onClick={(e) => {
            e.stopPropagation()
            assets.toggle(row.path)
          }}
        >
          {row.open ? "▾" : "▸"}
        </span>
      ) : (
        <span class="arrow" />
      )}
      <span class="icon">{typeIcon(type, row.path)}</span>
      <span class="asset-name">{row.name}</span>
      <span class="asset-type">{type || "Unknown"}</span>
      <span class="asset-uuid">{shortUuid(entry.uuid)}</span>
      {row.kind === "asset" && <span class="asset-meta">{formatSize(row.asset.size)}</span>}
    </div>
  )

}

/** The folder a new thing goes in: the selected folder, a selected file's folder, else the root */
function targetFolder(selected: string | null, rows: readonly AssetRow[]): string {
  if (selected === null) return RootFolder
  const row = rows.find((r) => r.path === selected)
  if (row?.kind === "folder") return row.path
  return parentOf(selected)
}

function AssetDetailView() {
  const { assets } = useApp()
  const path = assets.selected.value
  const listing = assets.listing.value
  const detail = assets.detail.value
  if (path === null || !listing) return null
  const file = listing.assets.find((asset) => asset.path === path)
  const hash = path.indexOf("#")

  if (hash >= 0) {
    const parent = listing.assets.find((asset) => asset.path === path.slice(0, hash))
    const sub = parent?.subAssets?.find((s) => s.key === path.slice(hash + 1))
    if (!parent || !sub) return null
    return (
      <div class="asset-detail">
        <div class="asset-detail-title">{sub.key}</div>
        <DetailLine label="Type" value={sub.type || "Unknown"} />
        <DetailLine label="UUID" value={sub.uuid} mono />
        <DetailLine label="Part of" value={parent.path} />
        <div class="asset-hint">A part of a model: drag it onto an asset field.</div>
      </div>
    )
  }
  if (!file) return null

  const info = detail?.path === path ? detail.info : null
  return (
    <div class="asset-detail">
      <div class="asset-detail-title">{nameOf(file.path)}</div>
      <DetailLine label="Path" value={file.path} />
      <DetailLine label="Type" value={file.type || "Unknown"} />
      <DetailLine label="UUID" value={file.uuid} mono />
      <DetailLine label="Size" value={`${formatSize(file.size)} (${file.size} bytes)`} />
      <DetailLine label="Modified" value={formatModified(file.modified)} />
      {info && <DetailLine label="In memory" value={info.loaded ? "yes" : "no"} />}
      {(file.subAssets?.length ?? 0) > 0 && (
        <DetailLine label="Parts" value={`${file.subAssets!.length} (open the model in the list)`} />
      )}
      {detail && detail.path === path && <ImportSettingsEditor />}
    </div>
  )
}

function DetailLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div class="detail-line">
      <span class="detail-label">{label}</span>
      <span class={mono ? "detail-value mono" : "detail-value"} title={value}>
        {value}
      </span>
    </div>
  )
}

function ImportSettingsEditor() {
  const { store, assets } = useApp()
  const detail = assets.detail.value
  if (!detail) return null
  const edited = detail.settings !== detail.baseline
  return (
    <div class="import-settings">
      <div class="detail-label">Import settings (JSON)</div>
      <textarea
        class="import-settings-text"
        spellcheck={false}
        value={detail.settings}
        disabled={detail.info === null}
        aria-label="Import settings"
        onInput={(e) => assets.editSettings((e.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault()
            if (edited) assets.applySettings().catch((err) => store.reportError("Failed to set the import settings", err))
          }
        }}
      />
      {detail.outdated && (
        <div class="asset-warning">The settings changed on the host while you were editing; Apply replaces them.</div>
      )}
      {detail.error && <div class="asset-error">{detail.error}</div>}
      <div class="import-settings-buttons">
        <button
          disabled={!edited || detail.saving || !store.connected.value}
          onClick={() =>
            assets.applySettings().catch((err) => store.reportError("Failed to set the import settings", err))
          }
        >
          {detail.saving ? "Applying..." : "Apply"}
        </button>
        <button class="secondary" disabled={!edited || detail.saving} onClick={() => assets.revertSettings()}>
          Revert
        </button>
      </div>
    </div>
  )
}

export function AssetsPanel() {
  const app = useApp()
  const { store, assets } = app
  const connected = store.connected.value
  const rows = assets.rows.value
  const filter = assets.filter.value
  const listing = assets.listing.value
  const error = assets.listingError.value
  const fail = (what: string) => (e: unknown) => store.reportError(what, e)
  const target = () => targetFolder(assets.selected.value, rows)

  let content
  if (!connected) content = <Empty>Not connected</Empty>
  else if (error && !listing) content = <Empty error>Failed to list the assets: {error}</Empty>
  else if (!listing) content = <Empty>Loading...</Empty>
  else if (rows.length === 0) content = <Empty>{isFiltering(filter) ? "No asset matches" : "No assets"}</Empty>
  else content = rows.map((row) => <RowView row={row} key={row.path} />)

  return (
    <Panel
      title="Assets"
      icon="📁"
      class="assets-panel"
      actions={
        <>
          <button
            disabled={!connected}
            title="Make a folder (in the selected folder)"
            onClick={() => void newFolder(app, target())}
          >
            + Folder
          </button>
          <button
            disabled={!connected}
            title="Make a script from the engine's template (in the selected folder)"
            onClick={() => void newScript(app, target())}
          >
            + Script
          </button>
          <button disabled={!connected} onClick={() => assets.refresh().catch(fail("Failed to list the assets"))}>
            Refresh
          </button>
        </>
      }
    >
      <div class="asset-filter">
        <input
          type="text"
          placeholder="Search path or UUID"
          value={filter.text}
          aria-label="Search assets"
          onInput={(e) => assets.setFilter({ text: (e.currentTarget as HTMLInputElement).value })}
        />
        <select
          value={filter.type}
          aria-label="Filter by type"
          onChange={(e) => assets.setFilter({ type: (e.currentTarget as HTMLSelectElement).value })}
        >
          <option value="">All types</option>
          {assets.types.value.map((type) => (
            <option value={type} key={type}>
              {type}
            </option>
          ))}
        </select>
      </div>
      {error && listing && <div class="asset-error">Couldn't refresh: {error}</div>}
      <div class="asset-list">{content}</div>
      <AssetDetailView />
    </Panel>
  )
}

// ==================== Text editor ====================

/** The editor of a text file open in a bottom-panel tab: Ctrl+S writes it through the host */
export function TextEditor({ path }: { path: string }) {
  const { store, assets } = useApp()
  const tab = assets.tabs.value.find((t) => t.path === path)
  // The reload's errors arrive as log events after the save
  const entries = store.console.entries.value
  if (!tab) return null

  const dirty = isDirty(tab)
  const logged = tab.saveMark === null ? [] : entriesAfter(entries, tab.saveMark, "error")
  const save = () => void assets.saveText(path)
  let status = "Saved"
  if (tab.saving) status = "Saving..."
  else if (dirty) status = "Unsaved changes"

  return (
    <div class="text-editor">
      {tab.external && (
        <div class="asset-warning text-banner">
          <span>
            {tab.external === "removed"
              ? "This file was deleted outside the editor. Saving makes it again."
              : "This file changed outside the editor. Saving replaces it with your text."}
          </span>
          {tab.external === "changed" && (
            <button
              class="secondary"
              onClick={() => assets.reloadText(path).catch((e) => store.reportError("Failed to reload the file", e))}
            >
              Discard mine and reload
            </button>
          )}
        </div>
      )}
      {tab.error && (
        <div class="asset-error text-banner" role="alert">
          <span>Not saved: {tab.error}</span>
        </div>
      )}
      {logged.length > 0 && (
        <div class="asset-error text-banner" role="alert">
          <div>The file is saved, but the host logged errors when it reloaded it:</div>
          {logged.slice(-5).map((entry) => (
            <pre class="log-line" key={entry.id}>
              {entry.message}
            </pre>
          ))}
        </div>
      )}
      <textarea
        class="script-editor"
        spellcheck={false}
        value={tab.text}
        aria-label={nameOf(path)}
        onInput={(e) => assets.editText(path, (e.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault()
            save()
          }
        }}
      />
      <div class="text-status">
        <span>{path}</span>
        <span class={dirty ? "dirty" : ""}>{status}</span>
        <button disabled={!dirty || tab.saving || !store.connected.value} onClick={save} title="Save (Ctrl+S)">
          Save
        </button>
      </div>
    </div>
  )
}
