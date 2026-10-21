// Typed client support for the host's Lua editor extensions (protocol 1.14.0): the capability, the error codes, and
// defensive parsing of the two JSON answers (EditorExtensions, EditorUi). There is no UI here. Every parser takes
// unknown input and never throws: unknown fields are ignored, missing ones take a default, and a shape that cannot be
// used at all becomes null (the wrappers turn that into a typed "malformed" result).
import type { FieldSchema } from "./protocol.generated"
import { parseProtocolVersion } from "./protocol.generated"
import { parseFieldSchema } from "./component-schema"

/** ServerInfo.capabilities names the host has when it was built with the editor extension commands (since 1.14.0) */
export const EditorExtensionsCapability = "editorExtensions"

/** Whether the host's ServerInfo.capabilities lists the capability; a null or malformed list has none */
export function hasCapability(capabilities: unknown, name: string): boolean {
  return Array.isArray(capabilities) && capabilities.includes(name)
}

/**
 * InvokeMenuItem (since 1.15.0) has no capability of its own: a 1.14 host has "editorExtensions" too, and answers the
 * command with an unknown-command Error. So running an item needs the capability and a host of at least this minor.
 */
export const InvokeMenuItemMinMinor = 15

/** Whether a host with these ServerInfo capabilities and protocol version has InvokeMenuItem (never throws) */
export function supportsInvokeMenuItem(capabilities: unknown, protocolVersion: unknown): boolean {
  if (!hasCapability(capabilities, EditorExtensionsCapability)) return false
  const version = typeof protocolVersion === "string" ? parseProtocolVersion(protocolVersion) : null
  return version !== null && (version.major > 1 || (version.major === 1 && version.minor >= InvokeMenuItemMinMinor))
}

/**
 * The ErrorCoded codes that concern extensions (the code is the contract, never the message): the first three since
 * 1.14.0 (answered by InvokeMenuItem since 1.15.0), staleUiRevision and editGroupOpen since 1.15.0
 */
export const ExtensionErrorCodes = {
  extensionsDisabled: "extensionsDisabled",
  extensionFailed: "extensionFailed",
  extensionFaulted: "extensionFaulted",
  staleUiRevision: "staleUiRevision",
  editGroupOpen: "editGroupOpen",
} as const

/** What a failed extension command was, kept apart from the denials (forbidden, readOnly) and from busy */
export type ExtensionErrorKind =
  /** The host was not started with --editor-extensions */
  | "disabled"
  /** An extension's call failed and the host took its changes back (InvokeMenuItem, since 1.15.0) */
  | "failed"
  /** The extension is disabled until the next reload (InvokeMenuItem, since 1.15.0) */
  | "faulted"
  /** The uiRevision sent is not the host's current one: nothing ran, fetch GetEditorUi again (1.15.0) */
  | "staleUi"
  /** The client has an edit group open: nothing ran, end the group first (1.15.0) */
  | "editGroupOpen"
  /** The arguments were refused before anything was sent (a selection or params of the wrong shape) */
  | "invalid"
  /** The role may not run the command */
  | "forbidden"
  /** The host is read-only */
  | "readOnly"
  /** The answer was not in the shape the protocol describes */
  | "malformed"
  /** Any other failure: no connection, an Error without a code, an unknown code */
  | "other"

/** The kind of an ErrorCoded code (undefined, or a code this client doesn't know, is "other") */
export function extensionErrorKindOf(code: string | undefined): ExtensionErrorKind {
  switch (code) {
    case ExtensionErrorCodes.extensionsDisabled:
      return "disabled"
    case ExtensionErrorCodes.extensionFailed:
      return "failed"
    case ExtensionErrorCodes.extensionFaulted:
      return "faulted"
    case ExtensionErrorCodes.staleUiRevision:
      return "staleUi"
    case ExtensionErrorCodes.editGroupOpen:
      return "editGroupOpen"
    case "forbidden":
      return "forbidden"
    case "readOnly":
      return "readOnly"
    default:
      return "other"
  }
}

