import { buildAuthHeaders, type WalletAccount } from './authHeaders.ts'
import { withChain } from './chainQuery.ts'

/** A dispute's off-chain record (backend/prisma: Dispute). Every text re-hashes to its on-chain hash. */
export interface RegistryDispute {
  id: string
  escrowId: string
  buyerWallet: string
  reason: string
  reasonHash: string
  sellerResponse: string | null
  responseHash: string | null
  responseSource: string | null
  respondedAt: string | null
  recVerdict: 'seller' | 'buyer' | null
  recConfidence: number | null
  recRationale: string | null
  recProvider: string | null
  recModel: string | null
  recommendedAt: string | null
  recUnavailable: boolean
  overrideDeadline: string | null
  resolution: 'ai-auto' | 'arbiter-manual' | 'timeout' | null
  releasedToSeller: boolean | null
  rationalePreimage: string | null
  rationaleHash: string | null
  resolutionTx: string | null
  resolvedAt: string | null
}

async function parseOrThrow<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) throw new Error(`${action} failed (${res.status}): ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function getDispute(apiUrl: string, escrowId: string, reader: WalletAccount, chainId?: string): Promise<RegistryDispute | null> {
  const res = await fetch(withChain(`${apiUrl}/disputes/${escrowId}`, chainId), { headers: await buildAuthHeaders(reader) })
  if (res.status === 404) return null
  return parseOrThrow(res, 'Reading dispute')
}

/** Buyer: the reason text behind raiseDispute's reasonHash, must be the exact hashed string. */
export async function submitDisputeReason(apiUrl: string, buyer: WalletAccount, escrowId: string, reason: string, chainId?: string): Promise<RegistryDispute> {
  const res = await fetch(withChain(`${apiUrl}/disputes/${escrowId}`, chainId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(await buildAuthHeaders(buyer)) },
    body: JSON.stringify({ reason }),
  })
  return parseOrThrow(res, 'Saving dispute reason')
}

/** Seller: the response text behind submitDisputeResponse's responseHash. */
export async function submitDisputeResponseText(
  apiUrl: string,
  seller: WalletAccount,
  escrowId: string,
  response: string,
  source: 'ai' | 'manual' | 'api',
  chainId?: string
): Promise<RegistryDispute> {
  const res = await fetch(withChain(`${apiUrl}/disputes/${escrowId}/response`, chainId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await buildAuthHeaders(seller)) },
    body: JSON.stringify({ response, source }),
  })
  return parseOrThrow(res, 'Saving dispute response')
}
