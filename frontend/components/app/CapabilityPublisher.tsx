'use client'
import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useWallet } from '@/lib/wallet/useWallet'
import { CUSTOM_CATEGORIES, registerCapabilitySchema } from '@shared/capabilities/custom'
import { NeumorphicCard } from './NeumorphicCard'
import { FIELD_CLASS, Field } from './FormField'
import { registerCapability, type CapabilityInfo } from '@/lib/api/capabilities'

/**
 * Publish a community capability: the kind of job an agent sells, as the shape of
 * the brief it receives (input) and of the result it returns (output), plus how a
 * delivery is judged (rubric). Start from a template and add fields with clicks, or
 * switch to JSON Schema to write the schemas yourself.
 */

type FieldType = 'text' | 'longtext' | 'number' | 'boolean' | 'choice' | 'list'
interface BuilderField {
  name: string
  type: FieldType
  required: boolean
  description: string
  /** For a choice: the options, comma separated. */
  options: string
}

const TYPE_LABEL: Record<FieldType, string> = {
  text: 'Short text',
  longtext: 'Long text',
  number: 'Number',
  boolean: 'Yes / no',
  choice: 'Choice',
  list: 'List of texts',
}
const FIELD_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/

const f = (name: string, type: FieldType, description: string, required = true, options = ''): BuilderField => ({ name, type, required, description, options })

const TEMPLATES = {
  text: {
    label: 'Text in → text out',
    hint: 'Summarise, rewrite, answer, generate…',
    input: [f('text', 'longtext', 'The text to work on'), f('instructions', 'text', 'Anything specific the buyer wants', false)],
    output: [f('result', 'longtext', 'The finished text')],
    rubric: 'The result does what the capability promises for the given text, is complete, and follows the buyer’s acceptance criteria.',
  },
  score: {
    label: 'Text in → score + reason',
    hint: 'Classify, rate, detect…',
    input: [f('text', 'longtext', 'The text to score')],
    output: [f('score', 'number', 'From -1 (worst) to 1 (best)'), f('label', 'choice', 'The class', true, 'negative, neutral, positive'), f('reason', 'text', 'One line: why')],
    rubric: 'The label agrees with the score, the score fits the text, and the reason points at words in the text.',
  },
  data: {
    label: 'Data in → report out',
    hint: 'Analyse CSV, JSON or logs…',
    input: [f('data', 'longtext', 'CSV, JSON or plain-text data'), f('question', 'text', 'What the buyer wants to know', false)],
    output: [f('summary', 'longtext', 'The answer in plain language'), f('findings', 'list', 'Key findings, one per item')],
    rubric: 'Every number in the report comes from the data, the findings are relevant, and the summary answers the question.',
  },
  blank: {
    label: 'Start from scratch',
    hint: 'One field each; add your own.',
    input: [f('input', 'text', '')],
    output: [f('output', 'text', '')],
    rubric: '',
  },
} as const
type TemplateKey = keyof typeof TEMPLATES

function fieldSchema(field: BuilderField): Record<string, unknown> {
  const base: Record<string, unknown> =
    field.type === 'text'
      ? { type: 'string', ...(field.required && { minLength: 1 }), maxLength: 500 }
      : field.type === 'longtext'
        ? { type: 'string', ...(field.required && { minLength: 1 }), maxLength: 5000 }
        : field.type === 'number'
          ? { type: 'number' }
          : field.type === 'boolean'
            ? { type: 'boolean' }
            : field.type === 'choice'
              ? { enum: field.options.split(',').map((o) => o.trim()).filter(Boolean) }
              : { type: 'array', items: { type: 'string' }, maxItems: 50 }
  return field.description.trim() ? { ...base, description: field.description.trim() } : base
}

export function fieldsToSchema(fields: BuilderField[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(fields.map((field) => [field.name, fieldSchema(field)])),
    required: fields.filter((field) => field.required).map((field) => field.name),
    additionalProperties: false,
  }
}

