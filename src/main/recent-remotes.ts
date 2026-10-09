// The recently used remote engines (frontend issue #21), newest first, in a JSON file in the app's user data folder.
// Only what isn't secret: user@host, the ports and the identity file's path. The access token is asked each time and
// never saved. Node only, so it is unit tested.
import * as fs from "fs"
import * as path from "path"
import { RemoteSettings, parseRemoteSettings } from "./ssh-tunnel"

export const MaxRecentRemotes = 10

const sameRemote = (a: RemoteSettings, b: RemoteSettings): boolean =>
  a.target === b.target && a.sshPort === b.sshPort && a.hostPort === b.hostPort

export class RecentRemotes {
  constructor(private readonly file: string) {}

  /** The saved remotes, newest first; a missing, unreadable or malformed file is an empty list, and bad entries are dropped */
  list(): RemoteSettings[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf-8"))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("Error reading recent remotes:", err)
      return []
    }
    if (!Array.isArray(parsed)) return []
    const remotes: RemoteSettings[] = []
    for (const item of parsed) {
      try {
        // Re-validated on every read: the file is the user's to edit, and what is in it ends up as ssh arguments
        const settings = parseRemoteSettings(item)
        if (!remotes.some((r) => sameRemote(r, settings))) remotes.push(settings)
      } catch {
        // not a remote
      }
    }
    return remotes.slice(0, MaxRecentRemotes)
  }

  /** Puts the remote first (replacing one with the same address and ports), keeping at most MaxRecentRemotes */
  add(settings: RemoteSettings): void {
    const clean = parseRemoteSettings(settings)
    this.save([clean, ...this.list().filter((r) => !sameRemote(r, clean))])
  }

  remove(settings: RemoteSettings): void {
    const clean = parseRemoteSettings(settings)
    const remotes = this.list()
    const kept = remotes.filter((r) => !sameRemote(r, clean))
    if (kept.length !== remotes.length) this.save(kept)
  }

  private save(remotes: RemoteSettings[]): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(remotes.slice(0, MaxRecentRemotes)))
    } catch (err) {
      console.error("Error saving recent remotes:", err)
    }
  }
}
