// Inspector sections of the host's editor extensions (protocol 1.16.0), without a DOM: which sections go under a
// component, what a read-only field shows, when a button is enabled, and running a button through the extensions state
// (the same steps and results as a menu item, with InvokeInspectorAction as the call).
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { ExtensionSummary } from "../protocol/extensions"
import {
  buttonAvailability,
  formatFieldValue,
  mayRunButtons,
  sectionsFor,
  MaxValueLength,
  type ButtonContext,
} from "../renderer/extension-inspector"
import { describeInvokeFailure } from "../renderer/extension-actions"
import { Uuid, fakeExtensions, field, inspectorButton, inspectorSection, invokeResult, serverInfo, summary } from "./fake-extensions"

const ready: ButtonContext = {
  role: "editor",
  canInvoke: true,
  blockedReason: null,
  openGroups: 0,
  running: false,
  extension: summary() as ExtensionSummary,
}

describe("sectionsFor", () => {
  test("keeps the sections of one component type, in the host's order", () => {
    const sections = [inspectorSection("Light", { label: "A" }), inspectorSection("Camera"), inspectorSection("Light", { label: "B" })]
    assert.deepEqual(sectionsFor(sections, "Light").map((s) => s.label), ["A", "B"])
    assert.deepEqual(sectionsFor(sections, "Mesh"), [])
  })

  test("a type name is matched exactly", () => {
    assert.deepEqual(sectionsFor([inspectorSection("Light")], "light"), [])
    assert.deepEqual(sectionsFor([inspectorSection("Light")], "Light "), [])
  })
})

describe("mayRunButtons", () => {
  test("admins and editors may; viewers and an unknown role may not", () => {
    assert.equal(mayRunButtons("admin"), true)
    assert.equal(mayRunButtons("editor"), true)
    assert.equal(mayRunButtons("viewer"), false)
    assert.equal(mayRunButtons(null), false)
  })
})

describe("buttonAvailability", () => {
  const button = inspectorButton("b", "B")

  test("is enabled when nothing stands in the way", () => {
    assert.deepEqual(buttonAvailability(button, ready), { enabled: true, reason: null })
  })

  test("a host before 1.16.0 disables it with the reason", () => {
    const a = buttonAvailability(button, { ...ready, canInvoke: false })
    assert.equal(a.enabled, false)
    assert.match(a.reason ?? "", /protocol 1\.16\.0/)
  })

  test("a faulted or failed extension disables it with the extension's name", () => {
    for (const state of ["faulted", "failed"] as const) {
      const a = buttonAvailability(button, { ...ready, extension: summary({ state, name: "Light Tools" }) })
      assert.equal(a.enabled, false)
      assert.match(a.reason ?? "", /Light Tools is disabled until an admin reloads it/)
    }
  })

  test("an admin button needs the admin role", () => {
    const admin = inspectorButton("b", "B", { minRole: "admin" })
    const editor = buttonAvailability(admin, ready)
    assert.equal(editor.enabled, false)
    assert.match(editor.reason ?? "", /admin role \(you are signed in as editor\)/)
    assert.equal(buttonAvailability(admin, { ...ready, role: "admin" }).enabled, true)
  })

  test("a read-only host, an open edit group and another run each disable it", () => {
    assert.match(buttonAvailability(button, { ...ready, blockedReason: "the host is read-only" }).reason ?? "", /Not available: the host is read-only/)
    assert.match(buttonAvailability(button, { ...ready, openGroups: 1 }).reason ?? "", /edit is in progress/)
    assert.match(buttonAvailability(button, { ...ready, running: true }).reason ?? "", /running/)
  })

  test("an extension the list does not name is not a reason to disable", () => {
    assert.equal(buttonAvailability(button, { ...ready, extension: undefined }).enabled, true)
  })
})

