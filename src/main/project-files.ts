// The open project's files, for the page. Every path the page passes must resolve inside the project root (links
// included, dangling ones refused), and only the text file types the editor uses can be read, written or deleted.
// Node only (no Electron), so it is unit tested.

import * as fs from "fs"
import * as path from "path"
import type { FileInfo } from "../shared/api"
import { ProjectTextExtensions } from "../shared/api"

export class ProjectPathError extends Error {}

/** How deep listFiles goes below the root */
const ListDepth = 3

/** Larger files aren't read into the page (scenes and scripts are far smaller) */
export const MaxReadBytes = 16 * 1024 * 1024

/** Windows device names, which open the device whatever the folder or extension (CON, nul.lua, COM1.txt, ...) */
const ReservedName = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i

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

  listFiles(): FileInfo[] {
    return readDirectory(this.requireRoot(), 0)
  }

  readTextFile(filePath: string): string {
    const resolved = this.resolveTextFile(filePath)
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) throw new ProjectPathError(`Not a file: ${filePath}`)
    if (stat.size > MaxReadBytes) {
      throw new ProjectPathError(`Too large to open (${stat.size} bytes, the limit is ${MaxReadBytes}): ${filePath}`)
    }
    return fs.readFileSync(resolved, "utf-8")
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
   * The real absolute path for p (absolute, or relative to the root), which must be strictly inside the root.
   *
   * - Each component is checked: no ":" (an NTFS alternate data stream), no Windows device name (CON, NUL.lua,
   *   COM1, ...), and no name ending in a dot or space (Windows strips those, so the name would mean another file).
   * - Walking down from the root, every existing component is lstat'd, and a link is resolved (realpath) and must
   *   stay inside the root. A dangling link is refused: writing through it would create its target, wherever that
   *   is. The first missing component ends the walk; the rest is created inside the real path so far.
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

    const components = path.relative(root, resolved).split(path.sep)
    for (const name of components) {
      if (name.includes(":")) throw new ProjectPathError(`Invalid name (":"): ${p}`)
      if (ReservedName.test(name)) throw new ProjectPathError(`Reserved device name "${name}": ${p}`)
      if (/[. ]$/.test(name)) throw new ProjectPathError(`Names can't end in a dot or space: ${p}`)
    }

    let current = root
    for (let i = 0; i < components.length; i++) {
      const next = path.join(current, components[i])
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(next)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
        current = path.join(next, ...components.slice(i + 1))
        break
      }
      if (stat.isSymbolicLink()) {
        let real: string
        try {
          real = fs.realpathSync.native(next)
        } catch {
          throw new ProjectPathError(`A link that leads nowhere: ${p}`)
        }
        if (real !== root && !isStrictlyInside(root, real)) {
          throw new ProjectPathError(`Outside the project: ${p}`)
        }
        current = real
      } else {
        current = next
      }
    }

    if (current === root) {
      throw new ProjectPathError(`The project folder itself: ${p}`)
    }
    return current
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
