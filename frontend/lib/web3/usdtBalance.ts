import { formatUnits } from 'viem'
import { readContract } from 'wagmi/actions'
import { wagmiConfig } from './config'
import { ERC20_ABI, USDT_ADDRESS } from './abi'
import { CHAIN_NAME, TOKEN_HAS_FAUCET, TOKEN_SYMBOL } from './network'

/** The wallet holds less of the settlement token than a flow needs. */
export class InsufficientTokenError extends Error {}

/**
 * Throws an InsufficientTokenError when `wallet` holds less than `amount` of
 * the settlement token. Run it before the first transaction of a flow,
 * otherwise createEscrow still goes through, fundEscrow reverts with "ERC20
 * transferFrom failed", and the buyer has paid gas for an escrow stuck in
 * CREATED.
 */
export async function assertUsdtBalance(wallet: `0x${string}`, amount: bigint, decimals: number): Promise<void> {
  const balance = await readContract(wagmiConfig, {
    address: USDT_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [wallet],
  })
  if (balance < amount) {
    const topUp = TOKEN_HAS_FAUCET ? `Claim free ${TOKEN_SYMBOL} below` : `Top up ${TOKEN_SYMBOL} first`
    throw new InsufficientTokenError(
      `Not enough ${TOKEN_SYMBOL}: this needs ${formatUnits(amount, decimals)} ${TOKEN_SYMBOL} but your wallet holds ` +
        `${formatUnits(balance, decimals)} ${TOKEN_SYMBOL} on ${CHAIN_NAME}. ${topUp}, no transaction was sent.`
    )
  }
}
