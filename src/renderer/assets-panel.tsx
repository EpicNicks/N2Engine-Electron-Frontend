// The Assets panel (protocol 1.9.0): the project's folders and assets as the host lists them, with their types and UUIDs;
// drag an asset onto an asset field of the inspector; make folders and scripts; read and edit an asset's import
// settings; and the text editor for scripts and other text files (bottom panel tabs). All state is in AssetsState.
import { ScriptEditor } from "./script-editor"
import { hostHasEditorTooling } from "../protocol/editor-tooling"
import { useRef } from "preact/hooks"
import { signal } from "@preact/signals"
import { AssetThumb, DetailPreviewSize, RowPreviewSize } from "./asset-thumb"
import { entriesAfter } from "./console-store"
import { AssetDragEffect, AssetDragType, EntityDragType, PrefabDragType, assetDragData, dragHas } from "./drag-types"
import type { AssetEntry } from "../shared/api"
import { PrefabCopyNotice, PrefabResourceType, prefabPathIn } from "../protocol/prefab-assets"
import { RootId } from "./hierarchy-tree"
import { isTextAssetPath, parseImportSettings } from "./asset-edit"
import { AssetRow, RootFolder, formatModified, formatSize, isFiltering, nameOf, parentOf, shortUuid } from "./asset-tree"
import { isDirty, settingsEdited } from "./assets-state"
import { ImportSettingsForm } from "./assets-import-form"
import { ImportCheck, ImportSchema, checkImportSettings, firstImportError, importSchemaFor } from "./assets-import-schema"
import { useKeymapActions } from "./keymap-hooks"
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
    case PrefabResourceType:
      return "🧩"
    default:
      return isTextAssetPath(name) ? "📄" : "▫️"
  }
}

// ==================== Making things ====================

/** Asks for a name and makes a folder in a folder; the host's refusal is shown */
async function newFolder(app: AppState, parent: string): Promise<void> {
  const { store, assets } = app
  if (!store.connected.value) return store.reportError("New folder", "Not connected to the editor host")
  if (!store.canWrite.value) return store.reportError("New folder", `Not allowed: ${store.readOnlyReason.value}`)
  const name = await prompt("New folder", "NewFolder")
  if (name) assets.createFolder(parent, name).catch((e) => store.reportError("Failed to create the folder", e))
}

async function newScript(app: AppState, parent: string): Promise<void> {
  const { store, assets } = app
  if (!store.connected.value) return store.reportError("New script", "Not connected to the editor host")
  if (!store.canWrite.value) return store.reportError("New script", `Not allowed: ${store.readOnlyReason.value}`)
  const name = await prompt("New script", "NewScript")
  if (name) assets.createScript(parent, name).catch((e) => store.reportError("Failed to create the script", e))
}

async function newScene(app: AppState, parent: string): Promise<void> {
  const { store, assets } = app
  if (!store.connected.value) return store.reportError("New scene", "Not connected to the editor host")
  if (!store.canWrite.value) return store.reportError("New scene", `Not allowed: ${store.readOnlyReason.value}`)
  const made = await store.newScene(`${parent === RootFolder ? RootFolder : `${parent}/`}Untitled.scene`)
  if (made) assets.refresh().catch((e) => store.reportError("Failed to list the assets", e))
}

function copyText(app: AppState, text: string): void {
  navigator.clipboard?.writeText(text).catch((e) => app.store.reportError("Failed to copy", e))
}

function folderMenu(app: AppState, folder: string): MenuItem[] {
  const playing = !app.store.canWrite.peek()
  return [
    { label: "New Folder...", action: () => void newFolder(app, folder), disabled: playing },
    { label: "New Script...", action: () => void newScript(app, folder), disabled: playing },
    { label: "New Scene...", action: () => void newScene(app, folder), disabled: playing },
  ]
}

/**
 * The prefabs to drag or add when a prefab row is used: every selected prefab file in the order of the rows shown when the
 * row is one of several selected (Ctrl/Cmd+click, Shift+click), else just the row's own
 */
export function prefabsOfUse(app: AppState, path: string, own: AssetEntry): AssetEntry[] {
  const paths = new Set(app.assets.selectedPaths())
  if (!paths.has(path) || paths.size < 2) return [own]
  const chosen: AssetEntry[] = []
  for (const row of app.assets.rows.peek()) {
    if (row.kind !== "asset" || !paths.has(row.path) || row.asset.type !== PrefabResourceType) continue
    chosen.push({ uuid: row.asset.uuid, path: row.asset.path, resourceType: row.asset.type })
  }
  return chosen.length > 0 ? chosen : [own]
}

