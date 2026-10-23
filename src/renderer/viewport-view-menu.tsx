import { ViewportController } from "./viewport-controller"
import type { OverlayOptions } from "./viewport-overlays"
const labels:Record<keyof OverlayOptions,string>={grid:"Grid",colliders:"Selected colliders",allColliders:"All colliders",bounds:"All bounds",icons:"Light and camera icons",ranges:"Light ranges"}
export function ViewportViewMenu({viewport,enabled,onUsed}:{viewport:ViewportController;enabled:boolean;onUsed?():void}) {
  viewport.overlayVersion.value
  const options=viewport.viewPreferences.value.overlays,camera=viewport.camera
  return <details class="viewport-view-menu">
    <summary aria-label="Viewport view and gizmos">View / Gizmos</summary>
    <div role="group" aria-label="Viewport view options">
      <label><input type="checkbox" disabled={!enabled} checked={camera.orthographic} onChange={e=>viewport.setOrthographic((e.target as HTMLInputElement).checked)} />Orthographic</label>
      <label><input type="checkbox" disabled={!enabled} checked={camera.mode2D} onChange={e=>viewport.set2D((e.target as HTMLInputElement).checked)} />2D mode</label>
      <label>Axis view <select aria-label="Axis view" disabled={!enabled} value="" onChange={e=>{viewport.setAxis((e.target as HTMLSelectElement).value as "front");onUsed?.()}}>
        <option value="" disabled>Choose view</option>
        {["front","back","left","right","top","bottom"].map(axis=><option value={axis}>{axis}</option>)}
      </select></label>
      <button type="button" disabled={!enabled || !viewport.target.value} onClick={()=>{viewport.alignViewToSelected();onUsed?.()}}>Align view to selected</button>
      <fieldset><legend>Gizmos (overlays draw through objects)</legend>
        {(Object.keys(labels) as Array<keyof OverlayOptions>).map(key=><label><input type="checkbox" disabled={!enabled} checked={options[key]} onChange={e=>viewport.setOverlay(key,(e.target as HTMLInputElement).checked)} />{labels[key]}</label>)}
      </fieldset>
      <fieldset><legend>Camera bookmarks for this scene</legend>
        {Array.from({length:9},(_,i)=><div class="viewport-bookmark-row"><span>{i+1}</span>
          <button type="button" disabled={!enabled} title={`Ctrl+Shift+${i+1}`} onClick={()=>viewport.bookmark(i+1,true)}>Save {i+1}</button>
          <button type="button" disabled={!enabled || !viewport.hasBookmark(i+1)} title={`Shift+${i+1}`} onClick={()=>{viewport.bookmark(i+1,false);onUsed?.()}}>Recall {i+1}</button>
        </div>)}
      </fieldset>
    </div>
  </details>
}
