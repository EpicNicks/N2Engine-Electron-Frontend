// Trust for a project's Lua editor extensions (design lua-editor-extensions D3 and D5, section 6.2). Extensions are
// code that runs on the editor host, in <project>/editor/*.lua. The host never loads them unless it is started with
// --editor-extensions, and this is the only place in the editor that decides to pass that flag:
//
//   - only for a LOCAL project (a remote host's flag is its operator's; nothing here is asked for a remote engine);
//   - only when the project's own editor/ folder holds at least one .lua file (a project without one never gets it);
//   - only after the user said Trust for THAT folder: the answer is kept per folder (the folder's real path, see
//     trustKey), so a moved or renamed folder, a copy, or another project asks again, and nothing a project holds
//     (it is outside the project, in the editor's user data) can say "trusted";
//   - "Not now" starts the host without the flag.
//
// Nothing here ever reads, parses or evaluates an extension: the editor/ listing is names only, from a bounded walk
// that follows no link. Node only (no Electron): the dialog is a function given to ExtensionTrust (extension-prompt.ts),
// so everything is unit tested.
import * as fs from "fs"
import * as path from "path"
import type { ExtensionTrustState } from "../shared/api"

/** The folder next to project.n2proj that holds extensions (the host looks nowhere else) */
export const EditorFolderName = "editor"

/** The limits of the walk, the host's own (docs/editor.html "Where the files are, and which are found") */
export interface ScanLimits {
  /** Directory levels below editor/ that are looked into */
  maxDepth: number
  /** Directory entries looked at in all; the walk stops there */
  maxEntries: number
  /** Files listed (the host loads the first 64); more are only counted */
  maxListed: number
  /** The longest file path listed (longer ones are cut with ...) */
  maxNameLength: number
}

export const DefaultScanLimits: ScanLimits = { maxDepth: 8, maxEntries: 4096, maxListed: 64, maxNameLength: 120 }

/** What editor/ holds, as the editor sees it before the host loads anything */
export interface EditorFolderScan {
  /** editor/ is a real folder of the project (not a link, not a file) */
  present: boolean
  /** The .lua files, as paths inside editor/ with / separators, in byte order; at most maxListed */
  files: string[]
  /** How many .lua files were found (files.length, or more when only the first maxListed are listed) */
  total: number
  /** The walk stopped at the entry limit: there may be more */
  truncated: boolean
}

const Control = /[\u0000-\u001f\u007f]/

const NoExtensions: EditorFolderScan = { present: false, files: [], total: 0, truncated: false }

/** Whether child is inside parent (both real paths), compared as the platform's file system does */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

/**
 * The .lua files of <projectDir>/editor, found the way the host finds them and no further: up to maxDepth levels, at
 * most maxEntries entries, a symbolic link or junction (file or folder) is skipped and never followed, a file whose
 * real path is not inside editor/ is left out, and a name with a control character is not a file the host loads.
 * Only names are read: never a file's content. A folder that cannot be read counts as having nothing.
 */
export function scanEditorFolder(projectDir: string, limits: ScanLimits = DefaultScanLimits): EditorFolderScan {
  const root = path.join(projectDir, EditorFolderName)
  let realRoot: string
  try {
    // editor/ itself must be a real folder: a link is not followed (the host loads nothing from one either)
    if (!fs.lstatSync(root).isDirectory()) return NoExtensions
    realRoot = fs.realpathSync.native(root)
  } catch {
    return NoExtensions
  }
  const found: string[] = []
  let entries = 0
  let truncated = false

  const walk = (dir: string, prefix: string, depth: number): void => {
    let listing: fs.Dirent[]
    try {
      listing = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of listing) {
      if (++entries > limits.maxEntries) {
        truncated = true
        return
      }
      if (entry.isSymbolicLink()) continue
      const name = entry.name
      if (Control.test(name)) continue
      const full = path.join(dir, name)
      if (entry.isDirectory()) {
        if (depth < limits.maxDepth) walk(full, `${prefix}${name}/`, depth + 1)
        if (truncated) return
      } else if (entry.isFile() && /\.lua$/i.test(name)) {
        try {
          if (!isInside(realRoot, fs.realpathSync.native(full))) continue
        } catch {
          continue
        }
        found.push(`${prefix}${name}`)
      }
    }
  }
  walk(root, "", 0)

  found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const shown = found.slice(0, limits.maxListed).map((name) =>
    name.length > limits.maxNameLength ? `${name.slice(0, limits.maxNameLength)}...` : name
  )
  return { present: true, files: shown, total: found.length, truncated }
}

