/**
 * Adds `chain=<id>` to an API URL. Escrow ids are numbered per chain, so every escrow-keyed
 * call names its chain; without one the API uses its default chain (older clients keep working).
 */
export function withChain(url: string, chainId?: string | null): string {
  if (!chainId) return url
  return `${url}${url.includes('?') ? '&' : '?'}chain=${encodeURIComponent(chainId)}`
}
