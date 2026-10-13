import type { z } from 'zod'
import { log } from '../log.ts'
import { LLM_MAX_WAIT_SECONDS, LLM_TIMEOUT_MS, type LLMTask } from './config.ts'
import { geminiProvider } from './providers/gemini.ts'
import { groqProvider } from './providers/groq.ts'
import { ProviderHttpError, type LLMProvider } from './providers/types.ts'
import { takeLLMSlot } from './rateLimit.ts'
import { DATA_RULES } from './sanitize.ts'

export interface LLMRequest<T> {
  task: LLMTask
  /** Instructions. DATA_RULES is appended automatically. */
  system: string
  /** The task input, untrusted parts already wrapped with wrapData(). */
  user: string
  /** Output shape; anything else is a failed attempt. */
  schema: z.ZodType<T>
  /** Counts against this agent's hourly budget (spec §6.3). */
  agentId?: string
}

export interface LLMResult<T> {
  data: T
  provider: string
  model: string
}

export type LLMOutcome = 'ok' | 'invalid' | 'rate_limited' | 'error' | 'fallback' | 'over_budget'

export interface LLMEvent {
  task: LLMTask
  provider: string
  model: string | null
  outcome: LLMOutcome
  ms: number | null
  agentId?: string
}

// Where each attempt is reported (the host and API install a database writer
// at startup, see aiCallLog.ts). Unset in tests, so they never touch a DB.
let recorder: ((event: LLMEvent) => void) | null = null
export function setLLMRecorder(fn: ((event: LLMEvent) => void) | null): void {
  recorder = fn
}
function record(event: LLMEvent): void {
  try {
    recorder?.(event)
  } catch {
    // Telemetry never breaks an AI call.
  }
}

export interface LLMDeps {
  providers: LLMProvider[]
  sleep: (ms: number) => Promise<void>
  maxWaitSeconds: number
  timeoutMs: number
  takeSlot: (agentId: string) => boolean
}

const defaultDeps: LLMDeps = {
  providers: [groqProvider, geminiProvider],
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  maxWaitSeconds: LLM_MAX_WAIT_SECONDS,
  timeoutMs: LLM_TIMEOUT_MS,
  takeSlot: takeLLMSlot,
}

/** Models sometimes wrap JSON in a code fence despite JSON mode. */
function parseJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return JSON.parse(fenced ? fenced[1] : trimmed)
}

function describe(error: unknown): string {
  if (error instanceof ProviderHttpError) return `HTTP ${error.status}`
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout'
  return error instanceof Error ? error.message.slice(0, 120) : String(error)
}

/**
 * One AI call with fallbacks (spec §6.2). Providers are tried in order. Groq,
 * then Gemini, skipping any without an API key. Per provider:
 * - output must be JSON matching `schema`; an invalid answer gets one retry
 *   that quotes the validation error, then the next provider takes over;
 * - HTTP 429 with retry-after ≤ LLM_MAX_WAIT_SECONDS waits once and retries;
 *   a longer wait (or any other error/timeout) moves to the next provider.
 * Returns null when every provider fails or the agent is over its hourly
 * budget, the caller must then use its deterministic fallback.
 *
 * Logs task, provider, model, duration and outcome, never the texts.
 */
export async function callLLM<T>(req: LLMRequest<T>, deps: Partial<LLMDeps> = {}): Promise<LLMResult<T> | null> {
  const d = { ...defaultDeps, ...deps }
  if (req.agentId && !d.takeSlot(req.agentId)) {
    log(`[ai] ${req.task}: agent ${req.agentId} is over its hourly AI budget, using fallback`)
    record({ task: req.task, provider: 'none', model: null, outcome: 'over_budget', ms: null, agentId: req.agentId })
    return null
  }

  const system = `${req.system}\n\n${DATA_RULES}`
  for (const provider of d.providers.filter((p) => p.available())) {
    const model = provider.modelFor(req.task)
    let user = req.user
    let validationRetried = false
    let waited = false

    for (;;) {
      const started = Date.now()
      const ms = () => Date.now() - started
      try {
        const text = await provider.complete({ task: req.task, model, system, user, timeoutMs: d.timeoutMs })
        let parsed: unknown
        try {
          parsed = parseJson(text)
        } catch {
          parsed = undefined
        }
        const result = req.schema.safeParse(parsed)
        if (result.success) {
          log(`[ai] ${req.task} ok via ${provider.name}/${model} in ${ms()}ms`)
          record({ task: req.task, provider: provider.name, model, outcome: 'ok', ms: ms(), agentId: req.agentId })
          return { data: result.data, provider: provider.name, model }
        }
        const issues = parsed === undefined ? 'The answer was not valid JSON.' : result.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')
        log(`[ai] ${req.task} invalid output from ${provider.name}/${model} (${ms()}ms)${validationRetried ? ', next provider' : ', retrying once'}`)
        record({ task: req.task, provider: provider.name, model, outcome: 'invalid', ms: ms(), agentId: req.agentId })
        if (validationRetried) break
        validationRetried = true
        user = `${req.user}\n\nYour previous answer was rejected: ${issues}\nAnswer again with only the JSON object in the required shape.`
      } catch (error) {
        const rateLimited = error instanceof ProviderHttpError && error.status === 429
        record({ task: req.task, provider: provider.name, model, outcome: rateLimited ? 'rate_limited' : 'error', ms: ms(), agentId: req.agentId })
        const retryAfter = rateLimited ? (error as ProviderHttpError).retryAfterSec : undefined
        if (retryAfter !== undefined && retryAfter <= d.maxWaitSeconds && !waited) {
          log(`[ai] ${req.task} rate-limited by ${provider.name}/${model}; waiting ${retryAfter}s`)
          waited = true
          await d.sleep(retryAfter * 1000)
          continue
        }
        log(`[ai] ${req.task} failed on ${provider.name}/${model} (${describe(error)}, ${ms()}ms), next provider`)
        break
      }
    }
  }

  log(`[ai] ${req.task}: no provider succeeded, using fallback`)
  record({ task: req.task, provider: 'none', model: null, outcome: 'fallback', ms: null, agentId: req.agentId })
  return null
}
