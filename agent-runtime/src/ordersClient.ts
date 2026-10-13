import { buildAuthHeaders, type WalletAccount } from './authHeaders.ts'

export type OrderDbStatus = 'agreed' | 'funded'

export interface RegistryOrder {
  id: string
  negotiationId: string
  buyerAgentId: string
  sellerAgentId: string
  capability: string
  price: string
  status: OrderDbStatus
  escrowId: string | null
}

async function parseOrThrow(res: Response, action: string): Promise<any> {
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${action} failed (${res.status}): ${body}`)
  }
  return res.json()
}

export async function listOrdersForAgent(
  apiUrl: string,
  reader: WalletAccount,
  agentId: string,
  status?: OrderDbStatus
): Promise<RegistryOrder[]> {
  const query = new URLSearchParams({ agentId })
  if (status) query.set('status', status)
  const res = await fetch(`${apiUrl}/orders?${query}`, { headers: await buildAuthHeaders(reader) })
  return parseOrThrow(res, 'Listing orders')
}

/** Buyer side, once the on-chain escrow exists, remember which escrowId belongs to this order. */
export async function attachEscrowToOrder(
  apiUrl: string,
  buyerAccount: WalletAccount,
  orderId: string,
  escrowId: string
): Promise<RegistryOrder> {
  const authHeaders = await buildAuthHeaders(buyerAccount)
  const res = await fetch(`${apiUrl}/orders/${orderId}/escrow`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ escrowId }),
  })
  return parseOrThrow(res, 'Attaching escrow to order')
}
