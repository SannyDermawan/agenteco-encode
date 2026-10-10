import { CHAIN_KEY } from '@/lib/web3/network'

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

/** Adds the selected network (`chain=<CAIP-2 id>`) to an AgentEco API URL; other URLs are left alone. */
export function withChain(url: string): string {
  if (!url.startsWith(API_URL) || /[?&]chain=/.test(url)) return url
  return `${url}${url.includes('?') ? '&' : '?'}chain=${encodeURIComponent(CHAIN_KEY)}`
}

/**
 * fetch for the AgentEco API: every call names the selected network, so escrow ids (numbered
 * per chain), listings, orders and disputes are always that network's. The api/* modules
 * import it as `fetch`.
 */
export function chainFetch(input: string, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(withChain(input), init)
}
