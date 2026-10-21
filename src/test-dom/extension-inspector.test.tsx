/// <reference path="../renderer/globals.d.ts" />
import "./setup"
import { test, describe, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import { cleanup, screen, waitFor, within } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { signal } from "@preact/signals-core"
import type { ComponentSchema, EntityDetails } from "../protocol/protocol.generated"
import type { InspectorSection } from "../protocol/extensions"
import { EditGroups } from "../renderer/edit-groups"
import { InspectorState } from "../renderer/inspector-state"
import { InspectorPanel } from "../renderer/inspector-panel"
import { ExtensionNotice } from "../renderer/extensions-ui"
import { FormDialog } from "../renderer/form-dialog"
import { ConfirmDialog, confirmDialog, formDialog, formRequest } from "../renderer/ui"
import type { Selection } from "../renderer/hierarchy-tree"
import { Uuid, fakeExtensions, field, inspectorButton, inspectorSection, invokeResult, serverInfo, summary } from "../test/fake-extensions"
import { renderWithApp } from "./helpers"

const lightType: ComponentSchema = {
  typeName: "Light",
  singleton: false,
  fields: [{ name: "intensity", displayName: "Intensity", kind: "Float", typeName: "float", hidden: false, readOnly: false }],
}
const cameraType: ComponentSchema = { typeName: "Camera", singleton: false, fields: [] }

const lightId = Uuid(5)
const cameraId = Uuid(6)
const evil = "<img src=x onerror=alert(1)>"

const powerForm = {
  fields: [field("power", "Float", { displayName: "Power", min: 0, max: 10 })],
  defaults: { power: 1 },
}

const lightSection = inspectorSection("Light", {
  label: "Light helpers",
  fields: [
    field("watts", "Float", { displayName: "Watts", readOnly: true }),
    field("mode", "String", { displayName: "Mode", readOnly: true }),
    field("secret", "String", { displayName: "Secret", hidden: true }),
  ],
  buttons: [inspectorButton("light.reset", "Reset"), inspectorButton("light.set", "Set power", { form: powerForm })],
})

/** An object with a Light and a Camera; the inspector shows it, over the page's real dialogs and the fake extensions */
async function mount(
  over: Parameters<typeof fakeExtensions>[0] = {},
  values: Record<string, unknown> = { isActive: true, intensity: 2, watts: 40, mode: "spot" }
) {
  const f = fakeExtensions({
    sections: [lightSection],
    ...over,
    run: {
      confirm: confirmDialog,
      askForm: async (item) => (item.form === undefined ? {} : formDialog(item.title, item.form, "Run")),
      ...over.run,
    },
  })
  await f.state.refresh()
  const engine = {
    isConnected: () => true,
    getEntity: async (id: string) => ({
      entity: {
        header: { id, parentId: "", index: 0, name: "Lamp", active: true, activeInHierarchy: true, layer: 0, tag: "" },
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
        components: [
          { type: "Light", uuid: lightId, values },
          { type: "Camera", uuid: cameraId, values: { isActive: true } },
        ],
      } as EntityDetails,
      worldMatrix: [],
    }),
    getComponentTypes: async () => [lightType, cameraType],
    addComponent: async () => ({ componentId: "x", values: {} }),
    removeComponent: async () => {},
    getLuaFields: async (): Promise<ComponentSchema> => ({ typeName: "LuaComponent", singleton: false, fields: [] }),
    setEntityProperties: async () => {},
    setComponentFields: async () => ({ isActive: true }),
    setLocalTransform: async () => {},
    beginEditGroup: async () => {},
    endEditGroup: async () => {},
  }
  const inspector = new InspectorState(engine, { listAssets: async () => [] }, { confirm: async () => true, onError: () => {}, groups: new EditGroups(engine) })
  await inspector.loadTypes()
  await inspector.select("e1")
  const reported: string[] = []
  const selection = signal<Selection>({ ids: new Set(["e1"]), anchor: "e1", primary: "e1" })
  renderWithApp(
    <>
      <InspectorPanel />
      <ExtensionNotice />
      <FormDialog />
      <ConfirmDialog />
    </>,
    {
      store: { connected: signal(true), reportError: (what: string, e: unknown) => void reported.push(`${what}: ${e}`) } as never,
      scene: { selectedId: signal<string | null>("e1") },
      hierarchy: { selection, deleteSelected: async () => {} } as never,
      inspector,
      extensions: f.state,
    }
  )
  return { f, inspector, reported, user: userEvent.setup() }
}

const sections = () => Array.from(document.querySelectorAll<HTMLElement>("[data-extension-section]"))
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement

beforeEach(() => {
  cleanup()
  formRequest.value = null
})

describe("an extension's inspector section", () => {
  test("is shown under the component of its type with its title, read-only fields and buttons", async () => {
    await mount()
    await screen.findByText("Light helpers")
    assert.equal(sections().length, 1, "only the Light has a section, not the Camera")
    const light = within(sections()[0])
    assert.ok(light.getByText("Light helpers"))
    // The component's values by field name, as text; a hidden field is not shown
    assert.ok(light.getByText("Watts"))
    assert.equal(light.getByText("Watts").parentElement?.querySelector(".extension-value")?.textContent, "40")
    assert.equal(light.getByText("Mode").parentElement?.querySelector(".extension-value")?.textContent, "spot")
    assert.equal(light.queryByText("Secret"), null)
    assert.ok(light.getByRole("button", { name: "Reset" }))
    assert.ok(light.getByRole("button", { name: "Set power..." }), "a button with a form ends in an ellipsis")
  })

  test("is inside the Light's card, and the Camera's card has none", async () => {
    await mount()
    await screen.findByText("Light helpers")
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".component-card"))
    assert.equal(cards.length, 2)
    assert.ok(cards[0].querySelector("[data-extension-section]"))
    assert.equal(cards[1].querySelector("[data-extension-section]"), null)
  })

  test("its fields are read-only text: no input of any kind", async () => {
    await mount()
    await screen.findByText("Light helpers")
    assert.equal(sections()[0].querySelector("input, select, textarea"), null)
  })

  test("a field the component has no value for shows a dash", async () => {
    await mount({}, { isActive: true, intensity: 2 })
    await screen.findByText("Light helpers")
    assert.equal(within(sections()[0]).getByText("Watts").parentElement?.querySelector(".extension-value")?.textContent, "-")
  })

  test("is not shown for a host before 1.16.0, with extensions off, or with no sections", async () => {
    await mount({ info: serverInfo({ protocolVersion: "1.15.0" }) })
    await screen.findByText("Components")
    assert.equal(sections().length, 0)
    cleanup()
    await mount({ enabled: false })
    await screen.findByText("Components")
    assert.equal(sections().length, 0)
    cleanup()
    await mount({ sections: [] })
    await screen.findByText("Components")
    assert.equal(sections().length, 0)
  })

  test("two sections for one type are both shown, in the host's order", async () => {
    await mount({ sections: [inspectorSection("Light", { label: "First" }), inspectorSection("Light", { label: "Second" })] })
    await screen.findByText("First")
    assert.deepEqual(sections().map((s) => s.querySelector("h5")?.textContent), ["First", "Second"])
  })
})

