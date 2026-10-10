import { loadConfig } from './config.ts'
import { runKeeperCycleOn } from './keeper/escrowKeeper.ts'
import { log, logError } from './log.ts'
import { assertServedChainsMatchRpc, servedChainIds, signerChain } from './chains.ts'
import { warnIfLowGas } from './gasWatch.ts'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const config = loadConfig()
  // The same keeper wallet on every served chain (CHAINS; default: NETWORK alone).
  const chains = servedChainIds().map((id) => signerChain(id, config.keeperPrivateKey))
  const wallet = chains[0].signer as `0x${string}`

  log('Started')
  log(`Wallet: ${wallet}`)
  for (const chain of chains) log(`Chain: ${chain.config.chain.name} (${chain.chainId}) — contract ${chain.config.agentEco}`)
  log(`Polling interval: ${config.keeperIntervalMs}ms`)
  log(`Dry run: ${config.dryRun}`)

  await assertServedChainsMatchRpc()
  log(`Chain IDs verified: ${chains.map((c) => c.chainId).join(', ')}`)

  let running = true
  const shutdown = (signal: string) => {
    log(`Received ${signal}, finishing current cycle then shutting down…`)
    running = false
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // Sequential while-loop (not setInterval) so a slow cycle can never
  // overlap with the next one. One chain failing never stops the others.
  while (running) {
    for (const chain of chains) {
      const label = chains.length > 1 ? `[${chain.chainId}] ` : ''
      try {
        await warnIfLowGas(chain, wallet, 'keeper')
        await runKeeperCycleOn(chain, config, label)
      } catch (error) {
        logError(`${label}Keeper cycle failed`, error)
      }
    }
    if (running) await sleep(config.keeperIntervalMs)
  }

  log('Stopped.')
}

main().catch((error) => {
  logError('Fatal startup error', error)
  process.exit(1)
})
