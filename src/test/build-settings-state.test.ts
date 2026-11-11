// The Build Settings panel's logic (build targets stage 3): the minimal SetBuildTargets patch and its field rules, the
// target list (turned-off targets hidden), who may change the settings, when a target can be built, and the build log.
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { signal } from "@preact/signals-core"
import type { ProjectInfoResponse } from "../protocol/protocol.generated"
import type { BuildApi, BuildRequest, BuildState, BuildTargetList, BuildUpdate, DoctorReport, JsonObject } from "../shared/api"
import { InitialBuildState } from "../shared/api"
import {
  BuildSettingsModel,
  MaxLogLines,
  OldHostNote,
  RemoteBuildNote,
  UnappliedNote,
  buildPatch,
  fieldError,
  savedText,
  targetsOf,
} from "../renderer/build-settings-state"
import type { HostRole } from "../renderer/store"

const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function info(targets?: JsonObject, id = "00000000-0000-0000-0000-000000000001"): ProjectInfoResponse {
  const project: Record<string, unknown> = { formatVersion: 1, name: "Tri", projectId: id, engineVersion: "", startupScene: "", scenes: [], settings: {} }
  if (targets) project.build = { modules: { physics3d: "none" }, targets }
  return { rootPath: "/p", userDataPath: "/u", project: project as unknown as ProjectInfoResponse["project"] }
}

const list: BuildTargetList = {
  location: { path: "/eng/tools/n2build/n2build.mjs", source: "host", problem: null },
  targets: [
    { name: "linux", displayName: "Linux", hostSystems: ["linux"], buildableHere: false, source: "targets/" },
    { name: "web", displayName: "Web", hostSystems: ["win32", "linux"], buildableHere: true, source: "targets/" },
    { name: "windows", displayName: "Windows", hostSystems: ["win32"], buildableHere: true, source: "targets/" },
  ],
}

function setup(options: { targets?: JsonObject; role?: HostRole; readOnly?: string | null; remote?: boolean; supported?: boolean; list?: BuildTargetList } = {}) {
  let project = info(options.targets ?? {})
  const patches: JsonObject[] = []
  const starts: BuildRequest[] = []
  let listener: ((u: BuildUpdate) => void) | null = null
  let refuse: string | null = null
  const build: Pick<BuildApi, "state" | "onUpdate" | "list" | "doctor" | "start" | "cancel"> = {
    state: () => InitialBuildState,
    onUpdate: (l) => (listener = l),
    list: async () => options.list ?? list,
    doctor: async (target): Promise<DoctorReport> => ({ target, displayName: target, ok: target !== "web", checks: [] }),
    start: async (request) => {
      starts.push(request)
      return { ...InitialBuildState, status: "running", id: 1, request }
    },
    cancel: async () => InitialBuildState,
  }
  const model = new BuildSettingsModel({
    build,
    getProjectInfo: async () => project,
    setBuildTargets: async (patch) => {
      if (refuse) throw new Error(refuse)
      patches.push(patch)
      // The host's merge patch, one level per target as the tests need
      const current = targetsOf(project)
      const next: JsonObject = { ...current }
      for (const [name, p] of Object.entries(patch)) {
        const merged: JsonObject = { ...((current[name] as JsonObject) ?? {}) }
        for (const [k, v] of Object.entries(p as JsonObject)) {
          if (v === null) delete merged[k]
          else merged[k] = v
        }
        next[name] = merged
      }
      project = info(next)
      return project
    },
    connected: signal(true),
    readOnlyReason: signal(options.readOnly ?? null),
    role: signal<HostRole | null>(options.role ?? "admin"),
    projectChangeCount: signal(0),
    remote: signal(options.remote ?? false),
    supported: signal(options.supported ?? true),
  })
  return {
    model,
    patches,
    starts,
    refuse: (message: string | null) => (refuse = message),
    push: (u: BuildUpdate) => listener?.(u),
  }
}

