// The editor's face for the host's Lua editor extensions: the Tools button and its nested menu, the result notice, the
// banner that offers to enable a project's extensions, and the admin Extensions section of the project settings. The
// logic is in extensions-state.ts, extension-menu.ts and extension-actions.ts (tested in Node). Every string from an
// extension (names, titles, paths, errors, messages) is untrusted and is only ever a text node here: nothing in this
// file puts a string into HTML, a URL, a style or an event handler.
import { useState } from "preact/hooks"
import type { ExtensionMenuItem, ExtensionSummary } from "../protocol/extensions"
import type { ExtensionTrustState } from "../shared/api"
import { countItems, type ToolsNode } from "./extension-menu"
import type { SectionProps } from "./project-settings-sections"
import { MenuItem, showContextMenu, useApp } from "./ui"

const NoItemsLabel = "No menu items declared by the extensions"

/** The Tools menu's items for ContextMenu: groups become submenus, a disabled item carries its reason as its tooltip */
export function toContextItems(nodes: readonly ToolsNode[], run: (item: ExtensionMenuItem) => void): MenuItem[] {
  return nodes.map((node): MenuItem => {
    if (node.kind === "group") return { label: node.label, submenu: toContextItems(node.children, run) }
    return { label: node.label, action: () => run(node.item), disabled: !node.enabled, title: node.reason ?? undefined }
  })
}

/** The Tools button: opens the menu of the extensions' items. Absent while the host has no extensions on. */
export function ToolsButton() {
  const { extensions } = useApp()
  if (!extensions.menuVisible.value) return null
  const running = extensions.running.value !== null
  const open = (e: MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    e.stopPropagation()
    // Built now, from the host's menu as it is and the selection as it is: the revision it came from is what a run sends
    const nodes = extensions.menu()
    const revision = extensions.uiRevision
    const items: MenuItem[] =
      countItems(nodes) === 0
        ? [{ label: NoItemsLabel, action: () => {}, disabled: true }]
        : toContextItems(nodes, (item) => void extensions.run(item, revision))
    showContextMenu(rect.left, rect.bottom, items, { keyboard: e.detail === 0 })
  }
  return (
    <button
      class="secondary tools-button"
      aria-haspopup="menu"
      aria-busy={running}
      title={running ? "A menu item is running" : "Menu items of the project's editor extensions"}
      onClick={open}
    >
      Tools
      {running && <span class="spinner" role="status" aria-label="A menu item is running" />}
    </button>
  )
}

