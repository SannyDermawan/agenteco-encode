import { z } from 'zod'

/**
 * The four capabilities, each one package (spec §7): what the buyer submits
 * (input schema + limits), what the seller delivers (output schema), and how a
 * verifier judges it (rubric). The frontend form, the API, hosted sellers and
 * standalone agents all validate against these same schemas.
 *
 * This file has no Node-only dependencies, the browser imports it.
 */

export const CAPABILITY_IDS = ['translation', 'data_analysis', 'crypto_market_brief', 'tx_explainer'] as const
export type CapabilityId = (typeof CAPABILITY_IDS)[number]

export const LIMITS = {
  translationChars: 2000,
  csvRows: 200,
  csvColumns: 20,
  /** Raw CSV text cap, 200 rows × 20 columns of short values. */
  csvChars: 60_000,
  questionChars: 500,
  coinsMin: 1,
  coinsMax: 3,
  txLogs: 20,
  /** Acceptance criteria, custom instructions, free-text brief fields. */
  textChars: 500,
  disputeReasonChars: 1000,
} as const

// ---------------------------------------------------------------------------
// translation
// ---------------------------------------------------------------------------

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ms', name: 'Malay' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'ar', name: 'Arabic' },
] as const

const languageCode = z.enum(LANGUAGES.map((l) => l.code) as [string, ...string[]])

export const translationInput = z.object({
  text: z.string().trim().min(1, 'Text is required').max(LIMITS.translationChars, `At most ${LIMITS.translationChars} characters`),
  targetLanguage: languageCode,
  tone: z.enum(['neutral', 'formal', 'casual']).optional(),
})

export const translationOutput = z.object({
  translatedText: z.string().min(1),
  targetLanguage: languageCode,
  notes: z.string().max(LIMITS.textChars).optional(),
})

// ---------------------------------------------------------------------------
// data_analysis
// ---------------------------------------------------------------------------

export const dataAnalysisInput = z.object({
  csv: z.string().trim().min(1, 'CSV is required').max(LIMITS.csvChars, 'CSV is too large'),
  question: z.string().trim().max(LIMITS.questionChars).optional(),
})

export const columnStats = z.object({
  column: z.string(),
  count: z.number(),
  mean: z.number(),
  median: z.number(),
  min: z.number(),
  max: z.number(),
  stddev: z.number(),
})

export const trendStats = z.object({
  dateColumn: z.string(),
  valueColumn: z.string(),
  firstDate: z.string(),
  lastDate: z.string(),
  firstValue: z.number(),
  lastValue: z.number(),
  /** (last - first) / |first| × 100; null when first is 0. */
  changePct: z.number().nullable(),
  direction: z.enum(['up', 'down', 'flat']),
})

export const dataStats = z.object({
  rows: z.number(),
  columns: z.array(z.string()),
  numeric: z.array(columnStats),
  trends: z.array(trendStats),
})

export const dataAnalysisOutput = z.object({
  stats: dataStats,
  insights: z.array(z.string().max(400)).max(8),
  summary: z.string().max(1200),
})

// ---------------------------------------------------------------------------
// crypto_market_brief
// ---------------------------------------------------------------------------

export const cryptoBriefInput = z.object({
  coins: z
    .array(z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/, 'Use CoinGecko ids, e.g. bitcoin'))
    .min(LIMITS.coinsMin, 'Pick at least one coin')
    .max(LIMITS.coinsMax, `At most ${LIMITS.coinsMax} coins`),
  horizon: z.enum(['24h', '7d']),
})

export const coinMarket = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  priceUsd: z.number(),
  change24hPct: z.number().nullable(),
  change7dPct: z.number().nullable(),
  volume24hUsd: z.number().nullable(),
  marketCapUsd: z.number().nullable(),
})

export const cryptoBriefOutput = z.object({
  data: z.object({ coins: z.array(coinMarket), fetchedAt: z.string(), source: z.literal('CoinGecko') }),
  brief: z.string().max(2000),
  disclaimer: z.string().min(1),
})

// ---------------------------------------------------------------------------
// tx_explainer
// ---------------------------------------------------------------------------

