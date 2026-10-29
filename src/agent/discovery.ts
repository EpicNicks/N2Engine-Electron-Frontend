// How the n2-mcp bridge finds the editor's agent endpoint (MCP6). While "Allow AI agent for this project" is on, the editor
// writes one small file per project into <userData>/agent/ (0600, in a 0700 folder): where its endpoint listens and this
// launch's secret. The file is the whole of the endpoint's credentials; it is deleted when the switch goes off, when the
// agent is disconnected and when the editor quits. Node only (no Electron), shared by both sides.
//
// The file is keyed by the project's folder: sha256 of its absolute path (lower-cased on Windows and macOS, whose file
// systems do not tell the case apart), so `--project <path>` finds it without listing anything.
import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/** The editor's app name as Electron derives it from package.json: the folder of its user data */
export const EditorAppName = "n2enginewebfrontend"

export const DiscoveryVersion = 1

/** What the file holds. Without `endpoint` and `secret` the endpoint is not running and `reason` says why (read-only, ...) */
export interface DiscoveryRecord {
  version: number
  /** The project folder the endpoint serves, as the editor has it open */
  projectPath: string
  /** A named pipe (Windows) or a Unix socket path */
  endpoint?: string
  /** 64 hex digits, new at every start of the endpoint */
  secret?: string
  /** The editor's process id, to tell a file a crash left from a live one */
  pid: number
  startedAt: string
  /** Why the endpoint is switched on but not running (the editor is read-only, ...) */
  reason?: string
}

/** The folder of the discovery files inside the editor's user data */
export function agentDirectory(userData: string): string {
  return path.join(userData, "agent")
}

/** The key of a project: its absolute path, case folded where the file system does, without a trailing separator */
export function projectKey(projectPath: string, platform: NodeJS.Platform = process.platform): string {
  let resolved = path.resolve(projectPath)
  if (resolved.length > 1) resolved = resolved.replace(/[\\/]+$/, "")
  if (platform === "win32" || platform === "darwin") resolved = resolved.toLowerCase()
  return createHash("sha256").update(resolved, "utf8").digest("hex").slice(0, 16)
}

export function discoveryFile(userData: string, projectPath: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(agentDirectory(userData), `project-${projectKey(projectPath, platform)}.json`)
}

/** Where Electron keeps the editor's user data when nothing says otherwise */
export function defaultUserData(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), EditorAppName)
  if (platform === "darwin") return path.join(home, "Library", "Application Support", EditorAppName)
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), EditorAppName)
}

/** A new secret: 256 random bits, as hex */
export function newSecret(): string {
  return randomBytes(32).toString("hex")
}

/**
 * Where a new endpoint listens. Windows: a named pipe with a random name. Elsewhere: a Unix socket in the agent folder,
 * or, when that path would be too long for the platform's sockaddr (about 104 bytes on macOS), in a private folder of the
 * temp directory.
 */
export function newEndpointPath(userData: string, platform: NodeJS.Platform = process.platform): { path: string; privateDir?: string } {
  const id = randomBytes(8).toString("hex")
  if (platform === "win32") return { path: `\\\\.\\pipe\\n2engine-agent-${id}` }
  const inside = path.join(agentDirectory(userData), `a-${id}.sock`)
  if (Buffer.byteLength(inside) <= 100) return { path: inside }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2agent-"))
  fs.chmodSync(dir, 0o700)
  return { path: path.join(dir, `a-${id}.sock`), privateDir: dir }
}

/**
 * Writes the record (0600, through a temp file and a rename, so a reader never sees half of it). On Windows the modes are
 * not enforced; the file sits in the user's profile, whose permissions already limit it to the user, SYSTEM and administrators.
 */
export function writeDiscovery(file: string, record: DiscoveryRecord): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // Windows has no such modes
  }
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 })
  try {
    fs.chmodSync(temp, 0o600)
  } catch {
    // Windows
  }
  fs.renameSync(temp, file)
}

/** Deletes the file; true when it was there. Never throws. */
export function removeDiscovery(file: string): boolean {
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/** The record in a file, or null when it is missing or not a valid record (nothing else of it is trusted) */
export function readDiscovery(file: string): DiscoveryRecord | null {
  let text: string
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 4096) return null
    // On POSIX a file others can read is not a secret: refuse it
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return null
    text = fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null) return null
  const r = value as Record<string, unknown>
  if (r.version !== DiscoveryVersion || typeof r.projectPath !== "string" || typeof r.pid !== "number" || typeof r.startedAt !== "string") return null
  const endpoint = typeof r.endpoint === "string" && r.endpoint.length > 0 && r.endpoint.length < 512 ? r.endpoint : undefined
  const secret = typeof r.secret === "string" && /^[0-9a-f]{64}$/.test(r.secret) ? r.secret : undefined
  return {
    version: DiscoveryVersion,
    projectPath: r.projectPath,
    pid: r.pid,
    startedAt: r.startedAt,
    ...(endpoint !== undefined && secret !== undefined ? { endpoint, secret } : {}),
    ...(typeof r.reason === "string" ? { reason: r.reason.slice(0, 300) } : {}),
  }
}

/** Every valid record in the user data's agent folder, with its file */
export function listDiscoveries(userData: string): Array<{ file: string; record: DiscoveryRecord }> {
  let names: string[]
  try {
    names = fs.readdirSync(agentDirectory(userData))
  } catch {
    return []
  }
  const found: Array<{ file: string; record: DiscoveryRecord }> = []
  for (const name of names) {
    if (!/^project-[0-9a-f]{16}\.json$/.test(name)) continue
    const file = path.join(agentDirectory(userData), name)
    const record = readDiscovery(file)
    if (record) found.push({ file, record })
  }
  return found
}

/** Whether a process with this id is running (a crashed editor leaves its file behind) */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}
