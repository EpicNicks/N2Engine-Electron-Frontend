import { test } from "node:test"
import * as assert from "node:assert/strict"
import { rig, settle } from "./viewport-rig"
import { ViewPreferencesPref } from "../renderer/viewport-view-prefs"

test("choosing wireframe tells the host and asks for a new frame; choosing it again sends nothing", async () => {
  const r = rig({ viewOptions: {} })
  await r.ready()
  const frames = r.frames()
  r.controller.setWireframe(true)
  await settle()
  assert.deepEqual(r.wireframes, [true])
  assert.ok(r.frames() > frames, "a frame is asked for")
  r.controller.setWireframe(true)
  await settle()
  assert.deepEqual(r.wireframes, [true])
  r.controller.setWireframe(false)
  await settle()
  assert.deepEqual(r.wireframes, [true, false])
})

test("a host without the command is never sent one, and the choice is kept for one that has it", async () => {
  const r = rig()
  await r.ready()
  assert.equal(r.controller.canViewOptions, false)
  r.controller.setWireframe(true)
  await settle()
  assert.equal(r.controller.viewPreferences.value.wireframe, true)
  assert.deepEqual(r.errors, [])
})

test("a new connection starts the host without wireframe, so the choice is sent again", async () => {
  const r = rig({ viewOptions: {} })
  await r.ready()
  r.controller.setWireframe(true)
  await settle()
  r.controller.disconnected()
  await r.controller.connected()
  await settle()
  assert.deepEqual(r.wireframes, [true, true])
})

test("the project's saved choice reaches a host that is already connected", async () => {
  const r = rig({ viewOptions: {} })
  await r.ready()
  r.controller.viewPreferences.value = { ...r.controller.viewPreferences.value, wireframe: true }
  r.controller.syncViewOptions()
  await settle()
  assert.deepEqual(r.wireframes, [true])
})

test("a refusal is reported and the wireframe choice is not forgotten", async () => {
  let refuse: string | null = "A play host refuses this option"
  const r = rig({ viewOptions: { refuse: () => refuse } })
  await r.ready()
  r.controller.setWireframe(true)
  await settle()
  assert.deepEqual(r.errors, ["Failed to change the view's wireframe"])
  assert.equal(r.controller.viewPreferences.value.wireframe, true)
  refuse = null
  r.controller.syncViewOptions()
  await settle()
  assert.deepEqual(r.wireframes, [true])
})

test("rapid choices end at the last one", async () => {
  const r = rig({ viewOptions: {} })
  await r.ready()
  r.controller.setWireframe(true)
  r.controller.setWireframe(false)
  r.controller.setWireframe(true)
  await settle()
  assert.equal(r.wireframes.at(-1), true)
})

test("the saved view options default to off and only a true flag turns wireframe on", () => {
  const read = (raw: unknown) => ViewPreferencesPref.validate(raw)?.wireframe
  assert.equal(read({}), false)
  assert.equal(read({ wireframe: "true" }), false)
  assert.equal(read({ wireframe: true }), true)
})
