// The Build Settings panel's IPC (Channels.build*): n2build list, doctor, build, run and cancel, for the open local
// project only. The page never names a folder or a program: the project is the one the editor opened, and n2build is the
// one the editor found (n2build-runner.ts). Updates go to the page batched, so a compiler's output does not flood it.
import type { IpcMain } from "electron"
import type { BuildEvent, BuildState, BuildTargetList, BuildUpdate, DoctorReport, HostState, N2BuildLocation } from "../shared/api"
import { Channels } from "../shared/api"
import { EditorPage, handleResult } from "./ipc"
import { N2BuildRunner, listTargets } from "./n2build-runner"

/** Why the editor does not build: the reason the panel shows instead of the Build button */
export const RemoteBuildReason =
  "Builds run on this machine, from the project folder on its disk. This editor is connected to a remote host, so its project is not here: build on the machine that has the project (n2build, or an editor opened there)."
export const NoProjectReason = "Open a project to build it"

/** The open local project's folder, or why there is none to build */
export function buildableProject(host: HostState): { projectDir: string } | { reason: string } {
  if (host.mode === "remote") return { reason: RemoteBuildReason }
  if (!host.projectPath) return { reason: NoProjectReason }
  return { projectDir: host.projectPath }
}

/** Collects updates and hands them on at most every intervalMs: the latest state, every event in order */
export class UpdateBatcher {
  private events: BuildEvent[] = []
  private state: BuildState | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly send: (update: BuildUpdate) => void,
    private readonly intervalMs = 100
  ) {}

  push(update: BuildUpdate): void {
    const statusChanged = this.state?.status !== update.state.status || this.state?.id !== update.state.id
    this.state = update.state
    this.events.push(...update.events)
    // A build that starts or ends is sent at once (with what came before it), so the buttons follow without a delay
    if (statusChanged || update.state.status !== "running") {
      this.flush()
      return
    }
    this.timer ??= setTimeout(() => this.flush(), this.intervalMs)
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.state === null) return
    const update: BuildUpdate = { state: this.state, events: this.events }
    this.events = []
    this.send(update)
  }
}

export interface BuildIpcDeps {
  page: EditorPage
  runner: N2BuildRunner
  /** The project session's host state: the open project and whether the host is local */
  hostState: () => HostState
  /** Where n2build is now (settings.json, N2BUILD_PATH, beside the host) */
  locate: () => N2BuildLocation
}

export function registerBuildIpc(ipcMain: IpcMain, deps: BuildIpcDeps): void {
  const { page, runner, hostState, locate } = deps
  const handle = (channel: string, handler: (...args: unknown[]) => unknown): void => handleResult(ipcMain, channel, page, handler)

  /** n2build, or an error saying why it can't be used */
  const script = (): string => {
    const location = locate()
    if (location.path === null || location.problem !== null) throw new Error(location.problem ?? "n2build was not found")
    return location.path
  }
  const projectDir = (): string => {
    const project = buildableProject(hostState())
    if ("reason" in project) throw new Error(project.reason)
    return project.projectDir
  }

  handle(Channels.buildList, async (): Promise<BuildTargetList> => {
    // With a remote host the targets still come from this machine's n2build when it has one; building is refused
    const location = locate()
    return listTargets(runner, location)
  })
  handle(Channels.buildDoctor, async (target): Promise<DoctorReport> => runner.doctor(script(), target, projectDir()))
  handle(Channels.buildStart, (request): BuildState => runner.start(script(), request, projectDir()))
  handle(Channels.buildCancel, (): BuildState => runner.cancel())
  handle(Channels.buildGetState, (): BuildState => runner.state)
}

/** The runner's onUpdate for the main process: batched, then sent to the editor page */
export function pageUpdates(page: EditorPage, intervalMs = 100): UpdateBatcher {
  return new UpdateBatcher((update) => page.getEditor()?.send(Channels.buildUpdate, update), intervalMs)
}
