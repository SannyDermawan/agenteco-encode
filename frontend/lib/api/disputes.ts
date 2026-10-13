import { buildAuthHeaders, type WalletSigner } from './authHeaders'
import { checkReadAccess, readHeaders } from './session'
import { API_URL, chainFetch as fetch } from './base'


/** A dispute's off-chain record (backend Dispute). Each text re-hashes to its on-chain hash. */
export interface ApiDispute {
  id: string
  escrowId: string
  buyerWallet: string
  /** Empty when only the on-chain hash is known (the buyer's save failed). */
  reason: string
  reasonHash: string
  sellerResponse: string | null
  responseHash: string | null
  responseSource: 'ai' | 'manual' | 'api' | null
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
  createdAt: string
  updatedAt: string
}

/** @deprecated use ApiDispute */
export type ApiDisputeReason = ApiDispute

async function parseOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || `Request failed (${res.status})`)
  }
  return res.json()
}

export async function getDisputeReason(escrowId: string): Promise<ApiDispute | null> {
  const res = await fetch(`${API_URL}/disputes/${escrowId}`, { cache: 'no-store', headers: readHeaders() })
  if (res.status === 404) return null
  await checkReadAccess(res)
  return parseOrThrow(res)
}

export async function listDisputeReasons(): Promise<ApiDispute[]> {
  const res = await fetch(`${API_URL}/disputes`, { cache: 'no-store', headers: readHeaders() })
  await checkReadAccess(res)
  return parseOrThrow(res)
}

/** The buyer's side of the story for the arbiter, signed, since only the escrow's buyer may write it. */
export async function submitDisputeReason(signer: WalletSigner, escrowId: string, reason: string): Promise<ApiDispute> {
  const authHeaders = await buildAuthHeaders(signer)
  const res = await fetch(`${API_URL}/disputes/${escrowId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ reason }),
  })
  return parseOrThrow(res)
}

/**
 * The arbiter's ruling text, after resolveDisputeFor*(id, rationaleHash) is
 * mined. No signature: the API accepts it only if it hashes to the on-chain
 * resolutionHash.
 */
export async function submitDisputeResolution(
  escrowId: string,
  rationale: { verdict: 'seller' | 'buyer'; confidence: number; rationale: string; decidedBy: 'ai-auto' | 'arbiter-manual' },
  txHash?: string
): Promise<ApiDispute> {
  const res = await fetch(`${API_URL}/disputes/${escrowId}/resolution`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...rationale, ...(txHash && { txHash }) }),
  })
  return parseOrThrow(res)
}

// The on-chain reasonHash commits to the exact text, so a retry after a failed
// save must resend the very same string. It's kept in this browser until saved.
const pendingKey = (escrowId: string) => `agenteco:dispute-reason:${escrowId}`

export function rememberPendingReason(escrowId: string, reason: string): void {
  try {
    localStorage.setItem(pendingKey(escrowId), reason)
  } catch {}
}

export function readPendingReason(escrowId: string): string {
  try {
    return localStorage.getItem(pendingKey(escrowId)) ?? ''
  } catch {
    return ''
  }
}

export function forgetPendingReason(escrowId: string): void {
  try {
    localStorage.removeItem(pendingKey(escrowId))
  } catch {}
}
