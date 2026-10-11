import type { AgentConfig } from './types.ts'
import { buildAuthHeaders, type WalletAccount } from './authHeaders.ts'
import { withChain } from './chainQuery.ts'

export interface RegistryAgent {
  id: string
  /** The chain this listing trades on (CAIP-2). */
  chainId?: string
  ownerWallet: string
  isOnline: boolean
  role?: 'buyer' | 'seller'
  name?: string
}

export interface RegisterOptions {
  apiUrl: string
  /** This agent's own account — signs proof of ownership for the registry API. */
  account: WalletAccount
  /** On-chain payout wallet to advertise for this agent (sellers only, usually). */
  walletAddress?: string
  /**
   * False for a buyer that runs its own key (the SDK, buyer-agent/): it then needs no
   * stored task brief, and may buy community capabilities. Only sent on registration.
   */
  hosted?: boolean
  /** The chain the agent trades on (CAIP-2). Default: the API's default chain. Only sent on registration. */
  chainId?: string
}

async function parseOrThrow(res: Response, action: string): Promise<any> {
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${action} failed (${res.status}): ${body}`)
  }
  return res.json()
}

/**
 * This wallet's own agent — of the given role, preferring the same name when
 * it owns several. Signed, so a buyer agent (listed only to its owner) finds itself too.
 */
export async function findOwnAgent(
  apiUrl: string,
  owner: WalletAccount,
  match: { role?: 'buyer' | 'seller'; name?: string; chainId?: string } = {}
): Promise<RegistryAgent | null> {
  const res = await fetch(withChain(`${apiUrl}/agents?ownerWallet=${owner.address}`, match.chainId), { headers: await buildAuthHeaders(owner) })
  const agents: RegistryAgent[] = (await parseOrThrow(res, 'Registry lookup')).filter(
    (a: RegistryAgent) => !match.role || !a.role || a.role === match.role
  )
  return agents.find((a) => match.name && a.name === match.name) ?? agents[0] ?? null
}

/** A seller's public profile — its negotiation limit and instructions are never shown to others. */
export interface DiscoveredAgent extends RegistryAgent {
  name: string
  role: 'buyer' | 'seller'
  capabilities: string[]
  price: string
  walletAddress: string | null
  /** ERC-8004 identity on its chain, once registered. */
  erc8004AgentId?: string | null
}

/**
 * Search Agent (§10 Discovery) — an agent asks the registry "who offers
 * this capability?" the same way a human browsing the Marketplace would,
 * just through the API directly instead of a page.
 */
export async function discoverAgents(
  apiUrl: string,
  filters: { role?: 'buyer' | 'seller'; capability?: string; q?: string; onlineOnly?: boolean; chainId?: string } = {}
): Promise<DiscoveredAgent[]> {
  const query = new URLSearchParams()
  if (filters.chainId) query.set('chain', filters.chainId)
  if (filters.role) query.set('role', filters.role)
  if (filters.capability) query.set('capability', filters.capability)
  if (filters.q) query.set('q', filters.q)
  if (filters.onlineOnly) query.set('isOnline', 'true')

  const res = await fetch(`${apiUrl}/agents${query.toString() ? `?${query}` : ''}`)
  return parseOrThrow(res, 'Discovery search')
}

/**
 * Registers this agent in the AgentEco registry on first run, or syncs its
 * config on every later run — exactly what a real Bring-Your-Own-Agent
 * developer's server would do against the public AgentEco API (§4.2).
 * Every write is signed by the agent's own account (see backend/src/auth.ts)
 * — ownerWallet is proven, not just claimed.
 */
export async function registerOrSyncSelf(config: AgentConfig, options: RegisterOptions): Promise<RegistryAgent> {
  const payload = {
    name: config.name,
    description: config.description,
    role: config.role,
    category: config.category,
    service: config.service,
    capabilities: config.capabilities,
    price: config.basePrice,
    minimumPrice: config.minimumPrice,
    maxBudget: config.maxBudget,
    customInstructions: config.customInstructions,
    taskBrief: config.taskBrief,
    acceptanceCriteria: config.acceptanceCriteria,
    walletAddress: options.walletAddress,
    isOnline: true,
  }

  const existing = await findOwnAgent(options.apiUrl, options.account, { role: config.role, name: config.name, chainId: options.chainId })
  const authHeaders = await buildAuthHeaders(options.account)

  if (existing) {
    const res = await fetch(`${options.apiUrl}/agents/${existing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(payload),
    })
    return parseOrThrow(res, 'Registry sync')
  }

  const res = await fetch(`${options.apiUrl}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({
      ...payload,
      ...(options.hosted !== undefined && { hosted: options.hosted }),
      ...(options.chainId && { chainId: options.chainId }),
    }),
  })
  return parseOrThrow(res, 'Registry registration')
}