describe("formatFieldValue", () => {
  const f = (name: string, over = {}) => field(name, "Float", over)

  test("plain values are shown as text", () => {
    assert.equal(formatFieldValue(f("a"), { a: 2.5 }), "2.5")
    assert.equal(formatFieldValue(f("a"), { a: "hello" }), "hello")
    assert.equal(formatFieldValue(f("a"), { a: true }), "true")
    assert.equal(formatFieldValue(f("a"), { a: false }), "false")
  })

  test("a missing value, null, a non-finite number and no values at all are a dash", () => {
    assert.equal(formatFieldValue(f("a"), {}), "-")
    assert.equal(formatFieldValue(f("a"), { a: null }), "-")
    assert.equal(formatFieldValue(f("a"), { a: Number.NaN }), "-")
    assert.equal(formatFieldValue(f("a"), { a: Number.POSITIVE_INFINITY }), "-")
    assert.equal(formatFieldValue(f("a"), null), "-")
    assert.equal(formatFieldValue(f("a"), "not an object"), "-")
  })

  test("a vector is (x, y, z); another object or a list is JSON", () => {
    assert.equal(formatFieldValue(f("p"), { p: { x: 1, y: 2, z: 3 } }), "(1, 2, 3)")
    assert.equal(formatFieldValue(f("p"), { p: { x: 1, y: 2 } }), '{"x":1,"y":2}')
    assert.equal(formatFieldValue(f("p"), { p: [1, 2] }), "[1,2]")
  })

  test("a field in a container is read from the container", () => {
    assert.equal(formatFieldValue(f("a", { container: "scriptData" }), { scriptData: { a: 7 } }), "7")
    assert.equal(formatFieldValue(f("a", { container: "scriptData" }), { scriptData: 5 }), "-")
  })

  test("control characters become spaces and a long text is cut", () => {
    assert.equal(formatFieldValue(f("a"), { a: "one\ntwo\tthree\u0000" }), "one two three ")
    const long = formatFieldValue(f("a"), { a: "x".repeat(MaxValueLength + 50) })
    assert.equal(long.length, MaxValueLength + 3)
    assert.ok(long.endsWith("..."))
  })

  test("markup stays a string, unchanged: the panel puts it in a text node", () => {
    assert.equal(formatFieldValue(f("a"), { a: "<b>x</b>" }), "<b>x</b>")
  })
})

describe("describeInvokeFailure for the inspector", () => {
  test("a stale revision says the inspector was refreshed and asks for the UI again", () => {
    const failure = describeInvokeFailure("staleUi", "x", { title: "Reset" }, "inspector")
    assert.match(failure.text, /inspector was refreshed/)
    assert.equal(failure.refreshUi, true)
    assert.match(describeInvokeFailure("staleUi", "x", { title: "Reset" }).text, /Tools menu/)
  })
})

