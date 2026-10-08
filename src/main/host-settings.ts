// Where N2EditorHost is: the N2_EDITOR_HOST environment variable if set, else the path picked once in the editor
// ("Locate N2EditorHost..."), kept in settings.json in the app's user data folder. Node only, so it is unit tested.
import * as fs from "fs"
import * as path from "path"
import type { HostLocation } from "../shared/api"

/** The environment variable that names the host executable; it wins over the saved setting */
export const HostPathEnv = "N2_EDITOR_HOST"

/** Why a path can't be the host, or null if it can: it must be an existing file */
export function hostPathProblem(hostPath: string): string | null {
  try {
    return fs.statSync(hostPath).isFile() ? null : `Not a file: ${hostPath}`
  } catch {
    return `Not found: ${hostPath}`
  }
}

export class HostSettings {
  constructor(
    /** settings.json in the app's user data folder */
    private readonly file: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Where the host is, and where that came from; with a problem when the path is set but unusable */
  locate(): HostLocation {
    const fromEnv = this.env[HostPathEnv]
    if (fromEnv) {
      const hostPath = path.resolve(fromEnv)
      return { path: hostPath, source: "env", problem: hostPathProblem(hostPath) }
    }
    const saved = this.read().hostPath
    if (typeof saved === "string" && saved !== "") {
      return { path: saved, source: "setting", problem: hostPathProblem(saved) }
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
      const where = location.source === "env" ? `${HostPathEnv}` : "the saved N2EditorHost path"
      throw new Error(`${location.problem} (from ${where})`)
    }
    return location.path
  }

  /** Saves the host's path (it must be an existing file), keeping any other settings */
  setHostPath(hostPath: string): void {
    const resolved = path.resolve(hostPath)
    const problem = hostPathProblem(resolved)
    if (problem !== null) throw new Error(problem)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify({ ...this.read(), hostPath: resolved }, null, 2))
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
}
