// The typed import settings form of the assets panel's detail (FE10): one row per field of the asset type's table
// (assets-import-schema.ts), its value read from the settings text and written back into it through AssetsState, the
// engine's default shown for a field the settings leave out, the keys the form does not know kept and shown. The
// editor around it (assets-panel.tsx) has the Apply and Revert buttons and the "Edit as JSON" switch.
import type { AssetDetail } from "./assets-state"
import type { AssetsState } from "./assets-state"
import { parseImportSettings } from "./asset-edit"
import {
  ImportField,
  ImportSchema,
  blockOf,
  checkImportSettings,
  defaultText,
  fieldText,
  otherSettings,
  parseFieldText,
} from "./assets-import-schema"

const inputId = (schema: ImportSchema, field: ImportField): string => `import-${schema.block}-${field.key}`

function FieldRow(props: {
  schema: ImportSchema
  field: ImportField
  text: string
  error: string | null
  disabled: boolean
  assets: AssetsState
}) {
  const { schema, field, text, error, disabled, assets } = props
  const id = inputId(schema, field)
  const edit = (value: string) => assets.editSettingField(field.key, value)
  let control
  if (field.kind === "bool" || field.kind === "enum") {
    const options = field.kind === "bool" ? ["true", "false"] : [...(field.options ?? [])]
    const known = text === "" || options.includes(text)
    control = (
      <select
        id={id}
        value={text}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(e) => edit((e.currentTarget as HTMLSelectElement).value)}
      >
        <option value="">Default ({defaultText(field)})</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        {!known && <option value={text}>{text} (as written)</option>}
      </select>
    )
  } else {
    control = (
      <input
        id={id}
        type="text"
        inputMode={field.kind === "integer" ? "numeric" : field.kind === "number" ? "decimal" : undefined}
        value={text}
        placeholder={field.kind === "text" ? "(none)" : defaultText(field)}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onInput={(e) => edit((e.currentTarget as HTMLInputElement).value)}
      />
    )
  }
  return (
    <div class={`import-field${text !== "" ? " set" : ""}`} title={field.help}>
      <label for={id}>{field.label}</label>
      <span class="import-control">
        {control}
        {field.unit && <span class="import-unit">{field.unit}</span>}
      </span>
      {error && (
        <div class="import-field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

/** The form of a type that has one; the settings text must be a JSON object (the editor shows JSON otherwise) */
export function ImportSettingsForm(props: {
  schema: ImportSchema
  detail: AssetDetail
  assets: AssetsState
  disabled: boolean
}) {
  const { schema, detail, assets, disabled } = props
  const parsed = parseImportSettings(detail.settings)
  if (!parsed.ok) return <div class="asset-error">{parsed.error}. Edit the settings as JSON to fix them.</div>
  const check = checkImportSettings(schema, parsed.value)
  if (check.blockError) {
    return <div class="asset-error">{check.blockError}. Edit the settings as JSON to fix them.</div>
  }
  const block = blockOf(schema, parsed.value) ?? {}
  const other = otherSettings(schema, parsed.value)
  return (
    <div class="import-form" aria-label={`${schema.type} import settings`} role="group">
      {schema.fields.map((field) => {
        const text = fieldText(field, block, detail.fields)
        const draft = detail.fields[field.key]
        let error: string | null = check.fieldErrors[field.key] ?? null
        if (draft !== undefined) {
          const typed = parseFieldText(field, draft)
          error = typed.ok ? null : typed.error
        }
        return (
          <FieldRow
            key={field.key}
            schema={schema}
            field={field}
            text={text}
            error={error}
            disabled={disabled}
            assets={assets}
          />
        )
      })}
      {check.warnings.map((w) => (
        <div class="asset-warning" key={w}>
          {w}
        </div>
      ))}
      {check.unknownKeys.length > 0 && (
        <div class="asset-hint">
          Kept, not read by the engine: {check.unknownKeys.map((k) => `${schema.block}.${k}`).join(", ")}
        </div>
      )}
      {Object.keys(other).length > 0 && (
        <div class="import-other">
          <div class="detail-label">Other (JSON, kept as is)</div>
          <pre class="import-other-text" aria-label="Other import settings">
            {JSON.stringify(other, null, 2)}
          </pre>
        </div>
      )}
      <div class="asset-hint">
        An empty field uses the engine's default. Apply saves the .meta; the host drops the loaded asset, so its next use
        reimports it with these settings.
      </div>
    </div>
  )
}
