'use client'
import { CharCount, FIELD_CLASS, Field } from './FormField'

/**
 * A form drawn from a flat JSON Schema: the buyer's brief for a community
 * capability, filled in field by field instead of as raw JSON. Handles strings,
 * numbers, booleans, enums and lists of strings or numbers; anything nested
 * falls back to the JSON editor (see isSimpleSchema).
 */

type Schema = Record<string, unknown>
const isObject = (v: unknown): v is Schema => !!v && typeof v === 'object' && !Array.isArray(v)

const PRIMITIVES = new Set(['string', 'number', 'integer', 'boolean'])

function isSimpleField(field: unknown): boolean {
  if (!isObject(field)) return false
  if (Array.isArray(field.enum)) return true
  if (typeof field.type === 'string' && PRIMITIVES.has(field.type)) return true
  if (field.type === 'array' && isObject(field.items)) return field.items.type === 'string' || field.items.type === 'number' || field.items.type === 'integer'
  return false
}

/** An object schema whose every field the form can draw. */
export function isSimpleSchema(schema: unknown): boolean {
  if (!isObject(schema) || schema.type !== 'object' || !isObject(schema.properties)) return false
  const fields = Object.values(schema.properties)
  return fields.length > 0 && fields.length <= 12 && fields.every(isSimpleField)
}

const label = (key: string, field: Schema) => (typeof field.title === 'string' ? field.title : key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()))

function hint(field: Schema): string | undefined {
  const parts: string[] = []
  if (typeof field.description === 'string') parts.push(field.description)
  if (typeof field.minimum === 'number' || typeof field.maximum === 'number') parts.push(`${field.minimum ?? '…'} to ${field.maximum ?? '…'}`)
  if (field.type === 'array') parts.push('separate with commas')
  return parts.length ? parts.join(' · ') : undefined
}

export function SchemaForm({
  schema,
  value,
  onChange,
}: {
  schema: Schema
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}) {
  const properties = schema.properties as Record<string, Schema>
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])

  /** Empty optional fields are left out of the brief, so they don't trip `minLength`-style rules. */
  function set(key: string, next: unknown) {
    const copy = { ...value }
    if (next === undefined || (next === '' && !required.has(key))) delete copy[key]
    else copy[key] = next
    onChange(copy)
  }

  return (
    <div className="space-y-4">
      {Object.entries(properties).map(([key, field]) => {
        const name = `${label(key, field)}${required.has(key) ? ' *' : ''}`
        const current = value[key]

        if (Array.isArray(field.enum)) {
          return (
            <Field key={key} label={name} hint={hint(field)}>
              <select value={String(current ?? '')} onChange={(e) => set(key, e.target.value === '' ? undefined : (field.enum as unknown[]).find((o) => String(o) === e.target.value))} className={FIELD_CLASS}>
                {!required.has(key) && <option value="">-</option>}
                {(field.enum as unknown[]).map((o) => (
                  <option key={String(o)} value={String(o)}>
                    {String(o)}
                  </option>
                ))}
              </select>
            </Field>
          )
        }
        if (field.type === 'boolean') {
          return (
            <label key={key} className="flex items-center gap-2.5 text-[13.5px] text-[#F5F5F7]">
              <input type="checkbox" checked={current === true} onChange={(e) => set(key, e.target.checked)} className="h-4 w-4 accent-[#5B5FEF]" />
              {name}
            </label>
          )
        }
        if (field.type === 'number' || field.type === 'integer') {
          return (
            <Field key={key} label={name} hint={hint(field)}>
              <input
                type="number"
                step={field.type === 'integer' ? 1 : 'any'}
                value={typeof current === 'number' ? current : ''}
                onChange={(e) => set(key, e.target.value === '' ? undefined : Number(e.target.value))}
                className={FIELD_CLASS}
              />
            </Field>
          )
        }
        if (field.type === 'array') {
          const numeric = (field.items as Schema).type !== 'string'
          const shown = Array.isArray(current) ? current.join(', ') : ''
          return (
            <Field key={key} label={name} hint={hint(field)}>
              <input
                value={shown}
                onChange={(e) => {
                  const parts = e.target.value.split(',').map((p) => p.trim()).filter(Boolean)
                  set(key, parts.length ? (numeric ? parts.map(Number) : parts) : undefined)
                }}
                className={FIELD_CLASS}
              />
            </Field>
          )
        }
        const text = typeof current === 'string' ? current : ''
        const max = typeof field.maxLength === 'number' ? field.maxLength : undefined
        const long = (max ?? 0) > 200 || field.format === 'textarea'
        return (
          <Field key={key} label={name} hint={max ? <CharCount value={text} max={max} /> : hint(field)}>
            {long ? (
              <textarea value={text} onChange={(e) => set(key, e.target.value)} rows={4} className={`${FIELD_CLASS} resize-y`} />
            ) : (
              <input value={text} onChange={(e) => set(key, e.target.value)} className={FIELD_CLASS} />
            )}
          </Field>
        )
      })}
    </div>
  )
}
