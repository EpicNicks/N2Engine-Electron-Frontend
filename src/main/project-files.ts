// The open project's files, for the page. Every path the page passes must resolve inside the project root
// (symlinks included), and only the text file types the editor uses can be read, written or deleted. Node only
// (no Electron), so it is unit tested.

import * as fs from "fs"
import * as path from "path"
import type { FileInfo } from "../shared/api"
import { ProjectTextExtensions } from "../shared/api"

export class ProjectPathError extends Error {}

/** How deep listFiles goes below the root */
const ListDepth = 3

export class ProjectFiles {
  private root: string | null = null

  /** The open project's directory, or null */
  get rootPath(): string | null {
    return this.root
  }

  /** Makes dir the open project (it must be an existing directory) */
  open(dir: string): string {
    const resolved = fs.realpathSync(path.resolve(dir))
    if (!fs.statSync(resolved).isDirectory()) {
      throw new ProjectPathError(`Not a directory: ${dir}`)
    }
    this.root = resolved
    return resolved
  }

  close(): void {
    this.root = null
  }

  listFiles(): FileInfo[] {
    return readDirectory(this.requireRoot(), 0)
  }

  readTextFile(filePath: string): string {
    return fs.readFileSync(this.resolveTextFile(filePath), "utf-8")
  }

  writeTextFile(filePath: string, text: string): void {
    if (typeof text !== "string") throw new ProjectPathError("The text must be a string")
    const resolved = this.resolveTextFile(filePath)
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isDirectory()) {
      throw new ProjectPathError(`Is a directory: ${filePath}`)
    }
    fs.writeFileSync(resolved, text, "utf-8")
  }

  createDirectory(dirPath: string): void {
    fs.mkdirSync(this.resolveInside(dirPath), { recursive: true })
  }

  deleteFile(filePath: string): void {
    const resolved = this.resolveTextFile(filePath)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(resolved)
    } catch {
      return // already gone
    }
    if (stat.isDirectory()) throw new ProjectPathError(`Is a directory: ${filePath}`)
    fs.unlinkSync(resolved)
  }

  /** resolveInside, limited to the editor's text file types */
  private resolveTextFile(filePath: string): string {
    const resolved = this.resolveInside(filePath)
    const ext = path.extname(resolved).toLowerCase()
    if (!ProjectTextExtensions.includes(ext)) {
      throw new ProjectPathError(`Not an editable file type (${ProjectTextExtensions.join(", ")}): ${filePath}`)
    }
    return resolved
  }

  /**
   * The absolute path for p (absolute, or relative to the root), which must be strictly inside the root. Links
   * are followed: the deepest existing ancestor's real path must be inside the root's real path, so a symlink in
   * the project can't lead outside it.
   */
  resolveInside(p: string): string {
    const root = this.requireRoot()
    if (typeof p !== "string" || p.length === 0 || p.includes("\0")) {
      throw new ProjectPathError("Invalid path")
    }
    const resolved = path.resolve(root, p)
    if (!isStrictlyInside(root, resolved)) {
      throw new ProjectPathError(`Outside the project: ${p}`)
    }

    // The part that exists must really be inside (resolving links); the rest is created inside it
    let existing = resolved
    const missing: string[] = []
    while (!fs.existsSync(existing)) {
      missing.unshift(path.basename(existing))
      existing = path.dirname(existing)
    }
    const real = path.join(fs.realpathSync(existing), ...missing)
    if (real !== root && !isStrictlyInside(root, real)) {
      throw new ProjectPathError(`Outside the project: ${p}`)
    }
    if (real === root) {
      throw new ProjectPathError(`The project folder itself: ${p}`)
    }
    return real
  }

  private requireRoot(): string {
    if (this.root === null) throw new ProjectPathError("No project is open")
    return this.root
  }
}

function isStrictlyInside(root: string, p: string): boolean {
  const relative = path.relative(root, p)
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
}

function readDirectory(dirPath: string, depth: number): FileInfo[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch (err) {
    console.error("Error reading directory:", err)
    return []
  }
  return entries
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => {
      const fullPath = path.join(dirPath, entry.name)
      const info: FileInfo = { name: entry.name, path: fullPath, isDirectory: entry.isDirectory() }
      if (info.isDirectory && depth < ListDepth) {
        info.children = readDirectory(fullPath, depth + 1)
      }
      return info
    })
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}
