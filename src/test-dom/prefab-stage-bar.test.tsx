import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { screen } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { signal } from "@preact/signals"
import { PrefabStageBar } from "../renderer/prefab-stage-bar"
import { parsePrefabStageInfo, PrefabStage, PrefabStageMode } from "../protocol/prefab-stage"
import { renderWithApp } from "./helpers"

const stageOf = (overrides: Record<string, unknown> = {}): PrefabStage =>
  parsePrefabStageInfo({
    open: true,
    prefabUuid: "p",
    path: "res://Crate.prefab",
    name: "Crate",
    mode: "isolated",
    dirty: false,
    contextAvailable: true,
    sceneName: "Main",
    scenePath: "res://scenes/Main.scene",
    warnings: [],
    ...overrides,
  })!

function shown(stage: PrefabStage | null, contextCapable = true) {
  const calls: string[] = []
  const prefabStage = signal<PrefabStage | null>(stage)
  renderWithApp(<PrefabStageBar />, {
    store: {
      prefabStage,
      busy: signal<string | null>(null),
      hostReadOnly: signal(false),
      prefabStageContextAvailable: signal(contextCapable),
      closePrefabStage: async () => {
        calls.push("close")
        return true
      },
      ensurePrefabStageClosed: async (action: string) => {
        calls.push(`ensure ${action}`)
        return true
      },
      openPrefabStage: async (path: string, mode?: PrefabStageMode) => {
        calls.push(`open ${path} ${mode}`)
        return true
      },
      savePrefabStage: async () => {
        calls.push("save")
        return true
      },
      setPrefabStageMode: async (mode: PrefabStageMode) => {
        calls.push(`mode ${mode}`)
      },
    },
  })
  return calls
}

describe("the prefab stage bar (protocol 1.26.0)", () => {
  test("nothing without a stage", () => {
    shown(null)
    assert.equal(screen.queryByRole("toolbar", { name: "Prefab stage" }), null)
  })

  test("the breadcrumb, the mode toggle, Save and Close", async () => {
    const calls = shown(stageOf({ dirty: true }))
    assert.ok(screen.getByRole("toolbar", { name: "Prefab stage" }))
    assert.ok(screen.getByLabelText("unsaved changes"))
    await userEvent.click(screen.getByRole("button", { name: "Main" }))
    await userEvent.click(screen.getByRole("button", { name: "In Scene" }))
    await userEvent.click(screen.getByRole("button", { name: "Save prefab" }))
    await userEvent.click(screen.getByRole("button", { name: "Close" }))
    assert.deepEqual(calls, ["close", "mode context", "save", "close"])
    assert.equal(screen.getByRole("button", { name: "Isolated" }).getAttribute("aria-pressed"), "true")
  })

  test("In Scene is off without the capability; a deleted file disables Save; an external change offers Reload", async () => {
    const calls = shown(stageOf({ externalChange: true, mode: "context" }), false)
    assert.equal((screen.getByRole("button", { name: "In Scene" }) as HTMLButtonElement).disabled, true)
    await userEvent.click(screen.getByRole("button", { name: "Reload" }))
    assert.deepEqual(calls, ["ensure reload it", "open res://Crate.prefab context"])
  })

  test("an orphaned stage can't be saved and says why", () => {
    shown(stageOf({ orphaned: true, warnings: ["1 reference to objects outside the prefab was cleared"] }))
    assert.equal((screen.getByRole("button", { name: "Save prefab" }) as HTMLButtonElement).disabled, true)
    assert.ok(screen.getByRole("alert").textContent?.includes("deleted"))
    assert.ok(screen.getByText(/1 reference to objects outside/))
  })
})
