import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { act, render, screen, waitFor, within } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { ProjectSettingsView } from "../renderer/project-settings-panel"
import { fakeBackend } from "../test/fake-backends"
import { fakeProjectHost, settleTasks } from "./fake-project-host"

async function shown(options: Parameters<typeof fakeProjectHost>[0] = {}) {
  const h = fakeProjectHost(options)
  render(<ProjectSettingsView model={h.model} />)
  await act(async () => {
    await settleTasks()
  })
  await userEvent.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByText("Physics backend"))
  await act(async () => {
    await settleTasks()
  })
  return h
}

const card = (id: string) => within(screen.getByRole("group", { name: id === "physx" ? "PhysX" : "Jolt" }))
const useButton = (id: string) => card(id).getByRole("button") as HTMLButtonElement

const jolt = fakeBackend({ id: "jolt", displayName: "Jolt", determinism: "CrossPlatform", deterministicSelectable: true })
const physx = fakeBackend({ id: "physx", displayName: "PhysX", missingFeatures: ["queries"], supportsSetState: false })

describe("the physics backend picker (FE-J9)", () => {
  test("lists each backend as a card with its determinism, missing features, snapshot support, compiled-in state and note", async () => {
    await shown({
      backends: [
        physx,
        fakeBackend({ id: "jolt", displayName: "Jolt", compiledIn: false, determinism: "None", note: "Not compiled in; what it declares is unknown" }),
      ],
    })
    const p = card("physx")
    assert.ok(p.getByText(/Same binary/))
    assert.ok(p.getByText("queries"))
    assert.ok(p.getByText(/Snapshot, no set state/))
    const j = card("jolt")
    assert.ok(j.getByText("not compiled in"))
    assert.ok(j.getByText("Not compiled in; what it declares is unknown"))
    assert.equal(useButton("jolt").disabled, true)
    assert.match(useButton("jolt").title, /not compiled into this host/)
  })

  test("shows current, configured, active and the network preset", async () => {
    await shown({ settings: { physics: { backend: "jolt" }, network: { preset: "lockstep" } }, backends: [physx, jolt], active: "physx" })
    const facts = document.querySelector(".ps-backends .ps-facts")!.textContent!
    assert.match(facts, /Current\s*jolt/)
    assert.match(facts, /Configured\s*Yes/)
    assert.match(facts, /Active\s*physx/)
    assert.match(facts, /Network preset\s*lockstep/)
    // The project names jolt, the host runs physx
    assert.ok(screen.getByText(/The host runs physx, the project names jolt/))
  })

  test("choosing a backend calls SetPhysicsBackend and says it takes effect at the next play session or host start", async () => {
    const h = await shown({ backends: [physx, jolt] })
    assert.equal(useButton("physx").disabled, true)
    assert.equal(useButton("jolt").disabled, false)
    await userEvent.click(useButton("jolt"))
    await waitFor(() => assert.deepEqual(h.chosen, ["jolt"]))
    await waitFor(() => assert.ok(screen.getByText(/Saved jolt\./)))
    assert.ok(screen.getAllByText(/Takes effect at the next play session or host start\./).length >= 1)
    assert.ok(screen.getByText(/The host runs physx, the project names jolt/))
    assert.equal(useButton("jolt").disabled, true)
    assert.equal(useButton("physx").disabled, false)
    assert.deepEqual((h.settings().physics as { backend: string }).backend, "jolt")
  })

  test("under the Deterministic preset a backend that is not deterministic-selectable is off, with the reason", async () => {
    const h = await shown({
      settings: { network: { preset: "deterministic" }, physics: { backend: "jolt" } },
      backends: [physx, jolt],
    })
    // physx is not selectable (jolt is the project's)
    assert.equal(useButton("physx").disabled, true)
    assert.match(useButton("physx").title, /Deterministic/)
    assert.ok(screen.getByText(/this backend is not deterministic-selectable/))
    await userEvent.click(useButton("physx"))
    assert.equal(h.chosen.length, 0)
  })

  test("under the Deterministic preset a deterministic-selectable backend can still be chosen", async () => {
    const h = await shown({ settings: { network: { preset: "deterministic" } }, backends: [physx, jolt] })
    assert.equal(useButton("jolt").disabled, false)
    await userEvent.click(useButton("jolt"))
    await waitFor(() => assert.deepEqual(h.chosen, ["jolt"]))
  })

  test("a refusal by the host is shown", async () => {
    const h = await shown({ backends: [physx, jolt] })
    h.refuseBackendNext("Not available in a play host")
    await userEvent.click(useButton("jolt"))
    await waitFor(() => assert.ok(screen.getByText(/Not available in a play host/)))
    assert.equal(useButton("jolt").disabled, false)
  })

  test("read-only (a play session, a read-only host, a viewer): every card is disabled with the reason, and nothing is sent", async () => {
    const h = await shown({ backends: [physx, jolt] })
    await act(async () => {
      h.readOnlyReason.value = "a game is running"
    })
    assert.ok(screen.getByText("Read-only: a game is running"))
    assert.equal(useButton("jolt").disabled, true)
    await userEvent.click(useButton("jolt"))
    assert.equal(h.chosen.length, 0)
  })

  test("a host without the physicsBackends capability: explained, nothing read", async () => {
    const h = await shown({ backendsSupported: false })
    assert.ok(screen.getByText(/does not have the physicsBackends capability/))
    assert.equal(h.backendReads.count, 0)
    assert.equal(screen.queryByRole("group", { name: "PhysX" }), null)
  })

  test("a change of the project settings refreshes the backends", async () => {
    const h = await shown({ backends: [physx, jolt] })
    const before = h.backendReads.count
    await act(async () => {
      h.projectChangeCount.value++
      await settleTasks()
    })
    assert.ok(h.backendReads.count > before)
  })
})
