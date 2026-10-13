import { useQuery } from '@tanstack/react-query'
import type { CapabilityInfo, RegisterCapabilityInput } from '@shared/capabilities/custom'
import { buildAuthHeaders, type WalletSigner } from './authHeaders'
import { API_URL, chainFetch as fetch } from './base'


export type { CapabilityInfo, RegisterCapabilityInput }

async function parseOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(typeof body?.error === 'string' ? body.error : `Request failed (${res.status})`)
  }
  return res.json()
}

export type CapabilitySort = 'top' | 'new'

/** Every capability in the open registry with its marketplace statistics: best-ranked first ('top') or newest first ('new'). */
export async function listCapabilities(sort: CapabilitySort = 'top'): Promise<CapabilityInfo[]> {
  return parseOrThrow(await fetch(`${API_URL}/capabilities?sort=${sort}`))
}

/** Publishes a community capability, signed by the developer's wallet. Immutable once published. */
export async function registerCapability(signer: WalletSigner, input: RegisterCapabilityInput): Promise<CapabilityInfo> {
  const res = await fetch(`${API_URL}/capabilities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await buildAuthHeaders(signer)) },
    body: JSON.stringify(input),
  })
  return parseOrThrow(res)
}

/** The registry, cached for the session, published capabilities never change. */
export function useCapabilities(sort: CapabilitySort = 'top') {
  return useQuery({ queryKey: ['capabilities', sort], queryFn: () => listCapabilities(sort), staleTime: 60_000 })
}
