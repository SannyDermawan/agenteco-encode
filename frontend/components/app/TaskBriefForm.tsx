'use client'
import type { ChangeEvent } from 'react'
import { CAPABILITIES, LANGUAGES, LIMITS, type CapabilityId } from '@shared/capabilities/definitions'
import { CHAIN_NAME } from '@/lib/web3/network'
import { CharCount, FIELD_CLASS, Field } from './FormField'

/**
 * Every brief field as the form edits it (plain strings). One draft serves all
 * four capabilities, so switching capability keeps what was typed.
 */
export interface BriefDraft {
  text: string
  targetLanguage: string
  tone: string
  csv: string
  question: string
  coins: string
  horizon: string
  txHash: string
}

export const EMPTY_BRIEF_DRAFT: BriefDraft = {
  text: '',
  targetLanguage: 'id',
  tone: '',
  csv: '',
  question: '',
  coins: 'bitcoin, ethereum',
  horizon: '24h',
  txHash: '',
}

const POPULAR_COINS = ['bitcoin', 'ethereum', 'binancecoin', 'solana', 'tether']

/** A stored brief (e.g. a buyer agent's taskBrief) back as an editable draft. */
export function draftFromBrief(brief: unknown): BriefDraft {
  if (!brief || typeof brief !== 'object') return EMPTY_BRIEF_DRAFT
  const b = brief as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return {
    ...EMPTY_BRIEF_DRAFT,
    ...(str(b.text) !== undefined && { text: str(b.text)! }),
    ...(str(b.targetLanguage) && { targetLanguage: str(b.targetLanguage)! }),
    ...(str(b.tone) && { tone: str(b.tone)! }),
    ...(str(b.csv) !== undefined && { csv: str(b.csv)! }),
    ...(str(b.question) !== undefined && { question: str(b.question)! }),
    ...(Array.isArray(b.coins) && { coins: b.coins.join(', ') }),
    ...(str(b.horizon) && { horizon: str(b.horizon)! }),
    ...(str(b.txHash) !== undefined && { txHash: str(b.txHash)! }),
  }
}

type FieldErrors = Partial<Record<keyof BriefDraft, string>>

/** The draft as the capability's brief object, before validation. */
function draftToRaw(capability: CapabilityId, d: BriefDraft): Record<string, unknown> {
  switch (capability) {
    case 'translation':
      return { text: d.text, targetLanguage: d.targetLanguage, ...(d.tone && { tone: d.tone }) }
    case 'data_analysis':
      return { csv: d.csv, ...(d.question.trim() && { question: d.question }) }
    case 'crypto_market_brief':
      return { coins: d.coins.split(/[\s,]+/).filter(Boolean), horizon: d.horizon }
    case 'tx_explainer':
      return { txHash: d.txHash }
  }
}

/**
 * Validates the draft against the capability's input schema, the same zod
 * schema the API and the seller check (spec §7: validated in three places).
 * Returns the normalised brief to send, or per-field errors.
 */
export function briefFromDraft(
  capability: CapabilityId,
  draft: BriefDraft
): { ok: true; brief: unknown } | { ok: false; errors: FieldErrors } {
  const parsed = CAPABILITIES[capability].input.safeParse(draftToRaw(capability, draft))
  if (parsed.success) return { ok: true, brief: parsed.data }
  const errors: FieldErrors = {}
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? '') as keyof BriefDraft
    if (key && !errors[key]) errors[key] = issue.message
  }
  return { ok: false, errors }
}

function csvShape(csv: string): string {
  const lines = csv.trim().split(/\r?\n/).filter((l) => l.trim())
  if (lines.length === 0) return `Up to ${LIMITS.csvRows} rows and ${LIMITS.csvColumns} columns, with a header row.`
  const columns = lines[0].split(',').length
  return `${Math.max(lines.length - 1, 0)} rows × ${columns} columns (max ${LIMITS.csvRows} × ${LIMITS.csvColumns}).`
}

/**
 * The buyer's Task Brief (spec §8.2): one set of inputs per capability,
 * shaped by that capability's schema, plus the optional Acceptance Criteria.
 */
