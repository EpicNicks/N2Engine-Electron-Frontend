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
