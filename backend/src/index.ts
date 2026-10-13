import { loadConfig } from './config.ts'
import { runKeeperCycleOn } from './keeper/escrowKeeper.ts'
import { log, logError } from './log.ts'
import type { EvmAdapter } from '../../agent-runtime/src/chain/evm.ts'
import { solanaSignerFromFile, signerSolana } from '../../agent-runtime/src/chain/solana-registry.ts'
import type { ChainAdapter } from '../../agent-runtime/src/chain/types.ts'
import { assertServedChainsMatchRpc, chainFamily, servedChainIds, signerChain } from './chains.ts'
import { warnIfLowGas } from './gasWatch.ts'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const config = loadConfig()
  // One keeper wallet per family on every served chain (CHAINS; default: NETWORK alone): the EVM key
  // for EVM chains, a Solana keypair file for Solana chains.
  const chains: ChainAdapter[] = []
  for (const id of servedChainIds()) {
    if (chainFamily(id) === 'solana') {
      const file = process.env.SOLANA_KEEPER_KEYPAIR?.trim()
      if (!file) throw new Error(`Missing required environment variable: SOLANA_KEEPER_KEYPAIR (a Solana keypair JSON file; ${id} is served)`)
      chains.push(signerSolana(id, await solanaSignerFromFile(file)))
    } else {
      chains.push(signerChain(id, config.keeperPrivateKey!))
    }
  }

  log('Started')
  for (const chain of chains) {
    log(`Chain: ${chain.chainId}, wallet ${chain.signer}`)
    if (chain.family === 'evm') log(`Contract: ${(chain as EvmAdapter).config.agentEco}`)
  }
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
        if (chain.family === 'evm') await warnIfLowGas(chain as EvmAdapter, chain.signer as `0x${string}`, 'keeper')
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
