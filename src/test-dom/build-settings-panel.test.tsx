// The Build Settings panel (build targets stage 3) over a fake n2build and host: the target list with doctor marks and
// fixes, editing and applying settings, Build with its progress and log, Cancel, a failed build's log kept, a viewer, and
// a remote host (no Build button, and why).
import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { act, render, screen, within } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { signal } from "@preact/signals"
import { BuildSettingsView } from "../renderer/build-settings-panel"
import { BuildSettingsModel } from "../renderer/build-settings-state"
import type { ProjectInfoResponse } from "../protocol/protocol.generated"
import type { BuildApi, BuildRequest, BuildState, BuildUpdate, DoctorReport, JsonObject } from "../shared/api"
import { InitialBuildState } from "../shared/api"
import type { HostRole } from "../renderer/store"

const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function info(targets: JsonObject): ProjectInfoResponse {
  const project = { formatVersion: 1, name: "Tri", projectId: "id", engineVersion: "", startupScene: "", scenes: [], settings: {}, build: { targets } }
  return { rootPath: "/p", userDataPath: "/u", project: project as unknown as ProjectInfoResponse["project"] }
}

const webDoctor: DoctorReport = {
  target: "web",
  displayName: "Web",
  ok: false,
  checks: [
    { id: "cmake", title: "CMake", required: true, ok: true, version: "3.30.1", detail: "", fix: null },
    { id: "emsdk", title: "Emscripten SDK", required: true, ok: false, version: null, detail: "emsdk was not found", fix: "git clone https://github.com/emscripten-core/emsdk" },
  ],
}

function harness(options: { role?: HostRole; remote?: boolean; targets?: JsonObject } = {}) {
  let project = info(options.targets ?? { windows: { displayName: "Tri" } })
  const patches: JsonObject[] = []
  const starts: BuildRequest[] = []
  let cancels = 0
  let listener: ((u: BuildUpdate) => void) | null = null
  const build: Pick<BuildApi, "state" | "onUpdate" | "list" | "doctor" | "start" | "cancel"> = {
    state: () => InitialBuildState,
    onUpdate: (l) => (listener = l),
    list: async () => ({
      location: { path: "/eng/tools/n2build/n2build.mjs", source: "host", problem: null },
      targets: [
        { name: "web", displayName: "Web", hostSystems: ["win32"], buildableHere: true, source: "targets/" },
        { name: "windows", displayName: "Windows", hostSystems: ["win32"], buildableHere: true, source: "targets/" },
      ],
    }),
    doctor: async (target) => (target === "web" ? webDoctor : { target, displayName: target, ok: true, checks: [] }),
    start: async (request) => {
      starts.push(request)
      return { ...InitialBuildState, status: "running", id: starts.length, request }
    },
    cancel: async () => {
      cancels++
      return { ...InitialBuildState, status: "running", id: starts.length }
    },
  }
  const model = new BuildSettingsModel({
    build,
    getProjectInfo: async () => project,
    setBuildTargets: async (patch) => {
      patches.push(patch)
      const name = Object.keys(patch)[0]
      const current = ((project.project as unknown as { build: { targets: JsonObject } }).build.targets[name] ?? {}) as JsonObject
      project = info({ ...(project.project as unknown as { build: { targets: JsonObject } }).build.targets, [name]: { ...current, ...(patch[name] as JsonObject) } })
      return project
    },
    connected: signal(true),
    readOnlyReason: signal<string | null>(null),
    role: signal<HostRole | null>(options.role ?? "admin"),
    projectChangeCount: signal(0),
    remote: signal(options.remote ?? false),
    supported: signal(true),
  })
  const push = (state: Partial<BuildState>, events: BuildUpdate["events"] = []) =>
    act(() => listener?.({ state: { ...InitialBuildState, ...state }, events }))
  return { model, patches, starts, cancels: () => cancels, push }
}

async function show(model: BuildSettingsModel) {
  render(<BuildSettingsView model={model} />)
  await act(async () => {
    await turn()
    await turn()
  })
}

