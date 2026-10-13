import { checkReadAccess, readHeaders } from './session'
import { API_URL, chainFetch as fetch } from './base'


/** A hosted buyer's AI verification of a delivered result (backend Verification). */
export interface ApiVerification {
  escrowId: string
  /** Null when no model answered, accepted unscored and not rated. */
  score: number | null
  verdict: 'accept' | 'dispute'
  rationale: string
  /** "none" (no model), "rule" (result never published), or the provider name. */
  provider: string
  model: string | null
  createdAt: string
}

export interface ApiRating {
  escrowId: string
  seller: string
  buyer: string
  score: number
  source: 'ai' | 'user'
  sameOwner: boolean
  txHash: string | null
}

/** Displayed rating per seller: same-owner ratings excluded (spec §10.3). */
export interface ApiRatingSummary {
  seller: string
  count: number
  avgScore: number | null
  excluded: number
}

async function getOrNull<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API_URL}${path}`, { cache: 'no-store', headers: readHeaders() })
  if (res.status === 404) return null
  await checkReadAccess(res)
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return res.json()
}

export const getVerification = (escrowId: string) => getOrNull<ApiVerification>(`/verifications/${escrowId}`)
export const getEscrowRating = (escrowId: string) => getOrNull<ApiRating>(`/ratings/escrow/${escrowId}`)

export async function getRatingSummaries(sellers: string[]): Promise<ApiRatingSummary[]> {
  if (sellers.length === 0) return []
  const res = await fetch(`${API_URL}/ratings?sellers=${sellers.join(',')}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return res.json()
}

/** Tells the API about a mined rateSeller tx; it reads the score from the receipt. */
export async function reportRating(txHash: string): Promise<void> {
  const res = await fetch(`${API_URL}/ratings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Request failed (${res.status})`)
}
