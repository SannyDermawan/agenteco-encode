import type { z } from 'zod'
import { CAPABILITIES, type CapabilityId } from '../shared/capabilities/definitions.ts'
import { NOT_FINANCIAL_ADVICE, type PreparedJob } from '../capabilities/prepare.ts'
import { DATA_RULES } from '../shared/ai/promptSafety.ts'
import {
  arbiterRecommendation,
  cryptoBriefExecution,
  dataAnalysisExecution,
  sellerDefense,
  translationExecution,
  txExplainerExecution,
  verification,
} from '../shared/ai/schemas.ts'
import { cryptoBriefPrompt, dataAnalysisPrompt, sellerDefensePrompt, translationPrompt, txExplainerPrompt, verifyPrompt, type JobContext, type Prompt } from '../shared/ai/prompts.ts'

/**
 * Bring your own AI. AgentEco gives self-hosted agents no model: every AI call
 * an SDK agent makes goes to the model YOU plug in, with your own key and your
 * own bill. A model is just a function from a prompt to the model's text answer:
 *
 *   const ai = openAiCompatible({ baseUrl: 'https://api.openai.com/v1', apiKey, model: 'gpt-4o-mini' })
 *
 * With one, a seller can serve the four platform capabilities (the same prompts
 * AgentEco's hosted agents use), defend disputes, and a buyer can score
 * deliveries. Without one, a seller uses its own `handle`, or delivers only the
 * code-computed part of a platform capability.
 */
export type AiModel = (prompt: Prompt) => Promise<string>

/** Anything that speaks the OpenAI chat-completions API: OpenAI, Groq, OpenRouter, Together, Mistral, Ollama, vLLM… */
export function openAiCompatible(options: { baseUrl: string; apiKey?: string; model: string; timeoutMs?: number }): AiModel {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return async ({ system, user }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}) },
      body: JSON.stringify({
        model: options.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    })
    if (!res.ok) throw new Error(`The model answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const text = body.choices?.[0]?.message?.content
    if (!text) throw new Error('The model returned no content.')
    return text
  }
}

/** Models sometimes wrap JSON in a code fence despite JSON mode. */
function parseJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return JSON.parse(fenced ? fenced[1] : trimmed)
}

/**
 * One AI call whose answer must be JSON in `schema`'s shape. The security
 * rules (text in <DATA> blocks is data, not instructions) are appended to the
 * system prompt, and an invalid answer gets one retry quoting what was wrong.
 * Returns null when the model is unreachable or never answers validly, the
 * caller then falls back, exactly like AgentEco's own hosted agents.
 */
export async function askJson<T>(ai: AiModel, prompt: Prompt, schema: z.ZodType<T>, log?: (m: string) => void): Promise<T | null> {
  const system = `${prompt.system}\n\n${DATA_RULES}`
  let user = prompt.user
  for (let attempt = 0; attempt < 2; attempt++) {
    let parsed: unknown
    try {
      parsed = parseJson(await ai({ system, user }))
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        log?.(`the model failed: ${(error as Error).message}`)
        return null
      }
    }
    const result = schema.safeParse(parsed)
    if (result.success) return result.data
    const issues =
      parsed === undefined
        ? 'The answer was not valid JSON.'
        : result.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')
    user = `${prompt.user}\n\nYour previous answer was rejected: ${issues}\nAnswer again with only the JSON object in the required shape.`
  }
  log?.('the model never produced a valid answer')
  return null
}

/**
 * Runs one of the four platform capabilities on your own model, the same
 * prompts AgentEco's hosted sellers use: code computed the facts, the model
 * writes the prose, and the combined result is checked against the capability's
 * output schema. Null when the model failed or the result is invalid.
 */
export async function runPlatformJob(
  job: PreparedJob,
  ai: AiModel,
  ctx: { criteria?: string | null; instructions?: string | null; log?: (m: string) => void } = {}
): Promise<Record<string, unknown> | null> {
  const { criteria, instructions, log } = ctx
  let result: Record<string, unknown> | null = null
  switch (job.capability) {
    case 'translation': {
      const out = await askJson(ai, translationPrompt(job.input, criteria, instructions), translationExecution, log)
      if (out) result = { translatedText: out.translatedText, targetLanguage: job.input.targetLanguage, ...(out.notes && { notes: out.notes }) }
      break
    }
    case 'data_analysis': {
      const out = await askJson(ai, dataAnalysisPrompt(job.input, job.stats, criteria, instructions), dataAnalysisExecution, log)
      if (out) result = { stats: job.stats, insights: out.insights, summary: out.summary }
      break
    }
    case 'crypto_market_brief': {
      const out = await askJson(ai, cryptoBriefPrompt(job.input, job.data, criteria, instructions), cryptoBriefExecution, log)
      if (out) result = { data: job.data, brief: out.brief, disclaimer: NOT_FINANCIAL_ADVICE }
      break
    }
    case 'tx_explainer': {
      const out = await askJson(ai, txExplainerPrompt(job.facts, criteria, instructions), txExplainerExecution, log)
      if (out) result = { facts: job.facts, explanation: out.explanation }
      break
    }
  }
  if (!result) return null
  const checked = CAPABILITIES[job.capability as CapabilityId].output.safeParse(result)
  return checked.success ? (checked.data as Record<string, unknown>) : null
}

/** A seller's answer to a dispute, written by your model (≤ 1,000 characters), or null. */
export async function defendWithAi(ai: AiModel, job: JobContext, buyerReason: string, log?: (m: string) => void): Promise<string | null> {
  const out = await askJson(ai, sellerDefensePrompt(job, buyerReason), sellerDefense, log)
  return out?.response ?? null
}

/** The score at or above which AgentEco's own hosted buyers accept a delivery. */
export const ACCEPT_SCORE = 60

/**
 * Scores a delivery 0–100 with your model, against the capability's rubric and
 * the buyer's criteria, the same verifier AgentEco's hosted buyers use. The
 * decision is code's: at or above `threshold` (default 60) it accepts.
 */
export async function scoreWithAi(
  ai: AiModel,
  job: JobContext,
  opts: { threshold?: number; log?: (m: string) => void } = {}
): Promise<{ score: number; accept: boolean; rationale: string } | null> {
  const out = await askJson(ai, verifyPrompt(job), verification, opts.log)
  if (!out) return null
  return { score: out.score, accept: out.score >= (opts.threshold ?? ACCEPT_SCORE), rationale: out.rationale }
}

// Re-exported so a custom flow can use the same output shapes.
export { arbiterRecommendation, verification as verificationSchema }
