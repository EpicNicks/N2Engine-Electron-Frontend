// What the assets panel checks before it asks the host to change something: a name for a new folder or script, the
// import settings text (JSON), and a text file about to be written. The host checks all of it again and stays the
// authority (EditorServer::ResolveAssetPath, MaxImportSettingsBytes, MaxTextAssetBytes); these catch the mistakes a
// person makes with the words the panel can say best, before a round trip. No DOM, so it is unit tested in Node.
import { MaxJsonDepth, MaxJsonNodes } from "../shared/api"
import type { JsonObject } from "../shared/api"
import type { Checked } from "./inspector-fields"
import { extname } from "./paths"

const ok = <T>(value: T): Checked<T> => ({ ok: true, value })
const fail = (error: string): Checked<never> => ({ ok: false, error })

/** SetImportSettings takes at most this many bytes of JSON (EditorServer::MaxImportSettingsBytes) */
export const MaxImportSettingsBytes = 64 * 1024
/** ReadTextAsset and WriteTextAsset handle at most this many bytes (EditorServer::MaxTextAssetBytes) */
export const MaxTextAssetBytes = 4 * 1024 * 1024

const encoder = new TextEncoder()
const utf8Length = (text: string): number => encoder.encode(text).length

// ==================== Names ====================

const WindowsDeviceNames = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i

/**
 * Whether a name can be a file or folder name on every platform the editor runs on, as the host decides it
 * (EditorServer::IsValidAssetName): not empty, at most 255 bytes, none of <>:"|?*\ / or a control character, no
 * trailing dot or space, not . or .., not a Windows device name (with or without an extension). Ok with the name.
 */
export function checkAssetName(name: string): Checked<string> {
  if (name === "") return fail("The name is empty")
  if (name === "." || name === "..") return fail(`"${name}" isn't a name`)
  if (utf8Length(name) > 255) return fail("The name is longer than 255 bytes")
  // eslint-disable-next-line no-control-regex
  const bad = /[<>:"|?*\\/\u0000-\u001f\u007f]/.exec(name)
  if (bad) {
    const shown = bad[0].charCodeAt(0) < 32 || bad[0] === "\u007f" ? "a control character" : `"${bad[0]}"`
    return fail(`A name can't contain ${shown}`)
  }
  if (/[. ]$/.test(name)) return fail("A name can't end with a dot or a space")
  const stem = name.includes(".") ? name.slice(0, name.indexOf(".")) : name
  if (WindowsDeviceNames.test(stem.replace(/ +$/, ""))) return fail(`"${stem}" is a reserved name on Windows`)
  return ok(name)
}

/** The file name for a new script: the name as typed, with .lua when it has no extension of that kind */
export function scriptFileName(name: string): string {
  const trimmed = name.trim()
  return trimmed.toLowerCase().endsWith(".lua") ? trimmed : `${trimmed}.lua`
}

/** The name for a new script, checked as a file name (the .lua is added to it) */
export function checkScriptName(name: string): Checked<string> {
  const file = scriptFileName(name)
  if (file.toLowerCase() === ".lua") return fail("The name is empty")
  const checked = checkAssetName(file)
  return checked.ok ? ok(file) : checked
}

// ==================== Import settings ====================

/** Whether the JSON stays within the depth and size the page may send (api.ts: the main process refuses more) */
function withinJsonLimits(value: unknown): boolean {
  let nodes = 0
  const walk = (item: unknown, depth: number): boolean => {
    if (++nodes > MaxJsonNodes || depth > MaxJsonDepth) return false
    if (Array.isArray(item)) return item.every((child) => walk(child, depth + 1))
    if (typeof item === "object" && item !== null) return Object.values(item).every((child) => walk(child, depth + 1))
    return true
  }
  return walk(value, 0)
}

/** An asset's import settings as the text the editor shows (pretty-printed; {} for none) */
export function importSettingsText(customData: unknown): string {
  return JSON.stringify(customData ?? {}, null, 2)
}

/** The text of the import settings as the JSON object SetImportSettings takes, or what is wrong with it */
export function parseImportSettings(text: string): Checked<JsonObject> {
  if (text.trim() === "") return fail("The import settings are empty (use {} for none)")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return fail(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("The import settings must be a JSON object ({ ... })")
  }
  if (!withinJsonLimits(parsed)) return fail("The import settings are nested too deeply or hold too many values")
  // What is sent is the compact form
  if (utf8Length(JSON.stringify(parsed)) > MaxImportSettingsBytes) {
    return fail(`The import settings are larger than ${MaxImportSettingsBytes / 1024} KiB`)
  }
  return ok(parsed as JsonObject)
}

/** Whether two texts hold the same settings (key order and spacing aside) */
export function sameImportSettings(a: string, b: string): boolean {
  const first = parseImportSettings(a)
  const second = parseImportSettings(b)
  if (!first.ok || !second.ok) return a === b
  return canonical(first.value) === canonical(second.value)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

// ==================== Text files ====================

/** The extensions ReadTextAsset and WriteTextAsset handle (EditorServer::IsTextAssetPath), lower case */
export const TextExtensions: readonly string[] = [
  ".lua",
  ".mat",
  ".scene",
  ".json",
  ".txt",
  ".md",
  ".csv",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".glsl",
  ".vert",
  ".frag",
  ".shader",
]

/** Whether the host reads and writes the file as text (anything else, a texture say, is never sent as text) */
export const isTextAssetPath = (path: string): boolean => TextExtensions.includes(extname(path).toLowerCase())

/** Whether the string holds a surrogate half with no partner (it has no UTF-8 spelling) */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}

/** A text the host will take: at most 4 MiB of UTF-8, no NUL, no half of a surrogate pair. Ok with the text. */
export function checkTextForWrite(text: string): Checked<string> {
  if (text.includes("\u0000")) return fail("The text has a NUL character, which a text file can't hold")
  if (hasLoneSurrogate(text)) return fail("The text has a character that can't be written as UTF-8")
  // Not counted when it can't reach the limit
  if (text.length > MaxTextAssetBytes || utf8Length(text) > MaxTextAssetBytes) {
    return fail(`The text is larger than ${MaxTextAssetBytes / (1024 * 1024)} MiB`)
  }
  return ok(text)
}

// ==================== Line endings ====================

/** A text file's line ending: what a textarea can't keep (it holds every line break as LF) */
export type LineEnding = "\n" | "\r\n"

/** The text as the editor holds it: every CRLF and lone CR is a LF (as a textarea does) */
export const normalizeLineEndings = (text: string): string => text.replace(/\r\n?/g, "\n")

/** The style most of the file's line breaks have (LF when there is a tie or none) */
export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/\n/g) ?? []).length - crlf
  return crlf > lf ? "\r\n" : "\n"
}

/** The editor's text as it goes to the file: every line break in the file's style */
export const withLineEnding = (text: string, ending: LineEnding): string =>
  ending === "\n" ? text : text.replace(/\n/g, ending)
