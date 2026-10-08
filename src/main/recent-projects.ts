// The recently opened projects' folders, newest first, kept as plain paths in a JSON file in the app's user data
// folder. Node only, so it is unit tested.
import * as fs from "fs"
import * as path from "path"

export const MaxRecent = 10

export class RecentProjects {
  constructor(private readonly file: string) {}

  /** The saved paths, newest first; a missing, unreadable or malformed file is an empty list */
  list(): string[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf-8"))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("Error reading recent projects:", err)
      return []
    }
    if (!Array.isArray(parsed)) return []
    const paths = parsed.filter((p): p is string => typeof p === "string" && p !== "")
    return [...new Set(paths)].slice(0, MaxRecent)
  }

  /** Puts the path first (moving it if it was already there), keeping at most MaxRecent */
  add(projectPath: string): void {
    this.save([projectPath, ...this.list().filter((p) => p !== projectPath)])
  }

  remove(projectPath: string): void {
    const recent = this.list()
    if (recent.includes(projectPath)) this.save(recent.filter((p) => p !== projectPath))
  }

  includes(projectPath: string): boolean {
    return this.list().includes(projectPath)
  }

  private save(recent: string[]): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(recent.slice(0, MaxRecent)))
    } catch (err) {
      console.error("Error saving recent projects:", err)
    }
  }
}