describe("an extension's text in the inspector is text", () => {
  test("a title, label, field name, value and tooltip with markup are shown as the characters they are", async () => {
    const hostile: InspectorSection = inspectorSection("Light", {
      label: evil,
      fields: [field("a", "String", { displayName: evil, tooltip: evil, readOnly: true })],
      buttons: [inspectorButton("b", evil)],
    })
    await mount({ sections: [hostile] }, { isActive: true, a: evil })
    await waitFor(() => assert.equal(sections().length, 1))
    const section = sections()[0]
    assert.equal(section.querySelector("img"), null, "no element was made from the text")
    assert.equal(section.querySelector("h5")?.textContent, evil)
    assert.equal(section.querySelector("label")?.textContent, evil)
    assert.equal(section.querySelector(".extension-value")?.textContent, evil)
    assert.equal(section.querySelector("button")?.textContent, evil)
    assert.equal(document.querySelector("img"), null)
  })

  test("the result of a button, with markup in its message and warnings, is text in the notice", async () => {
    const { f, user } = await mount()
    f.inspectorAnswer = { status: "ok", value: invokeResult({ message: evil, warnings: [evil] }) }
    await screen.findByText("Light helpers")
    await user.click(button("Reset"))
    await waitFor(() => assert.ok(document.querySelector(".extension-notice")))
    const notice = document.querySelector(".extension-notice")!
    assert.equal(notice.querySelector("img"), null)
    assert.ok((notice.textContent ?? "").includes(evil))
    assert.equal(notice.querySelector("li")?.textContent, evil)
  })
})

