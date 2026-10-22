import { Ledger } from './ledger.ts'
import { createGateway, PUBLIC_FACILITATOR, SOLANA_DEVNET } from './gateway.ts'
import { DEFAULT_AGENTS, translateAgent } from './agents.ts'

const payTo = process.env.PAY_TO_ADDRESS
if (!payTo) throw new Error('Set PAY_TO_ADDRESS in .env to the Solana address that should receive the payments (a public address).')

// A model-backed agent joins the cheap deterministic ones when a model is configured (any OpenAI-compatible endpoint, Nebius in the demo).
const { AI_BASE_URL, AI_API_KEY, AI_MODEL } = process.env
const agents = AI_BASE_URL && AI_API_KEY && AI_MODEL ? [...DEFAULT_AGENTS, translateAgent({ baseUrl: AI_BASE_URL, apiKey: AI_API_KEY, model: AI_MODEL })] : DEFAULT_AGENTS

const gateway = createGateway({
  agents,
  payTo,
  network: process.env.X402_NETWORK || SOLANA_DEVNET,
  facilitatorUrl: process.env.X402_FACILITATOR_URL || PUBLIC_FACILITATOR,
  facilitatorTimeoutMs: Number(process.env.X402_FACILITATOR_TIMEOUT_MS || 15_000),
  ledger: new Ledger(process.env.LEDGER_FILE || undefined),
  log: (message) => console.log(`[gateway] ${message}`),
})
await gateway.ready
const port = Number(process.env.PORT || 8402)
gateway.app.listen(port, () => console.log(`x402 gateway on http://localhost:${port} (${process.env.X402_NETWORK || SOLANA_DEVNET})`))
