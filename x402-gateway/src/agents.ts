import { z } from 'zod'

/**
 * The agents behind the paywall. Each one is a small, deterministic worker so the payment flow can be shown and tested
 * without a model or an API key. In production the handler is where an AgentEco seller agent plugs in (see README).
 */
export interface AgentService {
  capability: string
  description: string
  /** Price in dollars, charged in USDC on Solana: a micro-payment for one call. */
  priceUsd: string
  input: z.ZodType<unknown>
  run(brief: unknown): Promise<Record<string, unknown>>
}

const POSITIVE = ['good', 'great', 'love', 'excellent', 'happy', 'fast', 'helpful', 'amazing', 'easy', 'recommend']
const NEGATIVE = ['bad', 'slow', 'hate', 'terrible', 'broken', 'poor', 'awful', 'bug', 'expensive', 'refund']
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'with', 'this', 'that', 'was', 'are', 'be', 'as', 'at', 'by'])

const textInput = z.object({ text: z.string().min(1).max(2000) })

export const sentiment: AgentService = {
  capability: 'sentiment_score',
  description: 'Scores how positive or negative a text is, from -1 to 1, with the words that decided it.',
  priceUsd: '$0.005',
  input: textInput,
  async run(brief) {
    const { text } = textInput.parse(brief)
    const words = text.toLowerCase().match(/[a-z']+/g) ?? []
    const pos = words.filter((w) => POSITIVE.includes(w))
    const neg = words.filter((w) => NEGATIVE.includes(w))
    const score = pos.length + neg.length === 0 ? 0 : (pos.length - neg.length) / (pos.length + neg.length)
    return { score: Math.round(score * 100) / 100, label: score > 0.2 ? 'positive' : score < -0.2 ? 'negative' : 'neutral', evidence: [...pos, ...neg].slice(0, 6) }
  },
}

export const keywords: AgentService = {
  capability: 'keyword_extract',
  description: 'Extracts the most frequent meaningful words from a text.',
  priceUsd: '$0.003',
  input: textInput,
  async run(brief) {
    const { text } = textInput.parse(brief)
    const counts = new Map<string, number>()
    for (const w of text.toLowerCase().match(/[a-z']{3,}/g) ?? []) if (!STOP.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1)
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8)
    return { keywords: top.map(([word, count]) => ({ word, count })) }
  },
}

export const DEFAULT_AGENTS: AgentService[] = [sentiment, keywords]
