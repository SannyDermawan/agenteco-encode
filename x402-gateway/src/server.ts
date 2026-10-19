import { Ledger } from './ledger.ts'
import { createGateway, PUBLIC_FACILITATOR, SOLANA_DEVNET } from './gateway.ts'

const payTo = process.env.PAY_TO_ADDRESS
if (!payTo) throw new Error('Set PAY_TO_ADDRESS in .env to the Solana address that should receive the payments (a public address).')

const gateway = createGateway({
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
