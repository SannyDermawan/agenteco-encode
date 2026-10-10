import type { Address } from 'viem'
import { decryptAgentKey } from './agentKeyCrypto.ts'
import { prisma } from './db.ts'
import { refundLeftover } from './host/buyerTaskHost.ts'
import { readChain, signerChain, type ChainId } from './chains.ts'

// AgentEco.sol OrderStatus: FUNDED, EXECUTING, DELIVERED, DISPUTED — money is
// locked and someone still has to act. CREATED/SETTLED/REFUNDED are safe.
const IN_PROGRESS_STATUSES = new Set([1, 2, 3, 4])
const STATUS_LABEL = ['CREATED', 'FUNDED', 'EXECUTING', 'DELIVERED', 'DISPUTED', 'SETTLED', 'REFUNDED']

type DeletableAgent = {
  id: string
  chainId: string
  role: string
  walletAddress: string | null
  taskStatus: string | null
  escrowScanBlock: bigint | null
}

/**
 * Why this agent can't be deleted right now, or null if it can. Deleting
 * mid-deal would strand the counterparty: a hosted agent would stop acting,
 * and an agreed-but-unfunded deal would never get funded.
 */
export async function findBlockingWork(agent: DeletableAgent): Promise<string | null> {
  const orders = await prisma.order.findMany({
    where: { OR: [{ buyerAgentId: agent.id }, { sellerAgentId: agent.id }] },
    select: { status: true, escrowId: true },
  })
  if (orders.some((o) => o.status === 'agreed')) {
    return 'This agent has an agreed deal that has not been funded yet.'
  }

  // Every escrow this agent is part of on its chain: its orders' escrows, plus any
  // escrow naming its wallet (direct hires have no Order row). Read from contract
  // state — no event logs, so it works on RPCs that prune history.
  const orderEscrowIds = new Set(orders.filter((o) => o.escrowId).map((o) => o.escrowId!))
  const wallet = agent.walletAddress?.toLowerCase()
  for (const escrow of await readChain(agent.chainId).listEscrows()) {
    const involved =
      orderEscrowIds.has(escrow.id.toString()) ||
      (!!wallet && (escrow.seller.toLowerCase() === wallet || escrow.buyer.toLowerCase() === wallet))
    if (involved && IN_PROGRESS_STATUSES.has(escrow.status)) {
      return `On-chain order #${escrow.id} is still ${STATUS_LABEL[escrow.status]} — finish, settle, or refund it first.`
    }
  }
  return null
}

/**
 * Empties a hosted agent's own wallet back to whoever funded it: all of the
 * settlement token, then all native gas minus the gas for that last transfer.
 */
export async function withdrawHostedWallet(chainId: ChainId, encryptedKey: string, to: Address, label: string): Promise<void> {
  const chain = signerChain(chainId, decryptAgentKey(encryptedKey))
  await refundLeftover(chain, to, label, 'returned')
  await chain.sweepNative(to)
}
