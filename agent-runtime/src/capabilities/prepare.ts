import type { Hex, PublicClient } from 'viem'
import {
  CAPABILITIES,
  type CapabilityId,
  type CryptoBriefInput,
  type CryptoBriefOutput,
  type DataAnalysisInput,
  type DataStats,
  type TranslationInput,
  type TxExplainerInput,
  type TxFacts,
} from '../shared/capabilities/definitions.ts'
import { InvalidInputError, computeStats } from './dataAnalysis.ts'
import { fetchCoinMarkets } from './cryptoMarket.ts'
import { buildTxFacts } from './txFacts.ts'

/**
 * The code half of every capability (spec §7), shared by the hosted seller
 * (backend/src/capabilities/execute.ts adds the model on top) and the SDK's
 * sellers (which bring their own model). All four capabilities need an AI: code
 * computes the facts, the model writes the prose, and nothing is delivered
 * without it.
 */

/** The old stand-in text for "no model answered". A result carrying it is refused — see mentionsAiUnavailable. */
export const AI_UNAVAILABLE = 'AI unavailable'
export const NOT_FINANCIAL_ADVICE =
  'This brief summarises public market data for information only. It is not financial advice.'

/** A validated brief plus its code-computed data, ready for the model. */
export type PreparedJob =
  | { capability: 'translation'; input: TranslationInput }
  | { capability: 'data_analysis'; input: DataAnalysisInput; stats: DataStats }
  | { capability: 'crypto_market_brief'; input: CryptoBriefInput; data: CryptoBriefOutput['data'] }
  | { capability: 'tx_explainer'; input: TxExplainerInput; facts: TxFacts }

export interface PrepareContext {
  /** The EVM chain's client and AgentEco address; absent off EVM, where tx_explainer is unavailable. */
  publicClient?: PublicClient
  agentEcoAddress?: string
}

/**
 * Before the seller accepts the job on-chain: validate the brief and run the
 * fast, deterministic part (CSV statistics, CoinGecko data, decoded
 * transaction facts). Any failure here is an invalid input — the seller must
 * not call startExecution, so the accept timeout refunds the buyer (spec §7).
 * Network failures (RPC, CoinGecko) are thrown, not reported as invalid.
 */
export async function prepareJob(
  capability: CapabilityId,
  brief: unknown,
  ctx: PrepareContext
): Promise<{ ok: true; job: PreparedJob } | { ok: false; reason: string }> {
  const parsed = CAPABILITIES[capability].input.safeParse(brief)
  if (!parsed.success) {
    return { ok: false, reason: `Invalid brief: ${parsed.error.issues.map((i) => i.message).join('; ')}` }
  }
  try {
    switch (capability) {
      case 'translation':
        return { ok: true, job: { capability, input: parsed.data as TranslationInput } }
      case 'data_analysis': {
        const input = parsed.data as DataAnalysisInput
        return { ok: true, job: { capability, input, stats: computeStats(input.csv) } }
      }
      case 'crypto_market_brief': {
        const input = parsed.data as CryptoBriefInput
        return { ok: true, job: { capability, input, data: await fetchCoinMarkets(input.coins) } }
      }
      case 'tx_explainer': {
        const input = parsed.data as TxExplainerInput
        if (!ctx.publicClient || !ctx.agentEcoAddress) return { ok: false, reason: 'tx_explainer reads EVM transactions and is not available on this chain' }
        return { ok: true, job: { capability, input, facts: await buildTxFacts(ctx.publicClient, input.txHash as Hex, ctx.agentEcoAddress) } }
      }
    }
  } catch (error) {
    if (error instanceof InvalidInputError) return { ok: false, reason: `Invalid brief: ${error.message}` }
    throw error
  }
}

/**
 * The model-written fields of each platform capability. A result whose prose says
 * "AI unavailable" is not a delivery: the seller must not commit it and the API
 * does not publish it. (translatedText echoes the buyer's own text, so it is not
 * scanned; the stats, data and facts are code-computed numbers.)
 */
const PROSE_FIELDS: Record<CapabilityId, string[]> = {
  translation: ['notes'],
  data_analysis: ['insights', 'summary'],
  crypto_market_brief: ['brief'],
  tx_explainer: ['explanation'],
}

export function mentionsAiUnavailable(capability: CapabilityId, result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const record = result as Record<string, unknown>
  return PROSE_FIELDS[capability].some((field) => JSON.stringify(record[field] ?? '').toLowerCase().includes(AI_UNAVAILABLE.toLowerCase()))
}