/** The result of an extension command: nothing here ever throws into the UI */
export type ExtensionsResult<T> =
  | { status: "ok"; value: T }
  /** The host has no editor extensions (before 1.14.0, or built without them): nothing was sent */
  | { status: "unsupported" }
  | { status: "error"; kind: ExtensionErrorKind; message: string; code?: string }

export type ExtensionState = "loaded" | "failed" | "faulted"

export interface ExtensionSummary {
  id: string
  name: string
  sha256: string
  apiVersion: number
  state: ExtensionState
  error?: string
  capabilities: string[]
  itemCount: number
}

/** ListEditorExtensions' and ReloadEditorExtensions' answer */
export interface ExtensionsInfo {
  enabled: boolean
  uiRevision: number
  extensions: ExtensionSummary[]
}

export type SelectionRule = "any" | "nonEmpty" | "one" | "none"
export type MinRole = "editor" | "admin"

export interface EnabledWhen {
  selection: SelectionRule
  componentType?: string
}

export interface ExtensionMenuItem {
  id: string
  extension: string
  path: string
  title: string
  enabledWhen: EnabledWhen
  confirm?: string
  minRole: MinRole
  form?: { fields: FieldSchema[]; defaults: Record<string, unknown> }
}

/** GetEditorUi's answer (inspectorSections is reserved and always empty in 1.14.0, so it is not modelled) */
export interface ExtensionsUi {
  uiRevision: number
  menuItems: ExtensionMenuItem[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback)

const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

const SelectionRules: readonly string[] = ["any", "nonEmpty", "one", "none"]

/** An unknown state is treated as failed: the extension is shown as not usable, never as loaded */
function parseState(value: unknown): ExtensionState {
  return value === "loaded" || value === "faulted" ? value : "failed"
}

function parseSummary(value: unknown): ExtensionSummary | null {
  if (!isObject(value)) return null
  const id = text(value.id)
  if (id === "") return null
  const summary: ExtensionSummary = {
    id,
    name: text(value.name, id),
    sha256: text(value.sha256),
    apiVersion: count(value.apiVersion),
    state: parseState(value.state),
    capabilities: strings(value.capabilities),
    itemCount: count(value.itemCount),
  }
  if (typeof value.error === "string") summary.error = value.error
  return summary
}

/** The EditorExtensions JSON as a typed value, or null when it is not an object */
export function parseExtensionsInfo(value: unknown): ExtensionsInfo | null {
  if (!isObject(value)) return null
  const list = Array.isArray(value.extensions) ? value.extensions : []
  const extensions: ExtensionSummary[] = []
  for (const entry of list) {
    const summary = parseSummary(entry)
    if (summary) extensions.push(summary)
  }
  return { enabled: value.enabled === true, uiRevision: count(value.uiRevision), extensions }
}

function parseEnabledWhen(value: unknown): EnabledWhen {
  if (!isObject(value)) return { selection: "any" }
  const selection =
    typeof value.selection === "string" && SelectionRules.includes(value.selection) ? value.selection : "any"
  const result: EnabledWhen = { selection: selection as SelectionRule }
  if (typeof value.componentType === "string" && value.componentType !== "") result.componentType = value.componentType
  return result
}

function parseForm(value: unknown): ExtensionMenuItem["form"] {
  if (!isObject(value) || !Array.isArray(value.fields)) return undefined
  const fields: FieldSchema[] = []
  for (const [i, field] of value.fields.entries()) {
    try {
      fields.push(parseFieldSchema(field, `form field ${i}`))
    } catch {
      // A field that can't be edited is left out, not a reason to drop the item
    }
  }
  return { fields, defaults: isObject(value.defaults) ? { ...value.defaults } : {} }
}

function parseMenuItem(value: unknown): ExtensionMenuItem | null {
  if (!isObject(value)) return null
  const id = text(value.id)
  if (id === "") return null
  const path = text(value.path)
  const item: ExtensionMenuItem = {
    id,
    extension: text(value.extension),
    path,
    title: text(value.title, path.split("/").pop() ?? ""),
    enabledWhen: parseEnabledWhen(value.enabledWhen),
    // An unknown role is the stricter one: the host enforces the role anyway, so this only hides, never grants
    minRole: value.minRole === "editor" ? "editor" : "admin",
  }
  if (typeof value.confirm === "string" && value.confirm !== "") item.confirm = value.confirm
  const form = parseForm(value.form)
  if (form) item.form = form
  return item
}

/** The EditorUi JSON as a typed value, or null when it is not an object */
export function parseExtensionsUi(value: unknown): ExtensionsUi | null {
  if (!isObject(value)) return null
  const list = Array.isArray(value.menuItems) ? value.menuItems : []
  const seen = new Set<string>()
  const menuItems: ExtensionMenuItem[] = []
  for (const entry of list) {
    const item = parseMenuItem(entry)
    // Ids are unique across the host: a repeated one is ignored, so a client never holds two items for one id
    if (item && !seen.has(item.id)) {
      seen.add(item.id)
      menuItems.push(item)
    }
  }
  return { uiRevision: count(value.uiRevision), menuItems }
}

/** The most objects InvokeMenuItem takes in its selection (the host refuses more) */
export const MaxInvokeSelection = 4096

const UuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Why InvokeMenuItem's arguments would be refused (null when they would not be): checked before sending, so a bad
 * call costs no round trip and never reaches the host. The host stays the authority (a name its form lacks, a value
 * out of its field's range).
 */
export function checkInvokeArguments(itemId: unknown, selection: unknown, params: unknown, uiRevision: unknown): string | null {
  if (typeof itemId !== "string" || itemId === "" || itemId.includes("\0")) return "itemId must be a non-empty string"
  if (!Array.isArray(selection)) return "selection must be an array of object UUIDs"
  if (selection.length > MaxInvokeSelection) return `selection has more than ${MaxInvokeSelection} objects`
  if (!selection.every((id) => typeof id === "string" && UuidPattern.test(id))) return "selection must hold only UUID strings"
  if (!isObject(params)) return "params must be a JSON object"
  if (typeof uiRevision !== "number" || !Number.isInteger(uiRevision) || uiRevision < 0 || uiRevision > 0xffffffff) {
    return "uiRevision must be an unsigned 32-bit integer"
  }
  return null
}

/** What an item returned: each part is left out by the host when empty, so a missing one is empty here */
export interface ExtensionResult {
  /** UNTRUSTED text from project code: show it as text, never as HTML */
  message: string
  /** Object UUIDs the item asks the editor to select */
  select: string[]
  /** UNTRUSTED text, like message */
  warnings: string[]
}

/** The edit the item made, as EditResult has it (an item that changed nothing leaves the revisions as they were) */
export interface ExtensionEdit {
  label: string
  revision: number
  savedRevision: number
  canUndo: boolean
  canRedo: boolean
}

/** InvokeMenuItem's answer: what the item returned and the history state after its step */
export interface InvokeResult {
  result: ExtensionResult
  edit: ExtensionEdit
}

/** ExtensionResult's JSON part: unknown fields ignored, missing ones empty, wrong types dropped; null when not an object */
export function parseExtensionResultInfo(value: unknown): ExtensionResult | null {
  if (!isObject(value)) return null
  return { message: text(value.message), select: strings(value.select), warnings: strings(value.warnings) }
}

/** The whole ExtensionResult response as a typed value, or null when the result part is not an object */
export function parseInvokeResult(response: unknown): InvokeResult | null {
  if (!isObject(response)) return null
  const result = parseExtensionResultInfo(response.result)
  if (result === null) return null
  return {
    result,
    edit: {
      label: text(response.label),
      revision: count(response.revision),
      savedRevision: count(response.savedRevision),
      canUndo: response.canUndo === true,
      canRedo: response.canRedo === true,
    },
  }
}