describe("pressing a button", () => {
  test("a button with no form runs on this component with the section's revision, and its result is shown", async () => {
    const { f, user } = await mount()
    f.inspectorAnswer = { status: "ok", value: invokeResult({ message: "Reset the light", select: [Uuid(9)] }) }
    await screen.findByText("Light helpers")
    await user.click(button("Reset"))
    await waitFor(() => assert.equal(f.inspectorInvokes.length, 1))
    assert.deepEqual(f.inspectorInvokes[0], { componentId: lightId, actionId: "light.reset", params: {}, uiRevision: 4 })
    assert.deepEqual(f.invokes, [])
    await waitFor(() => assert.match(document.querySelector(".extension-notice")?.textContent ?? "", /Reset: Reset the light/))
    assert.deepEqual(f.selected, [[Uuid(9)]], "the objects it asked for are selected, as for a menu item")
    assert.deepEqual(f.edits, [{ revision: 7, savedRevision: 3 }])
  })

  test("a button with a form opens it, and Run sends the values", async () => {
    const { f, user } = await mount()
    await screen.findByText("Light helpers")
    await user.click(button("Set power..."))
    const dialog = await screen.findByRole("dialog", { name: "Set power" })
    const power = within(dialog).getByRole("textbox", { name: "Power" }) as HTMLInputElement
    assert.equal(power.value, "1")
    await user.clear(power)
    await user.type(power, "4")
    await user.click(within(dialog).getByRole("button", { name: "Run" }))
    await waitFor(() => assert.equal(f.inspectorInvokes.length, 1))
    assert.deepEqual(f.inspectorInvokes[0], { componentId: lightId, actionId: "light.set", params: { power: 4 }, uiRevision: 4 })
    await waitFor(() => assert.equal(screen.queryByRole("dialog"), null))
  })

  test("Cancel in the form sends nothing", async () => {
    const { f, user } = await mount()
    await screen.findByText("Light helpers")
    await user.click(button("Set power..."))
    const dialog = await screen.findByRole("dialog", { name: "Set power" })
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => assert.equal(screen.queryByRole("dialog"), null))
    assert.deepEqual(f.inspectorInvokes, [])
  })

  test("the buttons are disabled while one runs", async () => {
    const { f, user } = await mount()
    let release: () => void = () => {}
    f.inspectorAnswer = () => new Promise((resolve) => (release = () => resolve({ status: "ok", value: invokeResult() })))
    await screen.findByText("Light helpers")
    await user.click(button("Reset"))
    await waitFor(() => assert.equal(button("Reset").disabled, true))
    assert.match(button("Reset").title, /running/)
    assert.equal(button("Set power...").disabled, true)
    release()
    await waitFor(() => assert.equal(button("Reset").disabled, false))
  })

  test("a host's refusal is reported, not thrown, and the panel stays", async () => {
    const { f, user } = await mount()
    f.inspectorAnswer = { status: "error", kind: "failed", message: "Lua error: boom", code: "extensionFailed" }
    await screen.findByText("Light helpers")
    await user.click(button("Reset"))
    await waitFor(() => assert.equal(f.failures.length, 1))
    assert.equal(f.failures[0].message, "Lua error: boom")
    assert.ok(screen.getByText("Light helpers"))
  })
})

