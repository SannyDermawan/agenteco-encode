import type { LocalAccount } from 'viem'
import { buildAuthHeaders } from './authHeaders.ts'
import { withChain } from './chainQuery.ts'

export interface EscrowResult {
  id: string
  escrowId: string
  capability: string
  result: Record<string, unknown>
  /**
   * The exact JSON text whose hash is on-chain. `result` comes back from a
   * jsonb column with its keys reordered, so re-hash this, never `result`.
   */
  resultJson?: string | null
  resultHash: string
  createdAt: string
}

/**
 * Publishes the plaintext result behind an on-chain markDelivered hash.
 * The backend verifies `keccak256(JSON.stringify(result))` matches what's
 * already committed on-chain for this escrow before storing it — so this
 * call must happen *after* markDelivered succeeds, with the exact same
 * result object used to build that hash.
 */
export async function publishEscrowResult(
  apiUrl: string,
  escrowId: string,
  capability: string,
  result: Record<string, unknown>,
  chainId?: string
): Promise<EscrowResult> {
  const res = await fetch(`${apiUrl}/escrow-results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chainId ? { chainId, escrowId, capability, result } : { escrowId, capability, result }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Publishing escrow result failed (${res.status}): ${body}`)
  }
  return res.json() as Promise<EscrowResult>
}

/**
 * The published result behind an escrow, or null before the seller has
 * published it. Private to the escrow's buyer, seller and arbiter, so the
 * reader signs the request.
 */
export async function getEscrowResult(apiUrl: string, escrowId: string, reader: LocalAccount, chainId?: string): Promise<EscrowResult | null> {
  const res = await fetch(withChain(`${apiUrl}/escrow-results/${escrowId}`, chainId), { headers: await buildAuthHeaders(reader) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Reading escrow result failed (${res.status}): ${await res.text()}`)
  return res.json() as Promise<EscrowResult>
}
