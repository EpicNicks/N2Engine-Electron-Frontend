// A menu item's parameter form (FormDialog) as data: the fields the host declared (FieldSchema, with the types its
// params table supports: number, int, string, bool, Vector3, GameObject and enum), their starting values, and
// checking what was entered. The checks are the inspector's (inspector-fields.ts checkValue): the same bounds, and a
// number with a min or max is clamped as the host's ClampFieldValue does. The host checks every value again and is
// the authority; this keeps a request that would be refused from being sent, and says why next to the field.
import type { FieldSchema } from "../protocol/protocol.generated"
import type { ExtensionMenuItem } from "../protocol/extensions"
import { checkValue, defaultFieldValue } from "./inspector-fields"

export type ItemForm = NonNullable<ExtensionMenuItem["form"]>

/** The fields the dialog shows: the hidden ones are not (their defaults are still sent) */
export function visibleFields(form: ItemForm): FieldSchema[] {
  return form.fields.filter((field) => !field.hidden)
}

/** The values the dialog starts with: the host's default for each field, else the kind's neutral value */
export function initialValues(form: ItemForm): Record<string, unknown> {
  const entries: Array<[string, unknown]> = []
  for (const field of form.fields) {
    const given = Object.prototype.hasOwnProperty.call(form.defaults, field.name) ? form.defaults[field.name] : undefined
    entries.push([field.name, given === undefined ? defaultFieldValue(field) : given])
  }
  return Object.fromEntries(entries)
}

export type FormCheck =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> }

/**
 * The params to send, or the error of each field that cannot be sent. A field with no entered value takes its start
 * value; every field of the form is sent, the hidden ones with their defaults.
 */
export function checkForm(form: ItemForm, values: Record<string, unknown>): FormCheck {
  const start = initialValues(form)
  const params: Array<[string, unknown]> = []
  const errors: Array<[string, string]> = []
  for (const field of form.fields) {
    const value = Object.prototype.hasOwnProperty.call(values, field.name) ? values[field.name] : start[field.name]
    const checked = checkValue(field, value)
    if (checked.ok) params.push([field.name, checked.value])
    else errors.push([field.name, checked.error])
  }
  return errors.length > 0 ? { ok: false, errors: Object.fromEntries(errors) } : { ok: true, params: Object.fromEntries(params) }
}
