import type { PublicClient } from 'viem'
import { CAPABILITIES, type CapabilityId } from '../../../agent-runtime/src/shared/capabilities/definitions.ts'
import {
  AI_UNAVAILABLE,
  NOT_FINANCIAL_ADVICE,
  prepareJob,
  type PreparedJob,
} from '../../../agent-runtime/src/capabilities/prepare.ts'
import { callLLM, type LLMRequest, type LLMResult } from '../ai/llm.ts'
import { cryptoBriefPrompt, dataAnalysisPrompt, translationPrompt, txExplainerPrompt } from '../ai/prompts/execute.ts'
import {
  cryptoBriefExecution,
  dataAnalysisExecution,
  translationExecution,
  txExplainerExecution,
} from '../ai/schemas.ts'

// Step 1, brief validation and the code-computed data, lives in
// agent-runtime so the standalone seller-agent shares it (spec §7).
export { AI_UNAVAILABLE, NOT_FINANCIAL_ADVICE, prepareJob, type PreparedJob }

export interface ExecutionContext {
  /** Hosted seller id. AI calls count against its hourly budget. */
  agentId?: string
  customInstructions?: string | null
  criteria?: string | null
  publicClient: PublicClient
  agentEcoAddress: string
  /** Injected in tests. */
  llm?: <T>(req: LLMRequest<T>) => Promise<LLMResult<T> | null>
}

export type ExecutionOutcome =
  /** Deliver this result, written by the model named in `ai`. */
  | { deliver: true; result: unknown; ai: { provider: string; model: string } }
  /**
   * Do not deliver. Before startExecution (invalid brief) the accept timeout
   * refunds the buyer; after it (no model answered) the execution timeout does.
   */
  | { deliver: false; reason: string }

/**
 * Step 2, after startExecution: the model interprets the prepared data, and
 * the result is checked against the capability's output schema before it is
 * delivered. All four capabilities need the model: when every provider fails,
 * nothing is delivered, not even the code-computed data, and the execution
 * timeout refunds the buyer (spec §7).
 */
export async function runJob(job: PreparedJob, ctx: ExecutionContext): Promise<ExecutionOutcome> {
  const llm = ctx.llm ?? callLLM
  let result: unknown
  let ai: LLMResult<unknown> | null = null

  switch (job.capability) {
    case 'translation': {
      const p = translationPrompt(job.input, ctx.criteria, ctx.customInstructions)
      const out = await llm({ task: 'execute', ...p, schema: translationExecution, agentId: ctx.agentId })
      ai = out
      if (out) {
        result = { translatedText: out.data.translatedText, targetLanguage: job.input.targetLanguage, ...(out.data.notes && { notes: out.data.notes }) }
      }
      break
    }
    case 'data_analysis': {
      const p = dataAnalysisPrompt(job.input, job.stats, ctx.criteria, ctx.customInstructions)
      const out = await llm({ task: 'execute', ...p, schema: dataAnalysisExecution, agentId: ctx.agentId })
      ai = out
      if (out) result = { stats: job.stats, insights: out.data.insights, summary: out.data.summary }
      break
    }
    case 'crypto_market_brief': {
      const p = cryptoBriefPrompt(job.input, job.data, ctx.criteria, ctx.customInstructions)
      const out = await llm({ task: 'execute', ...p, schema: cryptoBriefExecution, agentId: ctx.agentId })
      ai = out
      if (out) result = { data: job.data, brief: out.data.brief, disclaimer: NOT_FINANCIAL_ADVICE }
      break
    }
    case 'tx_explainer': {
      const p = txExplainerPrompt(job.facts, ctx.criteria, ctx.customInstructions)
      const out = await llm({ task: 'execute', ...p, schema: txExplainerExecution, agentId: ctx.agentId })
      ai = out
      if (out) result = { facts: job.facts, explanation: out.data.explanation }
      break
    }
  }

  if (!ai) {
    return { deliver: false, reason: `${AI_UNAVAILABLE}: ${job.capability} needs the model, so it was not delivered.` }
  }

  const checked = CAPABILITIES[job.capability].output.safeParse(result)
  if (!checked.success) {
    return { deliver: false, reason: `Result failed the ${job.capability} output schema: ${checked.error.issues[0]?.message}` }
  }
  return { deliver: true, result: checked.data, ai: { provider: ai.provider, model: ai.model } }
}

/** prepareJob + runJob in one go, for callers with no on-chain step in between. */
export async function executeCapability(capability: CapabilityId, brief: unknown, ctx: ExecutionContext): Promise<ExecutionOutcome> {
  const prepared = await prepareJob(capability, brief, ctx)
  if (!prepared.ok) return { deliver: false, reason: prepared.reason }
  return runJob(prepared.job, ctx)
}
