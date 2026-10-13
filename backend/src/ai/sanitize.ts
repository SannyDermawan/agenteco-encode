export { DATA_RULES, wrapData, wrapJson } from '../../../agent-runtime/src/shared/ai/promptSafety.ts'

/**
 * Every way a price limit could plausibly be written: 0.24, .24, 0,24,
 * 0.240, 24 (cents), so a model can't hint at a private limit in its reason.
 */
function limitVariants(limit: number): RegExp[] {
  const out = new Set<string>()
  for (let d = 0; d <= 4; d++) {
    const fixed = limit.toFixed(d)
    if (Math.abs(Number(fixed) - limit) > 1e-9) continue
    out.add(fixed)
    out.add(fixed.replace('.', ','))
    if (fixed.startsWith('0.')) out.add(fixed.slice(1))
  }
  const cents = Math.round(limit * 100)
  if (limit < 10 && Math.abs(cents - limit * 100) < 1e-9 && cents > 0) out.add(`${cents} cents`)
  return [...out].map((v) => new RegExp(`(^|[^0-9.,])${v.replace(/[.,]/g, '[.,]')}(?![0-9])`, 'i'))
}

/** Replacement reason when a model leaks a private limit. */
export const GENERIC_REASON = 'This is my best offer at the moment.'

/**
 * Returns `reason`, or a generic sentence if it mentions any of the agent's
 * private limits in any reasonable format (spec §9 guardrail 4).
 */
export function filterLimitLeak(reason: string, privateLimits: number[]): { reason: string; leaked: boolean } {
  for (const limit of privateLimits) {
    if (!Number.isFinite(limit) || limit <= 0) continue
    if (limitVariants(limit).some((re) => re.test(reason))) return { reason: GENERIC_REASON, leaked: true }
  }
  return { reason, leaked: false }
}

// Words that give a private limit away without its number: "our minimum
// acceptable price", "my ceiling", "the lowest I can go", "walk-away price".
const LIMIT_HINTS = [
  /\b(my|our|the)\s+(absolute\s+|private\s+|final\s+)?(minimum|min|floor|lowest|bottom|reserve|limit|max|maximum|ceiling|cap)\b/i,
  /\bminimum\s+(acceptable|price|rate)\b/i,
  /\b(lowest|highest|most|least)\s+(i|we)\s+(can|could|will)\s+(go|accept|pay|offer|do)\b/i,
  /\b(walk[- ]?away|bottom[- ]line|reserve)\s+(price|point|line)?\b/i,
]

/**
 * Returns the reason, or the generic sentence if it hints that a price is this
 * agent's limit even without quoting a number (spec §9 guardrail 4).
 */
export function filterLimitHints(reason: string): { reason: string; leaked: boolean } {
  return LIMIT_HINTS.some((re) => re.test(reason)) ? { reason: GENERIC_REASON, leaked: true } : { reason, leaked: false }
}

/**
 * Returns the reason, or the generic sentence if it quotes a decimal price
 * that is not on the table (the offer being made, the one answered, or one
 * from the history / the listing / the market), e.g. "I can meet you at
 * 0.085" when the counter actually sent is 0.09 after rounding to cents.
 */
export function filterStrayPrices(reason: string, allowed: number[]): { reason: string; stray: boolean } {
  const ok = new Set(allowed.filter(Number.isFinite).map((p) => Number(p.toFixed(6))))
  for (const m of reason.matchAll(/(?<![\d.,])(\d*[.,]\d+)(?![\d])/g)) {
    const value = Number(m[1].replace(',', '.'))
    if (Number.isFinite(value) && !ok.has(Number(value.toFixed(6)))) return { reason: GENERIC_REASON, stray: true }
  }
  return { reason, stray: false }
}
