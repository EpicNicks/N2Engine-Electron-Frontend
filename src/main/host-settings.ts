// The editor's settings.json, in the app's user data folder. Node only, so it is unit tested.
//
// Where N2EditorHost is: the path configured in the editor ("Locate N2EditorHost...", saved here) wins; without one,
// the N2ENGINE_HOST environment variable names it (#6 §(h): "the configured path, else N2ENGINE_HOST").
//
// readyTimeoutMs: how long a launched host may take to print its ready line (default 30 s).
import * as fs from "fs"
import * as path from "path"
import type { HostLocation } from "../shared/api"
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
    fs.writeFileSync(this.file, JSON.stringify(settings, null, 2))
  }
}