describe("running a button", () => {
  const lights = inspectorSection("Light", {
    buttons: [
      inspectorButton("light.reset", "Reset"),
      inspectorButton("light.set", "Set power", { form: { fields: [field("power", "Float", { min: 0, max: 10 })], defaults: { power: 1 } } }),
    ],
  })
  const [reset, set] = lights.buttons

  test("settles, ends the edit groups, invokes with the component and the section's revision, then follows the host", async () => {
    const f = fakeExtensions({ sections: [lights] })
    f.inspectorAnswer = { status: "ok", value: invokeResult({ message: "Reset 1 light", select: [Uuid(8)] }) }
    await f.state.refresh()
    f.log.length = 0

    const outcome = await f.state.runButton(reset, Uuid(5), 4)

    assert.equal(outcome, "ok")
    assert.deepEqual(f.log, ["settle", "closeGroups", "invokeInspector", "applyEdit", "sync", "select"])
    assert.deepEqual(f.inspectorInvokes, [{ componentId: Uuid(5), actionId: "light.reset", params: {}, uiRevision: 4 }])
    assert.deepEqual(f.invokes, [], "it is not a menu item")
    assert.deepEqual(f.edits, [{ revision: 7, savedRevision: 3 }])
    assert.deepEqual(f.selected, [[Uuid(8)]])
    assert.deepEqual(f.state.notice.value, { title: "Reset", message: "Reset 1 light", warnings: [] })
    assert.deepEqual(f.notes, [["info", "Reset: Reset 1 light"]])
    assert.equal(f.state.running.value, null)
    assert.deepEqual(f.failures, [])
  })

  test("a button with a form asks it and sends the params", async () => {
    const f = fakeExtensions({ sections: [lights] })
    f.answers.form = { power: 4 }
    assert.equal(await f.state.runButton(set, Uuid(5), 4), "ok")
    assert.deepEqual(f.forms, ["light.set"])
    assert.deepEqual(f.inspectorInvokes[0].params, { power: 4 })
    assert.deepEqual(f.log.slice(0, 4), ["settle", "closeGroups", "form", "invokeInspector"])
  })

  test("Cancel in the form sends nothing and is not an error", async () => {
    const f = fakeExtensions({ sections: [lights] })
    f.answers.form = null
    assert.equal(await f.state.runButton(set, Uuid(5), 4), "cancelled")
    assert.deepEqual(f.inspectorInvokes, [])
    assert.deepEqual(f.failures, [])
  })

  test("a result's warnings reach the notice and the console", async () => {
    const f = fakeExtensions({ sections: [lights] })
    f.inspectorAnswer = { status: "ok", value: invokeResult({ message: "m", warnings: ["w1", "w2"] }) }
    await f.state.runButton(reset, Uuid(5), 4)
    assert.deepEqual(f.state.notice.value?.warnings, ["w1", "w2"])
    assert.deepEqual(f.notes, [["info", "Reset: m"], ["warn", "Reset: w1"], ["warn", "Reset: w2"]])
  })

  test("refused before anything is sent while the editor cannot write, or an edit group will not end", async () => {
    const f = fakeExtensions({ sections: [lights] })
    f.blocked.reason = "you are signed in as a viewer"
    assert.equal(await f.state.runButton(reset, Uuid(5), 4), "refused")
    assert.match(f.failures[0].message, /can't run now: you are signed in as a viewer/)
    assert.deepEqual(f.inspectorInvokes, [])

    f.blocked.reason = null
    f.stuckGroups.count = 1
    assert.equal(await f.state.runButton(reset, Uuid(5), 4), "refused")
    assert.match(f.failures[1].message, /edit is still in progress/)
    assert.deepEqual(f.inspectorInvokes, [])
    assert.equal(f.state.running.value, null)
  })

  test("a button is refused while another run is in progress", async () => {
    const f = fakeExtensions({ sections: [lights] })
    let release: () => void = () => {}
    f.inspectorAnswer = () => new Promise((resolve) => (release = () => resolve({ status: "ok", value: invokeResult() })))
    const first = f.state.runButton(reset, Uuid(5), 4)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.state.running.value, "light.reset")
    assert.equal(await f.state.runButton(reset, Uuid(6), 4), "refused")
    release()
    assert.equal(await first, "ok")
    assert.equal(f.inspectorInvokes.length, 1)
  })

  test("a stale revision refreshes the sections and reports it", async () => {
    const f = fakeExtensions({ sections: [lights] })
    await f.state.refresh()
    f.host.ui = { uiRevision: 9, menuItems: [], inspectorSections: [] }
    f.inspectorAnswer = { status: "error", kind: "staleUi", message: "stale", code: "staleUiRevision" }
    f.log.length = 0
    assert.equal(await f.state.runButton(reset, Uuid(5), 4), "failed")
    assert.match(f.failures[0].message, /inspector was refreshed/)
    assert.equal(f.failures[0].code, "staleUiRevision")
    assert.equal(f.state.uiRevision, 9, "the sections were fetched again")
    assert.deepEqual(f.state.sectionsFor("Light"), [])
    assert.ok(f.log.includes("list") && f.log.includes("ui"))
  })

  test("a failed button took its changes back: the scene is synced and the sections fetched again", async () => {
    const f = fakeExtensions({ sections: [lights] })
    f.inspectorAnswer = { status: "error", kind: "failed", message: "Lua error: boom", code: "extensionFailed" }
    f.log.length = 0
    assert.equal(await f.state.runButton(reset, Uuid(5), 4), "failed")
    assert.equal(f.failures[0].message, "Lua error: boom")
    assert.deepEqual(f.log.filter((s) => s === "sync" || s === "list"), ["sync", "list"])
    assert.deepEqual(f.edits, [])
  })

  test("a host that does not run buttons is refused, never sent to", async () => {
    const f = fakeExtensions({ sections: [lights] })
    f.inspectorAnswer = { status: "unsupported" }
    assert.equal(await f.state.runButton(reset, Uuid(5), 4), "refused")
    assert.match(f.failures[0].message, /protocol 1\.16\.0/)
  })
})

