// The editor's settings.json, in the app's user data folder. Node only, so it is unit tested.
//
// Where N2EditorHost is: the path configured in the editor ("Locate N2EditorHost...", saved here) wins; without one,
// the N2ENGINE_HOST environment variable names it (#6 §(h): "the configured path, else N2ENGINE_HOST").
//
// renderer: "opengl" or "software", passed to every host as --renderer (the play child gets its edit host's); without
// it the host picks its own default.
//
// readyTimeoutMs: how long a launched host may take to print its ready line (default 30 s).
import * as fs from "fs"
import * as path from "path"
import { randomUUID } from "crypto"
import type { HostLocation, HostPreferencesState } from "../shared/api"
import { parseHostLaunchPreferences } from "../shared/host-preferences"
import { DefaultReadyTimeoutMs } from "./host-launcher"

/** The environment variable that names the host executable when none is configured */
export const HostPathEnv = "N2ENGINE_HOST"

/** Why a path can't be the host, or null if it can: it must be an existing file */
export function hostPathProblem(hostPath: string): string | null {
  try {
    return fs.statSync(hostPath).isFile() ? null : `Not a file: ${hostPath}`
  } catch {
    return `Not found: ${hostPath}`
  }
}

/** Where the host is, without what it can do (HostLocation.canCreate comes from probing it) */
export type HostPathLocation = Omit<HostLocation, "canCreate">

export class HostSettings {
  constructor(
    /** settings.json in the app's user data folder */
    private readonly file: string,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  /** Where the host is, and where that came from; with a problem when the path is set but unusable */
  locate(): HostPathLocation {
    const saved = this.read().hostPath
    if (typeof saved === "string" && saved !== "") {
      return { path: saved, source: "setting", problem: hostPathProblem(saved) }
    }
    const fromEnv = this.env[HostPathEnv]
    if (fromEnv) {
      const hostPath = path.resolve(fromEnv)
      return { path: hostPath, source: "env", problem: hostPathProblem(hostPath) }
    }
    return { path: null, source: null, problem: null }
  }

  /** The host's path, or an error saying how to set it */
  require(): string {
    const location = this.locate()
    if (location.path === null) {
      throw new Error(`N2EditorHost isn't set: locate it in the editor, or set ${HostPathEnv}`)
    }
    if (location.problem !== null) {
      const where = location.source === "env" ? HostPathEnv : "the configured N2EditorHost path"
      throw new Error(`${location.problem} (from ${where})`)
    }
    return location.path
  }

  /** Saves the host's path (it must be an existing file), keeping any other settings */
  setHostPath(hostPath: string): void {
    const resolved = path.resolve(hostPath)
    const problem = hostPathProblem(resolved)
    if (problem !== null) throw new Error(problem)
    this.write({ ...this.read(), hostPath: resolved })
  }

  /** settings.json's readyTimeoutMs when it is a positive number of milliseconds, else DefaultReadyTimeoutMs */
  readyTimeoutMs(): number {
    const value = this.read().readyTimeoutMs
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DefaultReadyTimeoutMs
  }

  /** settings.json's renderer when it is one the host knows, else undefined (the host's default) */
  renderer(): string | undefined {
    const value = this.read().renderer
    return value === "opengl" || value === "software" ? value : undefined
  }

  preferences(): HostPreferencesState {
    const raw = this.readPreferences()
    const configured = typeof raw.hostPath === "string" ? raw.hostPath : ""
    const effective = configured || (this.env[HostPathEnv] ? path.resolve(this.env[HostPathEnv]!) : null)
    const renderer = raw.renderer === "opengl" || raw.renderer === "software" ? raw.renderer : ""
    const readyTimeoutMs = typeof raw.readyTimeoutMs === "number" && Number.isFinite(raw.readyTimeoutMs) && raw.readyTimeoutMs > 0
      ? raw.readyTimeoutMs : DefaultReadyTimeoutMs
    return { settings: { hostPath: configured, renderer, readyTimeoutMs }, location: {
      path: effective, source: configured ? "setting" : effective ? "env" : null,
      problem: effective ? hostPathProblem(effective) : null,
    } }
  }

  /** Preferences must distinguish absent settings from a file the user needs to repair or regain access to. */
  private readPreferences(): Record<string, unknown> {
    let text: string
    try { text = fs.readFileSync(this.file, "utf8") }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw new Error(`Couldn't read editor settings: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("settings.json must contain an object")
      return parsed as Record<string, unknown>
    } catch (error) { throw new Error(`Couldn't read editor settings: ${error instanceof Error ? error.message : String(error)}`) }
  }

  /** Validate every field before writing. This changes future launches only, never the running session. */
  savePreferences(raw: unknown): HostPreferencesState {
    const value = parseHostLaunchPreferences(raw)
    const resolved = value.hostPath ? path.resolve(value.hostPath) : ""
    if (resolved) {
      const problem = hostPathProblem(resolved)
      if (problem) throw new Error(problem)
    }
    const previous = this.readPreferences()
    const next: Record<string, unknown> = { ...previous, readyTimeoutMs: value.readyTimeoutMs }
    if (resolved) next.hostPath = resolved
    else delete next.hostPath
    if (value.renderer) next.renderer = value.renderer
    else delete next.renderer
    this.write(next)
    return this.preferences()
  }

  private read(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf-8"))
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // missing or unreadable: no settings
    }
    return {}
  }

  private write(settings: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temporary = this.file + ".tmp-" + randomUUID()
    try {
      fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), { mode: fs.existsSync(this.file) ? fs.statSync(this.file).mode & 0o777 : 0o600 })
      fs.renameSync(temporary, this.file)
    } finally {
      try { fs.rmSync(temporary, { force: true }) } catch { /* Preserve the original write failure. */ }
    }
  }
}
