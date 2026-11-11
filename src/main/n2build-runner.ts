// Runs the engine's n2build (tools/n2build/n2build.mjs; docs/build-targets.html in the engine repo) for the Build Settings
// panel (build targets stage 3). Node only (no Electron), so it is unit tested with a fake child process and with a real
// one.
//
// The rules it keeps:
//  - n2build is spawned without a shell, its arguments an array: nothing the page sends is ever parsed by a shell, and
//    every argument is checked here again (a target and a configuration are names, the archive zip or 7z);
//  - it is run with the editor's own Node (Electron's executable with ELECTRON_RUN_AS_NODE), so the editor needs no Node
//    on PATH;
//  - one build at a time; Cancel ends n2build and everything it started (CMake, the compiler, the game);
//  - its --json events are read line by line and checked; a line that is not an event is kept as a log line, never
//    trusted;
//  - no secret passes through here: n2build resolves a signing profile itself, from the user's own n2build.json.
import { ChildProcess, SpawnOptions, spawn as nodeSpawn } from "child_process"
import * as fs from "fs"
import * as path from "path"
import type {
  BuildEvent,
  BuildRequest,
  BuildResult,
  BuildState,
  BuildTargetInfo,
  BuildTargetList,
  BuildUpdate,
  DoctorCheck,
  DoctorReport,
  N2BuildLocation,
} from "../shared/api"
import { InitialBuildState } from "../shared/api"
import { LineSplitter } from "./host-launcher"

/** settings.json's key and the environment variable that name n2build.mjs */
export const N2BuildPathSetting = "n2buildPath"
export const N2BuildPathEnv = "N2BUILD_PATH"
/** Where n2build lives in an engine checkout */
export const N2BuildRelative = path.join("tools", "n2build", "n2build.mjs")

/** A target or configuration name, as n2build's descriptors name them */
const NamePattern = /^[a-z][a-z0-9-]{0,31}$/

/** The longest log line kept (a compiler can print very long ones) */
export const MaxLogLineLength = 4000

export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export function isTargetName(text: unknown): text is string {
  return typeof text === "string" && NamePattern.test(text)
}

/**
 * Where n2build.mjs is: settings.json's n2buildPath, else N2BUILD_PATH, else the engine checkout the host was built in
 * (the host's folder and each folder above it, looking for tools/n2build/n2build.mjs).
 */
