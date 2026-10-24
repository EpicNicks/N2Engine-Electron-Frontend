// The entity clipboard (protocol 1.18.0: SerializeEntities, InstantiateEntities). The host builds and checks the
// payload, so this only gives it a text form for the system clipboard (a header line, then the payload's JSON) and
// reads such text back, refusing anything that isn't ours or is too big to send, so a paste of some other text asks
// the host nothing.
import type { ClipboardPayload } from "./protocol.generated"

/** The Hello capability of a host with SerializeEntities and InstantiateEntities */
export const EntityClipboardCapability = "entityClipboard"

/** The payload's format name, as the host writes it */
export const ClipboardFormat = "n2engine.entities"

/** The first line of the clipboard text */
export const ClipboardHeader = "N2Engine entities v1"

/** The host refuses a payload over 16 MiB; text longer than that is not sent */
export const MaxClipboardChars = 16 * 1024 * 1024

/** The clipboard text for a payload the host serialized */
export function clipboardText(payload: ClipboardPayload): string {
  return `${ClipboardHeader}\n${JSON.stringify(payload)}`
}

/**
 * The JSON text to hand to InstantiateEntities, or null when the text isn't the editor's clipboard text (no header,
 * not JSON, the wrong format or not a list of objects) or is over the host's limit. The host checks the rest.
 */
export function parseClipboardText(text: unknown): string | null {
  if (typeof text !== "string" || !text.startsWith(`${ClipboardHeader}\n`)) return null
  const json = text.slice(ClipboardHeader.length + 1)
  if (json.length === 0 || json.length > MaxClipboardChars) return null
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const payload = value as Partial<ClipboardPayload>
  if (payload.format !== ClipboardFormat || !Array.isArray(payload.entities) || payload.entities.length === 0) return null
  return json
}
