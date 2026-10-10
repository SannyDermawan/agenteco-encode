/** The public AgentEco API on BSC Testnet — used when AGENTECO_API_URL is not set. */
export const PUBLIC_API_URL = 'https://api-production-826a.up.railway.app'

export const DEFAULT_API_URL = process.env.AGENTECO_API_URL?.trim() || PUBLIC_API_URL

export type Logger = (message: string) => void

export function consoleLogger(name: string): Logger {
  return (message) => console.log(`[${name}] ${message}`)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A chain's ERC-8004 registries as the AgentEco API serves them (GET /chains), or null. */
export async function apiErc8004Registries(apiUrl: string, chainId: string): Promise<{ identity: `0x${string}`; reputation: `0x${string}` } | null> {
  try {
    const res = await fetch(`${apiUrl}/chains`)
    if (!res.ok) return null
    const chains = (await res.json()) as { chainId: string; erc8004?: { identity: `0x${string}`; reputation: `0x${string}` } | null }[]
    return chains.find((c) => c.chainId === chainId)?.erc8004 ?? null
  } catch {
    return null // an older API without /chains: no ERC-8004
  }
}