export function assetMenu(app: AppState, row: Extract<AssetRow, { kind: "asset" | "sub" }>, open: () => void): MenuItem[] {
  const uuid = row.kind === "asset" ? row.asset.uuid : row.sub.uuid
  const items: MenuItem[] = []
  const isScene = row.path.toLowerCase().endsWith(".scene")
  if (row.kind === "asset" && (isScene || isTextAssetPath(row.path))) {
    // OpenScene is a write: a read-only host refuses it, like the toolbar's Open scene (disabled, not hidden)
    items.push({
      label: isScene ? "Open Scene" : "Open",
      action: open,
      disabled: isScene && app.store.hostReadOnly.peek(),
    })
  }
  if (row.kind === "asset" && row.asset.type === PrefabResourceType && app.hierarchy.canPrefabs) {
    // The same as dropping it on the hierarchy's empty space: a copy with a link, as the last root of the scene
    const prefabs = prefabsOfUse(app, row.path, { uuid, path: row.path, resourceType: PrefabResourceType })
    items.push({
      label: prefabs.length > 1 ? `Add ${prefabs.length} Prefabs to Scene` : "Add to Scene",
      action: () =>
        void app.hierarchy
          .instantiatePrefabs(
            prefabs.map((p) => p.uuid),
            { parentId: RootId, index: -1 }
          )
          .catch((e) => app.store.reportError("Failed to add the prefab", e)),
      disabled: !app.store.canWrite.peek() || app.store.scene.peek() === null,
    })
  }
  items.push({ label: "Copy Path", action: () => copyText(app, row.path) })
  items.push({ label: "Copy UUID", action: () => copyText(app, uuid) })
  return items
}

/** The folder an object being dragged from the hierarchy would be made a prefab in (highlighted); null when none */
const prefabDropFolder = signal<string | null>(null)

/**
 * Dropping an object from the hierarchy on a folder makes it a prefab there (CreatePrefab, protocol 1.19.0). Only the
 * type is readable during the drag, so any hierarchy object is taken; the host and the state check the rest.
 */
function folderDrop(app: AppState, folder: string) {
  const accepts = (e: DragEvent): boolean =>
    dragHas(e, EntityDragType) && app.hierarchy.canPrefabs && app.store.connected.value && app.store.canWrite.value
  return {
    onDragOver: (e: DragEvent) => {
      if (!accepts(e)) return
      e.stopPropagation()
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"
      if (prefabDropFolder.value !== folder) prefabDropFolder.value = folder
    },
    onDragLeave: (e: DragEvent) => {
      if (prefabDropFolder.value === folder && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) {
        prefabDropFolder.value = null
      }
    },
    onDrop: (e: DragEvent) => {
      prefabDropFolder.value = null
      if (!accepts(e)) return
      e.stopPropagation()
      e.preventDefault()
      const id = e.dataTransfer?.getData(EntityDragType) ?? ""
      const name = app.hierarchy.tree.peek().nodes.get(id)?.name
      if (name === undefined) return
      app.hierarchy
        .createPrefab(id, prefabPathIn(folder, name))
        .catch((err) => app.store.reportError("Failed to create the prefab", err))
    },
  }
}

