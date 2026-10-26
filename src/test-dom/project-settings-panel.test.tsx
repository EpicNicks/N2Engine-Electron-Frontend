import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { ProjectSettingsView } from "../renderer/project-settings-panel"
import { SectionRegistry } from "../renderer/project-settings-registry"
import { settingsSections } from "../renderer/project-settings-sections"
import { fakeProjectHost, settleTasks } from "./fake-project-host"

async function shown(options: Parameters<typeof fakeProjectHost>[0] = {}) {
  const h = fakeProjectHost(options)
  const view = render(<ProjectSettingsView model={h.model} />)
  await act(async () => {
    await settleTasks()
  })
  return { h, view }
}

const open = async (title: string) => {
  await userEvent.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByText(title))
}
const apply = () => screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement

describe("the project settings panel", () => {
  test("lists the sections in order, General first, with the project facts", async () => {
    await shown()
    const titles = within(screen.getByRole("navigation", { name: "Settings sections" }))
      .getAllByRole("button")
      .map((b) => b.querySelector(".ps-item-title")?.textContent)
    assert.deepEqual(titles, ["General", "Physics", "Physics backend", "Rendering", "Math", "Determinism", "Layers", "Network", "Extensions", "Input", "Raw JSON"])
    assert.ok(screen.getByText("Demo"))
    assert.ok(screen.getByText("1.2.3"))
  })

  test("not connected: nothing to edit", async () => {
    const h = fakeProjectHost()
    h.connected.value = false
    render(<ProjectSettingsView model={h.model} />)
    await act(async () => {
      await settleTasks()
    })
    assert.ok(screen.getByText("Not connected"))
  })

  test("editing a field marks it and the section dirty; Apply sends only that key and the form follows the host", async () => {
    const { h } = await shown()
    await open("Physics")
    assert.equal(apply().disabled, true)
    const field = screen.getByLabelText("Fixed timestep") as HTMLInputElement
    assert.equal(field.value, "0.02")
    await userEvent.clear(field)
    await userEvent.type(field, "0.01")
    await waitFor(() => assert.equal(apply().disabled, false))
    assert.ok(screen.getByTitle("Unsaved changes"))
    await userEvent.click(apply())
    await waitFor(() => assert.deepEqual(h.patches, [{ physics: { fixedTimestep: 0.01 } }]))
    await waitFor(() => assert.equal(apply().disabled, true))
    assert.equal((screen.getByLabelText("Fixed timestep") as HTMLInputElement).value, "0.01")
  })

  test("Revert puts the host's values back", async () => {
    const { h } = await shown()
    await open("Physics")
    await userEvent.clear(screen.getByLabelText("Fixed timestep"))
    await userEvent.type(screen.getByLabelText("Fixed timestep"), "0.5")
    await userEvent.click(screen.getByRole("button", { name: "Revert" }))
    await waitFor(() => assert.equal((screen.getByLabelText("Fixed timestep") as HTMLInputElement).value, "0.02"))
    assert.deepEqual(h.patches, [])
  })

  test("an out-of-range value shows its error and Apply stays off", async () => {
    await shown()
    await open("Physics")
    await userEvent.clear(screen.getByLabelText("Fixed timestep"))
    await userEvent.type(screen.getByLabelText("Fixed timestep"), "-1")
    await waitFor(() => assert.match(screen.getByRole("alert").textContent ?? "", /greater than 0/))
    assert.equal(apply().disabled, true)
  })

  test("a restart-needed field has its badge, and after Apply the note and a Restart host button", async () => {
    const { h } = await shown()
    await open("Physics")
    const badges = document.querySelectorAll(".ps-badge.restart")
    // gpu, deterministic and backend, and not the timestep or gravity
    assert.equal(badges.length, 3)
    await userEvent.selectOptions(screen.getByLabelText("GPU physics"), "auto")
    await userEvent.click(apply())
    const note = await screen.findByText(/Takes effect after the host restarts: physics.gpu/)
    assert.ok(note)
    await userEvent.click(screen.getByRole("button", { name: "Restart host" }))
    assert.equal(h.restarts(), 1)
  })

  test("a remote host has no Restart host button", async () => {
    await shown({ restartable: false })
    await open("Physics")
    await userEvent.selectOptions(screen.getByLabelText("GPU physics"), "auto")
    await userEvent.click(apply())
    await screen.findByText(/Takes effect after the host restarts/)
    assert.equal(screen.queryByRole("button", { name: "Restart host" }), null)
  })

  test("a host refusal is shown under the section and the edit is still there", async () => {
    const { h } = await shown()
    await open("Physics")
    await userEvent.selectOptions(screen.getByLabelText("Physics backend"), "jolt")
    h.refuseNext("Project settings refused: physics.backend: no such backend")
    await userEvent.click(apply())
    const alert = await screen.findByText(/no such backend/)
    assert.ok(alert)
    assert.match(screen.getByText(/your edits are kept/).textContent ?? "", /kept/)
    assert.equal((screen.getByLabelText("Physics backend") as HTMLSelectElement).value, "jolt")
    assert.equal(apply().disabled, false)
  })

  test("Restore previous values follows an Apply", async () => {
    await shown()
    await open("Physics")
    const restore = () => screen.getByRole("button", { name: "Restore previous values" }) as HTMLButtonElement
    assert.equal(restore().disabled, true)
    await userEvent.clear(screen.getByLabelText("Fixed timestep"))
    await userEvent.type(screen.getByLabelText("Fixed timestep"), "0.01")
    await userEvent.click(apply())
    await waitFor(() => assert.equal(restore().disabled, false))
    await userEvent.click(restore())
    await waitFor(() => assert.equal((screen.getByLabelText("Fixed timestep") as HTMLInputElement).value, "0.02"))
    assert.equal(apply().disabled, false)
  })

  test("the footer says settings are not in the undo history", async () => {
    await shown()
    assert.match(screen.getByText(/not part of the undo history/).textContent ?? "", /Ctrl\+Z/)
  })

  test("General: the startup scene picker applies with SetStartupScene", async () => {
    const { h } = await shown()
    const picker = screen.getByLabelText("Startup scene") as HTMLSelectElement
    assert.equal(picker.value, "res://scenes/main.scene")
    await userEvent.selectOptions(picker, "res://scenes/two.scene")
    await userEvent.click(apply())
    await waitFor(() => assert.deepEqual(h.startups, ["res://scenes/two.scene"]))
    assert.deepEqual(h.patches, [])
  })

  test("Layers: names are editable, the built-in ones are not, a duplicate is refused", async () => {
    const { h } = await shown()
    await open("Layers")
    assert.equal((screen.getByLabelText("Layer 0") as HTMLInputElement).disabled, true)
    assert.equal((screen.getByLabelText("Layer 0") as HTMLInputElement).value, "Default")
    await userEvent.type(screen.getByLabelText("Layer 6"), "Water")
    await waitFor(() => assert.match(screen.getByRole("alert").textContent ?? "", /used twice/))
    assert.equal(apply().disabled, true)
    await userEvent.clear(screen.getByLabelText("Layer 6"))
    await userEvent.type(screen.getByLabelText("Layer 6"), "Enemies")
    await waitFor(() => assert.equal(apply().disabled, false))
    await userEvent.click(apply())
    await waitFor(() => assert.equal(h.patches.length, 1))
    const layers = (h.patches[0].layers as { layers: string[] }).layers
    assert.equal(layers[6], "Enemies")
    assert.equal(layers.length, 32)
  })

  test("Input: invalid JSON is flagged and never sent; valid is sent as a minimal patch", async () => {
    const { h } = await shown({ settings: { input: { actionMaps: { a: { x: 1 } } } } })
    await open("Input")
    const box = screen.getByLabelText("Input as JSON") as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: "{ not json" } })
    await waitFor(() => assert.match(screen.getByRole("alert").textContent ?? "", /Not valid JSON/))
    assert.equal(apply().disabled, true)
    fireEvent.input(box, { target: { value: '{"actionMaps": {"a": {"x": 1}, "b": {"y": 2}}}' } })
    await waitFor(() => assert.equal(apply().disabled, false))
    await userEvent.click(apply())
    await waitFor(() => assert.deepEqual(h.patches, [{ input: { actionMaps: { b: { y: 2 } } } }]))
  })

  test("Raw JSON: Apply asks first; declined writes nothing", async () => {
    const { h } = await shown()
    await open("Raw JSON")
    const box = screen.getByLabelText("Raw JSON as JSON") as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: JSON.stringify({ ...h.settings(), extra: { a: 1 } }) } })
    await waitFor(() => assert.equal(apply().disabled, false))
    h.answerConfirm(false)
    await userEvent.click(apply())
    await waitFor(() => assert.equal(h.confirms.length, 1))
    assert.deepEqual(h.patches, [])
    h.answerConfirm(true)
    await userEvent.click(apply())
    await waitFor(() => assert.deepEqual(h.patches, [{ extra: { a: 1 } }]))
  })

  describe("determinism", () => {
    test("an admin sees the seed warning and can set the seed (restart badge)", async () => {
      const { h } = await shown({ role: "admin" })
      await open("Determinism")
      assert.match(screen.getByRole("note").textContent ?? "", /hash flooding/)
      assert.ok(document.querySelector(".ps-badge.restart"))
      const seed = screen.getByLabelText("Lua seed") as HTMLInputElement
      assert.equal(seed.disabled, false)
      await userEvent.type(seed, "42")
      await userEvent.click(apply())
      await waitFor(() => assert.deepEqual(h.patches, [{ determinism: { luaSeed: 42 } }]))
    })

    test("an editor sees it disabled with the reason and can't apply", async () => {
      const { h } = await shown({ role: "editor", settings: { determinism: { luaSeed: 5 } } })
      await open("Determinism")
      const seed = screen.getByLabelText("Lua seed") as HTMLInputElement
      assert.equal(seed.disabled, true)
      assert.equal(seed.value, "5")
      assert.match(screen.getByRole("status").textContent ?? "", /Only an admin/)
      assert.equal(apply().disabled, true)
      assert.match(screen.getByRole("note").textContent ?? "", /hash flooding/)
      assert.deepEqual(h.patches, [])
      // while the physics form is open to the editor
      await open("Physics")
      assert.equal((screen.getByLabelText("Fixed timestep") as HTMLInputElement).disabled, false)
    })

    test("a forbidden answer is shown, the edit kept, and the section turns read-only", async () => {
      const { h } = await shown({ role: "admin" })
      await open("Determinism")
      await userEvent.type(screen.getByLabelText("Lua seed"), "9")
      h.refuseNext("forbidden: role editor is not allowed to change the project's 'determinism' settings", "forbidden")
      await userEvent.click(apply())
      await screen.findByText(/not allowed to change the project's 'determinism' settings/)
      await waitFor(() => assert.equal((screen.getByLabelText("Lua seed") as HTMLInputElement).disabled, true))
      assert.equal((screen.getByLabelText("Lua seed") as HTMLInputElement).value, "9")
    })
  })

  test("read-only (a viewer, a read-only host or a play session): every control is disabled and nothing applies", async () => {
    const { h } = await shown()
    await open("Physics")
    await userEvent.clear(screen.getByLabelText("Fixed timestep"))
    await userEvent.type(screen.getByLabelText("Fixed timestep"), "0.01")
    await act(async () => {
      h.readOnlyReason.value = "you are signed in as a viewer, who can look but not change anything or play"
    })
    await waitFor(() => assert.equal((screen.getByLabelText("Fixed timestep") as HTMLInputElement).disabled, true))
    assert.equal((screen.getByLabelText("GPU physics") as HTMLSelectElement).disabled, true)
    assert.match(screen.getByRole("status").textContent ?? "", /Read-only: you are signed in as a viewer/)
    assert.equal(apply().disabled, true)
    await open("Raw JSON")
    assert.equal((screen.getByLabelText("Raw JSON as JSON") as HTMLTextAreaElement).disabled, true)
    assert.deepEqual(h.patches, [])
  })

  test("a section registered by a later change appears in the list and works, the panel unchanged", async () => {
    const registry = new SectionRegistry<unknown>()
    for (const def of settingsSections.list()) registry.register(def)
    registry.register({
      id: "later",
      title: "Later",
      order: 75,
      component: () => <p>Later goes here</p>,
    })
    const h = fakeProjectHost({ registry })
    render(<ProjectSettingsView model={h.model} />)
    await act(async () => {
      await settleTasks()
    })
    await open("Later")
    assert.ok(screen.getByText("Later goes here"))
    // no Apply bar for a section without logic
    assert.equal(screen.queryByRole("button", { name: "Apply" }), null)
    const titles = within(screen.getByRole("navigation", { name: "Settings sections" }))
      .getAllByRole("button")
      .map((b) => b.querySelector(".ps-item-title")?.textContent)
    assert.deepEqual(titles.slice(6, 10), ["Layers", "Network", "Later", "Extensions"])
  })
})
