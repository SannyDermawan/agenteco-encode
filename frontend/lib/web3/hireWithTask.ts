import { parseUnits } from 'viem'
import { readContract, waitForTransactionReceipt, writeContract } from 'wagmi/actions'
import { wagmiConfig } from './config'
import { AGENT_ECO_ABI, AGENT_ECO_ADDRESS, ERC20_ABI, USDT_ADDRESS } from './abi'
import { EXECUTION_WINDOW_SECONDS, REVIEW_WINDOW_SECONDS } from './constants'
import { parseCreatedEscrowId } from './hooks'
import { assertUsdtBalance } from './usdtBalance'
import { TOKEN_SYMBOL } from './network'
import { createTask, linkTaskEscrow, type ApiTask, type TaskLinkReceipt } from '@/lib/api/tasks'
import type { WalletSigner } from '@/lib/api/authHeaders'
import type { TransactionModifyingSigner } from '@runtime/chain/kit.ts'

export type HireStep =
  | 'checking-balance'
  | 'saving-task'
  | 'creating'
  | 'checking-allowance'
  | 'approving'
  | 'funding'
  | 'linking'

export const HIRE_STEP_LABEL: Record<HireStep, string> = {
  'checking-balance': `Checking ${TOKEN_SYMBOL} balance…`,
  'saving-task': 'Saving task brief (sign in wallet)…',
  creating: 'Creating escrow…',
  'checking-allowance': `Checking ${TOKEN_SYMBOL} allowance…`,
  approving: `Approving ${TOKEN_SYMBOL}…`,
  funding: 'Funding escrow…',
  linking: 'Linking task to escrow…',
}

export interface HireInput {
  signer: WalletSigner
  /** Solana only: the wallet's transaction signer (the EVM flow signs through wagmi's config). */
  txSigner?: TransactionModifyingSigner | null
  decimals: number
  seller: string
  price: string
  capability: string
  brief: unknown
  criteria?: string
  onStep: (step: HireStep) => void
}

/**
 * A human buyer's whole hire, in the order spec §5 requires: store the brief
 * (the API returns its taskHash) → createEscrow with that hash → approve →
 * fund → link the task to the escrow (the API checks the chain agrees). The
 * balance is checked first, so a short wallet never leaves a stray task or an
 * escrow stuck in CREATED.
 */
export async function hireWithTask(input: HireInput): Promise<{ escrowId: bigint; task: ApiTask }> {
  const { signer, decimals, seller, onStep } = input
  const buyer = signer.address as `0x${string}`
  const amount = parseUnits(input.price, decimals)

  onStep('checking-balance')
  await assertUsdtBalance(buyer, amount, decimals)

  onStep('saving-task')
  const task = await createTask(signer, {
    capability: input.capability,
    brief: input.brief,
    criteria: input.criteria,
    price: input.price,
    seller,
  })

  onStep('creating')
  const createHash = await writeContract(wagmiConfig, {
    address: AGENT_ECO_ADDRESS,
    abi: AGENT_ECO_ABI,
    functionName: 'createEscrow',
    args: [seller as `0x${string}`, amount, EXECUTION_WINDOW_SECONDS, REVIEW_WINDOW_SECONDS, task.taskHash],
  })
  const createReceipt = await waitForTransactionReceipt(wagmiConfig, { hash: createHash })
  const escrowId = parseCreatedEscrowId(createReceipt)
  if (escrowId === null) throw new Error('Could not read the new escrow id from the transaction receipt.')

  onStep('checking-allowance')
  const allowance = await readContract(wagmiConfig, {
    address: USDT_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [buyer, AGENT_ECO_ADDRESS],
  })
  if (allowance < amount) {
    onStep('approving')
    const approveHash = await writeContract(wagmiConfig, {
      address: USDT_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [AGENT_ECO_ADDRESS, amount],
    })
    await waitForTransactionReceipt(wagmiConfig, { hash: approveHash })
  }

  onStep('funding')
  const fundHash = await writeContract(wagmiConfig, {
    address: AGENT_ECO_ADDRESS,
    abi: AGENT_ECO_ABI,
    functionName: 'fundEscrow',
    args: [escrowId],
  })
  await waitForTransactionReceipt(wagmiConfig, { hash: fundHash })

  // The seller starts only once it can read the brief, retry a flaky link a
  // few times rather than leave a funded escrow for the accept timeout.
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
