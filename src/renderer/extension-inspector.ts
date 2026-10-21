// The inspector sections of the host's Lua editor extensions (protocol 1.16.0), as data: which sections go under a
// component, what a read-only field shows, and whether a button can be pressed now (with the reason). Pure, so it is
// unit tested in Node. Every string here comes from project code (an extension's declaration, or a value it reads):
// it is only ever shown as text, never as HTML.
import type { FieldSchema } from "../protocol/protocol.generated"
import type { ExtensionSummary, InspectorButton, InspectorSection } from "../protocol/extensions"
import { clean, type Availability } from "./extension-menu"
import { getFieldValue } from "./inspector-fields"
import type { HostRole } from "./store"

/** The longest value shown for a field (a longer one is cut) */
export const MaxValueLength = 200

/** The sections registered for a component type (in the host's order); none for any other type */
export function sectionsFor(sections: readonly InspectorSection[], componentType: string): InspectorSection[] {
  return sections.filter((section) => section.componentType === componentType)
}

/**
 * Whether the role may run buttons at all: they are a Write command, which a viewer is refused. A role that is not
 * known is not offered them. The host decides in the end; this only keeps the editor from offering what is refused.
 */
export function mayRunButtons(role: HostRole | null): boolean {
  return role === "admin" || role === "editor"
}

/** What buttonAvailability needs to know, as the editor stands now */
export interface ButtonContext {
  role: HostRole | null
  /** The host can run inspector buttons (protocol 1.16.0 or later, with the capability) */
  canInvoke: boolean
  /** Why nothing can be changed now (read-only host, play session, no scene, editor busy), or null */
  blockedReason: string | null
  /** Edit groups the editor has open (a drag in progress): the host refuses a button while one is */
  openGroups: number
  /** Another menu item or button is running */
  running: boolean
  /** The state of the extension the section belongs to, undefined when the editor does not know it */
  extension: ExtensionSummary | undefined
}

/** Whether a button can be pressed now, and why not (the first reason that applies) */
export function buttonAvailability(button: InspectorButton, ctx: ButtonContext): Availability {
  const no = (reason: string): Availability => ({ enabled: false, reason })
  if (!ctx.canInvoke) return no("This host is too old to run inspector buttons (they need protocol 1.16.0)")
  if (ctx.extension !== undefined && ctx.extension.state !== "loaded") {
    return no(`The extension ${clean(ctx.extension.name)} is disabled until an admin reloads it (Project Settings, Extensions)`)
  }
  if (button.minRole === "admin" && ctx.role !== "admin") {
    return no(`This button needs the admin role${ctx.role === null ? "" : ` (you are signed in as ${ctx.role})`}`)
  }
  if (ctx.blockedReason !== null) return no(`Not available: ${ctx.blockedReason}`)
  if (ctx.openGroups > 0) return no("An edit is in progress: finish it first")
  if (ctx.running) return no("Another extension action is running")
  return { enabled: true, reason: null }
}

/** Control characters (newlines and tabs too) become spaces in a shown value: one line, nothing that could pass as markup */
const Control = /[\u0000-\u001f\u007f]/g

function shorten(text: string): string {
  const flat = text.replace(Control, " ")
  return flat.length > MaxValueLength ? flat.slice(0, MaxValueLength) + "..." : flat
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

/**
 * What a section's field shows for a component's values, as text: the value the component holds under the field's name
 * (inside its container when it has one), or a dash when it has none. A vector is "(x, y, z)", anything else that is
 * not a plain value is shown as JSON. Never throws, whatever the value is.
 */
export function formatFieldValue(field: FieldSchema, values: unknown): string {
  let value: unknown
  try {
    value = getFieldValue(field, values)
  } catch {
    return "-"
  }
  if (value === undefined || value === null) return "-"
  if (typeof value === "string") return shorten(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (finite(value)) return String(value)
  if (typeof value === "number") return "-"
  if (typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>
    if (finite(v.x) && finite(v.y) && finite(v.z) && Object.keys(v).length === 3) return `(${v.x}, ${v.y}, ${v.z})`
  }
  try {
    return shorten(JSON.stringify(value) ?? "-")
  } catch {
    return "-"
  }
}
