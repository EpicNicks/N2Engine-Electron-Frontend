import { test } from "node:test"
import * as assert from "node:assert/strict"
import { EditorCameraController, DefaultCamera } from "../renderer/viewport-camera"
import { DefaultOverlays, entityOverlays, gridLines, MaxOverlayEntities, OverlayEntityCache, projectLine } from "../renderer/viewport-overlays"
import { directionToCamera, gizmoLayout, gizmoFrame, hitTestGizmo } from "../renderer/viewport-gizmo"
import { IdentityQuat, mat4Multiply, projectionMatrix, quatFromAxisAngle, screenRay, vec3, viewMatrix } from "../renderer/viewport-math"
import { ViewPreferencesPref } from "../renderer/viewport-view-prefs"
import { entityData, rig, settle } from "./viewport-rig"
const close=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`)

test("orthographic rays are parallel, handles keep their screen size and planes face consistently off axis",()=>{
  const view=viewMatrix(vec3(0,0,10),IdentityQuat), vp=mat4Multiply(projectionMatrix({...DefaultCamera,orthographic:true,orthoSize:5},2),view)
  const a=screenRay(vp,10,10,800,400)!,b=screenRay(vp,790,390,800,400)!
  assert.deepEqual(a.direction,b.direction);assert.notDeepEqual(a.origin,b.origin)
  close(gizmoFrame(view,vp,vec3(0,0,0),800,400)!.worldLength,gizmoFrame(view,vp,vec3(3,2,-10),800,400)!.worldLength)
  assert.deepEqual(directionToCamera(view,vp,vec3(0,0,0)),directionToCamera(view,vp,vec3(100,20,0)))
  const layout=gizmoLayout(view,vp,vec3(0,0,0),800,400)!,handle=layout.handles.find(h=>h.axis==="x")!
  assert.equal(hitTestGizmo(layout,{x:(handle.from.x+handle.to.x)/2,y:handle.to.y}),"x")
})

test("2D locks rotation and flight, pans and zooms by orthographic size, and restores the prior pose",()=>{
  const c=new EditorCameraController();c.orbit(80,30);const before=c.toRequest()
  c.set2D(true);assert.equal(c.orthographic,true);assert.deepEqual(c.forward,vec3(0,0,-1))
  const pose=c.toRequest();c.orbit(50,20);c.look(50,20);c.fly(vec3(1,0,1),1,20);assert.deepEqual(c.toRequest(),pose)
  c.pan(100,0,1000);close(c.target.x,-1)
  const distance=c.distance;c.zoom(-100);assert.ok(c.orthoSize<5);close(c.distance,distance)
  c.set2D(false);assert.deepEqual(c.toRequest(),before)
  c.setAxis("top");close(c.forward.y,-1);close(c.forward.z,0)
  c.setAxis("bottom");close(c.forward.y,1)
})

test("nine bookmark slots isolate scenes, preserve projection and orientation, and reject corrupt stored data",()=>{
  let scene="one";const {controller:c}=rig({sceneKey:()=>scene})
  c.setOrthographic(true);c.setAxis("top");const saved=c.camera.toRequest()
  for(let slot=1;slot<=9;slot++)assert.equal(c.bookmark(slot,true),true)
  assert.equal(c.bookmark(10,true),false);scene="two";assert.equal(c.hasBookmark(9),false)
  c.setAxis("front");assert.equal(c.bookmark(9,false),false)
  scene="one";assert.equal(c.bookmark(9,false),true);assert.deepEqual(c.camera.toRequest(),saved)
  const validated=ViewPreferencesPref.validate({...c.viewPreferences.value,bookmarks:{one:[{camera:{...saved,orthoSize:NaN},distance:10}],two:c.viewPreferences.value.bookmarks.one}})!
  assert.equal(validated.bookmarks.one[0],null);assert.equal(validated.bookmarks.two.length,9)
  assert.equal(validated.bookmarks.two[8]!.camera.orthographic,true)
})

test("box, sphere and capsule lines include collider offsets and the complete rotated, scaled world transform",()=>{
  const e=entityData("a",{position:vec3(10,20,30),rotation:quatFromAxisAngle(vec3(0,0,1),Math.PI/2),scale:vec3(2,3,4)})
  const points=(type:string,values:unknown)=>{e.entity.components=[{type,uuid:"c",values}];return entityOverlays(e,DefaultOverlays,true).lines.flatMap(l=>[l.a,l.b])}
  const box=points("BoxCollider",{_halfExtents:vec3(1,2,3),_offset:vec3(1,0,0)})
  assert.equal(box.length,24);close(Math.min(...box.map(p=>p.x)),4);close(Math.max(...box.map(p=>p.x)),16);close(Math.min(...box.map(p=>p.y)),20);close(Math.max(...box.map(p=>p.z)),42)
  const sphere=points("SphereCollider",{radius:1,offset:vec3(1,0,0)})
  close(Math.min(...sphere.map(p=>p.x)),7);close(Math.max(...sphere.map(p=>p.y)),24)
  const capsule=points("CapsuleCollider",{radius:.5,height:3,offset:vec3(0,1,0)})
  close(Math.min(...capsule.map(p=>p.x)),2.5);close(Math.max(...capsule.map(p=>p.x)),11.5)
  assert.ok(entityOverlays(e,{...DefaultOverlays,colliders:false,allColliders:true},false).lines.length>0)
  assert.ok(capsule.every(p=>Object.values(p).every(Number.isFinite)))
})

test("align view to selected uses the world rotation and preserves the orbit distance",async()=>{
  const rotation=quatFromAxisAngle(vec3(0,1,0),.7),r=rig({entities:{a:{position:vec3(3,2,1),rotation}}})
  await r.ready();r.controller.camera.distance=13
  assert.equal(r.controller.alignViewToSelected(),true)
  assert.deepEqual(r.controller.camera.target,vec3(3,2,1));close(r.controller.camera.distance,13)
  close(r.controller.camera.rotation.y,rotation.y)
})

test("spot ranges follow positive Z and use half-angle degrees without scaling the light radius",()=>{
  const e=entityData("a",{position:vec3(0,0,0),scale:vec3(2,3,4)})
  e.entity.components=[{type:"Light",uuid:"l",values:{type:"Spot",range:10,outerConeAngle:45}}]
  const lines=entityOverlays(e,DefaultOverlays,false).lines
  close(Math.max(...lines.flatMap(l=>[l.a.z,l.b.z])),10)
  close(Math.max(...lines.flatMap(l=>[l.a.x,l.b.x])),10)
})

test("grid generation is finite and bounded at any zoom, fades outward and follows the orthographic axis plane",()=>{
  for(const span of [.01,10,1e5]) {
    const lines=gridLines(vec3(0,0,0),span,vec3(0,0,-1),true)
    assert.equal(lines.length,82);assert.ok(lines.every(l=>l.a.z===0 && l.b.z===0 && l.alpha>0))
    assert.ok(lines[0].alpha<lines[40].alpha)
  }
  assert.deepEqual(gridLines(vec3(0,0,0),NaN,vec3(0,0,-1),false),[])
  const vp=mat4Multiply(projectionMatrix({...DefaultCamera,orthographic:false},1),viewMatrix(vec3(0,0,10),IdentityQuat))
  assert.equal(projectLine(vp,{a:vec3(0,0,11),b:vec3(0,0,12),color:"",alpha:1},100,100),null)
  assert.ok(projectLine(vp,{a:vec3(0,0,11),b:vec3(0,0,0),color:"",alpha:1},100,100)!.every(p=>Number.isFinite(p.x+p.y)))
})

test("overlay reads never exceed four in flight across revision churn, cap unique ids, ignore stale results and cache by revision",async()=>{
  let active=0,max=0,reads=0;const pending:Array<()=>void>=[]
  const cache=new OverlayEntityCache(id=>{reads++;max=Math.max(max,++active);return new Promise(resolve=>pending.push(()=>{active--;resolve(entityData(id,{position:vec3(0,0,0)}))}))},()=>{})
  cache.get(Array.from({length:1000},(_,i)=>String(i)),"old")
  cache.get(Array.from({length:1000},(_,i)=>"new"+i),"new")
  assert.equal(reads,4)
  while(pending.length){pending.shift()!();await settle()}
  const ids=Array.from({length:1000},(_,i)=>"new"+i)
  const values=cache.get(ids,"new");assert.equal(values.length,MaxOverlayEntities);assert.equal(max,4)
  assert.ok(values.every(e=>e.entity.header.id.startsWith("new")))
  const previous=reads;cache.get(ids,"new");await settle();assert.equal(reads,previous)
  cache.clear();assert.deepEqual(cache.get([],"empty"),[])
})
