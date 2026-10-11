import { privateKeyToAccount } from 'viem/accounts'
import { formatUnits, type Address } from 'viem'
import type { EvmAdapter } from '../../../agent-runtime/src/chain/evm.ts'
import { hireWithTask } from '../../../agent-runtime/src/tasksClient.ts'
import { NEGOTIATION_ROUNDS } from '../../../agent-runtime/src/runtime.ts'
import { decideTurn } from '../ai/negotiate.ts'
import { buildNegotiationExtras } from './negotiationContext.ts'
import {
  DemoAgentRuntime,
  discoverAgents,
  openNegotiation,
  respondToNegotiation,
  listNegotiationsForAgent,
  countOffersBySide,
  isMyTurn,
  listOrdersForAgent,
  attachEscrowToOrder,
} from '../../../agent-runtime/src/index.ts'
import { decryptAgentKey } from '../agentKeyCrypto.ts'
import { prisma, prismaWithAgentKey } from '../db.ts'
import { log, logError } from '../log.ts'
import { selectSeller } from './selectSeller.ts'
import { reviewEscrow } from './buyerReview.ts'
import { warnIfLowGas } from '../gasWatch.ts'
import { servedChainIdsOf, signerChain } from '../chains.ts'

// The host talks to the registry over HTTP like any other agent. Set
// AGENTECO_API_URL when the API runs as a separate service (e.g. on Railway);
// locally it's the API process on the same machine.
export const API_URL = normalizeApiUrl(process.env.AGENTECO_API_URL) || `http://localhost:${process.env.API_PORT ?? 4000}`

/** Tolerates the common env typos: a bare host with no scheme, or a trailing slash. */
function normalizeApiUrl(raw: string | undefined): string {
  const value = raw?.trim().replace(/\/+$/, '') ?? ''
  if (!value) return ''
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}

export interface HostedBuyerAgentRow {
  id: string
  /** The chain this buyer trades on — its wallet, budget and escrows are there. */
  chainId: string
  name: string
  capabilities: string[]
  price: unknown // Prisma.Decimal
  maxBudget: unknown
  isOnline: boolean // false = paused: finishes deals in flight, opens no new ones
  agentWalletKey: string | null
  depositorWallet: string | null
  minSuccessRate: number | null
  minCompletedJobs: number | null
  minReputation: number | null
  /** What to buy — validated against the capability's input schema at creation. */
  taskBrief: unknown
  acceptanceCriteria: string | null
}

/**
 * Sends whatever settlement token remains in the agent's wallet (the adapter's
 * signer) back to whoever deposited it — a buyer's unspent budget, or a hosted
 * seller's settled earnings.
 */
export async function refundLeftover(chain: EvmAdapter, depositorWallet: Address, label: string, verb = 'refunded'): Promise<void> {
  if (!chain.signer) throw new Error('refundLeftover needs a signing adapter')
  const [{ decimals, symbol }, balance] = await Promise.all([chain.token(), chain.tokenBalance(chain.signer)])
  if (balance === BigInt(0)) return

  await chain.transferToken(depositorWallet, balance)
  log(`[host:${label}] ${verb} ${formatUnits(balance, decimals)} ${symbol} to ${depositorWallet}`)
}

// A hosted buyer opens at this fraction of the chosen seller's listed price —
// anchored to what the seller asks, not to the buyer's own Max Budget, so a
// generous budget never turns into an instant overpay.
const OPENING_OFFER_RATIO = 0.5

/**
 * Worth negotiating with only if the buyer can afford its own opening offer —
 * a seller listed above Max Budget may still settle within it (its floor can
 * be lower than its listing), so the listed price alone doesn't rule it out.
 */
function canOpenWith(sellerPrice: number, maxBudget: number): boolean {
  return Math.round(sellerPrice * OPENING_OFFER_RATIO * 100) / 100 <= maxBudget
}

/**
 * The buyer's negotiating position against one specific seller: opens at
 * OPENING_OFFER_RATIO of the seller's price and concedes up to whichever is
 * lower of its Max Budget and that listed price — there's never a reason to
 * pay a seller more than it asked for.
 */
