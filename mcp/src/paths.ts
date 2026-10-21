// Client-side checks of the project paths a write tool is given (design 4.7). The host is the authority (ResolveAssetPath:
// lexical, canonical and symlink checks, an extension allow list, assets/ only, never <project>/editor/), and the bridge
// refuses first, so a path that could only be an attempt to leave assets/ or reach the editor extensions' folder never
// reaches the host at all.
import { BridgeError } from "./errors"

const MaxPathChars = 512

function refused(why: string): BridgeError {
  return new BridgeError(
    "path_refused",
    `The path is not allowed: ${why}.`,
    "Use res:// followed by a plain relative path inside the project's assets folder (letters, digits, - _ . and / only), never ..  or the editor folder."
  )
}

/**
 * The path as the host will see it, or a path_refused error. Accepts res://<segments>: each segment non-empty, not . or
 * .., with no backslash, colon, percent escape, control character or trailing dot or space (Windows reads those
 * differently); the first segment is not `editor` (the editor extensions' folder, which must stay unreachable), nor
 * `assets` followed by `editor`; and the text is the same after Unicode compatibility normalisation (no full-width dots or slashes).
 */
export function checkAssetPath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) throw refused("it is empty")
  if (raw.length > MaxPathChars) throw refused(`it is longer than ${MaxPathChars} characters`)
  if (!raw.startsWith("res://")) throw refused("it must start with res://")
  if (raw !== raw.normalize("NFKC")) throw refused("it contains characters that look like punctuation but are not (use plain ASCII)")
  const rest = raw.slice("res://".length)
  if (rest.length === 0) throw refused("it names no file")
  if (/[\u0000-\u001F\u007F-\u009F\\:*?"<>|]/.test(rest)) throw refused("it contains a backslash, colon or other character that is not valid in a path")
  if (/%[0-9a-f]{2}/i.test(rest)) throw refused("it contains a percent escape")
  const segments = rest.split("/")
  for (const segment of segments) {
    if (segment === "") throw refused("it has an empty segment (// or a trailing /)")
    if (segment === "." || segment === "..") throw refused("it has a . or .. segment")
    if (/[. ]$/.test(segment)) throw refused("a segment ends with a dot or a space")
  }
  const first = segments[0].toLowerCase()
  if (first === "editor" || (first === "assets" && (segments[1] ?? "").toLowerCase() === "editor")) {
    throw refused("the editor folder (editor extensions) is never writable")
  }
  return raw
}

/** A scene file path: the same rules and a .scene extension */
export function checkScenePath(raw: string): string {
  const checked = checkAssetPath(raw)
  if (!/\.scene$/i.test(checked)) throw refused("a scene file ends in .scene")
  return checked
}

/** The class name for a new script: the file's name without its extension, made a valid Lua identifier */
export function classNameFor(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1)
  const stem = file.replace(/\.[^.]*$/, "")
  const clean = stem.replace(/[^A-Za-z0-9_]/g, "_")
  return /^[A-Za-z_]/.test(clean) ? clean.slice(0, 64) : `_${clean}`.slice(0, 64)
}
