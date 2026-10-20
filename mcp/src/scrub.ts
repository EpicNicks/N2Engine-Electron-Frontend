// Everything that comes from the project (names, field values, asset text, console lines) is UNTRUSTED DATA: an
// attacker who can write a scene or a script can write a prompt. This module is what stands between the host's strings
// and the model:
//   - control characters are removed, and bidi, zero-width, line-separator and tag characters are shown as \u{...}
//     escapes, so what the model reads is what is there (design 4.6 item 2);
//   - the host's absolute paths and the bridge's own secrets are replaced (design 4.6 items 5 and 6, audit F10);
//   - every string and the whole value are bounded, with explicit truncation markers (design M1);
//   - text put in the result's text block travels in an <n2-data> envelope that the data itself cannot close.
// Pure functions and one small class; no I/O.

/** Characters that are shown as an escape instead of being passed on: invisible or direction-changing ones */
const EscapedChars = new RegExp(
  "[" +
    "\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F" +
    "\\uFEFF\\uFFF9-\\uFFFB" +
    "]|\\u{E0000}|[\\u{E0001}-\\u{E007F}]|[\\u{E0100}-\\u{E01EF}]",
  "gu"
)

/** C0 controls (not tab and newline, handled apart), DEL and C1 controls */
const Controls = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

