import { formatEther, parseUnits, type Address } from 'viem'
import { readChain, type ChainId } from './chains.ts'

// Buyer: enough for createEscrow + approve + fundEscrow + accept/dispute + rating + refund.
// Seller: enough for a handful of startExecution + markDelivered + dispute-response + payout rounds.
// Per chain (its hostedMinGas), below the frontend's activation top-up.

/** Pass requiredUsdt = '0' for a hosted seller — it only needs gas, not a budget. */
export async function checkHostedDeposit(
  chainId: ChainId,
  walletAddress: Address,
  requiredUsdt: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const chain = readChain(chainId)
  const { decimals, symbol } = await chain.token()
  const requiredAmount = parseUnits(requiredUsdt, decimals)

  const [usdtBalance, gasBalance] = await Promise.all([chain.tokenBalance(walletAddress), chain.nativeBalance(walletAddress)])

  if (usdtBalance < requiredAmount) {
    return { ok: false, error: `Agent wallet has not received the required ${requiredUsdt} ${symbol} deposit yet.` }
  }
  const minGas = chain.config.hostedMinGas
  if (gasBalance < parseUnits(minGas, 18)) {
    return {
      ok: false,
      error: `Agent wallet needs at least ${minGas} ${chain.nativeSymbol} for gas (has ${formatEther(gasBalance)}).`,
    }
  }

  return { ok: true }
}