/** What the last menu item said (its message and warnings, as text), until dismissed */
export function ExtensionNotice() {
  const { extensions } = useApp()
  const notice = extensions.notice.value
  if (notice === null) return null
  return (
    <div class="extension-notice" role="status">
      <div class="extension-notice-text">
        <b>{notice.title}</b>
        {notice.message !== "" ? `: ${notice.message}` : " ran."}
        {notice.warnings.length > 0 && (
          <ul class="extension-warnings">
            {notice.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        )}
      </div>
      <button class="secondary" aria-label="Dismiss" onClick={() => extensions.dismissNotice()}>
        ×
      </button>
    </div>
  )
}

/** A text for how many extension files a project holds ("3 editor extensions") */
export function extensionCount(trust: Pick<ExtensionTrustState, "files" | "more">): string {
  const n = trust.files.length + trust.more
  return `${n} editor extension${n === 1 ? "" : "s"}`
}

/**
 * Under the toolbar: the project has editor extensions that are not running (Not now, or an answer that could not be
 * kept), with the button that asks again. A project with none, a remote engine and a host that runs them show nothing.
 */
export function ExtensionTrustBanner() {
  const { store } = useApp()
  // Dismissal belongs to one host launch of one project: a later launch or another project shows the banner again
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const trust = store.extensionTrust.value
  const hostNow = store.host.value
  const key = `${hostNow.launch}|${hostNow.projectPath ?? ""}`
  if (dismissedFor === key || trust === null || trust.enabled || store.host.value.mode !== "local") return null
  const busy = store.busy.value !== null
  return (
    <div class="extension-banner" role="status">
      <span>
        This project has {extensionCount(trust)} that {trust.files.length + trust.more === 1 ? "is" : "are"} not running.
        They run code on this computer's editor host, so the editor asks before enabling them.
      </span>
      <button onClick={() => void store.enableExtensions()} disabled={busy}>
        Enable extensions...
      </button>
      <button class="secondary" aria-label="Dismiss" onClick={() => setDismissedFor(key)}>
        ×
      </button>
    </div>
  )
}

// ==================== The admin section ====================

/** What the section says when the host has the feature but extensions are off */
export function disabledExplanation(local: boolean, trust: ExtensionTrustState | null): string {
  if (!local) {
    return "Editor extensions are not enabled on this host. The operator of a remote host turns them on by starting N2EditorHost with --editor-extensions; the editor never does that for a remote host, and shows what the host reports."
  }
  if (trust === null) {
    return "Editor extensions are not enabled: this project has no .lua file in its editor/ folder. Add extensions there and open the project again."
  }
  return `Editor extensions are not enabled for this project: it has ${extensionCount(trust)} that the host was started without. Enabling them asks first, then restarts the host.`
}

const StateLabels: Record<ExtensionSummary["state"], string> = { loaded: "Loaded", failed: "Failed", faulted: "Faulted" }

function shortHash(hash: string): string {
  return hash === "" ? "-" : hash.slice(0, 8)
}

function ExtensionRow({ extension }: { extension: ExtensionSummary }) {
  const error = extension.error !== undefined && extension.error !== "" ? extension.error : null
  return (
    <>
      <tr data-extension={extension.id} class={"ext-" + extension.state}>
        <th scope="row">{extension.name}</th>
        <td>
          <span class={"ext-state " + extension.state}>{StateLabels[extension.state]}</span>
        </td>
        <td>{extension.apiVersion}</td>
        <td class="ext-hash" title={extension.sha256 === "" ? undefined : extension.sha256}>
          {shortHash(extension.sha256)}
        </td>
        <td>{extension.capabilities.length === 0 ? "none" : extension.capabilities.join(", ")}</td>
        <td>{extension.itemCount}</td>
      </tr>
      {error !== null && (
        <tr class="ext-error-row">
          <td class="ext-error" colSpan={6}>
            {error}
          </td>
        </tr>
      )}
    </>
  )
}

/** Local projects: what editor/ holds and whether this folder is trusted, with the way to forget the trust */
function TrustBlock({ trust }: { trust: ExtensionTrustState }) {
  const { store } = useApp()
  const busy = store.busy.value !== null
  return (
    <div class="ext-trust">
      <h4>Trust for this project</h4>
      <p class="ps-intro">
        {extensionCount(trust)} in editor/. Extensions run code on this computer's editor host, only for a folder you trusted. The
        trust is remembered for this exact folder, in this editor's user data (not in the project).
      </p>
      <div class="ps-facts">
        <span>This folder</span>
        {trust.trusted ? "Trusted" : "Not trusted"}
      </div>
      <div class="ps-facts">
        <span>Running host</span>
        {trust.enabled ? "Started with extensions enabled" : "Started without extensions"}
      </div>
      <ul class="ext-files" aria-label="Extension files">
        {trust.files.map((file) => (
          <li key={file}>{file}</li>
        ))}
        {trust.more > 0 && <li>and {trust.more} more</li>}
      </ul>
      {trust.enabled && !trust.trusted && (
        <div class="ps-restart" role="status">
          Trust was forgotten. The running host keeps the extensions it loaded until it restarts.{" "}
          <button type="button" onClick={() => void store.restartHost()} disabled={busy}>
            Restart host
          </button>
        </div>
      )}
      <div class="ps-buttons">
        <button type="button" class="secondary" onClick={() => void store.forgetExtensionTrust()} disabled={!trust.trusted || busy}>
          Forget trust for this project
        </button>
        {!trust.enabled && (
          <button type="button" onClick={() => void store.enableExtensions()} disabled={busy}>
            Enable extensions...
          </button>
        )}
      </div>
    </div>
  )
}

/** The Editor Extensions section of the project settings: what the host loaded, Reload for admins, and the trust of this folder */
export function ExtensionsSection(_props: SectionProps) {
  const { store, extensions } = useApp()
  const status = extensions.status.value
  const info = extensions.info.value
  const local = store.host.value.mode === "local"
  const trust = store.extensionTrust.value
  const isAdmin = extensions.isAdmin.value
  const blocked = store.readOnlyReason.value
  const reloading = extensions.reloading.value

  let reloadWhy: string | null = null
  if (!isAdmin) reloadWhy = "Only an admin can reload extensions: the host refuses any other role."
  else if (blocked !== null) reloadWhy = `Not available: ${blocked}`
  else if (reloading) reloadWhy = "Reloading..."

  let body
  if (status === "disconnected") body = <p class="ps-intro">Not connected.</p>
  else if (status === "unsupported") {
    body = <p class="ps-intro">This host is older than protocol 1.14.0, which added editor extensions: there is nothing to show.</p>
  } else if (status === "loading") body = <p class="ps-intro">Loading...</p>
  else if (status === "error") {
    body = (
      <p class="ps-field-error" role="alert">
        Failed to read the extensions: {extensions.loadError.value}
      </p>
    )
  } else if (status === "disabled") body = <p class="ps-note">{disabledExplanation(local, trust)}</p>
  else {
    body = (
      <>
        {info !== null && info.extensions.length === 0 ? (
          <p class="ps-intro">Extensions are on, and the host found no .lua file in the project's editor/ folder.</p>
        ) : (
          <table class="ext-table">
            <caption class="visually-hidden">Editor extensions</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">State</th>
                <th scope="col">API</th>
                <th scope="col">SHA-256</th>
                <th scope="col">Capabilities</th>
                <th scope="col">Items</th>
              </tr>
            </thead>
            <tbody>
              {(info?.extensions ?? []).map((extension) => (
                <ExtensionRow key={extension.id} extension={extension} />
              ))}
            </tbody>
          </table>
        )}
        <div class="ps-buttons">
          <button
            type="button"
            onClick={() => void extensions.reload()}
            disabled={reloadWhy !== null}
            title={reloadWhy ?? "Load every extension file again; a faulted extension is enabled again"}
          >
            {reloading ? "Reloading..." : "Reload"}
          </button>
        </div>
        {reloadWhy !== null && !reloading && <p class="ps-help">{reloadWhy}</p>}
        {extensions.reloadError.value !== null && (
          <p class="ps-field-error" role="alert">
            Reload failed: {extensions.reloadError.value}
          </p>
        )}
      </>
    )
  }

  return (
    <div class="ps-form ext-section">
      <p class="ps-intro">
        Lua extensions in the project's editor/ folder add items to the Tools menu. They run on the editor host, never in this
        window, and every change they make is one undo step.
      </p>
      {body}
      {local && trust !== null && <TrustBlock trust={trust} />}
    </div>
  )
}
