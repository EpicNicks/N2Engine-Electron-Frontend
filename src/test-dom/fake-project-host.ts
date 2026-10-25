// A fake host for the project settings tests: a project file with settings, GetProjectInfo, SetProjectSettings (a real
// RFC 7386 merge patch, all or nothing), SetStartupScene, and the refusals a test asks for. It records every patch.
import { signal } from "@preact/signals-core"
import type { PhysicsBackendInfo, PhysicsBackendsInfo, ProjectInfoResponse } from "../protocol/protocol.generated"
import type { HostRole } from "../renderer/store"
import { ProjectSettingsModel, type ProjectSettingsDeps } from "../renderer/project-settings-state"
import { SectionRegistry } from "../renderer/project-settings-registry"
import { settingsSections } from "../renderer/project-settings-sections"
import { applyMergePatch, type Json, type JsonObject } from "../renderer/project-settings-schema"
import { ipcError } from "../shared/api"
import { DefaultBackends } from "../test/fake-backends"
import { PhysicsBackendsModel } from "../renderer/physics-backends-state"

export { DefaultBackends, fakeBackend } from "../test/fake-backends"

export const settleTasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export function fakeProjectHost(
  options: {
    settings?: JsonObject
    scenes?: string[]
    startupScene?: string
    role?: HostRole | null
    restartable?: boolean
    registry?: SectionRegistry<unknown>
    /** The host has the physicsBackends capability (default true) */
    backendsSupported?: boolean
    backends?: PhysicsBackendInfo[]
    /** physics.backend as the host has it (undefined: not set) and the backend the host runs */
    active?: string
  } = {}
) {
  const project = {
    formatVersion: 1,
    name: "Demo",
    projectId: "11111111-1111-1111-1111-111111111111",
    engineVersion: "1.2.3",
    startupScene: options.startupScene ?? "res://scenes/main.scene",
    scenes: options.scenes ?? ["res://scenes/main.scene", "res://scenes/two.scene"],
    settings: (options.settings ?? { physics: { fixedTimestep: 0.02 }, window: { width: 800 } }) as unknown,
  }
  /** Every SetProjectSettings patch that reached the host, in order */
  const patches: JsonObject[] = []
  /** Every SetStartupScene path */
  const startups: string[] = []
  const log: string[] = []
  /** The next SetProjectSettings is refused with this message (and code), once */
  let refuse: { error: string; code?: string } | null = null
  const connected = signal(true)
  const readOnlyReason = signal<string | null>(null)
  const role = signal<HostRole | null>(options.role === undefined ? "admin" : options.role)
  const projectChangeCount = signal(0)
  const confirms: string[] = []
  let confirmAnswer = true
  let restarts = 0

  const backendList = options.backends ?? DefaultBackends
  const active = options.active ?? "physx"
  /** Every SetPhysicsBackend id that reached the host, and how many GetPhysicsBackends */
  const chosen: string[] = []
  const backendReads = { count: 0 }
  let refuseBackend: string | null = null
  const supported = signal(options.backendsSupported !== false)
  const backendInfo = (): PhysicsBackendsInfo => {
    const settings = project.settings as { physics?: { backend?: string }; network?: { preset?: string } }
    const set = settings?.physics?.backend
    const current = set ?? "physx"
    return {
      current,
      configured: set !== undefined,
      active,
      restartRequired: active !== current,
      networkPreset: settings?.network?.preset ?? "",
      backends: backendList,
    }
  }
  const info = (): ProjectInfoResponse => ({
    rootPath: "C:/p",
    userDataPath: "C:/p/.n2",
    project: JSON.parse(JSON.stringify(project)),
  })
  const deps: ProjectSettingsDeps = {
    getProjectInfo: async () => {
      log.push("getProjectInfo")
      return info()
    },
    setProjectSettings: async (patch) => {
      patches.push(JSON.parse(JSON.stringify(patch)))
      log.push("setProjectSettings")
      if (refuse) {
        const failure = refuse
        refuse = null
        throw ipcError(failure)
      }
      project.settings = applyMergePatch(project.settings as Json, patch as Json)
      return info()
    },
    setStartupScene: async (path) => {
      startups.push(path)
      log.push("setStartupScene")
      project.startupScene = path
      if (path !== "" && !project.scenes.includes(path)) project.scenes.push(path)
      return info()
    },
    connected,
    readOnlyReason,
    role,
    projectChangeCount,
    confirm: async (message) => {
      confirms.push(message)
      return confirmAnswer
    },
    restartHost: options.restartable === false ? null : async () => void restarts++,
    physicsBackends: new PhysicsBackendsModel({
      getPhysicsBackends: async () => {
        backendReads.count++
        return backendInfo()
      },
      setPhysicsBackend: async (backend) => {
        chosen.push(backend)
        if (refuseBackend !== null) {
          const message = refuseBackend
          refuseBackend = null
          throw ipcError({ error: message })
        }
        project.settings = applyMergePatch(project.settings as Json, { physics: { backend } })
        return backendInfo()
      },
      connected,
      supported,
      readOnlyReason,
    }),
  }
  const model = new ProjectSettingsModel(deps, options.registry ?? (settingsSections as SectionRegistry<unknown>))
  return {
    model,
    project,
    patches,
    startups,
    log,
    connected,
    readOnlyReason,
    role,
    projectChangeCount,
    confirms,
    restarts: () => restarts,
    chosen,
    backendReads,
    backendsSupported: supported,
    refuseBackendNext: (message: string) => void (refuseBackend = message),
    refuseNext: (error: string, code?: string) => void (refuse = { error, code }),
    answerConfirm: (yes: boolean) => void (confirmAnswer = yes),
    /** The host's saved settings */
    settings: () => project.settings as JsonObject,
  }
}
