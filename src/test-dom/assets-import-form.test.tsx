/// <reference path="../renderer/globals.d.ts" />
import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { act, screen, waitFor } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { AssetsState } from "../renderer/assets-state"
import { AssetsPanel } from "../renderer/assets-panel"
import { renderWithApp } from "./helpers"
import { FakeAssetHost, U4, stubStore } from "./panel-fakes"

/** The panel with one asset of each typed kind selected in turn; the host keeps the settings it was sent */
async function renderPanel(settings: Record<string, unknown> = {}) {
  const host = new FakeAssetHost()
  host.assets.push({ path: "res://ship.glb", uuid: U4, type: "Model", size: 1, modified: 1 })
  host.assets.push({ path: "res://ui.ttf", uuid: "55555555-5555-5555-5555-555555555555", type: "Font", size: 1, modified: 1 })
  let stored: Record<string, unknown> = settings
  const sent: string[] = []
  host.engine.getAssetInfo = (async (path: string) => {
    const asset = host.assets.find((a) => a.path === path)!
    return { ...asset, customData: structuredClone(stored), loaded: true }
  }) as typeof host.engine.getAssetInfo
  host.engine.setImportSettings = (async (path: string, customData: unknown) => {
    sent.push(`${path} ${JSON.stringify(customData)}`)
    stored = customData as Record<string, unknown>
  }) as typeof host.engine.setImportSettings
  const fake = stubStore()
  const assets = new AssetsState(host.engine, null, fake.signals.reportError, () => fake.signals.readOnlyReason.peek())
  await assets.refresh()
  renderWithApp(<AssetsPanel />, { store: fake.store, assets })
  return { host, assets, sent, ...fake }
}

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement
const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement
const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement

describe("the typed import settings form", () => {
  test("a texture shows its fields with the engine's defaults; a choice is applied as the texture block", async () => {
    const t = await renderPanel()
    await act(() => t.assets.select("res://hero.png"))
    await screen.findByRole("group", { name: "Texture import settings" })
    assert.equal(select("Filter").value, "")
    assert.equal(select("Filter").options[0].textContent, "Default (linear)")
    assert.deepEqual(
      Array.from(select("Wrap").options).map((o) => o.value),
      ["", "repeat", "clamp"]
    )
    assert.equal(select("sRGB colour").options[0].textContent, "Default (true)")
    assert.equal(button("Apply").disabled, true)
    assert.equal(button("Revert").disabled, true)

    const user = userEvent.setup()
    await user.selectOptions(select("Filter"), "nearest")
    await user.selectOptions(select("Flip Y"), "false")
    assert.equal(button("Apply").disabled, false)
    await user.click(button("Apply"))
    await waitFor(() => assert.deepEqual(t.sent, ['res://hero.png {"texture":{"filter":"nearest","flipY":false}}']))
    await waitFor(() => assert.equal(button("Apply").disabled, true))
    assert.equal(select("Filter").value, "nearest")
  })

  test("a model's scale out of range shows its error and Apply stays off; a valid one enables it", async () => {
    const t = await renderPanel()
    await act(() => t.assets.select("res://ship.glb"))
    await screen.findByRole("group", { name: "Model import settings" })
    assert.equal(input("Scale").placeholder, "1")
    const user = userEvent.setup()
    await user.type(input("Scale"), "-2")
    assert.match(screen.getByRole("alert").textContent ?? "", /Scale must be a number above 0/)
    assert.equal(button("Apply").disabled, true)
    assert.equal(input("Scale").getAttribute("aria-invalid"), "true")
    await user.clear(input("Scale"))
    await user.type(input("Scale"), "0.01")
    assert.equal(screen.queryByRole("alert"), null)
    assert.equal(button("Apply").disabled, false)
    await user.click(button("Apply"))
    await waitFor(() => assert.deepEqual(t.sent, ['res://ship.glb {"model":{"scale":0.01}}']))
  })

  test("Revert puts the host's values back in the fields", async () => {
    const t = await renderPanel({ font: { basePx: 32, charset: "ascii" } })
    await act(() => t.assets.select("res://ui.ttf"))
    await screen.findByRole("group", { name: "Font import settings" })
    assert.equal(input("Base size").value, "32")
    assert.equal(select("Charset").value, "ascii")
    const user = userEvent.setup()
    await user.clear(input("Base size"))
    await user.type(input("Base size"), "64")
    await user.selectOptions(select("Charset"), "")
    assert.equal(button("Revert").disabled, false)
    await user.click(button("Revert"))
    assert.equal(input("Base size").value, "32")
    assert.equal(select("Charset").value, "ascii")
    assert.equal(button("Revert").disabled, true)
  })

  test("keys the form does not know are kept, shown, and sent back with the change", async () => {
    const t = await renderPanel({ texture: { anisotropy: 8 }, custom: { a: 1 } })
    await act(() => t.assets.select("res://hero.png"))
    await screen.findByRole("group", { name: "Texture import settings" })
    assert.ok(screen.getByText(/Kept, not read by the engine: texture\.anisotropy/))
    assert.match(screen.getByLabelText("Other import settings").textContent ?? "", /"custom"/)
    await userEvent.setup().selectOptions(select("Wrap"), "clamp")
    await userEvent.setup().click(button("Apply"))
    await waitFor(() =>
      assert.deepEqual(t.sent, ['res://hero.png {"texture":{"anisotropy":8,"wrap":"clamp"},"custom":{"a":1}}'])
    )
  })

  test("Edit as JSON shows the text of the same settings, and Edit as form comes back to the fields", async () => {
    const t = await renderPanel({ texture: { filter: "nearest" } })
    await act(() => t.assets.select("res://hero.png"))
    await screen.findByRole("group", { name: "Texture import settings" })
    const user = userEvent.setup()
    await user.click(button("Edit as JSON"))
    const text = screen.getByLabelText("Import settings") as HTMLTextAreaElement
    assert.deepEqual(JSON.parse(text.value), { texture: { filter: "nearest" } })
    // Not JSON: the form can't show it, so the switch back is off until it is
    act(() => t.assets.editSettings("{ nope"))
    assert.equal(button("Edit as form").disabled, true)
    act(() => t.assets.editSettings('{ "texture": { "wrap": "clamp" } }'))
    await user.click(button("Edit as form"))
    assert.equal(select("Wrap").value, "clamp")
    assert.equal(select("Filter").value, "")
  })

  test("a value the engine would ignore, written as JSON, shows as written with its error, and Apply is off", async () => {
    const t = await renderPanel({ texture: { filter: "Nearest" } })
    await act(() => t.assets.select("res://hero.png"))
    await screen.findByRole("group", { name: "Texture import settings" })
    assert.equal(select("Filter").value, "Nearest")
    assert.match(screen.getByRole("alert").textContent ?? "", /Filter must be "linear" or "nearest"/)
    act(() => t.assets.editSettingField("mipmaps", "false"))
    assert.equal(button("Apply").disabled, true)
  })

  test("a font spread too large for the base size is a warning; Apply still sends it", async () => {
    const t = await renderPanel()
    await act(() => t.assets.select("res://ui.ttf"))
    await screen.findByRole("group", { name: "Font import settings" })
    await userEvent.setup().type(input("Base size"), "10")
    assert.ok(screen.getByText("SDF spread 8 is too large for base size 10: the engine uses 5"))
    assert.equal(button("Apply").disabled, false)
  })

  test("types without a form keep the JSON editor and no switch", async () => {
    const t = await renderPanel()
    await act(() => t.assets.select("res://scripts/a.lua"))
    await screen.findByLabelText("Import settings")
    assert.equal(screen.queryByRole("button", { name: "Edit as JSON" }), null)
    assert.equal(screen.queryByRole("group"), null)
  })

  test("a read-only host or a play session disables the fields and Apply and says why", async () => {
    const t = await renderPanel()
    await act(() => t.assets.select("res://hero.png"))
    await screen.findByRole("group", { name: "Texture import settings" })
    act(() => {
      t.signals.playMode.value = "A play session is running"
    })
    assert.equal(select("Filter").disabled, true)
    assert.equal(button("Apply").disabled, true)
    assert.ok(screen.getByText("Read only: A play session is running"))
    act(() => {
      t.signals.playMode.value = null
      t.signals.hostReadOnly.value = true
    })
    assert.equal(select("Wrap").disabled, true)
    act(() => {
      t.signals.hostReadOnly.value = false
    })
    assert.equal(select("Wrap").disabled, false)
  })

  test("an invalid number draft does not keep Apply off after Edit as JSON (the draft is dropped)", async () => {
    const t = await renderPanel()
    await act(() => t.assets.select("res://ship.glb"))
    await screen.findByRole("group", { name: "Model import settings" })
    const user = userEvent.setup()
    await user.type(input("Scale"), "-2")
    assert.equal(button("Apply").disabled, true)
    await user.click(button("Edit as JSON"))
    await screen.findByLabelText("Import settings")
    assert.equal(button("Apply").disabled, true, "nothing is edited: the text is the host's")
    assert.equal(button("Revert").disabled, true)
    act(() => t.assets.editSettings('{"model":{"scale":2}}'))
    assert.equal(button("Apply").disabled, false)
    await user.click(button("Apply"))
    await waitFor(() => assert.deepEqual(t.sent, ['res://ship.glb {"model":{"scale":2}}']))
  })

  test("typing 1.0 for a stored 1 is not an edit", async () => {
    const t = await renderPanel({ model: { scale: 1 } })
    await act(() => t.assets.select("res://ship.glb"))
    await screen.findByRole("group", { name: "Model import settings" })
    const user = userEvent.setup()
    await user.clear(input("Scale"))
    await user.type(input("Scale"), "1.0")
    assert.equal(button("Apply").disabled, true)
    assert.equal(button("Revert").disabled, true)
  })
})