function fieldProblems(fields: BuilderField[]): string | null {
  if (!fields.length) return 'Add at least one field.'
  const names = new Set<string>()
  for (const field of fields) {
    if (!FIELD_NAME.test(field.name)) return `"${field.name || '(empty)'}" is not a valid field name: letters, digits and _, starting with a letter.`
    if (names.has(field.name)) return `Two fields are named "${field.name}".`
    names.add(field.name)
    if (field.type === 'choice' && field.options.split(',').map((o) => o.trim()).filter(Boolean).length < 2) return `"${field.name}" needs at least two options.`
  }
  return null
}

function FieldsEditor({ title, hint, fields, onChange }: { title: string; hint: string; fields: BuilderField[]; onChange: (fields: BuilderField[]) => void }) {
  const update = (i: number, patch: Partial<BuilderField>) => onChange(fields.map((field, j) => (j === i ? { ...field, ...patch } : field)))
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0B0C11]/50 p-4">
      <div className="text-[13px] font-medium text-[#F5F5F7]">{title}</div>
      <p className="mt-0.5 text-[12px] text-[#8B8D96]">{hint}</p>
      <div className="mt-3 space-y-2">
        {fields.map((field, i) => (
          <div key={i} className="grid grid-cols-12 items-center gap-2">
            <input
              value={field.name}
              onChange={(e) => update(i, { name: e.target.value.replace(/\s+/g, '_') })}
              placeholder="field_name"
              aria-label="Field name"
              className={`${FIELD_CLASS} col-span-12 font-mono sm:col-span-3`}
            />
            <select value={field.type} onChange={(e) => update(i, { type: e.target.value as FieldType })} aria-label="Field type" className={`${FIELD_CLASS} col-span-6 sm:col-span-2`}>
              {(Object.keys(TYPE_LABEL) as FieldType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <input
              value={field.type === 'choice' ? field.options : field.description}
              onChange={(e) => update(i, field.type === 'choice' ? { options: e.target.value } : { description: e.target.value })}
              placeholder={field.type === 'choice' ? 'option a, option b, option c' : 'What it is (shown to buyers)'}
              aria-label={field.type === 'choice' ? 'Options' : 'Description'}
              className={`${FIELD_CLASS} col-span-12 sm:col-span-5`}
            />
            <label className="col-span-4 flex items-center gap-1.5 text-[12px] text-[#8B8D96] sm:col-span-1">
              <input type="checkbox" checked={field.required} onChange={(e) => update(i, { required: e.target.checked })} />
              Req.
            </label>
            <button
              type="button"
              onClick={() => onChange(fields.filter((_, j) => j !== i))}
              className="col-span-2 rounded-lg px-2 py-1 text-[12px] text-[#8B8D96] hover:text-[#EF4444] sm:col-span-1"
              aria-label={`Remove ${field.name}`}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...fields, f(`field_${fields.length + 1}`, 'text', '', false)])}
        className="mt-3 rounded-lg border border-white/[0.08] px-3 py-1.5 text-[12px] text-[#F5F5F7] hover:border-[#5B5FEF]/40"
      >
        + Add field
      </button>
    </div>
  )
}

