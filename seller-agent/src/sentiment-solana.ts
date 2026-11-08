import { createSellerAgent, parseSolanaSecretKey, registerCapability, resolveCapability, DEFAULT_API_URL } from '../../agent-runtime/src/sdk/index.ts'
import { sentiment } from '../../x402-gateway/src/agents.ts'

/**
 * The `sentiment_score` seller on Solana devnet, sold through AgentEco escrow.
 *
 * It runs the same scorer the x402 gateway sells per call (x402-gateway/src/agents.ts), so one agent has two ways to
 * be paid: x402 for a small call, escrow (with refund and dispute) for a bigger job.
 *
 *   npm run new-key           # once: makes the seller's key in .env and prints the public address
 *   npm run sentiment:solana  # lists the seller (if needed) and serves until stopped
 */

const secret = process.env.WALLET_PRIVATE_KEY
if (!secret) throw new Error('Missing WALLET_PRIVATE_KEY in .env. Run `npm run new-key` to make one.')
if (secret.startsWith('0x')) throw new Error('WALLET_PRIVATE_KEY is an EVM key. This seller needs a Solana secret key (base58 or a JSON array).')
const privateKey = await parseSolanaSecretKey(secret)
const apiUrl = process.env.AGENTECO_API_URL ?? DEFAULT_API_URL
const chain = process.env.CHAIN ?? 'solana-devnet'

const CAPABILITY = 'sentiment_score'

// The capability is shared: if it is already in the registry nothing is written.
try {
  await resolveCapability(apiUrl, CAPABILITY)
} catch {
  await registerCapability(
    privateKey,
    {
      id: CAPABILITY,
      name: 'Sentiment score',
      description: 'Scores how positive or negative a text is, from -1 to 1, with a one-line reason.',
      category: 'Content',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } },
        required: ['text'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          score: { type: 'number', minimum: -1, maximum: 1 },
          label: { enum: ['negative', 'neutral', 'positive'] },
          reason: { type: 'string', maxLength: 300 },
        },
        required: ['score', 'label', 'reason'],
      },
      rubric: 'The label agrees with the score, the score fits the tone of the text, and the reason quotes words from the text.',
    },
    apiUrl
  )
  console.log(`published "${CAPABILITY}" in the capability registry`)
}

const seller = createSellerAgent({
  privateKey,
  apiUrl,
  chain,
  name: 'Sentiment Scorer (Solana)',
  description: 'Scores the sentiment of reviews, tickets and posts with a word list, instantly. Also sold per call through x402.',
  capability: CAPABILITY,
  category: 'Content',
  price: 0.06,
  floor: 0.04,
  async handle(job) {
    const out = (await sentiment.run(job.brief)) as { score: number; label: string; evidence: string[] }
    const quoted = out.evidence.slice(0, 4).map((w) => `"${w}"`).join(', ')
    return {
      score: out.score,
      label: out.label,
      reason: quoted ? `Tone words found: ${quoted}.` : 'No clearly positive or negative words found.',
    }
  },
  async respondToDispute({ result, reason }) {
    return `The score follows the tone words in the text (${String(result.reason)}). Buyer's concern: ${reason ?? 'not given'}.`
  },
})

process.on('SIGINT', () => seller.stop())
process.on('SIGTERM', () => seller.stop())
await seller.start()
