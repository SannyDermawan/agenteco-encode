'use client'
import { useState } from 'react'
import { validateWithSchema, type CapabilityInfo } from '@shared/capabilities/custom'
import { LIMITS } from '@shared/capabilities/definitions'
import { CharCount, FIELD_CLASS, Field } from './FormField'
import { SchemaForm, isSimpleSchema } from './SchemaForm'

/**
 * The brief for a community capability (open registry), checked live against
 * the capability's published input schema, the same check the API and the
 * seller run before any money moves. A flat schema gets a real form (one field
 * per property); anything else, or anyone who prefers it, edits the JSON.
 * The capability's worked examples fill the brief in one click.
 */
export function CustomBriefForm({
  capability,
  json,
  onJsonChange,
  criteria,
  onCriteriaChange,
  showErrors,
}: {
  capability: CapabilityInfo
  json: string
  onJsonChange: (v: string) => void
  criteria: string
  onCriteriaChange: (v: string) => void
  showErrors: boolean
}) {
  const check = parseCustomBrief(capability, json)
  const formable = isSimpleSchema(capability.inputSchema)
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const asForm = formable && mode === 'form'
  const examples = capability.examples ?? []

  let current: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed
  } catch {
    // mid-edit in the JSON view; the form shows what it can
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12px] leading-relaxed text-[#8B8D96]">
          <span className="text-[#F5F5F7]">{capability.name}</span> is a community capability.{' '}
          {asForm ? 'Fill in the brief below.' : 'Write the brief as JSON that matches its input schema.'}
        </p>
        {formable && (
          <button type="button" onClick={() => setMode(asForm ? 'json' : 'form')} className="shrink-0 text-[12px] text-[#5B5FEF] hover:underline">
            {asForm ? 'Edit as JSON' : 'Use the form'}
          </button>
        )}
      </div>

      {examples.length > 0 && (
        <Field label="Start from an example">
          <select
            value=""
            onChange={(e) => {
              const example = examples[Number(e.target.value)]
              if (example) onJsonChange(JSON.stringify(example.input, null, 2))
            }}
            className={FIELD_CLASS}
          >
            <option value="">Choose…</option>
            {examples.map((x, i) => (
              <option key={x.title} value={i}>
                {x.title}
              </option>
            ))}
          </select>
        </Field>
      )}

      {asForm ? (
        <>
          <SchemaForm schema={capability.inputSchema} value={current} onChange={(next) => onJsonChange(JSON.stringify(next, null, 2))} />
          {showErrors && !check.ok && <p className="text-[11.5px] text-[#EF4444]">{check.error}</p>}
          {check.ok && <p className="text-[11.5px] text-[#54565F]">✓ matches the input schema</p>}
        </>
      ) : (
        <Field label="Brief (JSON)" error={showErrors && !check.ok ? check.error : undefined} hint={check.ok ? '✓ matches the input schema' : undefined}>
          <textarea
            value={json}
            onChange={(e) => onJsonChange(e.target.value)}
            rows={7}
            spellCheck={false}
            className={`${FIELD_CLASS} resize-y font-mono text-[12.5px]`}
          />
        </Field>
      )}

      <Field label="Acceptance criteria (optional)" hint={<CharCount value={criteria} max={LIMITS.textChars} />}>
        <textarea
          value={criteria}
          onChange={(e) => onCriteriaChange(e.target.value)}
          rows={2}
          maxLength={LIMITS.textChars}
          placeholder="What a good result must satisfy, the verifier and the arbiter read this."
          className={`${FIELD_CLASS} resize-none`}
        />
      </Field>
    </div>
  )
}

/** The brief as an object, if it is valid JSON that the capability's input schema accepts. */
export function parseCustomBrief(capability: CapabilityInfo, json: string): { ok: true; brief: unknown } | { ok: false; error: string } {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return { ok: false, error: 'Not valid JSON yet.' }
  }
  const checked = validateWithSchema(capability.inputSchema, value)
  return checked.ok ? { ok: true, brief: checked.data } : { ok: false, error: checked.error }
}
