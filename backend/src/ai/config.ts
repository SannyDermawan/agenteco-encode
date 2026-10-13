/**
 * AI configuration from env (spec §6.4). Model ids verified against the
 * providers' docs on 2026-09-27: on Groq's free plan the production models are
 * openai/gpt-oss-20b and openai/gpt-oss-120b (Llama 3.x is enterprise-only now)
 * plus qwen/qwen3.8-27b in preview. Gemini is the fallback, so it runs
 * gemini-3.5-flash-lite: on 2026-09-28 gemini-3.8-flash answered 503 "high
 * demand" on about half the calls and took 6-11 s, while flash-lite answered
 * every call in ~1 s (it also has the higher free limits). Each Groq task can
 * use its own model because Groq counts rate limits per model.
 */

export type LLMTask = 'negotiation' | 'execute' | 'verify' | 'seller_defense' | 'arbiter'

function env(name: string): string | undefined {
  const v = process.env[name]?.trim()
  return v ? v : undefined
}

function positive(name: string, fallback: number): number {
  const raw = env(name)
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got: ${raw}`)
  return n
}

export const GROQ_API_KEY = env('GROQ_API_KEY')
export const GEMINI_API_KEY = env('GEMINI_API_KEY')

/**
 * Small, fast models for negotiation and the seller's defense; larger ones for
 * execution, verification and arbitration. The arbiter must not use the
 * verifier's model (spec §6.4), and verification runs on a different model
 * family than execution, so a model never grades its own output.
 */
export const GROQ_MODELS: Record<LLMTask, string> = {
  negotiation: env('GROQ_MODEL_NEGOTIATION') ?? 'openai/gpt-oss-20b',
  seller_defense: env('GROQ_MODEL_SELLER_DEFENSE') ?? 'openai/gpt-oss-20b',
  execute: env('GROQ_MODEL_EXECUTE') ?? 'openai/gpt-oss-120b',
  verify: env('GROQ_MODEL_VERIFY') ?? 'qwen/qwen3.8-27b',
  arbiter: env('GROQ_MODEL_ARBITER') ?? 'openai/gpt-oss-120b',
}

export const GEMINI_MODEL = env('GEMINI_MODEL') ?? 'gemini-3.5-flash-lite'

export const LLM_TIMEOUT_MS = positive('LLM_TIMEOUT_MS', 20_000)
export const LLM_MAX_WAIT_SECONDS = positive('LLM_MAX_WAIT_SECONDS', 10)
export const LLM_MAX_CALLS_PER_AGENT_PER_HOUR = positive('LLM_MAX_CALLS_PER_AGENT_PER_HOUR', 60)

function percent(name: string, fallback: number): number {
  const raw = env(name)
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error(`${name} must be a whole number 0-100, got: ${raw}`)
  return n
}

/** A verification score at or above this settles; below it the buyer disputes (spec §10.1). */
export const VERIFY_ACCEPT_THRESHOLD = percent('VERIFY_ACCEPT_THRESHOLD', 60)
/** The AI arbiter's ruling executes on its own only at or above this confidence (spec §11). */
export const ARBITER_AUTO_MIN_CONFIDENCE = percent('ARBITER_AUTO_MIN_CONFIDENCE', 70)

if (GROQ_MODELS.arbiter === GROQ_MODELS.verify) {
  throw new Error('GROQ_MODEL_ARBITER must differ from GROQ_MODEL_VERIFY (spec §6.4), the arbiter must not reuse the verifier.')
}
