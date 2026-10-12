import './polyfills'
import { formatUnits, parseUnits } from 'viem'
import { createTask, linkTaskEscrow, type ApiTask, type TaskLinkReceipt } from '@/lib/api/tasks'
import { InsufficientTokenError } from '@/lib/web3/usdtBalance'
import { TOKEN_SYMBOL } from '@/lib/web3/network'
import type { HireInput } from '@/lib/web3/hireWithTask'
import { solanaWriter } from './chain'

/**
 * A human buyer's whole hire on Solana, in the order spec §5 requires: check the wallet can pay → store
 * the brief (the API returns its taskHash) → ONE transaction that creates the escrow with that hash and
 * funds it (the wallet asks once; if the seller has no token account yet the same transaction creates it)
 * → link the task to the escrow (the API checks the program agrees). The balance is checked first, so a
 * short wallet never leaves a stray task.
 */
export async function hireWithTask(input: HireInput): Promise<{ escrowId: bigint; task: ApiTask }> {
  const { signer, txSigner, decimals, seller, onStep } = input
  if (!txSigner) throw new Error('Connect a Solana wallet first.')
  const adapter = solanaWriter(txSigner)
  const amount = parseUnits(input.price, decimals)

  onStep('checking-balance')
  const [token, sol] = await Promise.all([adapter.tokenBalance(signer.address), adapter.nativeBalance(signer.address)])
  if (token < amount) {
    throw new InsufficientTokenError(
      `Not enough ${TOKEN_SYMBOL}: this needs ${input.price} ${TOKEN_SYMBOL} but your wallet holds ${formatUnits(token, decimals)} ${TOKEN_SYMBOL}. ` +
        `Get some from the faucet below — no transaction was sent.`
    )
  }
  if (sol === BigInt(0)) {
    throw new Error(`Your wallet holds no ${adapter.nativeSymbol} for network fees. Get some from the faucet below — no transaction was sent.`)
  }

  onStep('saving-task')
  const task = await createTask(signer, {
    capability: input.capability,
    brief: input.brief,
    criteria: input.criteria,
    price: input.price,
    seller,
  })

  onStep('creating')
  const escrowId = await adapter.createAndFundEscrow({ seller, amount: input.price, taskHash: task.taskHash })

  // The seller starts only once it can read the brief — retry a flaky link a few times rather than
  // leave a funded escrow for the accept timeout.
  onStep('linking')
  let linked: TaskLinkReceipt | null = null
  for (let attempt = 0; attempt < 3 && !linked; attempt++) {
    try {
      linked = await linkTaskEscrow(task.id, escrowId.toString())
    } catch (error) {
      if (attempt === 2) throw error
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  return { escrowId, task: { ...task, ...linked! } }
}