describe("the Build Settings panel", () => {
  test("lists the targets and shows the selected one's doctor report with the fix", async () => {
    const h = harness()
    await show(h.model)
    const list = within(screen.getByRole("navigation", { name: "Build targets" }))
    assert.ok(list.getByRole("button", { name: /Web/ }))
    assert.ok(list.getByRole("button", { name: /Windows/ }))
    assert.ok(await screen.findByText("Not ready to build"))
    assert.ok(screen.getByText(/Fix: git clone https:\/\/github\.com\/emscripten-core\/emsdk/))
    assert.ok(screen.getByText("emsdk was not found"))
  })

  test("edits a target's settings and applies the minimal patch", async () => {
    const h = harness()
    await show(h.model)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /Windows/ }))
    const name = screen.getByLabelText("Name on this platform") as HTMLInputElement
    assert.equal(name.value, "Tri")
    await user.clear(name)
    await user.type(name, "Triangle-Like")
    await user.selectOptions(screen.getByLabelText("3D physics"), "jolt")
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Apply" }))
      await turn()
    })
    assert.deepEqual(h.patches, [{ windows: { displayName: "Triangle-Like", modules: { physics3d: "jolt" } } }])
  })

  test("a field the host would refuse is marked and Apply stays off", async () => {
    const h = harness()
    await show(h.model)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("Version"), "1.0")
    assert.ok(screen.getByText("major.minor.patch, each part 1 to 5 digits", { selector: ".ps-field-error" }))
    assert.equal((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled, true)
  })

  test("Build shows the progress and the log; Cancel asks the main process; a failed build's log stays", async () => {
    const h = harness()
    await show(h.model)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /Windows/ }))
    await user.selectOptions(screen.getByLabelText("Configuration"), "debug")
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Build" }))
      await turn()
    })
    assert.deepEqual(h.starts, [{ target: "windows", run: false, config: "debug" }])
    await h.push({ status: "running", id: 1, request: h.starts[0], step: { id: "compile", title: "Building n2player" } }, [
      { type: "step", id: "compile", title: "Building n2player" },
      { type: "log", stream: "stderr", text: "error C2065: 'x': undeclared identifier" },
    ])
    assert.ok(screen.getByText("windows: Building n2player"))
    assert.equal((screen.getByRole("button", { name: "Build" }) as HTMLButtonElement).disabled, true, "one build at a time")
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Cancel" }))
      await turn()
    })
    assert.equal(h.cancels(), 1)
    await h.push({ status: "failed", id: 1, result: { type: "result", ok: false, error: "The windows build failed" }, message: "The windows build failed" }, [
      { type: "result", ok: false, error: "The windows build failed" },
    ])
    const log = screen.getByLabelText("Build log")
    assert.match(log.textContent ?? "", /error C2065/)
    assert.match(log.textContent ?? "", /Failed: The windows build failed/)
    assert.ok(screen.getByText("Build failed"))
  })

  test("a viewer sees the settings but cannot change them", async () => {
    const h = harness({ role: "viewer" })
    await show(h.model)
    assert.ok(screen.getByText(/a viewer cannot change the project/))
    assert.equal((screen.getByLabelText("Name on this platform") as HTMLInputElement).disabled, true)
    assert.equal((screen.getByRole("checkbox", { name: "Offered in the build list" }) as HTMLInputElement).disabled, true)
  })

  test("a remote host: the targets and settings, no Build button, and why", async () => {
    const h = harness({ remote: true })
    await show(h.model)
    assert.ok(screen.getByText(/Builds run on this machine, from the project folder on its disk/))
    assert.equal(screen.queryByRole("button", { name: "Build" }), null)
    assert.equal(screen.queryByRole("button", { name: "Build and Run" }), null)
    assert.ok(screen.getByLabelText("Name on this platform"))
  })

  test("a turned-off target is hidden until asked for", async () => {
    const h = harness({ targets: { web: { enabled: false } } })
    await show(h.model)
    const list = within(screen.getByRole("navigation", { name: "Build targets" }))
    assert.equal(list.queryByRole("button", { name: /Web/ }), null)
    const user = userEvent.setup()
    await user.click(screen.getByLabelText(/Show turned-off targets \(1\)/))
    assert.ok(list.getByRole("button", { name: /Web/ }))
  })
})