describe("the SetBuildTargets patch", () => {
  test("only what changed; an emptied field removes its key; modules and signing nest", () => {
    const saved = { displayName: "Tri", version: "1.0.0", modules: { physics3d: "jolt" }, signing: { profile: "release" } }
    assert.deepEqual(buildPatch(saved, {}), { patch: null, changed: [], errors: {} })
    assert.deepEqual(buildPatch(saved, { displayName: "Tri" }).patch, null, "the same text is no change")
    const built = buildPatch(saved, {
      displayName: "Triangle-Like",
      version: "",
      buildNumber: "42",
      enabled: "false",
      "modules.physics3d": "",
      "modules.physics2d": "true",
      "signing.profile": "",
    })
    assert.deepEqual(built.patch, {
      enabled: false,
      displayName: "Triangle-Like",
      version: null,
      buildNumber: 42,
      modules: { physics3d: null, physics2d: true },
      signing: null,
    })
    assert.deepEqual(buildPatch({}, { "signing.profile": "store" }).patch, { signing: { profile: "store" } })
  })

  test("the host's rules are checked before sending", () => {
    assert.equal(fieldError("version", "1.2.3"), null)
    assert.match(fieldError("version", "1.2") ?? "", /major\.minor\.patch/)
    assert.match(fieldError("buildNumber", "0") ?? "", /1 to 2100000000/)
    assert.match(fieldError("buildNumber", "2100000001") ?? "", /1 to 2100000000/)
    assert.equal(fieldError("appId", "com.example.tri_like"), null)
    assert.ok(fieldError("appId", "example"))
    assert.ok(fieldError("appId", "com.1example"))
    assert.ok(fieldError("displayName", "a\nb"))
    assert.ok(fieldError("icon", "assets/icon.png"))
    assert.equal(fieldError("icon", "res://icons/app.png"), null)
    assert.ok(fieldError("renderer", "metal"))
    assert.ok(fieldError("signing.profile", "-----BEGIN PRIVATE KEY-----"), "a key is not a profile name")
    assert.deepEqual(Object.keys(buildPatch({}, { version: "x" }).errors), ["version"])
  })

  test("saved values as the form's text", () => {
    assert.equal(savedText({ buildNumber: 3, enabled: false, modules: { physics2d: true } }, "buildNumber"), "3")
    assert.equal(savedText({ enabled: false }, "enabled"), "false")
    assert.equal(savedText({ modules: { physics2d: true } }, "modules.physics2d"), "true")
    assert.equal(savedText({}, "modules.physics3d"), "")
  })
})

describe("the target list", () => {
  test("n2build's targets, then the project's own; turned-off ones hidden until asked", async () => {
    const { model } = setup({ targets: { windows: { enabled: false }, switch: { displayName: "Console" } } })
    model.start()
    await turn()
    assert.deepEqual(model.rows.value.map((r) => [r.name, r.known, r.enabled]), [
      ["linux", true, true],
      ["web", true, true],
      ["windows", true, false],
      ["switch", false, true],
    ])
    assert.deepEqual(model.visibleRows.value.map((r) => r.name), ["linux", "web", "switch"])
    assert.equal(model.hiddenCount.value, 1)
    model.showDisabled.value = true
    assert.equal(model.visibleRows.value.length, 4)
  })

  test("turning a target back on removes the key (on is the default)", async () => {
    const { model, patches } = setup({ targets: { windows: { enabled: false } } })
    model.start()
    await turn()
    assert.equal(await model.setEnabled("windows", true), true)
    assert.deepEqual(patches, [{ windows: { enabled: null } }])
    assert.equal(model.rows.value.find((r) => r.name === "windows")?.enabled, true)
    await model.setEnabled("web", false)
    assert.deepEqual(patches[1], { web: { enabled: false } })
  })
})

describe("changing the settings", () => {
  test("Apply sends the target's minimal patch and clears its edits; a refusal keeps them", async () => {
    const { model, patches, refuse } = setup({ targets: { web: { displayName: "Tri" } } })
    model.start()
    await turn()
    model.setEdit("web", "displayName", "Tri Web")
    model.setEdit("web", "version", "1.0.0")
    assert.equal(model.isDirty("web"), true)
    refuse("build.targets.web.signing: a key that looks like a secret")
    assert.equal(await model.apply("web"), false)
    assert.match(model.applyError.value ?? "", /looks like a secret/)
    assert.equal(model.textOf("web", "displayName"), "Tri Web", "the edits are kept")
    refuse(null)
    assert.equal(await model.apply("web"), true)
    assert.deepEqual(patches, [{ web: { displayName: "Tri Web", version: "1.0.0" } }])
    assert.equal(model.isDirty("web"), false)
    assert.equal(model.textOf("web", "version"), "1.0.0")
  })

  test("an invalid field is not sent", async () => {
    const { model, patches } = setup()
    model.start()
    await turn()
    model.setEdit("web", "buildNumber", "0")
    assert.equal(await model.apply("web"), false)
    assert.deepEqual(patches, [])
  })

  test("a viewer, a read-only host and a host before 1.29.0 cannot change them", async () => {
    for (const [options, expected] of [
      [{ role: "viewer" as HostRole }, /viewer/],
      [{ readOnly: "a play session is running" }, /Read-only: a play session/],
      [{ supported: false }, new RegExp(OldHostNote.slice(0, 30))],
    ] as const) {
      const { model, patches } = setup(options)
      model.start()
      await turn()
      assert.match(model.settingsLockedReason.value ?? "", expected)
      model.setEdit("web", "displayName", "X")
      assert.equal(await model.apply("web"), false)
      assert.equal(await model.setEnabled("web", false), false)
      assert.deepEqual(patches, [])
    }
  })
})