describe("the state's inspector sections", () => {
  const lights = inspectorSection("Light", { buttons: [inspectorButton("light.reset", "Reset")] })

  test("are offered by component type once the extensions are ready on a 1.16 host", async () => {
    const f = fakeExtensions({ sections: [lights, inspectorSection("Camera")] })
    assert.deepEqual(f.state.sectionsFor("Light"), [], "not read yet")
    await f.state.refresh()
    assert.deepEqual(f.state.sectionsFor("Light").map((s) => s.componentType), ["Light"])
    assert.deepEqual(f.state.sectionsFor("Mesh"), [])
  })

  test("are none on a 1.15 host, with extensions off, and after a disconnect", async () => {
    const old = fakeExtensions({ sections: [lights], info: serverInfo({ protocolVersion: "1.15.0" }) })
    await old.state.refresh()
    assert.equal(old.state.canInvokeInspector.value, false)
    assert.deepEqual(old.state.sectionsFor("Light"), [])

    const off = fakeExtensions({ sections: [lights], enabled: false })
    await off.state.refresh()
    assert.deepEqual(off.state.sectionsFor("Light"), [])

    const f = fakeExtensions({ sections: [lights] })
    await f.state.refresh()
    f.connected.value = false
    await f.state.refresh()
    assert.deepEqual(f.state.sectionsFor("Light"), [])
  })

  test("follow the host's extensionsChanged event", async () => {
    const f = fakeExtensions({ sections: [lights] })
    const stop = f.state.start()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.state.sectionsFor("Light").length, 1)
    f.host.ui = { uiRevision: 5, menuItems: [], inspectorSections: [inspectorSection("Light"), inspectorSection("Light")] }
    f.changeCount.value++
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.state.sectionsFor("Light").length, 2)
    assert.equal(f.state.uiRevision, 5)
    stop()
  })

  test("a viewer may not run buttons, an editor and an admin may", () => {
    const f = fakeExtensions({ sections: [lights], role: "viewer" })
    assert.equal(f.state.mayRunButtons.value, false)
    f.role.value = "editor"
    assert.equal(f.state.mayRunButtons.value, true)
    f.role.value = "admin"
    assert.equal(f.state.mayRunButtons.value, true)
  })

  test("a button's availability follows the extension's state and the editor's", async () => {
    const f = fakeExtensions({ sections: [lights], extensions: [summary({ state: "faulted" })] })
    await f.state.refresh()
    const [button] = lights.buttons
    assert.match(f.state.buttonAvailability(lights, button).reason ?? "", /disabled until an admin reloads it/)
    const ok = fakeExtensions({ sections: [lights] })
    await ok.state.refresh()
    assert.equal(ok.state.buttonAvailability(lights, button).enabled, true)
    ok.blocked.reason = "the host is read-only"
    assert.match(ok.state.buttonAvailability(lights, button).reason ?? "", /read-only/)
  })
})
