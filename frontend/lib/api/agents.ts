import type { AgentSummary } from '@/lib/agenteco-data'
import { buildAuthHeaders, type WalletSigner } from './authHeaders'
import { dropReadSession, readHeaders } from './session'
import { API_URL, chainFetch as fetch } from './base'


export type ApiAgentRole = 'buyer' | 'seller'

export type HostedTaskStatus = 'awaiting_deposit' | 'active' | 'completed' | 'refunded'

export interface ApiAgent {
  id: string
  name: string
  description: string
  role: ApiAgentRole
  category: string | null
  service: string | null
  capabilities: string[]
  price: string
  minimumPrice: string | null
  maxBudget: string | null
  walletAddress: string | null
  endpoint: string | null
  inputSchema: unknown
  outputSchema: unknown
  isOnline: boolean
  ownerWallet: string
  createdAt: string
  updatedAt: string
  // Hosted agent fields, only set for an agent AgentEco runs on the
  // owner's behalf (a buyer task, or a hosted seller). Null for self-custody
  // demo agents.
  taskStatus: HostedTaskStatus | null
  depositorWallet: string | null
  minSuccessRate: number | null
  minCompletedJobs: number | null
  /** Minimum average rating 0–100 (stars × 20), see create-agent. */
  minReputation: number | null
  /** Seller: style guide for its model. */
  customInstructions: string | null
  /** Hosted buyer: what it buys, and what a good result must satisfy. */
  taskBrief: unknown
  acceptanceCriteria: string | null
  /** Self-hosted: the last heartbeat from the agent's own process. */
  lastSeenAt: string | null
  /** Set when the arbiter council delisted it after a report. */
  delistedAt: string | null
  delistReason: string | null
}

export interface CreateAgentInput {
  name: string
  // Optional, a buyer agent doesn't offer a capability, so it has neither.
  description?: string
  role: ApiAgentRole
  category?: string
  service?: string
  capabilities?: string[]
  price: number
  minimumPrice?: number
  maxBudget?: number
  walletAddress?: string
  // Seller only: AgentEco generates and runs this agent's wallet (buyers always are).
  hosted?: boolean
  endpoint?: string
  inputSchema?: unknown
  outputSchema?: unknown
  isOnline?: boolean
  // Hosted buyer task seller-selection filters, omit all three for
  // "Recommended" (cheapest qualifying seller, no reputation filtering).
  minSuccessRate?: number
  minCompletedJobs?: number
  /** Minimum average rating 0–100: the UI asks for stars and sends stars × 20. */
  minReputation?: number
  customInstructions?: string
  taskBrief?: unknown
  acceptanceCriteria?: string
}

export type UpdateAgentInput = Partial<CreateAgentInput>

async function parseOrThrow(res: Response) {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error?.formErrors?.join(', ') || body?.error || `Request failed (${res.status})`)
  }
  return res.json()
}

export async function listAgents(params?: {
  role?: ApiAgentRole
  isOnline?: boolean
  ownerWallet?: string
  capability?: string
  q?: string
}): Promise<ApiAgent[]> {
  const query = new URLSearchParams()
  if (params?.role) query.set('role', params.role)
  if (params?.isOnline !== undefined) query.set('isOnline', String(params.isOnline))
  if (params?.ownerWallet) query.set('ownerWallet', params.ownerWallet)
  if (params?.capability) query.set('capability', params.capability)
  if (params?.q) query.set('q', params.q)
  // Signed in: the wallet's own agents come back in full (buyers included); otherwise public profiles.
  return parseOrThrow(await fetchWithSession(`${API_URL}/agents${query.toString() ? `?${query}` : ''}`))
}

export async function getAgent(id: string): Promise<ApiAgent | null> {
  const res = await fetchWithSession(`${API_URL}/agents/${id}`)
  if (res.status === 404) return null
  return parseOrThrow(res)
}

/**
 * Agent profiles are public, so a session the API refuses (expired, or
 * signed on another domain) is dropped, the sign-in prompt comes back where
 * one is needed, and the read is retried anonymously.
 */
async function fetchWithSession(url: string): Promise<Response> {
  const headers = readHeaders()
  const res = await fetch(url, { cache: 'no-store', headers })
  if (res.status !== 401 || Object.keys(headers).length === 0) return res
  dropReadSession()
  return fetch(url, { cache: 'no-store' })
}

/**
 * A freshly registered real agent has no on-chain history yet, so
 * completedJobs/successRate/reputation are genuinely 0, not a stand-in for
 * missing data. On-chain reputation lookup (once orders actually settle)
 * happens separately via `useReputation(agent.walletAddress)`.
 */
export function toAgentSummary(agent: ApiAgent): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    category: agent.category ?? undefined,
    service: agent.service ?? agent.capabilities[0] ?? 'Agent Service',
    description: agent.description,
    capabilities: agent.capabilities,
    price: Number(agent.price),
    status: agent.isOnline ? 'online' : 'offline',
    completedJobs: 0,
    successRate: 0,
    reputation: 0,
    walletAddress: agent.walletAddress as `0x${string}` | undefined,
    // Only agents AgentEco holds a wallet key for have a hosted task status.
    hosted: agent.taskStatus !== null,
    createdAt: agent.createdAt,
    lastSeenAt: agent.lastSeenAt ?? null,
    delisted: !!agent.delistedAt,
  }
}

export async function createAgent(signer: WalletSigner, input: CreateAgentInput): Promise<ApiAgent> {
  const authHeaders = await buildAuthHeaders(signer)
  const res = await fetch(`${API_URL}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(input),
  })
  return parseOrThrow(res)
}

export async function updateAgent(id: string, signer: WalletSigner, patch: UpdateAgentInput): Promise<ApiAgent> {
  const authHeaders = await buildAuthHeaders(signer)
  const res = await fetch(`${API_URL}/agents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(patch),
  })
  return parseOrThrow(res)
}

/**
 * Soft-deletes an agent. The backend refuses (409) while it's mid-deal, and
 * for a hosted agent first returns its wallet's USDT + BOT to the funder.
 */
export async function deleteAgent(id: string, signer: WalletSigner): Promise<void> {
  const authHeaders = await buildAuthHeaders(signer)
  const res = await fetch(`${API_URL}/agents/${id}`, { method: 'DELETE', headers: authHeaders })
  if (!res.ok) await parseOrThrow(res)
}

/**
 * Confirms a hosted buyer task's deposit has arrived on-chain and flips it
 * from `awaiting_deposit` to `active` (the host runtime then takes over).
 */
export async function activateAgent(id: string, signer: WalletSigner): Promise<ApiAgent> {
  const authHeaders = await buildAuthHeaders(signer)
  const res = await fetch(`${API_URL}/agents/${id}/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
  })
  return parseOrThrow(res)
}
