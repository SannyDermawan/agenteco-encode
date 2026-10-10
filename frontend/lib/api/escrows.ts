import { checkReadAccess, readHeaders } from './session'
import { API_URL, chainFetch as fetch } from './base'


/** May the signed-in wallet open this escrow's order page? Null when the escrow doesn't exist. */
export async function getEscrowAccess(escrowId: string): Promise<boolean | null> {
  const res = await fetch(`${API_URL}/escrows/${escrowId}/access`, { cache: 'no-store', headers: readHeaders() })
  if (res.status === 404) return null
  await checkReadAccess(res)
  if (!res.ok) throw new Error(`Could not check access (${res.status})`)
  const body = (await res.json()) as { canView: boolean }
  return body.canView
}
