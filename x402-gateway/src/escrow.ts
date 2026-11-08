import type { AgentService } from './agents.ts'

/**
 * The bridge from the pay-per-call gateway to AgentEco's escrow: it does not move money and holds no key. Given what a
 * job is worth, it tells a buyer which way to pay (x402 for a small call, escrow for a bigger job) and what the steps are.
 * The buyer signs its own payment or escrow transaction.
 */

export const SOLANA_DEVNET_ID = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
export const ESCROW_PROGRAM = '3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE'
export const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
export const DEFAULT_API_URL = 'https://agenteco-multichain-production.up.railway.app'
/** A job worth less than this (in dollars) is paid per call with x402; this or more goes through escrow. */
export const DEFAULT_ESCROW_THRESHOLD_USD = 0.05

export interface EscrowSeller {
  id: string
  name: string
  price: number
  isOnline: boolean
}

export type PaymentMode = 'x402' | 'escrow'

export interface EscrowPlan {
  capability: string
  budgetUsd: number
  thresholdUsd: number
  recommendedMode: PaymentMode
  x402: { endpoint: string; price: string } | null
  escrow: {
    chain: string
    program: string
    tokenMint: string
    sellers: EscrowSeller[]
    cli: string
    sdk: string
  }
  notes: string[]
}

export const priceNumber = (price: string): number => Number(price.replace(/^\$/, ''))

/** A budget in dollars from a query string: a positive, finite number of at most a million. Anything else is null. */
export function parseBudget(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,9})?$/.test(value.trim())) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 && n <= 1_000_000 ? n : null
}

/** A capability id as the registry writes it. The strict shape keeps anything odd out of the commands the plan prints. */
export const isCapabilityId = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(value)

interface ApiAgent {
  id?: unknown
  name?: unknown
  chainId?: unknown
  role?: unknown
  capabilities?: unknown
  price?: unknown
  isOnline?: unknown
}

/** The Solana sellers of a capability that AgentEco's API lists. Never throws: an API that is down gives no sellers and a note. */
export async function listSolanaSellers(apiUrl: string, capability: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<{ sellers: EscrowSeller[]; note?: string }> {
  try {
    const res = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/agents`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
    if (!res.ok) return { sellers: [], note: `The AgentEco API answered HTTP ${res.status}, so the seller list is empty. Try again shortly.` }
    const body = (await res.json()) as unknown
    const list = Array.isArray(body) ? (body as ApiAgent[]) : []
    const sellers = list
      .filter((a) => a.role === 'seller' && typeof a.chainId === 'string' && a.chainId.startsWith('solana:') && Array.isArray(a.capabilities) && a.capabilities.includes(capability))
      .map((a) => ({ id: String(a.id), name: String(a.name), price: Number(a.price), isOnline: a.isOnline === true }))
      .filter((s) => Number.isFinite(s.price))
      .sort((x, y) => Number(y.isOnline) - Number(x.isOnline) || x.price - y.price)
      .slice(0, 10)
    return sellers.length ? { sellers } : { sellers, note: `No Solana seller lists "${capability}" right now.` }
  } catch {
    return { sellers: [], note: 'The AgentEco API did not answer, so the seller list is empty. Try again shortly.' }
  }
}

export interface PlanInput {
  capability: string
  budgetUsd: number
  agents: AgentService[]
  thresholdUsd: number
  apiUrl: string
  fetchImpl?: typeof fetch
}

export async function buildPlan(input: PlanInput): Promise<EscrowPlan> {
  const { capability, budgetUsd, agents, thresholdUsd } = input
  const agent = agents.find((a) => a.capability === capability)
  const price = agent ? priceNumber(agent.priceUsd) : null
  const notes: string[] = []

  let mode: PaymentMode = 'escrow'
  if (!agent) {
    notes.push(`The gateway does not sell "${capability}" per call, so a job for it goes through escrow with a seller from the marketplace.`)
  } else if (budgetUsd >= thresholdUsd) {
    notes.push(`A $${budgetUsd} job is at or above the $${thresholdUsd} threshold: escrow keeps the money locked until you accept the work, and you can dispute it.`)
  } else if (price !== null && budgetUsd < price) {
    notes.push(`The gateway sells "${capability}" for ${agent.priceUsd} per call, more than your $${budgetUsd} budget.`)
  } else {
    mode = 'x402'
    notes.push(`A $${budgetUsd} job is below the $${thresholdUsd} threshold and the gateway sells "${capability}" for ${agent.priceUsd}: pay per call with x402. It is instant, and nothing is charged if the agent fails. There is no refund or dispute step.`)
  }

  let sellers: EscrowSeller[] = []
  if (mode === 'escrow') {
    const found = await listSolanaSellers(input.apiUrl, capability, input.fetchImpl)
    sellers = found.sellers
    if (found.note) notes.push(found.note)
  }

  return {
    capability,
    budgetUsd,
    thresholdUsd,
    recommendedMode: mode,
    x402: agent ? { endpoint: `/v1/agents/${agent.capability}`, price: agent.priceUsd } : null,
    escrow: {
      chain: SOLANA_DEVNET_ID,
      program: ESCROW_PROGRAM,
      tokenMint: DEVNET_USDC,
      sellers,
      cli: `agenteco hire --capability ${capability} --brief '<json>' --max-budget ${budgetUsd} --chain solana-devnet`,
      sdk: `hire({ chain: 'solana-devnet', capability: '${capability}', brief, maxBudget: ${budgetUsd}, review })`,
    },
    notes,
  }
}
