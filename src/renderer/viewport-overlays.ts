// Pure, bounded overlay geometry. Client overlays have no depth buffer and are intentionally not occluded by meshes.
import type { EntityDataResponse, Mat4, Vec3 } from "../protocol/protocol.generated"
import { add, mat4TransformPoint, Pixel } from "./viewport-math"

export interface OverlayOptions { grid: boolean; colliders: boolean; allColliders: boolean; bounds: boolean; icons: boolean; ranges: boolean }
export const DefaultOverlays: OverlayOptions = { grid: true, colliders: true, allColliders: false, bounds: false, icons: true, ranges: true }
export interface WorldLine { a: Vec3; b: Vec3; color: string; alpha: number }
export interface OverlayIcon { at: Vec3; label: string; color: string }
export const MaxOverlayEntities = 256
const steps = 32
const finite = (v: Vec3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" ? v as Record<string,unknown> : {}
const value = (r: Record<string,unknown>, name: string) => r[name] ?? r["_"+name]
const number = (v: unknown, fallback: number) => typeof v === "number" && Number.isFinite(v) ? v : fallback
const vector = (v: unknown, fallback: Vec3): Vec3 => { const r=record(v); return {x:number(r.x,fallback.x),y:number(r.y,fallback.y),z:number(r.z,fallback.z)} }
const zero = {x:0,y:0,z:0}
function line(out: WorldLine[], matrix: Mat4, a: Vec3, b: Vec3, color: string, alpha=0.8): void {
  const x=mat4TransformPoint(matrix,a)?.point,y=mat4TransformPoint(matrix,b)?.point
  if(x && y && finite(x) && finite(y) && out.length < 10000) out.push({a:x,b:y,color,alpha})
}
function circle(out: WorldLine[], matrix: Mat4, center: Vec3, radius: number, axes: readonly ["x"|"y"|"z","x"|"y"|"z"], color: string): void {
  if(!(radius>0) || radius>1e6)return
  for(let i=0;i<steps;i++) {
    const a={...center},b={...center}; const t=i*Math.PI*2/steps,u=(i+1)*Math.PI*2/steps
    a[axes[0]]+=Math.cos(t)*radius;a[axes[1]]+=Math.sin(t)*radius
    b[axes[0]]+=Math.cos(u)*radius;b[axes[1]]+=Math.sin(u)*radius
    line(out,matrix,a,b,color)
  }
}
export function entityOverlays(entity: EntityDataResponse, options: OverlayOptions, selected: boolean): { lines: WorldLine[]; icons: OverlayIcon[] } {
  const lines: WorldLine[]=[],icons: OverlayIcon[]=[]; const m=entity.worldMatrix
  for(const component of entity.entity.components) {
    const r=record(component.values), type=component.type
    const centre=vector(value(r,"offset"),zero), radius=number(value(r,"radius"),0.5), color="#67d8a0"
    if((options.colliders && selected) || options.allColliders) {
      if(type==="BoxCollider") {
        const h=vector(value(r,"halfExtents"),{x:.5,y:.5,z:.5});if(!(h.x>0 && h.y>0 && h.z>0))continue
        const corners=Array.from({length:8},(_,i)=>add(centre,{x:(i&1?1:-1)*h.x,y:(i&2?1:-1)*h.y,z:(i&4?1:-1)*h.z}))
        for(let i=0;i<8;i++) for(const bit of [1,2,4]) if(!(i&bit))line(lines,m,corners[i],corners[i|bit],color)
      } else if(type==="SphereCollider") {
        for(const axes of [["x","y"],["x","z"],["y","z"]] as const)circle(lines,m,centre,radius,axes,color)
      } else if(type==="CapsuleCollider") {
        const half=Math.max(0,number(value(r,"height"),2)/2-radius)
        for(const sign of [-1,1])circle(lines,m,add(centre,{x:0,y:sign*half,z:0}),radius,["x","z"],color)
        for(const axis of ["x","z"] as const) {
          for(const sign of [-1,1])line(lines,m,add(centre,{x:axis==="x"?sign*radius:0,y:-half,z:axis==="z"?sign*radius:0}),add(centre,{x:axis==="x"?sign*radius:0,y:half,z:axis==="z"?sign*radius:0}),color)
          for(const sign of [-1,1]) for(let i=0;i<steps/2;i++) {
            const a={...centre},b={...centre},t=i*Math.PI/(steps/2),u=(i+1)*Math.PI/(steps/2)
            a[axis]+=Math.cos(t)*radius;b[axis]+=Math.cos(u)*radius
            a.y+=sign*(half+Math.sin(t)*radius);b.y+=sign*(half+Math.sin(u)*radius)
            line(lines,m,a,b,color)
          }
        }
      }
    }
    if(type==="Light" || type==="Camera") {
      const at=mat4TransformPoint(m,zero)?.point
      if(options.icons && at && finite(at))icons.push({at,label:type==="Light"?"\u2600":"\u25a3",color:type==="Light"?"#ffd866":"#8dbfff"})
      if(type==="Light" && options.ranges) {
        const range=number(value(r,"range"),10), kind=value(r,"type") ?? value(r,"lightType")
        const lightMatrix=[...m] as Mat4
        for(const start of [0,4,8]) { const length=Math.hypot(m[start],m[start+1],m[start+2]);if(length>0)for(let i=0;i<3;i++)lightMatrix[start+i]/=length }
        if(kind===2 || kind==="Spot" || kind==="spot") {
          const angle=number(value(r,"outerConeAngle"),45)*Math.PI/180
          const end={x:0,y:0,z:range};const spread=Math.tan(Math.min(Math.PI/2-.01,Math.max(0,angle)))*range
          circle(lines,lightMatrix,end,spread,["x","y"],"#e9c664")
          for(const v of [{x:spread,y:0,z:range},{x:-spread,y:0,z:range},{x:0,y:spread,z:range},{x:0,y:-spread,z:range}])line(lines,lightMatrix,zero,v,"#e9c664",.5)
        } else if(kind!==0 && kind!=="Directional" && kind!=="directional") {
          for(const axes of [["x","y"],["x","z"],["y","z"]] as const)circle(lines,lightMatrix,zero,range,axes,"#e9c664")
        }
      }
    }
  }
  return {lines,icons}
}
export function gridLines(target: Vec3, span: number, forward: Vec3, orthographic: boolean): WorldLine[] {
  if(!finite(target) || !(span>0) || !Number.isFinite(span))return []
  const step=10**Math.ceil(Math.log10(Math.max(.001,span/10))), count=20, out: WorldLine[]=[]
  const normal=orthographic ? Math.abs(forward.x)>.99 ? "x" : Math.abs(forward.z)>.99 ? "z" : "y" : "y"
  const axes=normal==="x" ? ["y","z"] as const : normal==="z" ? ["x","y"] as const : ["x","z"] as const
  const center={...target,[normal]:0};center[axes[0]]=Math.round(target[axes[0]]/step)*step;center[axes[1]]=Math.round(target[axes[1]]/step)*step
  for(let i=-count;i<=count;i++)for(const axis of axes) {
    const other=axis===axes[0]?axes[1]:axes[0],a={...center},b={...center}
    a[axis]=b[axis]=center[axis]+i*step;a[other]-=count*step;b[other]+=count*step
    out.push({a,b,color:a[axis]===0?"#758ba0":"#69727c",alpha:.35*(1-Math.abs(i)/(count+1))})
  }
  return out
}
/** Clip a line against the camera near plane before its perspective divide. */
export function projectLine(m: Mat4, line: WorldLine, width: number, height: number): [Pixel,Pixel] | null {
  const clip=(p:Vec3)=>({x:m[0]*p.x+m[4]*p.y+m[8]*p.z+m[12],y:m[1]*p.x+m[5]*p.y+m[9]*p.z+m[13],z:m[2]*p.x+m[6]*p.y+m[10]*p.z+m[14],w:m[3]*p.x+m[7]*p.y+m[11]*p.z+m[15]})
  let a=clip(line.a),b=clip(line.b);const da=a.z+a.w,db=b.z+b.w
  if(da<0 && db<0)return null
  if(da<0 || db<0) {
    const t=da/(da-db),c={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t,w:a.w+(b.w-a.w)*t}
    if(da<0)a=c;else b=c
  }
  if(a.w<=0 || b.w<=0)return null
  return [a,b].map(c=>({x:(c.x/c.w*.5+.5)*width,y:(.5-c.y/c.w*.5)*height})) as [Pixel,Pixel]
}

/** A revision cache with a hard entity/read-concurrency bound; stale reads never replace a newer scene. */
export class OverlayEntityCache {
  private key=""
  private generation=0
  private values: EntityDataResponse[]=[]
  private queue: string[]=[]
  private active=0
  constructor(private readonly read:(id:string)=>Promise<EntityDataResponse>, private readonly changed:()=>void) {}
  clear():void { this.key="";this.generation++;this.values=[];this.queue=[] }
  private drain():void {
    while(this.active<4 && this.queue.length) {
      const id=this.queue.shift()!,generation=this.generation
      this.active++
      void this.read(id).then(result=>{if(generation===this.generation)this.values.push(result)},()=>{}).finally(()=>{
        this.active--
        this.drain()
        if(generation===this.generation)this.changed()
      })
    }
  }
  get(ids:readonly string[], revision:string):readonly EntityDataResponse[] {
    const limited=[...new Set(ids)].slice(0,MaxOverlayEntities),key=JSON.stringify([revision,limited])
    if(key!==this.key) {
      this.key=key;this.values=[];this.generation++;this.queue=limited
      this.drain()
    }
    return this.values
  }
}
