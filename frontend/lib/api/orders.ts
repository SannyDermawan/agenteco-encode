import type { ApiAgent } from './agents'
import { buildAuthHeaders, type WalletSigner } from './authHeaders'
import { checkReadAccess, readHeaders } from './session'
import type { ActivityEntry, NegotiationEntry, Order, OrderStatus } from '@/lib/agenteco-data'
import { TOKEN_SYMBOL } from '@/lib/web3/network'
import { API_URL, chainFetch as fetch } from './base'

export type OrderDbStatus = 'agreed' | 'funded'

export interface ApiNegotiationMessage {
  id: string
  side: 'buyer' | 'seller'
  action: 'offer' | 'counter' | 'accept' | 'reject'
  price: string | null
  reason: string | null
  source: 'ai' | 'rule'
  adjusted: boolean
  createdAt: string
}

export interface ApiOrder {
  id: string
  negotiationId: string
  buyerAgentId: string
  sellerAgentId: string
  capability: string
  price: string
  status: OrderDbStatus
  escrowId: string | null
  createdAt: string
  updatedAt: string
  buyerAgent: ApiAgent
  sellerAgent: ApiAgent
  negotiation: {
    id: string
    status: string
    agreedPrice: string | null
    messages: ApiNegotiationMessage[]
  }
}


async function parseOrThrow(res: Response) {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error?.formErrors?.join(', ') || body?.error || `Request failed (${res.status})`)
  }
  return res.json()
}

export async function listOrders(params?: { ownerWallet?: string; status?: OrderDbStatus }): Promise<ApiOrder[]> {
  const query = new URLSearchParams()
  if (params?.ownerWallet) query.set('ownerWallet', params.ownerWallet)
  if (params?.status) query.set('status', params.status)
  const res = await fetch(`${API_URL}/orders${query.toString() ? `?${query}` : ''}`, { cache: 'no-store', headers: readHeaders() })
  await checkReadAccess(res)
  return parseOrThrow(res)
}

export async function getOrder(id: string): Promise<ApiOrder | null> {
  const res = await fetch(`${API_URL}/orders/${id}`, { cache: 'no-store', headers: readHeaders() })
  if (res.status === 404) return null
  await checkReadAccess(res)
  return parseOrThrow(res)
}

/**
 * Beyond "funded", AgentEco.sol is the source of truth for status (see
 * schema comment on the Order model) — this DB record only distinguishes
 * agreed-but-not-yet-funded from funded. The on-chain order page reads the
 * real live status once `escrowId` is set.
 */
export function toOrderRow(order: ApiOrder): Order {
  const status: OrderStatus = order.status === 'funded' ? 'Escrow Funded' : 'Agreed'
  return {
    id: order.id,
    buyer: order.buyerAgent.name,
    seller: order.sellerAgent.name,
    service: order.sellerAgent.service ?? order.capability,
    amount: Number(order.price),
    status,
    createdAt: new Date(order.createdAt).toLocaleDateString(),
  }
}

export function toNegotiationEntries(order: ApiOrder): NegotiationEntry[] {
  return order.negotiation.messages.map((m) => ({
    side: m.side,
    who: m.side === 'buyer' ? order.buyerAgent.name : order.sellerAgent.name,
    action: m.action,
    price: m.price === null ? null : Number(m.price),
    reason: m.reason ?? null,
    source: m.source === 'ai' ? 'ai' : 'rule',
    adjusted: !!m.adjusted,
  }))
}

/**
 * Off-chain half of the activity feed (§20) — built from real negotiation
 * messages, not synthetic "discovered"/"quote requested" lines we have no
 * record of. The on-chain half (escrow funded/executing/delivered/settled)
 * is merged in by the page itself once it has batched on-chain timestamps.
 */
export function buildActivityEntries(orders: ApiOrder[]): (ActivityEntry & { at: number })[] {
  const entries: (ActivityEntry & { at: number })[] = []

  for (const order of orders) {
    order.negotiation.messages.forEach((m, i) => {
      const who = m.side === 'buyer' ? order.buyerAgent.name : order.sellerAgent.name
      const other = m.side === 'buyer' ? order.sellerAgent.name : order.buyerAgent.name
      const at = new Date(m.createdAt).getTime()

      let message: string
      if (i === 0) {
        message = `${who} discovered ${other} and offered ${m.price} ${TOKEN_SYMBOL}`
      } else if (m.action === 'counter') {
        message = `${who} countered with ${m.price} ${TOKEN_SYMBOL}`
      } else if (m.action === 'accept') {
        message = `${who} accepted at ${m.price} ${TOKEN_SYMBOL}`
      } else {
        message = `${who} rejected the offer`
      }

      entries.push({ at, time: new Date(at).toLocaleString(), message, kind: i === 0 ? 'discovery' : 'negotiation' })
    })
  }

  return entries.sort((a, b) => b.at - a.at)
}

export async function fundOrder(id: string, signer: WalletSigner, escrowId: string): Promise<ApiOrder> {
  const authHeaders = await buildAuthHeaders(signer)
  const res = await fetch(`${API_URL}/orders/${id}/escrow`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ escrowId }),
  })
  return parseOrThrow(res)
}
