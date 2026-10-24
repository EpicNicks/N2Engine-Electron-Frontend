import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks"
import type { PreferencesApi } from "../shared/api"
import { appPrefs, type PrefsStore } from "./prefs"
import { PreferencesState } from "./preferences-state"
import { preferencesRequest, closePreferences } from "./preferences-request"
import type { ViewportToolPrefValue } from "./viewport-tool-prefs"

export interface PreferencesDialogProps {
  api?: PreferencesApi
  prefs?: PrefsStore
  onSaved?(viewport: ViewportToolPrefValue): void
}
export function PreferencesDialog(props: PreferencesDialogProps) {
  const request = preferencesRequest.value
  return request === null ? null : <OpenPreferences key={request} {...props} />
}
function OpenPreferences(props: PreferencesDialogProps) {
  const model = useMemo(() => new PreferencesState(props.api ?? window.preferences, props.prefs ?? appPrefs(), props.onSaved), [])
  const root = useRef<HTMLFormElement>(null)
  const [discard, setDiscard] = useState(false)
  const previousDiscard = useRef(false)
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    root.current?.querySelector<HTMLHeadingElement>("h2")?.focus({ preventScroll: true })
    void model.load()
    return () => { model.dispose(); opener?.focus?.() }
  }, [])
  useEffect(() => {
    if (discard || previousDiscard.current)
      root.current?.querySelector<HTMLButtonElement>(discard ? "button[data-keep-editing]" : "button[data-cancel]")?.focus()
    previousDiscard.current = discard
  }, [discard])
  const host = model.host.value, tool = model.viewport.value, loading = model.loading.value, busy = model.busy.value
  const close = () => { if (!busy) { if (model.dirty.peek()) setDiscard(true); else closePreferences() } }
  const changeHost = (patch: Partial<typeof host>) => { model.host.value = { ...model.host.peek(), ...patch } }
  const changeTool = (patch: Partial<typeof tool>) => { model.viewport.value = { ...model.viewport.peek(), ...patch } }
  return <div class="modal-overlay" onClick={e => { if (e.target === e.currentTarget) close() }}>
    <div class="modal preferences-dialog" role="dialog" aria-modal="true" aria-labelledby="preferences-title" aria-busy={loading || busy}>
    <form ref={root} tabIndex={-1} onSubmit={e => { e.preventDefault(); void model.save().then(saved => { if (saved) closePreferences() }) }}
      onKeyDown={e => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (discard) setDiscard(false); else close() }
        if (e.key === "Tab") {
          const controls = Array.from(root.current!.querySelectorAll<HTMLElement>("input,select,button,[tabindex]"))
            .filter(el => !el.matches(":disabled") && el.tabIndex >= 0)
          if (controls.length === 0) { e.preventDefault(); return }
          const first = controls[0], last = controls.at(-1)
          if (!controls.includes(document.activeElement as HTMLElement)) { e.preventDefault(); (e.shiftKey ? last : first)?.focus(); return }
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
        }
      }}>
      <h2 id="preferences-title" tabIndex={-1}>Preferences</h2>
      <p class="note">Local to this editor on this machine. Available while disconnected, playing, or viewing a read-only host.</p>
      {loading && <p role="status">Loading preferences...</p>}
      {model.error.value && <div class="preferences-error" role="alert">{model.error.value}
        {!model.snapshot.value && !loading && <button type="button" class="secondary" onClick={() => void model.load()}>Retry</button>}
      </div>}
      {model.warning.value && <p class="preferences-error" role="alert">{model.warning.value}</p>}
      <fieldset disabled={loading || busy || discard || !model.snapshot.value}>
        <legend>Local engine launches</legend>
        <p class="note">Changes apply to the next host launch. Saving does not restart the current host or game.</p>
        <label for="preferences-host">N2EditorHost executable</label>
        <div class="preferences-path"><input id="preferences-host" type="text" value={host.hostPath} maxLength={4096}
          onInput={e => changeHost({ hostPath: e.currentTarget.value })} aria-describedby="preferences-path-help" />
          <button type="button" class="secondary" onClick={() => void model.browse()}>Browse...</button></div>
        <p class="note" id="preferences-path-help">Leave blank to use N2ENGINE_HOST from the environment.</p>
        {model.snapshot.value?.location.path && <p class="preferences-location">Current location ({model.snapshot.value.location.source}): {model.snapshot.value.location.path}</p>}
        {model.snapshot.value?.location.problem && <p class="preferences-error">{model.snapshot.value.location.problem}</p>}
        <label for="preferences-renderer">Renderer</label>
        <select id="preferences-renderer" value={host.renderer} onChange={e => changeHost({ renderer: e.currentTarget.value as typeof host.renderer })}>
          <option value="">Host default</option><option value="opengl">OpenGL</option><option value="software">Software</option>
        </select>
        <label for="preferences-timeout">Startup timeout (seconds)</label>
        <input id="preferences-timeout" type="number" min="1" max="300" step="0.001" required value={host.readyTimeoutMs / 1000}
          onInput={e => changeHost({ readyTimeoutMs: Number.isFinite(e.currentTarget.valueAsNumber) ? Math.round(e.currentTarget.valueAsNumber * 1000) : NaN })} />
        <p class="note">Allow 1 to 300 seconds for the host to become ready. Default: 30 seconds.</p>
      </fieldset>
      <fieldset disabled={loading || busy || discard || !model.snapshot.value}>
        <legend>Viewport tools</legend><p class="note">User preferences shared across projects. Apply immediately; project snapping and layout stay separate.</p>
        <label for="preferences-tool">Tool</label><select id="preferences-tool" value={tool.mode} onChange={e => changeTool({ mode: e.currentTarget.value as typeof tool.mode })}>
          <option value="translate">Move</option><option value="rotate">Rotate</option><option value="scale">Scale</option><option value="none">None</option></select>
        <label for="preferences-space">Space</label><select id="preferences-space" value={tool.space} onChange={e => changeTool({ space: e.currentTarget.value as typeof tool.space })}>
          <option value="world">World</option><option value="local">Local</option></select>
        <label for="preferences-pivot">Pivot</label><select id="preferences-pivot" value={tool.pivot} onChange={e => changeTool({ pivot: e.currentTarget.value as typeof tool.pivot })}>
          <option value="pivot">Pivot</option><option value="center">Center</option></select>
      </fieldset>
      {discard ? <div class="preferences-discard" role="group" aria-label="Discard unsaved preferences">
        <p>Discard your unsaved preferences?</p>
        <button type="button" class="secondary" data-keep-editing onClick={() => setDiscard(false)}>Keep editing</button>
        <button type="button" onClick={closePreferences}>Discard changes</button>
      </div> : <div class="modal-buttons">
        <span role="status">{busy ? "Saving or choosing a file..." : model.dirty.value ? "Unsaved changes" : ""}</span>
        <button type="button" class="secondary" data-cancel onClick={close} disabled={busy}>Cancel</button>
        <button type="submit" disabled={loading || busy || !model.snapshot.value || !model.dirty.value}>Save preferences</button>
      </div>}
    </form></div>
  </div>
}
