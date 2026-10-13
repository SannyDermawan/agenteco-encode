import { formatEther, parseEther, type Address } from 'viem'
import type { EvmAdapter } from '../../agent-runtime/src/chain/evm.ts'
import { log } from './log.ts'

// A wallet's balance is re-read at most this often, the host loop runs every
// few seconds per agent, and gas drains slowly.
const CHECK_EVERY_MS = 5 * 60_000
const lastChecked = new Map<string, number>()

/**
 * Logs a warning when a system wallet (keeper, arbiter, a hosted agent) runs
 * low on native gas on a chain, so an operator tops it up before transactions
 * start failing. Never throws, a failed balance read must not stop the loop.
 */
export async function warnIfLowGas(
  chain: EvmAdapter,
  address: Address,
  label: string,
  /** 'system' = keeper/arbiter (the chain's lowGasWarn); 'hosted' = an agent wallet (its hostedMinGas). */
  kind: 'system' | 'hosted' = 'system'
): Promise<void> {
  const key = `${chain.chainId}:${address.toLowerCase()}`
  const now = Date.now()
  if (now - (lastChecked.get(key) ?? 0) < CHECK_EVERY_MS) return
  lastChecked.set(key, now)

  try {
    const balance = await chain.nativeBalance(address)
    const threshold = kind === 'hosted' ? chain.config.hostedMinGas : chain.config.lowGasWarn
    if (balance < parseEther(threshold)) {
      log(
        `WARNING low gas: ${label} ${address} has ${formatEther(balance)} ${chain.nativeSymbol} on ${chain.chainId} ` +
          `(below ${threshold}). Top it up before its transactions start failing.`
      )
    }
  } catch {
    // Balance read failed (RPC hiccup), try again next window.
    lastChecked.delete(key)
  }
}
