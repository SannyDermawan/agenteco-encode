/**
 * The x402 gateway (x402-gateway/): small jobs are paid per call, bigger ones go through escrow. This file talks to the
 * gateway's free endpoints. Paying is in ./pay.ts.
 */

/** Public address of the gateway. Set NEXT_PUBLIC_X402_GATEWAY_URL to use another one. */
export const GATEWAY_URL = (process.env.NEXT_PUBLIC_X402_GATEWAY_URL || 'https://agenteco-encode-production.up.railway.app').replace(/\/+$/, '')

export type PaymentMode = 'x402' | 'escrow'

export interface GatewayAgent {
  capability: string
  description: string
  /** Dollars, for example "$0.005". */
  price: string
  endpoint: string
}

export interface GatewayPricing {
  network: string
  payTo: string
  agents: GatewayAgent[]
  escrow: { chain: string; program: string; thresholdUsd: number; plan: string }
}

export interface EscrowSeller {
  id: string
  name: string
  price: number
  isOnline: boolean
}

export interface RoutePlan {
  capability: string
  budgetUsd: number
  thresholdUsd: number
  recommendedMode: PaymentMode
  x402: { endpoint: string; price: string } | null
  escrow: { chain: string; program: string; tokenMint: string; sellers: EscrowSeller[]; cli: string; sdk: string }
  notes: string[]
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}${path}`, { signal, headers: { accept: 'application/json' } })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string; error?: string } | null
    throw new Error(body?.detail ?? body?.error ?? `The gateway answered HTTP ${res.status}.`)
  }
  return (await res.json()) as T
}

export const fetchPricing = (signal?: AbortSignal) => getJson<GatewayPricing>('/v1/pricing', signal)

export const fetchPlan = (capability: string, budgetUsd: number, signal?: AbortSignal) =>
  getJson<RoutePlan>(`/v1/escrow/plan?capability=${encodeURIComponent(capability)}&budgetUsd=${encodeURIComponent(String(budgetUsd))}`, signal)

/** A budget typed by a person: a positive number of dollars, or null while it is not one. */
export function parseBudgetInput(text: string): number | null {
  const t = text.trim().replace(/^\$/, '')
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null
  const n = Number(t)
  return n > 0 && n <= 1_000_000 ? n : null
}

export interface Receipt {
  success: boolean
  transaction: string
  network?: string
  payer?: string
}

/** The settlement receipt in a PAYMENT-RESPONSE header (base64 JSON), or null when there is none or it cannot be read. */
export function decodeReceipt(header: string | null): Receipt | null {
  if (!header) return null
  try {
    const parsed = JSON.parse(atob(header)) as Partial<Receipt>
    return typeof parsed.transaction === 'string' ? { success: parsed.success === true, transaction: parsed.transaction, network: parsed.network, payer: parsed.payer } : null
  } catch {
    return null
  }
}
