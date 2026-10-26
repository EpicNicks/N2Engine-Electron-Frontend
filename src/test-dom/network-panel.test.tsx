import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { act, render, screen, waitFor, within } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { ProjectSettingsView } from "../renderer/project-settings-panel"
import { fakeProjectHost, settleTasks } from "./fake-project-host"

async function shown(options: Parameters<typeof fakeProjectHost>[0] = {}) {
  const h = fakeProjectHost(options)
  render(<ProjectSettingsView model={h.model} />)
  await act(async () => {
    await settleTasks()
  })
  await userEvent.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByText("Network"))
  await act(async () => {
    await settleTasks()
  })
  return h
}

const card = (name: string) => within(screen.getByRole("group", { name }))
const useButton = (name: string) => card(name).getByRole("button", { name: /Use this preset|Chosen|Choosing/ }) as HTMLButtonElement
const rowOf = (key: string) => within(document.querySelector(`[data-row="${key}"]`) as HTMLElement)

describe("the Network panel (FE-B11)", () => {
  test("shows three preset cards, the project's preset marked, and the takes-effect note", async () => {
    await shown({ settings: { network: { preset: "authoritative" } } })
    assert.ok(screen.getByRole("group", { name: "None" }))
    assert.ok(screen.getByRole("group", { name: "Server authoritative" }))
    assert.ok(screen.getByRole("group", { name: "Deterministic lockstep/rollback" }))
    assert.ok(card("Server authoritative").getByText("project preset"))
    assert.equal(useButton("Server authoritative").disabled, true)
    assert.equal(useButton("None").disabled, false)
    assert.ok(screen.getAllByText(/Takes effect at the next play session or host start\./).length >= 1)
  })

  test("Deterministic is disabled with the host's unavailableReason when no backend can carry it", async () => {
    const h = await shown({ network: { deterministicBackends: [] } })
    const button = useButton("Deterministic lockstep/rollback")
    assert.equal(button.disabled, true)
    assert.match(button.title, /does not declare CrossPlatform determinism/)
    assert.ok(card("Deterministic lockstep/rollback").getByText(/qualifying backends in this build: none/))
    await userEvent.click(button)
    assert.deepEqual(h.networkSets, [])
  })

  test("choosing a preset calls SetNetworkSettings and says it takes effect at the next start", async () => {
    const h = await shown()
    await userEvent.click(useButton("Server authoritative"))
    await waitFor(() => assert.deepEqual(h.networkSets, [{ preset: "authoritative", settings: {} }]))
    await waitFor(() => assert.ok(screen.getByText(/Saved \(preset authoritative\)\./)))
    assert.deepEqual((h.settings().network as { preset: string }).preset, "authoritative")
    assert.ok(card("Server authoritative").getByText("project preset"))
    assert.equal(useButton("Server authoritative").disabled, true)
  })

  test("the bundle table shows locked and tunable rows with the preset value, the current value and the source", async () => {
    await shown({ settings: { network: { preset: "deterministic" }, physics: { backend: "jolt", gpu: "on" } } })
    const gpu = rowOf("physics.gpu")
    assert.ok(gpu.getByText("locked"))
    assert.ok(gpu.getByText("checked at start"))
    assert.ok(gpu.getByText(/Loses: GPU dynamics is not deterministic/))
    assert.ok(gpu.getByText("Project file"))
    const tick = rowOf("network.tickRate")
    assert.ok(tick.getByText("tunable"))
    assert.equal((tick.getByLabelText("Tick rate") as HTMLInputElement).value, "60")
    // A locked row can't be edited here
    assert.equal(gpu.queryByRole("spinbutton"), null)
    assert.equal(gpu.queryByRole("textbox"), null)
  })

  test("a customised project lists the guarantees it loses", async () => {
    await shown({ settings: { network: { preset: "deterministic" }, physics: { backend: "jolt", gpu: "on" } } })
    const note = document.querySelector("[data-customised]") as HTMLElement
    assert.ok(note)
    assert.match(note.textContent!, /physics\.gpu/)
    assert.match(note.textContent!, /peers desync/)
  })

  test("editing a tunable row and pressing Apply sends only that row; out-of-range values are stopped before sending", async () => {
    const h = await shown({ settings: { network: { preset: "authoritative" } } })
    const input = rowOf("network.tickRate").getByLabelText("Tick rate") as HTMLInputElement
    await userEvent.clear(input)
    await userEvent.type(input, "500")
    assert.ok(screen.getAllByText("Must be between 30 and 120").length >= 1)
    assert.equal((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled, true)
    await userEvent.clear(input)
    await userEvent.type(input, "120")
    await userEvent.click(screen.getByRole("button", { name: "Apply" }))
    await waitFor(() => assert.deepEqual(h.networkSets, [{ preset: "", settings: { tickRate: 120 } }]))
    await waitFor(() => assert.ok(screen.getByText(/Saved \(settings\)\./)))
    assert.equal((rowOf("network.tickRate").getByLabelText("Tick rate") as HTMLInputElement).value, "120")
  })

  test("another preset's bundle can be viewed but not edited, and its requirements are checked", async () => {
    const h = await shown({ settings: { network: { preset: "authoritative" }, physics: { backend: "jolt" } } })
    await userEvent.click(card("Deterministic lockstep/rollback").getByRole("button", { name: "View bundle" }))
    await waitFor(() => assert.ok(screen.getByRole("table", { name: "Deterministic lockstep/rollback bundle" })))
    assert.deepEqual(h.validationAsked.at(-1), "deterministic")
    assert.equal(rowOf("network.tickRate").queryByLabelText("Tick rate"), null)
    assert.ok(screen.getByText(/can't be edited here/))
  })

  test("the validation report lists met and unmet requirements; a fix button applies the patch through SetProjectSettings", async () => {
    const h = await shown({ settings: { network: { preset: "deterministic" }, physics: { backend: "jolt" } } })
    const reqs = within(screen.getByRole("list", { name: "Requirements" }))
    assert.ok(screen.getByText(/2 of 4 requirements are unmet/))
    assert.ok(screen.getAllByText(/refuse to start this project/).length >= 1)
    const simd = within(document.querySelector('[data-requirement="simd-scalar"]') as HTMLElement)
    assert.ok(simd.getByText("Unmet"))
    assert.ok(reqs.getAllByText("Met").length === 2)
    await userEvent.click(simd.getByRole("button", { name: "Set math.simdTier to scalar" }))
    await waitFor(() => assert.deepEqual(h.patches, [{ math: { simdTier: "scalar" } }]))
    assert.deepEqual(h.networkSets, [])
    await waitFor(() => assert.ok(screen.getByText(/Saved \(fix: Set math\.simdTier to scalar\)\./)))
    assert.ok(within(document.querySelector('[data-requirement="simd-scalar"]') as HTMLElement).getByText("Met"))
    // A requirement with no fix has no button
    assert.equal(within(document.querySelector('[data-requirement="strict-fp"]') as HTMLElement).queryByRole("button"), null)
  })

  test("Server authoritative shows the host's warnings, which do not stop anything", async () => {
    await shown({ settings: { network: { preset: "authoritative" }, physics: { gpu: "on" } } })
    assert.ok(screen.getByRole("list", { name: "Warnings" }))
    assert.ok(screen.getByText(/physics\.gpu is on/))
    assert.equal(screen.queryByText(/refuse to start/), null)
  })

  test("the nudge is shown when the project looks networked but has no model", async () => {
    await shown({ network: { networkObjects: 3 } })
    const nudge = document.querySelector("[data-nudge]") as HTMLElement
    assert.ok(nudge)
    assert.match(nudge.textContent!, /no network model/)
  })

  test("no nudge for a project that has a preset", async () => {
    await shown({ settings: { network: { preset: "authoritative" } }, network: { networkObjects: 3 } })
    assert.equal(document.querySelector("[data-nudge]"), null)
  })

  test("a host without the networkPanel capability reads nothing and says so", async () => {
    const h = await shown({ networkSupported: false })
    assert.ok(screen.getByText(/does not have the networkPanel capability/))
    assert.equal(h.networkReads.settings, 0)
    assert.equal(screen.queryByRole("group", { name: "None" }), null)
  })

  test("read-only: the cards and the fixes are off with the reason, the report still shows", async () => {
    const h = fakeProjectHost({ settings: { network: { preset: "deterministic" }, physics: { backend: "jolt" } } })
    h.readOnlyReason.value = "a game is running"
    render(<ProjectSettingsView model={h.model} />)
    await act(async () => {
      await settleTasks()
    })
    await userEvent.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByText("Network"))
    await act(async () => {
      await settleTasks()
    })
    assert.equal(useButton("None").disabled, true)
    assert.match(useButton("None").title, /Read-only: a game is running/)
    const fix = screen.getByRole("button", { name: "Set math.simdTier to scalar" }) as HTMLButtonElement
    assert.equal(fix.disabled, true)
    assert.ok(screen.getByText(/requirements are unmet/))
  })

  test("the host's refusal is shown as it said it", async () => {
    const h = await shown()
    h.refuseNetworkNext("Not available in a play host")
    await userEvent.click(useButton("Server authoritative"))
    await waitFor(() => assert.ok(screen.getByText("The host refused it.")))
    assert.ok(screen.getByText("Not available in a play host"))
    assert.equal(screen.queryByText(/Saved \(/), null)
  })

  test("the panel is read again when the project changes", async () => {
    const h = await shown()
    const before = h.networkReads.settings
    await act(async () => {
      h.projectChangeCount.value++
      await settleTasks()
    })
    assert.ok(h.networkReads.settings > before)
  })
})
