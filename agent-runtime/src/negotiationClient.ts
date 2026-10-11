import { buildAuthHeaders, type WalletAccount } from './authHeaders.ts'

export type NegotiationSide = 'buyer' | 'seller'
export type NegotiationAction = 'offer' | 'counter' | 'accept' | 'reject'
export type NegotiationStatus = 'open' | 'accepted' | 'rejected' | 'expired'

/** Why a move was made (spec §9) — the model's reason, or rule-based. */
export interface MoveMeta {
  reason?: string | null
  source?: 'ai' | 'rule' | 'agent'
  adjusted?: boolean
}

export interface NegotiationMessage {
  id: string
  side: NegotiationSide
  action: NegotiationAction
  price: string | null
  createdAt: string
  reason?: string | null
  source?: 'ai' | 'rule' | 'agent'
  adjusted?: boolean
}

export interface Negotiation {
  id: string
  buyerAgentId: string
  sellerAgentId: string
  capability: string
  status: NegotiationStatus
  agreedPrice: string | null
  messages: NegotiationMessage[]
}

async function parseOrThrow(res: Response, action: string): Promise<any> {
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${action} failed (${res.status}): ${body}`)
  }
  return res.json()
}

/** Buyer opens a negotiation with an opening offer (§11: Offer -> ...). */
export async function openNegotiation(
  apiUrl: string,
  buyerAccount: WalletAccount,
  input: { buyerAgentId: string; sellerAgentId: string; capability: string; price: number } & MoveMeta
): Promise<Negotiation> {
  const authHeaders = await buildAuthHeaders(buyerAccount)
  const res = await fetch(`${apiUrl}/negotiations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(input),
  })
  return parseOrThrow(res, 'Opening negotiation')
}

/** Either side responds: counter, accept, or reject. */
export async function respondToNegotiation(
  apiUrl: string,
  account: WalletAccount,
  negotiationId: string,
  response: { side: NegotiationSide; action: 'counter' | 'accept' | 'reject'; price?: number } & MoveMeta
): Promise<Negotiation> {
  const authHeaders = await buildAuthHeaders(account)
  const res = await fetch(`${apiUrl}/negotiations/${negotiationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(response),
  })
  return parseOrThrow(res, 'Responding to negotiation')
}

export async function listNegotiationsForAgent(
  apiUrl: string,
  reader: WalletAccount,
  agentId: string,
  status?: NegotiationStatus
): Promise<Negotiation[]> {
  const query = new URLSearchParams({ agentId })
  if (status) query.set('status', status)
  const res = await fetch(`${apiUrl}/negotiations?${query}`, { headers: await buildAuthHeaders(reader) })
  return parseOrThrow(res, 'Listing negotiations')
}

/** How many offers has `side` already made in this session? (Its opening offer counts as one.) */
export function countOffersBySide(negotiation: Negotiation, side: NegotiationSide): number {
  return negotiation.messages.filter((m) => m.side === side && (m.action === 'offer' || m.action === 'counter')).length
}

export function isMyTurn(negotiation: Negotiation, side: NegotiationSide): boolean {
  const last = negotiation.messages[negotiation.messages.length - 1]
  return negotiation.status === 'open' && last.side !== side
}
