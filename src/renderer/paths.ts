// Path helpers for the page, which has no Node "path". Paths come from the main process in the platform's form
// (C:\a\b on Windows, /a/b elsewhere); both separators are understood.

function lastSeparator(p: string): number {
  return Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
}

function trimTrailingSeparators(p: string): string {
  let end = p.length
  while (end > 1 && (p[end - 1] === "/" || p[end - 1] === "\\")) end--
  return p.slice(0, end)
}

/** The last path component */
export function basename(p: string): string {
  const trimmed = trimTrailingSeparators(p)
  return trimmed.slice(lastSeparator(trimmed) + 1)
}

/** The extension of the last component, with its dot ("" for none, and for dotfiles like ".gitignore") */
export function extname(p: string): string {
  const name = basename(p)
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? "" : name.slice(dot)
}

/** Joins with the separator the base path already uses (backslash for a Windows path, else slash) */
export function join(base: string, ...parts: string[]): string {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/"
  return [trimTrailingSeparators(base), ...parts.map((part) => part.replace(/^[\/]+|[\/]+$/g, ""))]
    .filter((part, i) => i === 0 || part.length > 0)
    .join(separator)
}

/**
 * A file or folder of the project's assets folder as a res:// path (res:// is <project>/assets), or null when it
 * isn't inside it. The assets folder itself is "res://".
 */
export function toResPath(projectPath: string, filePath: string): string | null {
  const normalize = (p: string) => trimTrailingSeparators(p).replaceAll("\\", "/")
  const root = normalize(projectPath) + "/assets"
  const file = normalize(filePath)
  // Windows paths don't care about case
  const windows = /^[a-z]:/i.test(root)
  const [a, b] = windows ? [root.toLowerCase(), file.toLowerCase()] : [root, file]
  if (b === a) return "res://"
  return b.startsWith(a + "/") ? "res://" + file.slice(root.length + 1) : null
}

/**
 * What a user typed as a scene's path, as one the host takes: "res://" in front when it has no scheme, and ".scene"
 * at the end when it doesn't have it (in any case). The host checks the rest. Empty stays empty.
 */
export function normalizeScenePath(input: string): string {
  let path = input.trim().replaceAll("\\", "/")
  if (path === "") return ""
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) path = "res://" + path.replace(/^\/+/, "")
  return /\.scene$/i.test(path) ? path : path + ".scene"
}

/**
 * Why what the user typed can't be a scene's path, in words for them; null when it can (the host still checks the
 * rest). Empty is not a problem here: it means "cancel".
 */
export function scenePathProblem(input: string): string | null {
  const path = input.trim().replaceAll("\\", "/")
  if (path === "") return null
  if (/^[a-z]:(\/|$)/i.test(path) || path.startsWith("//")) {
    return "A scene's path is a res:// path (res:// is the project's assets folder), not a file on disk"
  }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(path)
  if (scheme && scheme[1].toLowerCase() !== "res") return "A scene's path starts with res://"
  const rest = scheme ? path.slice(scheme[0].length) : path
  const name = rest.slice(rest.lastIndexOf("/") + 1)
  if (name === "" || /^\.scene$/i.test(name)) return "The path needs a file name, like res://scenes/Level1.scene"
  return null
}