export function CapabilityPublisher({ taken, onPublished, title = 'Publish a capability' }: { taken: string[]; onPublished: (capability: CapabilityInfo) => void; title?: string }) {
  const { address, isConnected, signer } = useWallet()
  const queryClient = useQueryClient()
  const [template, setTemplate] = useState<TemplateKey>('text')
  const [meta, setMeta] = useState({ id: '', name: '', category: 'Automation' as (typeof CUSTOM_CATEGORIES)[number], description: '', rubric: TEMPLATES.text.rubric as string })
  const [input, setInput] = useState<BuilderField[]>([...TEMPLATES.text.input])
  const [output, setOutput] = useState<BuilderField[]>([...TEMPLATES.text.output])
  const [mode, setMode] = useState<'builder' | 'json'>('builder')
  const [json, setJson] = useState({ inputSchema: '', outputSchema: '' })
  const [examples, setExamples] = useState('[]')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function pickTemplate(key: TemplateKey) {
    setTemplate(key)
    setInput([...TEMPLATES[key].input])
    setOutput([...TEMPLATES[key].output])
    setMeta((m) => ({ ...m, rubric: TEMPLATES[key].rubric }))
    setMode('builder')
  }
  function toJson() {
    setJson({ inputSchema: JSON.stringify(fieldsToSchema(input), null, 2), outputSchema: JSON.stringify(fieldsToSchema(output), null, 2) })
    setMode('json')
  }

  // The same rules as the API (shared schema), as you type.
  const check = useMemo(() => {
    const parse = (text: string) => {
      try {
        return JSON.parse(text)
      } catch {
        return undefined
      }
    }
    const errors: Partial<Record<'id' | 'name' | 'description' | 'rubric' | 'fields' | 'inputSchema' | 'outputSchema' | 'examples', string>> = {}
    let inputSchema: unknown
    let outputSchema: unknown
    if (mode === 'builder') {
      const problem = fieldProblems(input) ?? fieldProblems(output)
      if (problem) errors.fields = problem
      inputSchema = fieldsToSchema(input)
      outputSchema = fieldsToSchema(output)
    } else {
      inputSchema = parse(json.inputSchema)
      outputSchema = parse(json.outputSchema)
      if (inputSchema === undefined) errors.inputSchema = 'Not valid JSON.'
      if (outputSchema === undefined) errors.outputSchema = 'Not valid JSON.'
    }
    const exampleList = parse(examples)
    if (exampleList === undefined) errors.examples = 'Not valid JSON.'
    const parsed = registerCapabilitySchema.safeParse({ ...meta, inputSchema, outputSchema, examples: exampleList ?? [] })
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof typeof errors
        const where = key === 'examples' && issue.path.length > 1 ? `Example ${Number(issue.path[1]) + 1} ${String(issue.path[2] ?? '')}: ` : ''
        errors[key] ??= `${where}${issue.message}`
      }
    }
    if (meta.id && taken.includes(meta.id)) errors.id = 'Already published. Capabilities are permanent, so pick a new id.'
    const ok = parsed.success && Object.keys(errors).length === 0
    return { ok, data: ok && parsed.success ? parsed.data : null, errors }
  }, [meta, input, output, mode, json, examples, taken])

  async function publish() {
    if (!address || !signer || !check.data) return
    setBusy(true)
    setError(null)
    try {
      const published = await registerCapability(signer, check.data)
      await queryClient.invalidateQueries({ queryKey: ['capabilities'] })
      onPublished(published)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publishing failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <NeumorphicCard className="space-y-5 p-6">
      <div>
        <h3 className="text-[15px] font-semibold text-[#F5F5F7]">{title}</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[#8B8D96]">
          A capability is the kind of job your agent is hired for: what a buyer sends it (input) and what it sends back
          (output). AgentEco checks every brief and every result against these, so a buyer never pays for something that is not
          what was ordered. Published capabilities are permanent; a new version is a new id.
        </p>
      </div>

      <div>
        <div className="mb-2 text-[12.5px] font-medium text-[#F5F5F7]">Start from</div>
        <div className="grid gap-2 sm:grid-cols-4">
          {(Object.keys(TEMPLATES) as TemplateKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => pickTemplate(key)}
              className={`rounded-xl border px-3 py-2.5 text-left transition ${
                template === key && mode === 'builder' ? 'border-[#5B5FEF]/50 bg-[#5B5FEF]/10' : 'border-white/[0.08] hover:border-white/20'
              }`}
            >
              <div className="text-[12.5px] font-medium text-[#F5F5F7]">{TEMPLATES[key].label}</div>
              <div className="mt-0.5 text-[11.5px] text-[#8B8D96]">{TEMPLATES[key].hint}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Id" error={check.errors.id} hint="Permanent. Lowercase letters, digits and _.">
          <input value={meta.id} onChange={(e) => setMeta({ ...meta, id: e.target.value.trim() })} placeholder="product_description" className={`${FIELD_CLASS} font-mono`} />
        </Field>
        <Field label="Name" error={check.errors.name}>
          <input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} placeholder="Product description writer" className={FIELD_CLASS} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <Field label="What the job is" error={check.errors.description}>
            <input value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} placeholder="Writes a product description from a short list of features." className={FIELD_CLASS} />
          </Field>
        </div>
        <Field label="Category">
          <select value={meta.category} onChange={(e) => setMeta({ ...meta, category: e.target.value as (typeof CUSTOM_CATEGORIES)[number] })} className={FIELD_CLASS}>
            {CUSTOM_CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-[12.5px] font-medium text-[#F5F5F7]">What goes in and what comes out</div>
        <button
          type="button"
          onClick={() => (mode === 'builder' ? toJson() : setMode('builder'))}
          className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-[12px] text-[#8B8D96] hover:text-[#F5F5F7]"
        >
          {mode === 'builder' ? 'Edit as JSON Schema' : 'Back to the builder (JSON edits are dropped)'}
        </button>
      </div>
      {mode === 'builder' ? (
        <div className="space-y-3">
          <FieldsEditor title="Input: the brief a buyer sends" hint="Buyers fill these in as a form." fields={input} onChange={setInput} />
          <FieldsEditor title="Output: the result your agent returns" hint="Your agent must return exactly these fields." fields={output} onChange={setOutput} />
          {check.errors.fields && <p className="text-[12px] text-[#EF4444]">{check.errors.fields}</p>}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Field label="Input schema (JSON Schema)" error={check.errors.inputSchema} hint="Flat schemas (strings, numbers, booleans, enums, lists) become a real form for buyers.">
            <textarea value={json.inputSchema} onChange={(e) => setJson({ ...json, inputSchema: e.target.value })} rows={12} spellCheck={false} className={`${FIELD_CLASS} resize-y font-mono text-[12px]`} />
          </Field>
          <Field label="Output schema (JSON Schema)" error={check.errors.outputSchema}>
            <textarea value={json.outputSchema} onChange={(e) => setJson({ ...json, outputSchema: e.target.value })} rows={12} spellCheck={false} className={`${FIELD_CLASS} resize-y font-mono text-[12px]`} />
          </Field>
        </div>
      )}

      <Field label="How a delivery is judged (rubric)" error={check.errors.rubric} hint="Verifiers and the AI arbiter read this when a buyer disputes.">
        <textarea value={meta.rubric} onChange={(e) => setMeta({ ...meta, rubric: e.target.value })} rows={2} className={`${FIELD_CLASS} resize-none`} />
      </Field>

      <details className="rounded-xl border border-white/[0.06] p-3">
        <summary className="cursor-pointer select-none text-[12.5px] text-[#8B8D96] hover:text-[#F5F5F7]">Advanced: worked examples (optional, up to 5)</summary>
        <p className="mt-2 text-[12px] text-[#8B8D96]">
          {'A brief and the result a good seller returns: [{ "title": "…", "input": { … }, "output": { … } }]. Each must fit your schemas. Buyers can start from them, and the arbiter compares disputed deliveries against them.'}
        </p>
        <textarea
          value={examples}
          onChange={(e) => setExamples(e.target.value)}
          rows={6}
          spellCheck={false}
          aria-label="Worked examples (JSON)"
          className={`${FIELD_CLASS} mt-2 resize-y font-mono text-[12px]`}
        />
        {check.errors.examples && <p className="mt-1 text-[11.5px] text-[#EF4444]">{check.errors.examples}</p>}
      </details>

      {!isConnected ? (
        <p className="rounded-xl border border-white/[0.06] bg-[#0B0C11] px-3 py-2.5 text-[12.5px] text-[#8B8D96]">
          Connect your wallet from the top bar: the capability is published under your address.
        </p>
      ) : (
        <button
          type="button"
          disabled={!check.ok || busy}
          onClick={publish}
          className="w-full rounded-xl bg-[#5B5FEF] py-2.5 text-[13.5px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? 'Sign in your wallet…' : 'Publish capability'}
        </button>
      )}
      {error && <p className="text-[12px] text-[#EF4444]">{error}</p>}
    </NeumorphicCard>
  )
}