function RowView({ row }: { row: AssetRow }) {
  const app = useApp()
  const { store, assets } = app
  const selected = assets.selected.value === row.path || assets.marked.value.has(row.path)
  const indent = { paddingLeft: `${row.depth * 12 + 4}px` }
  const fail = (what: string) => (e: unknown) => store.reportError(what, e)

  if (row.kind === "folder") {
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      void assets.select(row.path)
      showContextMenu(e.clientX, e.clientY, folderMenu(app, row.path))
    }
    const classes = ["asset-row"]
    if (selected) classes.push("selected")
    if (prefabDropFolder.value === row.path) classes.push("drop-target")
    return (
      <div
        class={classes.join(" ")}
        style={indent}
        title={row.path}
        onClick={() => {
          void assets.select(row.path)
          assets.toggle(row.path)
        }}
        onContextMenu={onContextMenu}
        {...folderDrop(app, row.path)}
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
      if (store.hostReadOnly.peek()) return
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
      onClick={(e) => {
        // Ctrl/Cmd+click and Shift+click select several files (to drag several prefabs at once); a part of a model is one
        if (row.kind === "asset" && (e.ctrlKey || e.metaKey)) void assets.toggleMarked(row.path)
        else if (row.kind === "asset" && e.shiftKey) void assets.selectRange(row.path)
        else void assets.select(row.path)
      }}
      onDblClick={open}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        // A row that is one of several selected keeps the selection, so the menu acts on all of them
        if (!(assets.marked.peek().size > 0 && assets.selectedPaths().includes(row.path))) void assets.select(row.path)
        showContextMenu(e.clientX, e.clientY, assetMenu(app, row, open))
      }}
      // An asset field of the inspector takes it, if it holds that type
      draggable
      onDragStart={(e) => {
        if (!e.dataTransfer) return
        e.dataTransfer.effectAllowed = AssetDragEffect
        e.dataTransfer.setData(AssetDragType, assetDragData(entry))
        // A prefab can also be dropped on the hierarchy (a copy with a link is made there)
        // Dragging one of several selected prefabs carries all of them, as a list (the drop adds them as one edit group)
        if (type === PrefabResourceType) {
          const prefabs = prefabsOfUse(app, row.path, entry)
          e.dataTransfer.setData(
            PrefabDragType,
            prefabs.length > 1 ? JSON.stringify(prefabs.map((p) => JSON.parse(assetDragData(p)))) : assetDragData(entry)
          )
        }
        e.dataTransfer.setData("text/plain", row.path)
      }}
      // An object dragged from the hierarchy onto a file makes a prefab in the file's folder
      {...folderDrop(app, parentOf(row.kind === "sub" ? row.parent.path : row.path))}
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
      {row.kind === "asset" && <AssetThumb asset={row.asset} size={RowPreviewSize} name={row.name} />}
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
      <AssetThumb asset={file} size={DetailPreviewSize} name={nameOf(file.path)} />
      <DetailLine label="Path" value={file.path} />
      <DetailLine label="Type" value={file.type || "Unknown"} />
      <DetailLine label="UUID" value={file.uuid} mono />
      <DetailLine label="Size" value={`${formatSize(file.size)} (${file.size} bytes)`} />
      <DetailLine label="Modified" value={formatModified(file.modified)} />
      {file.type === PrefabResourceType && (
        <div class="asset-hint">
          Drag it onto the hierarchy to add a copy to the scene. {PrefabCopyNotice}
        </div>
      )}
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
  const edited = settingsEdited(detail)
  const writable = store.connected.value && store.canWrite.value
  // A type with a typed form (Texture, Model, Font) shows it unless JSON was asked for; the others are JSON only
  const schema = importSchemaFor(detail.info?.type)
  const view = schema ? assets.settingsView.value : "json"
  // The form needs a JSON object; while the text is not one, only the JSON view can fix it
  const formUsable = schema !== null && parseImportSettings(detail.settings).ok
  // What the engine would ignore stops Apply (applySettings checks it again)
  const blocked = schema ? firstImportError(checkFormSettings(schema, detail.settings), detail.fields, schema) : null
  return (
    <div class="import-settings">
      <div class="import-settings-head">
        <span class="detail-label">{view === "form" ? `Import settings (${schema!.type})` : "Import settings (JSON)"}</span>
        {schema && (
          <button
            class="secondary"
            disabled={view === "json" && !formUsable}
            title={view === "json" && !formUsable ? "The JSON must be a valid object to edit it as a form" : undefined}
            onClick={() => assets.setSettingsView(view === "form" ? "json" : "form")}
          >
            {view === "form" ? "Edit as JSON" : "Edit as form"}
          </button>
        )}
      </div>
      {view === "form" && schema ? (
        <ImportSettingsForm schema={schema} detail={detail} assets={assets} disabled={detail.info === null || !writable} />
      ) : (
        <textarea
          class="import-settings-text"
          spellcheck={false}
          value={detail.settings}
          disabled={detail.info === null}
          readOnly={!store.canWrite.value}
          aria-label="Import settings"
          onInput={(e) => assets.editSettings((e.currentTarget as HTMLTextAreaElement).value)}
        />
      )}
      {!writable && store.connected.value && (
        <div class="asset-hint">Read only: {store.readOnlyReason.value}</div>
      )}
      {detail.outdated && (
        <div class="asset-warning">The settings changed on the host while you were editing; Apply replaces them.</div>
      )}
      {detail.error && <div class="asset-error">{detail.error}</div>}
      <div class="import-settings-buttons">
        <button
          disabled={!edited || detail.saving || !writable || blocked !== null}
          title={blocked ?? undefined}
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

/** The typed check of the settings text; a text that is not an object has nothing to check (Apply says why) */
function checkFormSettings(schema: ImportSchema, settings: string): ImportCheck {
  const parsed = parseImportSettings(settings)
  if (!parsed.ok) return { fieldErrors: {}, blockError: null, unknownKeys: [], warnings: [] }
  return checkImportSettings(schema, parsed.value)
}

export function AssetsPanel() {
  const app = useApp()
  const { store, assets } = app
  const connected = store.connected.value
  // Nothing is changed while a play session runs (the host refuses it)
  const editable = connected && store.canWrite.value
  const rows = assets.rows.value
  const filter = assets.filter.value
  const listing = assets.listing.value
  const error = assets.listingError.value
  const fail = (what: string) => (e: unknown) => store.reportError(what, e)
  const target = () => targetFolder(assets.selected.value, rows)

  // Ctrl+S applies the import settings being edited, in their field only (anywhere else in the panel it saves the scene)
  useKeymapActions({
    "assets.applySettings": (e) => {
      // The JSON text or a field of the typed form
      if (!(e.target as Element | null)?.closest?.(".import-settings-text, .import-form")) return false
      const detail = assets.detail.value
      if (detail && settingsEdited(detail)) {
        assets.applySettings().catch((err) => store.reportError("Failed to set the import settings", err))
      }
    },
  })

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
      keymapScope="assets"
      actions={
        <>
          <button
            disabled={!editable}
            title="Make a folder (in the selected folder)"
            onClick={() => void newFolder(app, target())}
          >
            + Folder
          </button>
          <button
            disabled={!editable}
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
      <div
        class={prefabDropFolder.value === RootFolder ? "asset-list drop-target" : "asset-list"}
        {...folderDrop(app, RootFolder)}
      >
        {content}
      </div>
      <AssetDetailView />
    </Panel>
  )
}

// ==================== Text editor ====================

/** The editor of a text file open in a bottom-panel tab: Ctrl+S writes it through the host */
export function TextEditor({ path }: { path: string }) {
  const { assets } = useApp()
  // Closed while it was shown: nothing (the inner editor registers its key, which needs its element to exist)
  return assets.tabs.value.some((t) => t.path === path) ? <OpenTextEditor path={path} /> : null
}

function OpenTextEditor({ path }: { path: string }) {
  const { store, assets } = useApp()
  const root = useRef<HTMLDivElement>(null)
  // Ctrl+S in this editor writes its file (before the scene's save: the text scope is the more specific)
  useKeymapActions({ "text.save": () => void assets.saveText(path) }, root)
  const tab = assets.tabs.value.find((t) => t.path === path)
  // CheckLuaSyntax (protocol 1.17.0) is a Read command: it lints in a read-only session too, but needs the connection
  const lintAvailable = store.connected.value && hostHasEditorTooling(store.serverInfo.value?.protocolVersion)
  // The reload's errors arrive as log events after the save
  const entries = store.console.entries.value
  if (!tab) return null

  const dirty = isDirty(tab)
  const logged = tab.saveMark === null ? [] : entriesAfter(entries, tab.saveMark, "error", tab.saveEnd ?? undefined)
  const save = () => void assets.saveText(path)
  let status = "Saved"
  if (tab.saving) status = "Saving..."
  else if (dirty) status = "Unsaved changes"

  return (
    <div class="text-editor" ref={root} data-keymap-scope="text">
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
      <ScriptEditor path={path} text={tab.text} readOnly={!store.canWrite.value}
        onChange={text => assets.editText(path, text)}
        checkSyntax={lintAvailable ? window.engine?.checkLuaSyntax : undefined} />
      <div class="text-status">
        <span>{path}</span>
        <span class={dirty ? "dirty" : ""}>{status}</span>
        <button disabled={!dirty || tab.saving || !store.connected.value || !store.canWrite.value} onClick={save} title="Save (Ctrl+S)">
          Save
        </button>
      </div>
    </div>
  )
}
