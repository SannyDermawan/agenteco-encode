import { app } from './app.ts'
import { log, logError } from './log.ts'
import { assertServedChainsMatchRpc, chainSummaries } from './chains.ts'
import { FRONTEND_ORIGINS } from './origins.ts'
import { startMaintenance } from './maintenance.ts'

// PORT is what hosting platforms (Railway, Render, …) inject; API_PORT is the local-dev name.
const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 4000)

// Refuse to serve a mainnet frontend from a testnet RPC (or vice versa), on any served chain.
assertServedChainsMatchRpc().catch((error) => {
  logError('Network check failed', error, 'API')
  process.exit(1)
})

app.listen(PORT, () => {
  log(`AgentEco API listening on http://localhost:${PORT}`, 'API')
  for (const s of chainSummaries()) log(`Chain: ${s.name} (${s.chainId}), ${s.family === 'solana' ? 'program' : 'contract'} ${s.agentEco}`, 'API')
  log(`Allowed frontend origins: ${FRONTEND_ORIGINS.join(', ')}`, 'API')
  startMaintenance()
})

process.on('unhandledRejection', (error) => {
  logError('Unhandled rejection', error, 'API')
})