export function locateN2Build(options: {
  setting?: unknown
  env: NodeJS.ProcessEnv
  hostPath: string | null
  exists?: (file: string) => boolean
}): N2BuildLocation {
  const exists = options.exists ?? ((file: string) => fs.existsSync(file) && fs.statSync(file).isFile())
  const check = (file: string, source: N2BuildLocation["source"]): N2BuildLocation => ({
    path: file,
    source,
    problem: exists(file) ? null : `Not found: ${file}`,
  })
  if (typeof options.setting === "string" && options.setting !== "") return check(path.resolve(options.setting), "setting")
  const fromEnv = options.env[N2BuildPathEnv]
  if (fromEnv) return check(path.resolve(fromEnv), "env")
  if (options.hostPath) {
    let dir = path.dirname(path.resolve(options.hostPath))
    for (;;) {
      const candidate = path.join(dir, N2BuildRelative)
      if (exists(candidate)) return { path: candidate, source: "host", problem: null }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return {
    path: null,
    source: null,
    problem: `n2build was not found: set ${N2BuildPathSetting} in the editor's settings.json, or ${N2BuildPathEnv}, to the engine's ${N2BuildRelative.split(path.sep).join("/")}`,
  }
}

/** A request from the page, checked: what n2build is given comes only from these fields */
export function checkRequest(raw: unknown): BuildRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("A build request must be an object")
  const value = raw as Record<string, unknown>
  if (!isTargetName(value.target)) throw new Error("A build target is a lowercase name (letters, digits and -)")
  if (typeof value.run !== "boolean") throw new Error("run must be true or false")
  const request: BuildRequest = { target: value.target, run: value.run }
  if (value.config !== undefined) {
    if (typeof value.config !== "string" || !NamePattern.test(value.config)) throw new Error("A configuration is a lowercase name")
    request.config = value.config
  }
  if (value.archive !== undefined) {
    if (value.archive !== "zip" && value.archive !== "7z") throw new Error("The archive is zip or 7z")
    if (value.run) throw new Error("An archive is made by Build, not Build and Run")
    request.archive = value.archive
  }
  return request
}

/** n2build's arguments after the script: always an array, never one string */
export function buildArguments(request: BuildRequest, projectDir: string): string[] {
  const args = [request.run ? "run" : "build", "--target", request.target, "--project", projectDir, "--json"]
  if (request.config !== undefined) args.push("--config", request.config)
  if (request.archive !== undefined) args.push("--archive", request.archive)
  return args
}

const str = (v: unknown): v is string => typeof v === "string"

function parseCheck(raw: unknown): DoctorCheck | null {
  if (typeof raw !== "object" || raw === null) return null
  const c = raw as Record<string, unknown>
  if (!str(c.id) || !str(c.title) || typeof c.ok !== "boolean" || typeof c.required !== "boolean") return null
  return {
    id: c.id,
    title: c.title,
    required: c.required,
    ok: c.ok,
    version: str(c.version) ? c.version : null,
    detail: str(c.detail) ? c.detail : "",
    fix: str(c.fix) ? c.fix : null,
  }
}

function parseTarget(raw: unknown): BuildTargetInfo | null {
  if (typeof raw !== "object" || raw === null) return null
  const t = raw as Record<string, unknown>
  if (!isTargetName(t.name) || !str(t.displayName) || typeof t.buildableHere !== "boolean") return null
  return {
    name: t.name,
    displayName: t.displayName,
    hostSystems: Array.isArray(t.hostSystems) ? t.hostSystems.filter(str) : [],
    buildableHere: t.buildableHere,
    source: str(t.source) ? t.source : "",
  }
}

/** One --json line as an event, or null when it is not one (it is then shown as a plain log line) */
export function parseEvent(line: string): BuildEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const e = raw as Record<string, unknown>
  switch (e.type) {
    case "step":
      return str(e.id) && str(e.title) ? { type: "step", id: e.id, title: e.title } : null
    case "log":
      return (e.stream === "stdout" || e.stream === "stderr") && str(e.text)
        ? { type: "log", stream: e.stream, text: e.text.slice(0, MaxLogLineLength) }
        : null
    case "warning":
      return str(e.text) ? { type: "warning", text: e.text } : null
    case "doctor": {
      if (!str(e.target) || typeof e.ok !== "boolean" || !Array.isArray(e.checks)) return null
      const checks = e.checks.map(parseCheck)
      if (checks.some((c) => c === null)) return null
      return { type: "doctor", target: e.target, displayName: str(e.displayName) ? e.displayName : e.target, ok: e.ok, checks: checks as DoctorCheck[] }
    }
    case "targets": {
      if (!Array.isArray(e.targets)) return null
      return { type: "targets", targets: e.targets.map(parseTarget).filter((t): t is BuildTargetInfo => t !== null) }
    }
    case "result": {
      if (typeof e.ok !== "boolean") return null
      const result: BuildResult = { type: "result", ok: e.ok }
      for (const key of ["error", "output", "entry", "archive", "url"] as const) if (str(e[key])) result[key] = e[key] as string
      if (e.serving === true) result.serving = true
      return result
    }
    default:
      return null
  }
}

export interface RunnerOptions {
  /** The Node that runs n2build: Electron's own executable, with ELECTRON_RUN_AS_NODE=1 (default: process.execPath) */
  nodePath?: string
  env?: NodeJS.ProcessEnv
  spawn?: SpawnFunction
  platform?: NodeJS.Platform
  /** Ends a process tree (default: taskkill /T on Windows, a signal to the process group elsewhere) */
  killTree?: (child: ChildProcess) => void
  /** Each state change and the events since the previous one (the main process sends them to the page) */
  onUpdate?: (update: BuildUpdate) => void
  /** How long list and doctor may take */
  queryTimeoutMs?: number
}