describe("building", () => {
  test("Build and Build and Run send n2build's request; the configuration and archive are optional", async () => {
    const { model, starts, push } = setup()
    model.start()
    await turn()
    assert.equal(model.buildBlockedReason("web"), null)
    // Each build ends before the next (one at a time)
    const end = (id: number) => push({ state: { ...InitialBuildState, status: "succeeded", id }, events: [] })
    await model.build("web", false)
    end(1)
    model.config.value = "debug"
    model.archive.value = "zip"
    await model.build("windows", false)
    end(2)
    await model.build("windows", true)
    assert.deepEqual(starts, [
      { target: "web", run: false },
      { target: "windows", run: false, config: "debug", archive: "zip" },
      { target: "windows", run: true, config: "debug" },
    ])
  })

  test("what blocks a build: a remote host, no n2build, another system, unapplied edits, a running build", async () => {
    const remote = setup({ remote: true })
    remote.model.start()
    await turn()
    assert.equal(remote.model.buildBlockedReason("web"), RemoteBuildNote)
    await remote.model.build("web", false)
    assert.deepEqual(remote.starts, [])

    const missing = setup({ list: { location: { path: null, source: null, problem: "n2build was not found: set n2buildPath" }, targets: [] } })
    missing.model.start()
    await turn()
    assert.match(missing.model.buildBlockedReason("web") ?? "", /n2buildPath/)

    const { model, starts, push } = setup({ targets: { switch: {} } })
    model.start()
    await turn()
    assert.match(model.buildBlockedReason("linux") ?? "", /builds on linux only/)
    assert.match(model.buildBlockedReason("switch") ?? "", /no switch target/)
    model.setEdit("web", "version", "2.0.0")
    assert.equal(model.buildBlockedReason("web"), UnappliedNote)
    model.revert("web")
    push({ state: { ...InitialBuildState, status: "running", id: 1, request: { target: "windows", run: false } }, events: [] })
    assert.equal(model.buildBlockedReason("web"), "A build is running")
    await model.build("web", false)
    assert.deepEqual(starts, [])
  })

  test("doctor is asked per target, and never for a remote host", async () => {
    const { model } = setup()
    model.start()
    await turn()
    await model.checkTarget("web")
    assert.equal(model.doctor.value.web?.ok, false)
    const remote = setup({ remote: true })
    await remote.model.checkTarget("web")
    assert.deepEqual(remote.model.doctor.value, {})
  })
})

describe("the build log", () => {
  const state = (over: Partial<BuildState>): BuildState => ({ ...InitialBuildState, ...over })

  test("a new build starts a new log; steps, warnings, lines and the result are shown in order", async () => {
    const { model, push } = setup()
    model.start()
    push({ state: state({ status: "running", id: 1 }), events: [{ type: "step", id: "configure", title: "Configuring" }, { type: "log", stream: "stdout", text: "-- ok" }] })
    push({ state: state({ status: "running", id: 1 }), events: [{ type: "warning", text: "no Vulkan" }, { type: "log", stream: "stderr", text: "warn" }] })
    push({ state: state({ status: "succeeded", id: 1, result: { type: "result", ok: true, output: "/out/Tri" } }), events: [{ type: "result", ok: true, output: "/out/Tri" }] })
    assert.deepEqual(model.log.value.map((l) => [l.kind, l.text]), [
      ["step", "==> Configuring"],
      ["out", "-- ok"],
      ["warning", "warning: no Vulkan"],
      ["err", "warn"],
      ["result", "Done: /out/Tri"],
    ])
    push({ state: state({ status: "running", id: 2 }), events: [{ type: "step", id: "configure", title: "Again" }] })
    assert.deepEqual(model.log.value.map((l) => l.text), ["==> Again"])
  })

  test("a failed build keeps its log; a cancel or a crash is said once", async () => {
    const { model, push } = setup()
    model.start()
    push({ state: state({ status: "running", id: 1 }), events: [{ type: "log", stream: "stderr", text: "error C2065" }] })
    push({ state: state({ status: "failed", id: 1, message: "n2build exited with code 3" }), events: [] })
    push({ state: state({ status: "failed", id: 1, message: "n2build exited with code 3" }), events: [] })
    assert.deepEqual(model.log.value.map((l) => l.text), ["error C2065", "Failed: n2build exited with code 3"])
    push({ state: state({ status: "running", id: 2 }), events: [] })
    push({ state: state({ status: "cancelled", id: 2, message: "Cancelled" }), events: [] })
    assert.deepEqual(model.log.value.map((l) => l.text), ["Cancelled"])
  })

  test("the log keeps the newest lines", async () => {
    const { model, push } = setup()
    model.start()
    const events = Array.from({ length: MaxLogLines + 10 }, (_, i) => ({ type: "log" as const, stream: "stdout" as const, text: `line ${i}` }))
    push({ state: state({ status: "running", id: 1 }), events })
    assert.equal(model.log.value.length, MaxLogLines)
    assert.equal(model.log.value[0].text, "line 10")
  })
})