/** A path of the host's that no result should carry: a drive path, or a UNC path, or a path under a home or temp dir */
const GenericPaths =
  /(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/])[^\s"'<>|*?`]*|\/(?:home|Users|root|tmp|var|opt|mnt|srv|etc|usr|proc|private)\/[^\s"'<>|*?`]*/g

export const RedactedPath = "<host-path>"
export const RedactedSecret = "[redacted]"

/** "\u{202e}" for a character shown as an escape */
function showAsEscape(ch: string): string {
  return `\\u{${ch.codePointAt(0)!.toString(16)}}`
}

/** Text with no lone surrogates, and (when it was cut at a surrogate pair) no half character at the end */
function wellFormed(text: string): string {
  return text.toWellFormed()
}

/** How much a value may still add to a result */
export class Budget {
  private left: number
  /** Something was left out for lack of budget */
  truncated = false

  constructor(bytes: number) {
    this.left = bytes
  }

  /** Spends bytes; false (and the budget is marked truncated) when there are not that many left */
  take(bytes: number): boolean {
    if (bytes > this.left) {
      this.truncated = true
      this.left = 0
      return false
    }
    this.left -= bytes
    return true
  }

  get remaining(): number {
    return this.left
  }
}

export const OmittedBudget = "[omitted: size budget reached]"
export const OmittedDepth = "[omitted: nested too deeply]"

/** The marker that ends a string that was cut: how much was left out */
export function truncationMarker(omittedChars: number): string {
  return `...[truncated ${omittedChars} more characters]`
}

export interface ScrubOptions {
  /** Newlines and tabs are kept (asset text); otherwise they become spaces */
  multiline?: boolean
  /** The string is cut at this many characters, with a marker */
  maxChars?: number
  /** Also replace any absolute host path (messages and log lines), not just the known project folders */
  anyPath?: boolean
}

/** What replaces what: the project's folders (learned from the host) and the secrets the bridge holds */
export class Scrubber {
  private readonly roots: Array<{ pattern: RegExp; replacement: string }> = []
  private readonly secrets = new Set<string>()

  /** A secret (an access token) that must never appear in anything the bridge writes. Short values are refused. */
  addSecret(secret: string): void {
    if (secret.length >= 8) this.secrets.add(secret)
  }

  /** Whether a text holds a registered secret (for tests and the last-resort check) */
  hasSecret(text: string): boolean {
    for (const secret of this.secrets) if (text.includes(secret)) return true
    return false
  }

  /**
   * The project's folder and the user-data folder, as the host reports them: replaced by <project> and <userdata> in
   * every string from then on (both slash styles, any case on Windows paths)
   */
  setRoots(rootPath: string | undefined, userDataPath: string | undefined): void {
    this.roots.length = 0
    // The longer first, so a user-data folder inside the project folder is not half replaced
    const entries: Array<[string | undefined, string]> = [
      [rootPath, "<project>"],
      [userDataPath, "<userdata>"],
    ]
    entries
      .filter((entry): entry is [string, string] => typeof entry[0] === "string" && entry[0].length > 3)
      .sort((a, b) => b[0].length - a[0].length)
      .forEach(([root, replacement]) => {
        const trimmed = root.replace(/[\\/]+$/, "")
        const escaped = trimmed
          .split(/[\\/]+/)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("[\\\\/]+")
        this.roots.push({ pattern: new RegExp(escaped + "(?![A-Za-z0-9_-])", "gi"), replacement })
      })
  }

  /** A string made safe to show: see the top of this file */
  str(value: string, options: ScrubOptions = {}): string {
    let text = wellFormed(value)
    for (const secret of this.secrets) text = text.split(secret).join(RedactedSecret)
    for (const root of this.roots) text = text.replace(root.pattern, root.replacement)
    if (options.anyPath) text = text.replace(GenericPaths, RedactedPath)
    if (options.multiline) {
      text = text.replace(/\r\n?/g, "\n")
      text = text.replace(Controls, "")
    } else {
      text = text.replace(/[\t\r\n\u0085\u2028\u2029]+/g, " ")
      text = text.replace(Controls, "")
    }
    text = text.replace(EscapedChars, showAsEscape)
    const max = options.maxChars ?? StringCharsDefault
    if (text.length > max) {
      const kept = wellFormed(text.slice(0, max))
      text = kept + truncationMarker(text.length - kept.length)
    }
    return text
  }

  /** An entity's, asset's or tag's name: single line, cut at the name limit */
  name(value: string, maxChars: number = NameCharsDefault): string {
    return this.str(value, { maxChars })
  }

  /** A host message (an error, a log line): single line, paths of the host removed */
  message(value: string, maxChars: number = StringCharsDefault): string {
    return this.str(value, { maxChars, anyPath: true })
  }

  /**
   * Any JSON value from the host, scrubbed all the way down (keys too) and kept within the budget: a string that no
   * longer fits is replaced by a marker, an array is cut at maxItems with a marker element, and nesting past maxDepth is
   * a marker. Numbers that are not finite become null. Class instances and functions can't come from JSON.
   */
  deep(value: unknown, budget: Budget, maxDepth: number = 16, maxItems: number = 1000): unknown {
    const visit = (v: unknown, depth: number): unknown => {
      if (v === null || typeof v === "boolean") return v
      if (typeof v === "number") return Number.isFinite(v) ? v : null
      if (typeof v === "string") {
        const text = this.str(v, { multiline: true, maxChars: StringCharsDefault })
        return budget.take(Buffer.byteLength(text) + 2) ? text : OmittedBudget
      }
      if (typeof v !== "object") return null
      if (depth >= maxDepth) return OmittedDepth
      if (Array.isArray(v)) {
        const out: unknown[] = []
        for (const item of v.slice(0, maxItems)) {
          if (budget.remaining <= 0) {
            budget.truncated = true
            out.push(OmittedBudget)
            return out
          }
          out.push(visit(item, depth + 1))
        }
        if (v.length > maxItems) {
          budget.truncated = true
          out.push(`...[${v.length - maxItems} more items omitted]`)
        }
        return out
      }
      const entries: Array<[string, unknown]> = []
      for (const [key, item] of Object.entries(v as Record<string, unknown>)) {
        const safeKey = this.str(key, { maxChars: NameCharsDefault })
        if (!budget.take(Buffer.byteLength(safeKey) + 4)) {
          entries.push(["...", OmittedBudget])
          break
        }
        entries.push([safeKey, visit(item, depth + 1)])
      }
      // fromEntries defines own properties, so a key named __proto__ stays data
      return Object.fromEntries(entries)
    }
    return visit(value, 0)
  }
}

// The defaults, kept here (not imported from limits.ts) so scrub.ts has no dependency but the language
const NameCharsDefault = 256
const StringCharsDefault = 4096

/** The envelope's tags */
export const EnvelopeOpen = (source: string): string => `<n2-data source="${source}" untrusted>`
export const EnvelopeClose = "</n2-data>"

/**
 * JSON text that can sit inside the envelope: < and > (and &) are escaped, so nothing in the data can write the closing
 * tag or another one, and U+2028 and U+2029 (already escaped by the scrubber) can't break a line
 */
export function envelopeJson(value: unknown): string {
  return JSON.stringify(value, null, 1).replace(/[<>&\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

/** The text block of a result: a short summary, then the data in the envelope */
export function envelopeText(summary: string, source: string, data: unknown): string {
  return `${summary}\n${EnvelopeOpen(source)}\n${envelopeJson(data)}\n${EnvelopeClose}`
}