// ==================== The trust record ====================

/** What the record of one trusted folder holds */
interface TrustEntry {
  /** trustKey of the folder */
  key: string
  /** The folder as it was when trusted, for the person reading the file (never used to decide) */
  path: string
  /** ISO time of the answer */
  at: string
}

/** The most folders remembered; the oldest answers go first */
export const MaxTrusted = 200

/**
 * The folder's identity for trust: its real path (links, "..", a trailing separator and, on Windows, the letters'
 * case are resolved by the file system), lower-cased on macOS (a case-insensitive volume does not always return the
 * stored case). A folder that cannot be resolved has no key (null): it is never trusted. Two folders share a key only
 * if they are the same folder, so a moved, renamed or copied project has another key and asks again.
 */
export function trustKey(dir: string, platform: NodeJS.Platform = process.platform): string | null {
  let real: string
  try {
    real = fs.realpathSync.native(path.resolve(dir))
    if (!fs.statSync(real).isDirectory()) return null
  } catch {
    return null
  }
  // Windows' "\\?\C:\..." extended form names the same folder as "C:\..."
  if (/^\\\\\?\\[a-zA-Z]:\\/.test(real)) real = real.slice(4)
  return platform === "darwin" ? real.toLowerCase() : real
}

/**
 * Which project folders the user trusted to run editor extensions: a JSON file in the editor's user data folder (it
 * lives beside recent-projects.json, in its own file: the recent list holds ten paths and drops the oldest, and trust
 * must neither vanish with it nor outlive a deliberate revoke). Only the main process writes it, only after the
 * user's answer in a dialog; a project cannot reach it. A missing, unreadable or malformed file trusts nothing.
 */
export class ExtensionTrustStore {
  constructor(
    private readonly file: string,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  private read(): TrustEntry[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf-8"))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("Error reading extension trust:", err)
      return []
    }
    const list = typeof parsed === "object" && parsed !== null ? (parsed as { trusted?: unknown }).trusted : undefined
    if (!Array.isArray(list)) return []
    const entries: TrustEntry[] = []
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue
      const { key, path: shown, at } = item as Record<string, unknown>
      if (typeof key !== "string" || key === "") continue
      entries.push({ key, path: typeof shown === "string" ? shown : key, at: typeof at === "string" ? at : "" })
    }
    return entries.slice(-MaxTrusted)
  }

  private write(entries: TrustEntry[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify({ version: 1, trusted: entries.slice(-MaxTrusted) }), "utf-8")
  }

  /** Whether the user trusted exactly this folder (its real path); false for a folder that cannot be resolved */
  isTrusted(dir: string): boolean {
    const key = trustKey(dir, this.platform)
    return key !== null && this.read().some((entry) => entry.key === key)
  }

  /** Records the answer for this folder; throws when the record cannot be saved (nothing is then trusted) */
  trust(dir: string, now: Date = new Date()): void {
    const key = trustKey(dir, this.platform)
    if (key === null) throw new Error(`Not a folder that can be trusted: ${dir}`)
    const others = this.read().filter((entry) => entry.key !== key)
    this.write([...others, { key, path: key, at: now.toISOString() }])
  }

  /** Forgets the folder's trust (not an error when there was none) */
  revoke(dir: string): void {
    const key = trustKey(dir, this.platform)
    if (key === null) return
    const entries = this.read()
    const rest = entries.filter((entry) => entry.key !== key)
    if (rest.length !== entries.length) this.write(rest)
  }

  /** How many folders are trusted (for tests and diagnostics) */
  get size(): number {
    return this.read().length
  }
}

// ==================== The decision ====================

/** What launching a host for a project does about extensions, and what to tell the page */
export interface ExtensionLaunch {
  /** Start the host with --editor-extensions */
  flag: boolean
  /** For the page (HostState.extensionTrust); null when the project has no .lua files in editor/ */
  state: ExtensionTrustState | null
}

export const NoExtensionLaunch: ExtensionLaunch = Object.freeze({ flag: false, state: null })

export interface ExtensionTrustDeps {
  store: Pick<ExtensionTrustStore, "isTrusted" | "trust" | "revoke">
  /** Defaults to scanEditorFolder */
  scan?: (projectDir: string) => EditorFolderScan
  /**
   * Asks the user (a native dialog the page cannot answer for them): true for Trust. Any failure to ask, or a dialog
   * that was closed, is "Not now" (the caller treats a rejection that way).
   */
  ask(projectDir: string, scan: EditorFolderScan): Promise<boolean>
  log?: (message: string) => void
}

