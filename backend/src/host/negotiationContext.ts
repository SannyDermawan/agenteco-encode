import type { EvmAdapter } from '../../../agent-runtime/src/chain/evm.ts'
import { discoverAgents, type Negotiation } from '../../../agent-runtime/src/index.ts'
import { ratingSummaries } from '../ratings.ts'

export interface NegotiationExtras {
  history: { side: 'buyer' | 'seller'; action: string; price: number | null }[]
  brief: { length: number } | null
  seller: { stars: number | null; completedJobs: number } | null
  otherSellerPrices: number[]
}

/**
 * What the negotiating model sees besides the offer itself (spec §9): the
 * offer history, the job's size (never its content), the seller's on-chain
 * track record on the deal's chain, and competing sellers' listing prices for
 * the capability on that chain. Every lookup is best-effort, a failed one
 * just leaves that field empty.
 */
export async function buildNegotiationExtras(
  apiUrl: string,
  chain: EvmAdapter,
  negotiation: Negotiation,
  opts: { taskBrief?: unknown; sellerWallet?: string | null }
): Promise<NegotiationExtras> {
  const history = negotiation.messages.map((m) => ({
    side: m.side,
    action: m.action,
    price: m.price === null ? null : Number(m.price),
  }))

  const brief = opts.taskBrief === undefined || opts.taskBrief === null ? null : { length: JSON.stringify(opts.taskBrief).length }

  let seller: NegotiationExtras['seller'] = null
  if (opts.sellerWallet) {
    try {
      const [rep, [rating]] = await Promise.all([chain.getReputation(opts.sellerWallet), ratingSummaries([opts.sellerWallet], chain.chainId)])
      // Same displayed rating as the marketplace: same-owner ratings excluded.
      seller = { stars: rating?.avgScore == null ? null : rating.avgScore / 20, completedJobs: rep.completedJobs }
    } catch {
      seller = null
    }
  }

  let otherSellerPrices: number[] = []
  try {
    const sellers = await discoverAgents(apiUrl, { role: 'seller', capability: negotiation.capability, onlineOnly: true, chainId: chain.chainId })
    otherSellerPrices = sellers.filter((s) => s.id !== negotiation.sellerAgentId).map((s) => Number(s.price)).slice(0, 10)
  } catch {
    otherSellerPrices = []
  }

  return { history, brief, seller, otherSellerPrices }
}