function buyerRuntimeFor(agentRow: HostedBuyerAgentRow, sellerPrice: number): DemoAgentRuntime {
  const maxBudget = Number(agentRow.maxBudget)
  const ceiling = Math.min(maxBudget, sellerPrice)
  const opening = Math.min(Math.round(sellerPrice * OPENING_OFFER_RATIO * 100) / 100, ceiling)
  return new DemoAgentRuntime({
    name: agentRow.name,
    role: 'buyer',
    capabilities: agentRow.capabilities,
    description: 'Hosted buyer task.',
    basePrice: opening,
    maxBudget: ceiling,
  })
}

/**
 * One cycle of work for one active hosted buyer task. Does at most one
 * "step" per call (respond to a negotiation OR open one OR fund an order OR
 * settle one) — kept simple and predictable rather than racing through the
 * whole lifecycle in a single pass.
 */
export async function processHostedBuyerTask(agentRow: HostedBuyerAgentRow): Promise<void> {
  if (!agentRow.agentWalletKey || !agentRow.depositorWallet) return
  const capability = agentRow.capabilities[0]
  if (!capability) return

  const privateKey = decryptAgentKey(agentRow.agentWalletKey)
  const account = privateKeyToAccount(privateKey)
  const chain = signerChain(agentRow.chainId, privateKey)
  const tokenSymbol = chain.config.tokenSymbol
  const depositorWallet = agentRow.depositorWallet as Address
  await warnIfLowGas(chain, account.address, `hosted buyer "${agentRow.name}"`, 'hosted')

  const maxBudget = Number(agentRow.maxBudget)
  const allNegotiations = await listNegotiationsForAgent(API_URL, account, agentRow.id)

  // 1. Respond to anything awaiting our turn.
  for (const negotiation of allNegotiations.filter((n) => n.status === 'open')) {
    if (!isMyTurn(negotiation, 'buyer')) continue
    const sellerRes = await fetch(`${API_URL}/agents/${negotiation.sellerAgentId}`)
    const seller = (await sellerRes.json()) as { price: string; walletAddress: string | null }
    const listingPrice = Number(seller.price)
    const runtime = buyerRuntimeFor(agentRow, listingPrice)

    const lastMessage = negotiation.messages[negotiation.messages.length - 1]
    const offeredPrice = Number(lastMessage.price)
    const extras = await buildNegotiationExtras(API_URL, chain, negotiation, {
      taskBrief: agentRow.taskBrief,
      sellerWallet: seller.walletAddress,
    })
    const move = await decideTurn({
      runtime,
      offeredPrice,
      myPriorOfferCount: countOffersBySide(negotiation, 'buyer'),
      listingPrice,
      maxRounds: NEGOTIATION_ROUNDS,
      capability: negotiation.capability,
      agentId: agentRow.id,
      ...extras,
    })
    log(
      `[host:${agentRow.name}] negotiation ${negotiation.id}: incoming ${offeredPrice} ${tokenSymbol} -> ${move.action}` +
        (move.action === 'counter' ? ` (${move.price} ${tokenSymbol})` : '') +
        ` [${move.source}${move.adjusted ? ', adjusted' : ''}]`
    )
    await respondToNegotiation(API_URL, account, negotiation.id, { side: 'buyer', ...move })
    return
  }

  // 2. No live negotiation for this capability yet? Go find a seller —
  //    unless the owner paused this buyer. Steps 1, 3 and 4 still run while
  //    paused, so a seller already mid-deal is never left stranded.
  // Rejected or expired: that seller is done with us; anything else is still live.
  const ended = (status: string) => status === 'rejected' || status === 'expired'
  const hasPendingNegotiation = allNegotiations.some((n) => n.capability === capability && !ended(n.status))
  if (!hasPendingNegotiation && agentRow.isOnline) {
    // A seller that already walked away from this capability won't take the
    // same opening offer again — reopening with it would just loop forever.
    const rejectedSellerIds = new Set(
      allNegotiations.filter((n) => n.capability === capability && ended(n.status)).map((n) => n.sellerAgentId)
    )
    // Only sellers on this buyer's chain: the deal is escrowed where the budget is.
    const sellers = (await discoverAgents(API_URL, { role: 'seller', capability, onlineOnly: true, chainId: agentRow.chainId })).filter(
      (s) => !rejectedSellerIds.has(s.id)
    )
    const chosen = await selectSeller(chain, sellers, (p) => canOpenWith(p, maxBudget), {
      minSuccessRate: agentRow.minSuccessRate,
      minCompletedJobs: agentRow.minCompletedJobs,
      minReputation: agentRow.minReputation,
    })
    if (!chosen) {
      log(`[host:${agentRow.name}] no qualifying seller for "${capability}" yet — will retry.`)
      return
    }
    const openingOffer = buyerRuntimeFor(agentRow, Number(chosen.price)).config.basePrice
    log(
      `[host:${agentRow.name}] opening negotiation with "${chosen.name}" (asks ${chosen.price} ${tokenSymbol}) — offering ${openingOffer} ${tokenSymbol}`
    )
    await openNegotiation(API_URL, account, {
      buyerAgentId: agentRow.id,
      sellerAgentId: chosen.id,
      capability,
      price: openingOffer,
    })
    return
  }

  // 3. Deal struck but not funded yet? Fund exactly the negotiated price,
  //    then refund whatever's left of the original deposit immediately.
  const agreedOrders = await listOrdersForAgent(API_URL, account, agentRow.id, 'agreed')
  for (const order of agreedOrders) {
    const sellerRes = await fetch(`${API_URL}/agents/${order.sellerAgentId}`)
    const seller = (await sellerRes.json()) as { walletAddress: Address | null }
    if (!seller.walletAddress) {
      log(`[host:${agentRow.name}] order ${order.id}: seller has no on-chain wallet — cannot fund.`)
      continue
    }

    if (agentRow.taskBrief === null || agentRow.taskBrief === undefined) {
      log(`[host:${agentRow.name}] order ${order.id}: this buyer has no task brief — cannot hire.`)
      continue
    }

    // Store the task, escrow its hash, link the two (spec §5).
    log(`[host:${agentRow.name}] funding escrow for ${order.price} ${tokenSymbol} (deposit was ${agentRow.maxBudget} ${tokenSymbol})…`)
    const { escrowId, task } = await hireWithTask(
      API_URL,
      { account },
      {
        capability: order.capability,
        brief: agentRow.taskBrief,
        criteria: agentRow.acceptanceCriteria,
        price: order.price,
        seller: seller.walletAddress,
      },
      chain
    )
    await attachEscrowToOrder(API_URL, account, order.id, escrowId.toString())
    log(`[host:${agentRow.name}] order ${order.id}: funded as escrow #${escrowId} (task ${task.taskHash.slice(0, 10)}…).`)

    await refundLeftover(chain, depositorWallet, agentRow.name)
    return
  }

  // 4. Funded: verify the delivery, then settle + rate or dispute (spec §10.1).
  //    The task is done once its escrow is final; whatever the escrow returned
  //    to the agent wallet (a refund) goes back to the owner.
  const fundedOrders = await listOrdersForAgent(API_URL, account, agentRow.id, 'funded')
  for (const order of fundedOrders) {
    if (!order.escrowId) continue
    const step = await reviewEscrow(API_URL, agentRow, chain, account, BigInt(order.escrowId))
    if (step === 'waiting') continue
    if (step === 'final') {
      await refundLeftover(chain, depositorWallet, agentRow.name)
      await prisma.agent.update({ where: { id: agentRow.id }, data: { taskStatus: 'completed' } })
      log(`[host:${agentRow.name}] task completed.`)
    }
    return
  }
}

export async function runHostCycleOnce(): Promise<void> {
  // The only place allowed to read agentWalletKey — see db.ts.
  const served = servedChainIdsOf('evm')
  // Buyers on a chain this host does not serve (CHAINS) wait until it does.
  const activeAgents = await prismaWithAgentKey.agent.findMany({
    where: { role: 'buyer', taskStatus: 'active', deletedAt: null, chainId: { in: served } },
  })

  for (const agentRow of activeAgents) {
    try {
      await processHostedBuyerTask(agentRow)
    } catch (error) {
      logError(`[host:${agentRow.name}] cycle failed`, error, 'HOST')
    }
  }
}