/** The dialog's words: what the project holds, what trusting means, and what is not known yet */
export function trustPromptText(projectDir: string, scan: EditorFolderScan): { message: string; detail: string } {
  const count = scan.total
  const shown = scan.files.slice(0, 10)
  const more = count - shown.length
  const list = shown.map((name) => `  ${name}`).join("\n") + (more > 0 ? `\n  and ${more} more` : "")
  return {
    message: `This project contains ${count} editor extension${count === 1 ? "" : "s"}. Trust this project?`,
    detail:
      `${projectDir}\n\n${list}\n\n` +
      "They run code on this computer's editor host. What each one is allowed to do (its capabilities) is not known " +
      "until the host loads it, so judge it by where the project came from. " +
      "Trust is remembered for this folder only. Choose Not now to open the project without them; you can enable them later."
  }
}

/**
 * Decides, for a local project, whether its host is started with --editor-extensions. The invariant that matters:
 * `flag` is true only when the folder's editor/ holds at least one .lua file AND the user trusted that folder (the
 * store is asked with the folder's real path, so no other folder inherits it).
 */
export class ExtensionTrust {
  private readonly scan: (projectDir: string) => EditorFolderScan

  constructor(private readonly deps: ExtensionTrustDeps) {
    this.scan = deps.scan ?? ((dir) => scanEditorFolder(dir))
  }

  private launch(projectDir: string, scan: EditorFolderScan, flag: boolean): ExtensionLaunch {
    if (scan.total === 0) return NoExtensionLaunch
    const trusted = this.deps.store.isTrusted(projectDir)
    return {
      // Re-derived here, never taken from the caller: no files or no trust is no flag
      flag: flag && trusted,
      state: { files: scan.files, more: Math.max(0, scan.total - scan.files.length), trusted, enabled: flag && trusted },
    }
  }

  /**
   * Opening a project: a trusted folder gets the flag; an untrusted one with extensions is asked (once, here); "Not
   * now" (or a failed dialog) starts the host without it. A project with no .lua file in editor/ is not asked.
   */
  async forOpen(projectDir: string): Promise<ExtensionLaunch> {
    const scan = this.scan(projectDir)
    if (scan.total === 0) return NoExtensionLaunch
    if (this.deps.store.isTrusted(projectDir)) return this.launch(projectDir, scan, true)
    let answer = false
    try {
      answer = (await this.deps.ask(projectDir, scan)) === true
    } catch (e) {
      this.deps.log?.(`The extension trust question failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (answer) {
      try {
        this.deps.store.trust(projectDir)
      } catch (e) {
        // Not recorded: not trusted, and no flag (the person is told through the banner, which offers it again)
        this.deps.log?.(`Couldn't record the trust: ${e instanceof Error ? e.message : String(e)}`)
        answer = false
      }
    }
    return this.launch(projectDir, scan, answer)
  }

  /** Restarting the host of an open project: the flag if the folder is trusted now; never a question */
  forRestart(projectDir: string): ExtensionLaunch {
    const scan = this.scan(projectDir)
    return this.launch(projectDir, scan, true)
  }

  /**
   * The page's "enable extensions" (the banner): always asks, in the native dialog, then trusts the folder and answers
   * the launch for the restart. null when the user said Not now, the project has no extensions, or it could not be recorded.
   */
  async enable(projectDir: string): Promise<ExtensionLaunch | null> {
    const scan = this.scan(projectDir)
    if (scan.total === 0) return null
    let answer = false
    try {
      answer = (await this.deps.ask(projectDir, scan)) === true
    } catch (e) {
      this.deps.log?.(`The extension trust question failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!answer) return null
    try {
      this.deps.store.trust(projectDir)
    } catch (e) {
      this.deps.log?.(`Couldn't record the trust: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
    return this.launch(projectDir, scan, true)
  }

  /** Forgets the folder's trust. The host that is running keeps what it loaded: the answer says so (enabled stays as it was). */
  revoke(projectDir: string, runningWithFlag: boolean): ExtensionTrustState | null {
    this.deps.store.revoke(projectDir)
    const scan = this.scan(projectDir)
    if (scan.total === 0) return null
    return { files: scan.files, more: Math.max(0, scan.total - scan.files.length), trusted: false, enabled: runningWithFlag }
  }
}