export const txExplainerInput = z.object({
  txHash: z.string().trim().regex(/^0x[0-9a-fA-F]{64}$/, 'A transaction hash is 0x followed by 64 hex characters'),
})

export const decodedEvent = z.object({
  contract: z.string(),
  event: z.string(),
  args: z.record(z.string(), z.string()),
})

export const txFacts = z.object({
  hash: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  valueNative: z.string(),
  status: z.enum(['success', 'reverted']),
  gasUsed: z.string(),
  blockNumber: z.string(),
  decodedEvents: z.array(decodedEvent),
  /** Logs present but not decodable as ERC-20 or AgentEco events. */
  otherLogs: z.number(),
})

export const txExplainerOutput = z.object({
  facts: txFacts,
  explanation: z.string().max(2000),
})

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface CapabilityDefinition<I extends z.ZodTypeAny = z.ZodTypeAny, O extends z.ZodTypeAny = z.ZodTypeAny> {
  id: CapabilityId
  label: string
  category: 'Content' | 'Data' | 'Research'
  /** Default seller description (the form fills it in). */
  description: string
  input: I
  output: O
  /** What a verifier checks the result against (spec §7). */
  rubric: string
}

export const CAPABILITIES = {
  translation: {
    id: 'translation',
    label: 'Translation',
    category: 'Content',
    description: 'Translates text into the requested language, in the requested tone.',
    input: translationInput,
    output: translationOutput,
    rubric:
      'The target language is correct; no part of the source is missing; the meaning is faithful; it follows the acceptance criteria and the requested tone.',
  },
  data_analysis: {
    id: 'data_analysis',
    label: 'Data Analysis',
    category: 'Data',
    description: 'Computes statistics for a CSV and explains what they show.',
    input: dataAnalysisInput,
    output: dataAnalysisOutput,
    rubric:
      'Every number quoted in the insights and summary matches the computed stats; the question is answered if one was asked; nothing is claimed that the stats do not support.',
  },
  crypto_market_brief: {
    id: 'crypto_market_brief',
    label: 'Crypto Market Brief',
    category: 'Research',
    description: 'Live CoinGecko prices, changes and volume for up to three coins, with a short analysis.',
    input: cryptoBriefInput,
    output: cryptoBriefOutput,
    rubric:
      'Every number in the brief matches the fetched data; it covers the requested coins and horizon; a not-financial-advice disclaimer is present.',
  },
  tx_explainer: {
    id: 'tx_explainer',
    label: 'Transaction Explainer',
    category: 'Research',
    description: 'Reads a transaction and its receipt from the chain and explains what happened in plain English.',
    input: txExplainerInput,
    output: txExplainerOutput,
    rubric:
      'The explanation is consistent with the decoded facts (parties, amounts, status); it does not invent events, tokens or amounts that are not in the facts.',
  },
} as const satisfies Record<CapabilityId, CapabilityDefinition>

export function isCapabilityId(value: string): value is CapabilityId {
  return (CAPABILITY_IDS as readonly string[]).includes(value)
}

/** Validates a buyer's brief for a capability. Returns zod's result. */
export function parseBrief(capability: CapabilityId, brief: unknown) {
  return CAPABILITIES[capability].input.safeParse(brief)
}

/** Validates a delivered result for a capability. */
export function parseResult(capability: CapabilityId, result: unknown) {
  return CAPABILITIES[capability].output.safeParse(result)
}

export type TranslationInput = z.infer<typeof translationInput>
export type TranslationOutput = z.infer<typeof translationOutput>
export type DataAnalysisInput = z.infer<typeof dataAnalysisInput>
export type DataAnalysisOutput = z.infer<typeof dataAnalysisOutput>
export type DataStats = z.infer<typeof dataStats>
export type CryptoBriefInput = z.infer<typeof cryptoBriefInput>
export type CryptoBriefOutput = z.infer<typeof cryptoBriefOutput>
export type CoinMarket = z.infer<typeof coinMarket>
export type TxExplainerInput = z.infer<typeof txExplainerInput>
export type TxExplainerOutput = z.infer<typeof txExplainerOutput>
export type TxFacts = z.infer<typeof txFacts>
