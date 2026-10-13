import { LIMITS } from '../../../agent-runtime/src/shared/capabilities/definitions.ts'
import { ARBITER_AUTO_MIN_CONFIDENCE, VERIFY_ACCEPT_THRESHOLD } from './config.ts'
import { callLLM, type LLMRequest, type LLMResult } from './llm.ts'
import { arbiterPrompt, sellerDefensePrompt, verifyPrompt, type JobContext } from './prompts/judge.ts'
import { arbiterRecommendation, sellerDefense, verification } from './schemas.ts'

type LLM = <T>(req: LLMRequest<T>) => Promise<LLMResult<T> | null>

export type { JobContext }

// ---------------------------------------------------------------------------
// Verification (hosted buyer, spec §10.1)
// ---------------------------------------------------------------------------

export interface VerificationOutcome {
  /** Null when no model answered. */
  score: number | null
  /** Decided by code from the score, never by the model's own verdict. */
  verdict: 'accept' | 'dispute'
  rationale: string
  /** "none" for the fallback. */
  provider: string
  model: string | null
}

export const VERIFY_FALLBACK_RATIONALE = 'AI verification was unavailable, so the result was accepted without a score.'

/**
 * Asks the verifier model to score a delivered result. The decision is the
 * code's: score ≥ VERIFY_ACCEPT_THRESHOLD accepts, anything lower disputes,
 * whatever verdict the model wrote. No model → accept, unscored (the old
 * behaviour, spec §10.1 step 5), and the caller must then not rate.
 */
export async function verifyResult(
  job: JobContext,
  opts: { agentId?: string; llm?: LLM; threshold?: number } = {}
): Promise<VerificationOutcome> {
  const threshold = opts.threshold ?? VERIFY_ACCEPT_THRESHOLD
  const out = await (opts.llm ?? callLLM)({ task: 'verify', ...verifyPrompt(job), schema: verification, agentId: opts.agentId })
  if (!out) return { score: null, verdict: 'accept', rationale: VERIFY_FALLBACK_RATIONALE, provider: 'none', model: null }
  return {
    score: out.data.score,
    verdict: out.data.score >= threshold ? 'accept' : 'dispute',
    rationale: out.data.rationale,
    provider: out.provider,
    model: out.model,
  }
}

/**
 * The on-chain dispute reason a hosted buyer files from its verification:
 * at least the contract-side 10 characters, at most the 1,000 the API takes.
 */
export function disputeReasonFrom(outcome: VerificationOutcome, threshold = VERIFY_ACCEPT_THRESHOLD): string {
  const text = `AI verification scored ${outcome.score ?? 0}/100 (accept threshold ${threshold}). ${outcome.rationale}`
  return text.length > LIMITS.disputeReasonChars ? `${text.slice(0, LIMITS.disputeReasonChars - 1)}…` : text
}

/** rateSeller takes 1–100; a verification can score 0. */
export function ratingScoreFrom(score: number): number {
  return Math.min(100, Math.max(1, Math.round(score)))
}

// ---------------------------------------------------------------------------
// Seller defense (hosted seller, spec §11 step 2)
// ---------------------------------------------------------------------------

/** The seller's answer to a dispute, or null when no model answered (the arbiter then sees "no response"). */
export async function defendDispute(
  job: JobContext,
  buyerReason: string,
  opts: { agentId?: string; llm?: LLM } = {}
): Promise<{ response: string; provider: string; model: string } | null> {
  const out = await (opts.llm ?? callLLM)({
    task: 'seller_defense',
    ...sellerDefensePrompt(job, buyerReason),
    schema: sellerDefense,
    agentId: opts.agentId,
  })
  if (!out) return null
  const response = out.data.response.trim().slice(0, LIMITS.disputeReasonChars)
  return response ? { response, provider: out.provider, model: out.model } : null
}

// ---------------------------------------------------------------------------
// Arbiter recommendation (backend, spec §11 steps 3 and 5)
// ---------------------------------------------------------------------------

export interface ArbiterOutcome {
  verdict: 'seller' | 'buyer'
  confidence: number
  rationale: string
  provider: string
  model: string
}

export async function recommendRuling(
  job: JobContext,
  buyerReason: string | null,
  sellerResponse: string | null,
  opts: { llm?: LLM } = {}
): Promise<ArbiterOutcome | null> {
  const out = await (opts.llm ?? callLLM)({
    task: 'arbiter',
    ...arbiterPrompt(job, buyerReason, sellerResponse),
    schema: arbiterRecommendation,
  })
  if (!out) return null
  return { ...out.data, provider: out.provider, model: out.model }
}

/** Minimum time left before disputeDeadline for the backend to still execute a ruling (spec §11 step 5). */
export const AUTO_RESOLVE_SAFETY_SECONDS = 60

/**
 * Should the backend execute the AI recommendation now? Only after the human
 * arbiter's override window, only when confident enough, and only with a safe
 * margin before the on-chain dispute deadline (after which only a timeout
 * refund is possible).
 */
export function shouldAutoResolve(input: {
  confidence: number
  nowSec: number
  overrideDeadlineSec: number
  disputeDeadlineSec: number
  minConfidence?: number
}): { ok: true } | { ok: false; reason: 'override-window' | 'low-confidence' | 'too-late' } {
  if (input.nowSec < input.overrideDeadlineSec) return { ok: false, reason: 'override-window' }
  if (input.confidence < (input.minConfidence ?? ARBITER_AUTO_MIN_CONFIDENCE)) return { ok: false, reason: 'low-confidence' }
  if (input.disputeDeadlineSec - input.nowSec < AUTO_RESOLVE_SAFETY_SECONDS) return { ok: false, reason: 'too-late' }
  return { ok: true }
}
