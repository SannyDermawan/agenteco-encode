import { checkReadAccess, readHeaders } from './session'
import { API_URL, chainFetch as fetch } from './base'


export interface ApiEscrowResult {
  id: string
  escrowId: string
  capability: string
  result: Record<string, unknown>
  /** The exact text whose keccak256 is the on-chain resultHash. */
  resultJson: string | null
  resultHash: string
  createdAt: string
}

export async function getEscrowResult(escrowId: string): Promise<ApiEscrowResult | null> {
  const res = await fetch(`${API_URL}/escrow-results/${escrowId}`, { cache: 'no-store', headers: readHeaders() })
  if (res.status === 404) return null
  await checkReadAccess(res)
  if (!res.ok) throw new Error(`Failed to load escrow result (${res.status})`)
  return res.json()
}
