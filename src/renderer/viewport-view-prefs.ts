import { effect } from "@preact/signals-core"
import type { SetEditorCameraRequest } from "../protocol/protocol.generated"
import { definePref, isRecord, PrefScopeView } from "./prefs"
import { DefaultOverlays, OverlayOptions } from "./viewport-overlays"
import type { ViewportController } from "./viewport-controller"

export interface CameraBookmark { camera: SetEditorCameraRequest; distance: number; mode2D: boolean }
/** wireframe: the editor view draws wireframe (SetEditorViewOptions, protocol 1.17.0); the host forgets it, so it is sent again on connecting */
export interface ViewPreferences { overlays: OverlayOptions; bookmarks: Record<string, Array<CameraBookmark | null>>; wireframe: boolean }
export const DefaultViewPreferences: ViewPreferences = { overlays: DefaultOverlays, bookmarks: {}, wireframe: false }
function validBookmark(raw:unknown): CameraBookmark | null {
  if(!isRecord(raw) || !isRecord(raw.camera))return null
  const c=raw.camera,p=c.position,q=c.rotation
  if(!isRecord(p) || !isRecord(q))return null
  const finite=(x:unknown):x is number=>typeof x==="number" && Number.isFinite(x)
  if(![p.x,p.y,p.z,q.x,q.y,q.z,q.w,c.fovY,c.orthoSize,c.nearPlane,c.farPlane,raw.distance].every(finite))return null
  const position={x:p.x as number,y:p.y as number,z:p.z as number},rotation={x:q.x as number,y:q.y as number,z:q.z as number,w:q.w as number}
  if(Object.values(position).some(x=>Math.abs(x)>1e6) || Math.abs(Math.hypot(...Object.values(rotation))-1)>.001)return null
  if((c.fovY as number)<=0 || (c.fovY as number)>=180 || (c.orthoSize as number)<.01 || (c.orthoSize as number)>1e5 || (c.nearPlane as number)<=0 || (c.farPlane as number)<=(c.nearPlane as number) || (raw.distance as number)<.01 || (raw.distance as number)>1e5 || typeof c.orthographic!=="boolean")return null
  return {camera:{position,rotation,fovY:c.fovY as number,orthographic:c.orthographic,orthoSize:c.orthoSize as number,nearPlane:c.nearPlane as number,farPlane:c.farPlane as number},distance:raw.distance as number,mode2D:raw.mode2D===true && c.orthographic}
}
export const ViewPreferencesPref=definePref<ViewPreferences,"project">({
  key:"viewport.view",scope:"project",default:DefaultViewPreferences,
  validate(raw) {
    if(!isRecord(raw))return undefined
    const source=isRecord(raw.overlays)?raw.overlays:{}
    const overlays={...DefaultOverlays}
    for(const key of Object.keys(overlays) as Array<keyof OverlayOptions>) if(typeof source[key]==="boolean")overlays[key]=source[key] as boolean
    const entries=isRecord(raw.bookmarks)?Object.entries(raw.bookmarks).slice(0,64):[]
    const bookmarks=Object.fromEntries(entries.filter(([key,value])=>key.length>0 && key.length<=512 && Array.isArray(value)).map(([key,value])=>[key,Array.from({length:9},(_,i)=>validBookmark((value as unknown[])[i]))]))
    return {overlays,bookmarks,wireframe:raw.wireframe===true}
  }
})
export function attachViewportViewPrefs(viewport:ViewportController,scope:PrefScopeView<"project">):()=>void {
  viewport.viewPreferences.value=scope.get(ViewPreferencesPref)
  // The project's wireframe choice reaches a host that is already connected (a connection made it before the project was known)
  viewport.syncViewOptions()
  let first=true
  return effect(()=>{
    const value=viewport.viewPreferences.value
    if(first){first=false;return}
    scope.set(ViewPreferencesPref,value)
  })
}
