// The recently opened projects, newest first, kept in a JSON file in the app's user data folder
import * as fs from "fs"

const MaxRecent = 10

export class RecentProjects {
  constructor(private readonly file: string) {}

  list(): string[] {
    try {
      if (fs.existsSync(this.file)) {
        const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf-8"))
        if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === "string")
      }
    } catch (err) {
      console.error("Error reading recent projects:", err)
    }
    return []
  }

  add(projectPath: string): void {
    const recent = [projectPath, ...this.list().filter((p) => p !== projectPath)].slice(0, MaxRecent)
    try {
      fs.writeFileSync(this.file, JSON.stringify(recent))
    } catch (err) {
      console.error("Error saving recent projects:", err)
    }
  }

  includes(projectPath: string): boolean {
    return this.list().includes(projectPath)
  }
}