/** taskkill /T ends a Windows process with its children; elsewhere n2build leads its own process group */
export function defaultKillTree(child: ChildProcess, platform: NodeJS.Platform = process.platform, spawn: SpawnFunction = nodeSpawn): void {
  if (child.pid === undefined) return
  if (platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {})
    } catch {
      child.kill()
    }
    return
  }
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
}

export class N2BuildRunner {
  private stateValue: BuildState = InitialBuildState
  private child: ChildProcess | null = null
  private cancelled = false
  private pending: BuildEvent[] = []

  constructor(private readonly options: RunnerOptions = {}) {}

  get state(): BuildState {
    return this.stateValue
  }

  get running(): boolean {
    return this.stateValue.status === "running"
  }

  private env(): NodeJS.ProcessEnv {
    // Electron's executable runs as plain Node with this set; with real Node it changes nothing
    return { ...(this.options.env ?? process.env), ELECTRON_RUN_AS_NODE: "1" }
  }

  private spawnN2Build(script: string, args: string[], cwd: string): ChildProcess {
    const spawn = this.options.spawn ?? nodeSpawn
    const platform = this.options.platform ?? process.platform
    return spawn(this.options.nodePath ?? process.execPath, [script, ...args], {
      cwd,
      env: this.env(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Its own process group, so Cancel can end CMake and the compiler with it (Windows uses taskkill /T instead)
      detached: platform !== "win32",
      shell: false,
    })
  }

  private publish(patch: Partial<BuildState>, events: BuildEvent[] = []): void {
    this.stateValue = { ...this.stateValue, ...patch }
    this.pending.push(...events)
    const update: BuildUpdate = { state: this.stateValue, events: this.pending }
    this.pending = []
    this.options.onUpdate?.(update)
  }

  /**
   * Starts n2build build (or run) for projectDir. Throws when a build is already running or the request is refused; the
   * outcome arrives through onUpdate (the state ends succeeded, failed or cancelled).
   */
  start(script: string, rawRequest: unknown, projectDir: string): BuildState {
    if (this.running) throw new Error("A build is already running")
    const request = checkRequest(rawRequest)
    const args = buildArguments(request, projectDir)
    this.cancelled = false
    const id = this.stateValue.id + 1
    let child: ChildProcess
    try {
      child = this.spawnN2Build(script, args, path.dirname(script))
    } catch (e) {
      this.publish({ status: "failed", id, request, step: null, result: null, message: `Couldn't start n2build: ${e instanceof Error ? e.message : String(e)}` })
      return this.stateValue
    }
    this.child = child
    this.publish({ status: "running", id, request, step: null, result: null, message: null })

    let result: BuildResult | null = null
    const onLine = (line: string, stream: "stdout" | "stderr"): void => {
      const text = line.replace(/\r$/, "")
      if (text === "") return
      // stdout carries the events; anything else (stderr, a stray line) is a log line
      const event = stream === "stdout" ? parseEvent(text) : null
      if (event === null) {
        this.publish({}, [{ type: "log", stream, text: text.slice(0, MaxLogLineLength) }])
        return
      }
      if (event.type === "result") result = event
      // A web run's result (serving: the URL) comes while n2build keeps serving: the page shows it at once
      const patch: Partial<BuildState> =
        event.type === "step" ? { step: { id: event.id, title: event.title } } : event.type === "result" ? { result: event } : {}
      this.publish(patch, [event])
    }
    const out = new LineSplitter()
    const err = new LineSplitter()
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk).forEach((l) => onLine(l, "stdout")))
    child.stdout?.on("end", () => out.end().forEach((l) => onLine(l, "stdout")))
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk).forEach((l) => onLine(l, "stderr")))
    child.stderr?.on("end", () => err.end().forEach((l) => onLine(l, "stderr")))

    let ended = false
    const finish = (message: string | null): void => {
      if (ended) return
      ended = true
      this.child = null
      const r = result as BuildResult | null
      if (this.cancelled) this.publish({ status: "cancelled", result: r, message: "Cancelled" })
      else if (r !== null) this.publish({ status: r.ok ? "succeeded" : "failed", result: r, message: r.ok ? null : r.error ?? null })
      else this.publish({ status: "failed", result: null, message: message ?? "n2build ended without a result" })
    }
    child.on("error", (e) => finish(`Couldn't start n2build: ${e.message}`))
    child.on("close", (code, signal) => finish(code !== null ? `n2build exited with code ${code}` : `n2build was ended by ${signal}`))
    return this.stateValue
  }

  /** Ends the running build and what it started; the state ends cancelled once n2build has gone */
  cancel(): BuildState {
    const child = this.child
    if (!child || !this.running) return this.stateValue
    this.cancelled = true
    const killTree = this.options.killTree ?? ((c: ChildProcess) => defaultKillTree(c, this.options.platform ?? process.platform, this.options.spawn ?? nodeSpawn))
    killTree(child)
    return this.stateValue
  }

  /** Runs a short n2build command (list, doctor) and collects its events; rejects on a failure to start or a timeout */
  private query(script: string, args: string[]): Promise<BuildEvent[]> {
    const timeoutMs = this.options.queryTimeoutMs ?? 60000
    return new Promise((resolve, reject) => {
      let child: ChildProcess
      try {
        child = this.spawnN2Build(script, args, path.dirname(script))
      } catch (e) {
        reject(new Error(`Couldn't start n2build: ${e instanceof Error ? e.message : String(e)}`))
        return
      }
      const events: BuildEvent[] = []
      const errors: string[] = []
      const out = new LineSplitter()
      const err = new LineSplitter()
      const onOut = (lines: string[]): void => {
        for (const line of lines) {
          const event = parseEvent(line.replace(/\r$/, ""))
          if (event) events.push(event)
        }
      }
      child.stdout?.on("data", (chunk: Buffer) => onOut(out.push(chunk)))
      child.stdout?.on("end", () => onOut(out.end()))
      child.stderr?.on("data", (chunk: Buffer) => errors.push(...err.push(chunk)))
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        reject(new Error(`n2build ${args[0]} didn't finish within ${timeoutMs / 1000} s`))
      }, timeoutMs)
      child.on("error", (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`Couldn't start n2build: ${e.message}`))
      })
      child.on("close", () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const result = events.find((e): e is BuildResult => e.type === "result")
        if (!result && events.length === 0) {
          const said = [...errors, ...err.end()].map((l) => l.replace(/\r$/, "")).filter(Boolean).slice(-6).join("\n")
          reject(new Error(`n2build ${args[0]} gave no answer${said ? `:\n${said}` : ""}`))
          return
        }
        resolve(events)
      })
    })
  }

  /** n2build list --json */
  async list(script: string): Promise<BuildTargetInfo[]> {
    const events = await this.query(script, ["list", "--json"])
    const targets = events.find((e): e is Extract<BuildEvent, { type: "targets" }> => e.type === "targets")
    if (!targets) {
      const result = events.find((e): e is BuildResult => e.type === "result")
      throw new Error(result?.error ?? "n2build list reported no targets")
    }
    return targets.targets
  }

  /** n2build doctor --target T --project DIR --json (a not-ready report is an answer, not an error) */
  async doctor(script: string, target: unknown, projectDir: string): Promise<DoctorReport> {
    if (!isTargetName(target)) throw new Error("A build target is a lowercase name (letters, digits and -)")
    const events = await this.query(script, ["doctor", "--target", target, "--project", projectDir, "--json"])
    const report = events.find((e): e is Extract<BuildEvent, { type: "doctor" }> => e.type === "doctor")
    if (!report) {
      const result = events.find((e): e is BuildResult => e.type === "result")
      throw new Error(result?.error ?? "n2build doctor reported nothing")
    }
    const { type: _type, ...rest } = report
    return rest
  }

  /** Ends a running build (the editor quits) */
  shutdown(): void {
    this.cancel()
  }
}

/** The list for the page: where n2build is, and its targets when it can be asked */
export async function listTargets(runner: N2BuildRunner, location: N2BuildLocation): Promise<BuildTargetList> {
  if (location.path === null || location.problem !== null) return { location, targets: [] }
  return { location, targets: await runner.list(location.path) }
}