export function TaskBriefForm({
  capability,
  draft,
  onDraftChange,
  criteria,
  onCriteriaChange,
  showErrors,
}: {
  capability: CapabilityId
  draft: BriefDraft
  onDraftChange: (draft: BriefDraft) => void
  criteria: string
  onCriteriaChange: (criteria: string) => void
  /** Show validation messages (after a submit attempt). */
  showErrors: boolean
}) {
  const result = briefFromDraft(capability, draft)
  const errors: FieldErrors = showErrors && !result.ok ? result.errors : {}
  const set = (patch: Partial<BriefDraft>) => onDraftChange({ ...draft, ...patch })
  const bind = (key: keyof BriefDraft) => ({
    value: draft[key],
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => set({ [key]: e.target.value }),
  })

  async function loadCsvFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) set({ csv: await file.text() })
    e.target.value = ''
  }

  function toggleCoin(coin: string) {
    const coins = draft.coins.split(/[\s,]+/).filter(Boolean)
    const next = coins.includes(coin) ? coins.filter((c) => c !== coin) : [...coins, coin]
    set({ coins: next.join(', ') })
  }
  const selectedCoins = draft.coins.split(/[\s,]+/).filter(Boolean)

  return (
    <div className="space-y-4">
      {capability === 'translation' && (
        <>
          <Field label="Text to translate" error={errors.text} hint={<CharCount value={draft.text} max={LIMITS.translationChars} />}>
            <textarea rows={5} placeholder="Paste the text the seller should translate." className={FIELD_CLASS} {...bind('text')} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Target language" error={errors.targetLanguage}>
              <select className={FIELD_CLASS} {...bind('targetLanguage')}>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tone (optional)" error={errors.tone}>
              <select className={FIELD_CLASS} {...bind('tone')}>
                <option value="">Seller&apos;s default</option>
                <option value="neutral">Neutral</option>
                <option value="formal">Formal</option>
                <option value="casual">Casual</option>
              </select>
            </Field>
          </div>
        </>
      )}

      {capability === 'data_analysis' && (
        <>
          <Field label="CSV data" error={errors.csv} hint={csvShape(draft.csv)}>
            <textarea
              rows={6}
              placeholder={'date,visitors,signups\n2026-09-01,120,8\n2026-09-02,135,11'}
              className={`${FIELD_CLASS} font-mono text-[12px]`}
              {...bind('csv')}
            />
          </Field>
          <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-[#8B8D96] hover:text-[#F5F5F7]">
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={loadCsvFile} />
            <span className="rounded-lg border border-white/[0.08] px-2.5 py-1">Load a .csv file</span>
          </label>
          <Field label="Question (optional)" error={errors.question} hint={<CharCount value={draft.question} max={LIMITS.questionChars} />}>
            <input type="text" placeholder="e.g. Are signups growing faster than visitors?" className={FIELD_CLASS} {...bind('question')} />
          </Field>
        </>
      )}

      {capability === 'crypto_market_brief' && (
        <>
          <Field label={`Coins (CoinGecko ids, ${LIMITS.coinsMin}–${LIMITS.coinsMax})`} error={errors.coins}>
            <input type="text" placeholder="bitcoin, ethereum" className={FIELD_CLASS} {...bind('coins')} />
          </Field>
          <div className="flex flex-wrap gap-1.5">
            {POPULAR_COINS.map((coin) => (
              <button
                key={coin}
                type="button"
                onClick={() => toggleCoin(coin)}
                className={`rounded-lg border px-2.5 py-1 text-[11.5px] transition ${
                  selectedCoins.includes(coin)
                    ? 'border-[#5B5FEF]/50 bg-[#5B5FEF]/10 text-[#F5F5F7]'
                    : 'border-white/[0.08] text-[#8B8D96] hover:border-white/20'
                }`}
              >
                {coin}
              </button>
            ))}
          </div>
          <Field label="Horizon" error={errors.horizon}>
            <select className={FIELD_CLASS} {...bind('horizon')}>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
            </select>
          </Field>
        </>
      )}

      {capability === 'tx_explainer' && (
        <Field label="Transaction hash" error={errors.txHash} hint={`A transaction on ${CHAIN_NAME}.`}>
          <input type="text" placeholder="0x…" className={`${FIELD_CLASS} font-mono text-[12px]`} {...bind('txHash')} />
        </Field>
      )}

      <Field
        label="Acceptance Criteria (optional)"
        error={showErrors && criteria.trim().length > LIMITS.textChars ? `At most ${LIMITS.textChars} characters` : undefined}
        hint={<CharCount value={criteria} max={LIMITS.textChars} />}
      >
        <textarea
          rows={2}
          placeholder="What must a good result include? The buyer's verifier checks the result against this."
          className={FIELD_CLASS}
          value={criteria}
          onChange={(e) => onCriteriaChange(e.target.value)}
        />
      </Field>
    </div>
  )
}

/** True when the brief and criteria are both ready to send. */
export function isBriefReady(capability: CapabilityId, draft: BriefDraft, criteria: string): boolean {
  return briefFromDraft(capability, draft).ok && criteria.trim().length <= LIMITS.textChars
}
