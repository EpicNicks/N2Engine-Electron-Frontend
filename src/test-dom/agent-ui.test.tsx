/// <reference path="../renderer/globals.d.ts" />
import "./setup"
import { test, describe, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import { screen, act, cleanup } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import type { AgentState, ServerInfo } from "../shared/api"
import { InitialAgentState } from "../shared/api"
import { EditorStore, HostReadOnlyReason, StoreApi, ViewerReason } from "../renderer/store"
import { AgentModel, agentModel } from "../renderer/agent-state"
import { AgentBanner, AgentToggle } from "../renderer/agent-ui"
import { renderWithApp } from "./helpers"

afterEach(() => {
  cleanup()
  agentModel.value = null
})

/** An EditorStore connected to a host whose ServerInfo is as given (the same fake page API as read-only.test.tsx) */
async function connectedStore(info: Partial<ServerInfo>) {
  const full: ServerInfo = { protocolVersion: "1.22.0", engineVersion: "1.0.0", capabilities: [], projectLoaded: true, readOnly: false, user: "", role: "", ...info }
  let connected = false
  const listeners: Array<(connected: boolean) => void> = []
  const api = {
    engine: {
      isConnected: () => connected,
      serverInfo: () => (connected ? full : null),
      onConnectionChange: (listener: (connected: boolean) => void) => listeners.push(listener),
      pollEvents: async () => ({ epoch: 1, nextSeq: 1, dropped: 0, events: [] }),
      getOpenScene: async () => ({ path: "res://scenes/a.scene", name: "a", uuid: "u1", revision: 1, savedRevision: 1 }),
      getHistory: async () => ({ cursor: 0, entries: [] }),
      getAutosave: async () => ({ exists: false }),
    },
    host: { state: () => ({ status: "running", mode: "local", launch: 1, projectPath: "C:\\P", message: null }), onStateChange: () => {} },
    remote: {},
    project: {},
    dialogs: { dismissAutosave: () => {} },
  } as unknown as StoreApi
  const store = new EditorStore(api, { timers: { setTimeout: () => 0, clearTimeout: () => {} } })
  connected = true
  await act(async () => {
    listeners.forEach((listener) => listener(true))
    await new Promise((resolve) => setImmediate(resolve))
  })
  return store
}

/** The page's window.agent over a state the test controls */
function fakeAgentApi(initial: AgentState) {
  let state = initial
  const listeners: Array<(s: AgentState) => void> = []
  const calls: string[] = []
  const api = {
    state: () => state,
    onStateChange: (l: (s: AgentState) => void) => void listeners.push(l),
    setEnabled: async (enabled: boolean) => {
      calls.push(`setEnabled ${enabled}`)
      state = { ...state, enabled, listening: enabled }
      return state
    },
    disconnect: async () => {
      calls.push("disconnect")
      state = { ...state, enabled: false, listening: false, connected: false }
      return state
    },
  }
  return {
    api,
    calls,
    push(next: AgentState) {
      state = next
      listeners.forEach((l) => l(next))
    },
  }
}

const available: AgentState = { available: true, reason: null, enabled: false, listening: false, connected: false }

function mount(initial: AgentState) {
  const fake = fakeAgentApi(initial)
  const errors: string[] = []
  agentModel.value = new AgentModel(fake.api, (what) => errors.push(what))
  return { fake, errors }
}

describe("the Allow AI agent switch", () => {
  test("is off by default, labelled for screen readers, and turns the endpoint on when clicked", async () => {
    const store = await connectedStore({ role: "editor" })
    const { fake } = mount(available)
    renderWithApp(<AgentToggle />, { store })
    const box = screen.getByRole("checkbox", { name: "Allow AI agent for this project" }) as HTMLInputElement
    assert.equal(box.checked, false)
    assert.equal(box.disabled, false)
    await userEvent.click(box)
    assert.deepEqual(fake.calls, ["setEnabled true"])
    assert.equal((screen.getByRole("checkbox") as HTMLInputElement).checked, true)
  })

  test("on, it can be turned off again", async () => {
    const store = await connectedStore({ role: "editor" })
    const { fake } = mount({ ...available, enabled: true, listening: true })
    renderWithApp(<AgentToggle />, { store })
    await userEvent.click(screen.getByRole("checkbox"))
    assert.deepEqual(fake.calls, ["setEnabled false"])
  })

  test("on a read-only host it is disabled, and the tooltip says why", async () => {
    const store = await connectedStore({ readOnly: true })
    mount(available)
    renderWithApp(<AgentToggle />, { store })
    const box = screen.getByRole("checkbox") as HTMLInputElement
    assert.equal(box.disabled, true)
    assert.ok(box.closest("label")!.title.includes(HostReadOnlyReason))
  })

  test("as a viewer it is disabled, and the tooltip says why", async () => {
    const store = await connectedStore({ role: "viewer" })
    mount(available)
    renderWithApp(<AgentToggle />, { store })
    const box = screen.getByRole("checkbox") as HTMLInputElement
    assert.equal(box.disabled, true)
    assert.ok(box.closest("label")!.title.includes(ViewerReason))
  })

  test("when the editor says it is not available (no project, a remote engine) it is disabled with that reason", async () => {
    const store = await connectedStore({ role: "editor" })
    mount({ ...InitialAgentState, reason: "Not available for a remote engine" })
    renderWithApp(<AgentToggle />, { store })
    const box = screen.getByRole("checkbox") as HTMLInputElement
    assert.equal(box.disabled, true)
    assert.match(box.closest("label")!.title, /remote engine/)
  })

  test("a switch that is on stays operable when the host turned read-only, so the person can turn it off", async () => {
    const store = await connectedStore({ readOnly: true })
    const { fake } = mount({ ...available, enabled: true, listening: false })
    renderWithApp(<AgentToggle />, { store })
    const box = screen.getByRole("checkbox") as HTMLInputElement
    assert.equal(box.checked, true)
    assert.equal(box.disabled, false)
    await userEvent.click(box)
    assert.deepEqual(fake.calls, ["setEnabled false"])
  })

  test("a refusal from the main process is shown as an error, and the switch stays as it was", async () => {
    const store = await connectedStore({ role: "editor" })
    const errors: string[] = []
    agentModel.value = new AgentModel(
      { ...fakeAgentApi(available).api, setEnabled: async () => Promise.reject(new Error("The editor is read-only")) },
      (what) => errors.push(what)
    )
    renderWithApp(<AgentToggle />, { store })
    await userEvent.click(screen.getByRole("checkbox"))
    assert.equal(errors.length, 1)
    assert.equal((screen.getByRole("checkbox") as HTMLInputElement).checked, false)
  })

  test("renders nothing where the page has no agent API (a page without the model)", async () => {
    const store = await connectedStore({ role: "editor" })
    renderWithApp(<AgentToggle />, { store })
    assert.equal(screen.queryByRole("checkbox"), null)
  })
})

describe("the AI agent banner", () => {
  test("is not there while no agent is attached", async () => {
    mount({ ...available, enabled: true, listening: true })
    renderWithApp(<AgentBanner />)
    assert.equal(screen.queryByRole("status"), null)
  })

  test("says an agent is connected while one is, and goes when it leaves", async () => {
    const { fake } = mount({ ...available, enabled: true, listening: true })
    renderWithApp(<AgentBanner />)
    act(() => fake.push({ ...available, enabled: true, listening: true, connected: true }))
    const banner = screen.getByRole("status")
    assert.match(banner.textContent ?? "", /AI agent connected/)
    assert.match(banner.textContent ?? "", /AI:/)
    act(() => fake.push({ ...available, enabled: true, listening: true, connected: false }))
    assert.equal(screen.queryByRole("status"), null)
  })

  test("Disconnect closes the agent's connection, revokes the secret and turns the switch off", async () => {
    const { fake } = mount({ ...available, enabled: true, listening: true, connected: true })
    renderWithApp(<AgentBanner />)
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }))
    assert.deepEqual(fake.calls, ["disconnect"])
    assert.equal(screen.queryByRole("status"), null)
    assert.equal(agentModel.value!.state.value.enabled, false)
  })
})
