// The parameter dialog of an extension's menu item: one row per field the host declared, edited with the inspector's own
// field editors, checked with the same rules (extension-form.ts), then OK sends the values. Everything it shows
// (titles, field names, tooltips, enum options) comes from project code and is shown as text only.
//
// Keys: Enter in a field is OK, Escape (not inside an open picker) is Cancel, Tab stays inside the dialog, the first
// field has the focus when it opens and what had the focus gets it back when it closes. A click outside does not
// close it: typed values are not thrown away by a stray click.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"
import type { FieldSchema } from "../protocol/protocol.generated"
import { checkForm, initialValues, visibleFields } from "./extension-form"
import { FieldEditor } from "./inspector-editors"
import { formRequest, type FormRequest } from "./ui"

const Focusable = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function FormDialog() {
  const request = formRequest.value
  if (!request) return null
  // A key per form: a second one starts with its own values
  return <FormBody key={request.id} request={request} />
}

function FormBody({ request }: { request: FormRequest }) {
  const fields = visibleFields(request.form)
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(request.form))
  // The values as of the last commit, read synchronously: Enter can come right after a field committed
  const current = useRef(values)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const errorsRef = useRef(errors)
  const root = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null)
  const done = useRef(false)

  const setFieldError = (name: string, message: string | null) => {
    const next = { ...errorsRef.current }
    if (message === null) delete next[name]
    else next[name] = message
    errorsRef.current = next
    setErrors(next)
  }

  // Before the first paint, so nothing typed into the first field can be stolen by a late focus
  useLayoutEffect(() => {
    const first = root.current?.querySelector<HTMLElement>(Focusable)
    first?.focus()
  }, [])

  useEffect(() => {
    return () => {
      // Closed (or replaced): whoever is waiting gets Cancel, and the focus goes back
      if (!done.current) request.resolve(null)
      opener.current?.focus?.()
    }
  }, [])

  const close = (params: Record<string, unknown> | null) => {
    if (done.current) return
    done.current = true
    formRequest.value = null
    request.resolve(params)
  }

  const submit = () => {
    // A box that was typed in and refused (its text stays) has not committed: its error blocks OK
    if (Object.keys(errorsRef.current).length > 0) {
      focusField(errorsRef.current)
      return
    }
    const checked = checkForm(request.form, current.current)
    if (!checked.ok) {
      errorsRef.current = checked.errors
      setErrors(checked.errors)
      focusField(checked.errors)
      return
    }
    close(checked.params)
  }

  const focusField = (failed: Record<string, string>) => {
    const name = Object.keys(failed)[0]
    const rows = [...(root.current?.querySelectorAll<HTMLElement>("[data-field]") ?? [])]
    const row = rows.find((element) => element.dataset.field === name)
    row?.querySelector<HTMLElement>(Focusable)?.focus()
  }

  const commit = (field: FieldSchema, value: unknown) => {
    current.current = { ...current.current, [field.name]: value }
    setValues(current.current)
    setFieldError(field.name, null)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement
    if (e.key === "Escape") {
      // Escape inside an open picker closes the picker (its own handler), not the dialog
      if (target.closest?.(".picker")) return
      e.preventDefault()
      e.stopPropagation()
      close(null)
    } else if (e.key === "Enter" && !e.isComposing) {
      const tag = target.tagName
      if (tag === "BUTTON" || tag === "TEXTAREA" || tag === "SELECT" || target.closest?.(".picker")) return
      e.preventDefault()
      // After the field's own handling of the key: a text box commits on its change event, which follows the keydown
      setTimeout(submit, 0)
    } else if (e.key === "Tab") {
      const focusable = [...(root.current?.querySelectorAll<HTMLElement>(Focusable) ?? [])]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  const titleId = `form-title-${request.id}`
  return (
    <div class="modal-overlay">
      <div ref={root} class="modal form-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <h3 id={titleId} class="form-title">
          {request.title}
        </h3>
        <div class="form-rows">
          {fields.map((field) => {
            const error = errors[field.name]
            const labelId = `form-${request.id}-${field.name}`
            return (
              <div class="form-row" key={field.name} data-field={field.name} role="group" aria-labelledby={labelId}>
                <span class="form-label" id={labelId} title={field.tooltip}>
                  {field.displayName}
                </span>
                <div class="form-editor">
                  <FieldEditor
                    field={field}
                    value={values[field.name]}
                    disabled={field.readOnly}
                    commit={(value) => commit(field, value)}
                    invalid={(message) => setFieldError(field.name, message)}
                  />
                </div>
                {field.tooltip && <div class="form-hint">{field.tooltip}</div>}
                {error && (
                  <div class="form-error" role="alert">
                    {error}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <div class="modal-buttons">
          <button type="button" class="secondary" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="button" onClick={submit}>
            {request.okLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
