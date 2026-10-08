// The open project's folder, as the main process holds it: which folder is open, for ProjectSession and the page's
// project name. The project's files are the host's (the page asks it through the asset commands, which check every
// path), so nothing here reads or writes them. Node only (no Electron), so it is unit tested.

import * as fs from "fs"
import * as path from "path"

export class ProjectPathError extends Error {}

export class ProjectFiles {
  private root: string | null = null

  /** The open project's directory, or null */
  get rootPath(): string | null {
    return this.root
  }

  /** Makes dir the open project (it must be an existing directory) */
  open(dir: string): string {
    const resolved = fs.realpathSync.native(path.resolve(dir))
    if (!fs.statSync(resolved).isDirectory()) {
      throw new ProjectPathError(`Not a directory: ${dir}`)
    }
    this.root = resolved
    return resolved
  }

  close(): void {
    this.root = null
  }
}