describe("who may press a button", () => {
  test("a viewer sees the fields but no buttons", async () => {
    await mount({ role: "viewer" })
    await screen.findByText("Light helpers")
    const section = within(sections()[0])
    assert.ok(section.getByText("Watts"))
    assert.equal(section.queryAllByRole("button").length, 0)
  })

  test("an editor can press an editor button and is shown an admin button disabled, with the reason", async () => {
    const adminOnly = inspectorSection("Light", {
      buttons: [inspectorButton("a.ed", "Editor one"), inspectorButton("a.ad", "Admin one", { minRole: "admin" })],
    })
    const { f, user } = await mount({ sections: [adminOnly], role: "editor" })
    await screen.findByText("Editor one")
    assert.equal(button("Editor one").disabled, false)
    const admin = button("Admin one")
    assert.equal(admin.disabled, true)
    assert.match(admin.title, /admin role \(you are signed in as editor\)/)
    await user.click(admin)
    assert.deepEqual(f.inspectorInvokes, [])
  })

  test("an admin can press an admin button", async () => {
    const adminOnly = inspectorSection("Light", { buttons: [inspectorButton("a.ad", "Admin one", { minRole: "admin" })] })
    const { f, user } = await mount({ sections: [adminOnly], role: "admin" })
    await user.click(await screen.findByRole("button", { name: "Admin one" }))
    await waitFor(() => assert.equal(f.inspectorInvokes.length, 1))
  })

  test("a read-only host disables the buttons with the reason, and a click sends nothing", async () => {
    const { f, user } = await mount()
    f.blocked.reason = "the host is read-only"
    await screen.findByText("Light helpers")
    // The state reads the editor when the panel renders: a change of the connection role re-renders it
    f.role.value = "admin"
    f.role.value = "editor"
    await waitFor(() => assert.match(button("Reset").title, /Not available: the host is read-only/))
    assert.equal(button("Reset").disabled, true)
    await user.click(button("Reset"))
    assert.deepEqual(f.inspectorInvokes, [])
  })

  test("an extension that became faulted: its buttons stay, disabled, with the reason", async () => {
    await mount({ extensions: [summary({ state: "faulted" })] })
    await screen.findByText("Light helpers")
    assert.equal(button("Reset").disabled, true)
    assert.match(button("Reset").title, /disabled until an admin reloads it/)
  })

  test("when the role becomes viewer the buttons go", async () => {
    const { f } = await mount()
    await screen.findByText("Light helpers")
    assert.ok(button("Reset"))
    f.role.value = "viewer"
    await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Reset" }), null))
    assert.ok(screen.getByText("Light helpers"))
  })
})

describe("the sections follow the host", () => {
  test("an extensionsChanged event shows the new sections", async () => {
    const { f } = await mount()
    f.state.start()
    await screen.findByText("Light helpers")
    f.host.ui = { uiRevision: 5, menuItems: [], inspectorSections: [inspectorSection("Light", { label: "Reloaded section" })] }
    f.changeCount.value++
    await screen.findByText("Reloaded section")
    assert.equal(screen.queryByText("Light helpers"), null)
  })

  test("a stale revision: the press is refused by the host, the user is told, and the sections are fetched again", async () => {
    const { f, user } = await mount()
    await screen.findByText("Light helpers")
    // The host reloaded its extensions after the sections were built
    f.host.ui = { uiRevision: 9, menuItems: [], inspectorSections: [inspectorSection("Light", { label: "After reload", buttons: [inspectorButton("light.reset", "Reset")] })] }
    f.inspectorAnswer = { status: "error", kind: "staleUi", message: "stale", code: "staleUiRevision" }
    await user.click(button("Reset"))
    await waitFor(() => assert.equal(f.failures.length, 1))
    assert.match(f.failures[0].message, /inspector was refreshed/)
    assert.equal(f.failures[0].code, "staleUiRevision")
    assert.equal(f.inspectorInvokes[0].uiRevision, 4, "it was sent with the revision the section was built from")
    await screen.findByText("After reload")
    await user.click(button("Reset"))
    await waitFor(() => assert.equal(f.inspectorInvokes.length, 2))
    assert.equal(f.inspectorInvokes[1].uiRevision, 9, "and the next press with the new one")
  })
})
