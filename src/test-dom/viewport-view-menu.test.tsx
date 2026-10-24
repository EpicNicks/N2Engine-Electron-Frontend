import "./setup"
import { test, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import { cleanup, fireEvent, render, screen } from "@testing-library/preact"
import { ViewportViewMenu } from "../renderer/viewport-view-menu"
import { attachViewportViewPrefs } from "../renderer/viewport-view-prefs"
import { PrefsStore } from "../renderer/prefs"
import { rig, settle } from "../test/viewport-rig"
import { keymap } from "../renderer/keymap"
import { ViewportKeyboard } from "../renderer/viewport-keys"
afterEach(cleanup)
const project="11111111-1111-4111-8111-111111111111"
function show(viewport:ReturnType<typeof rig>["controller"],enabled=true) {
  render(<ViewportViewMenu viewport={viewport} enabled={enabled}/> )
  screen.getByText("View / Gizmos").closest("details")!.open=true
}
test("overlay toggles survive storage reload, while a different project retains its defaults",()=>{
  const data=new Map<string,string>(),storage={get:(k:string)=>data.get(k)??null,set:(k:string,v:string)=>void data.set(k,v),remove:(k:string)=>void data.delete(k)}
  const prefs=new PrefsStore(storage),a=rig({sceneKey:()=>"scene"}).controller,off=attachViewportViewPrefs(a,prefs.project(project))
  show(a);fireEvent.click(screen.getByRole("checkbox",{name:"Grid"}));fireEvent.click(screen.getByRole("checkbox",{name:"All colliders"}));fireEvent.click(screen.getByRole("button",{name:"Save 9"}));prefs.flush();off();cleanup()
  const next=new PrefsStore(storage),b=rig({sceneKey:()=>"scene"}).controller,offB=attachViewportViewPrefs(b,next.project(project))
  show(b);assert.equal(b.hasBookmark(9),true);assert.equal((screen.getByRole("checkbox",{name:"Grid"}) as HTMLInputElement).checked,false);assert.equal((screen.getByRole("checkbox",{name:"All colliders"}) as HTMLInputElement).checked,true);offB();cleanup()
  const c=rig().controller,offC=attachViewportViewPrefs(c,next.project("22222222-2222-4222-8222-222222222222"));show(c);assert.equal((screen.getByRole("checkbox",{name:"Grid"}) as HTMLInputElement).checked,true);offC()
})
test("the view menu changes projection, axis and 2D lock and saves/recalls all nine poses",()=>{
  const c=rig({sceneKey:()=>"scene"}).controller;show(c)
  fireEvent.click(screen.getByRole("checkbox",{name:"Orthographic"}));assert.equal(c.camera.orthographic,true)
  fireEvent.change(screen.getByRole("combobox",{name:"Axis view"}),{target:{value:"top"}});assert.ok(c.camera.forward.y<-.999)
  fireEvent.click(screen.getByRole("checkbox",{name:"2D mode"}));assert.equal(c.camera.mode2D,true)
  for(let i=1;i<=9;i++) {fireEvent.click(screen.getByRole("button",{name:`Save ${i}`}));assert.equal(c.hasBookmark(i),true)}
  c.set2D(false);fireEvent.click(screen.getByRole("button",{name:"Recall 9"}));assert.equal(c.camera.mode2D,true)
})
test("view settings and bookmark actions are disabled while the game is live",()=>{
  show(rig().controller,false)
  for(const input of screen.getAllByRole("checkbox"))assert.equal((input as HTMLInputElement).disabled,true)
  for(const input of screen.getAllByRole("button"))assert.equal((input as HTMLButtonElement).disabled,true)
})
test("bookmark and axis shortcuts only act inside the viewport and leave live-game keys alone",()=>{
  const c=rig({sceneKey:()=>"scene"}).controller;let live=false
  const view=document.createElement("div");view.tabIndex=0;view.dataset.keymapScope="viewport";document.body.append(view)
  const keyboard=new ViewportKeyboard({gesture:()=>null,endGesture:()=>{},frameSelected:()=>{},live:()=>live,bookmark:(slot,save)=>c.bookmark(slot,save),axisView:axis=>c.setAxis(axis),toggleOrthographic:()=>c.setOrthographic(!c.camera.orthographic)})
  const off=keyboard.register(keymap,view),detach=keymap.install(document)
  try {
    view.focus();for(let i=1;i<=9;i++)fireEvent.keyDown(view,{code:`Digit${i}`,ctrlKey:true,shiftKey:true})
    assert.equal(c.hasBookmark(9),true)
    fireEvent.keyDown(document.body,{code:"Numpad5"});assert.equal(c.camera.orthographic,false)
    fireEvent.keyDown(view,{code:"Numpad7"});assert.ok(c.camera.forward.y<-.999)
    fireEvent.keyDown(view,{code:"Numpad5"});assert.equal(c.camera.orthographic,true)
    live=true;fireEvent.keyDown(view,{code:"Numpad5"});assert.equal(c.camera.orthographic,true)
  } finally {off();detach();view.remove()}
})
test("the Wireframe toggle tells the host, is remembered per project and sent again after a reload",async()=>{
  const data=new Map<string,string>(),storage={get:(k:string)=>data.get(k)??null,set:(k:string,v:string)=>void data.set(k,v),remove:(k:string)=>void data.delete(k)}
  const prefs=new PrefsStore(storage),a=rig({sceneKey:()=>"scene",viewOptions:{}}),off=attachViewportViewPrefs(a.controller,prefs.project(project))
  await a.ready();show(a.controller)
  const box=()=>screen.getByRole("checkbox",{name:"Wireframe"}) as HTMLInputElement
  assert.equal(box().checked,false);assert.equal(box().disabled,false)
  fireEvent.click(box());await settle();assert.deepEqual(a.wireframes,[true]);assert.equal(box().checked,true)
  prefs.flush();off();cleanup()
  const next=new PrefsStore(storage),b=rig({sceneKey:()=>"scene",viewOptions:{}}),offB=attachViewportViewPrefs(b.controller,next.project(project))
  await b.ready();show(b.controller);await settle()
  assert.equal(box().checked,true);assert.deepEqual(b.wireframes,[true]);offB();cleanup()
  const other=rig({viewOptions:{}}),offC=attachViewportViewPrefs(other.controller,next.project("22222222-2222-4222-8222-222222222222"))
  await other.ready();show(other.controller);assert.equal(box().checked,false);assert.deepEqual(other.wireframes,[]);offC()
})
test("the Wireframe toggle is disabled for a host without the command and while the game is live",()=>{
  show(rig().controller)
  assert.equal((screen.getByRole("checkbox",{name:"Wireframe"}) as HTMLInputElement).disabled,true)
  cleanup()
  show(rig({viewOptions:{}}).controller,false)
  assert.equal((screen.getByRole("checkbox",{name:"Wireframe"}) as HTMLInputElement).disabled,true)
})
