import { API_URL } from './base'

/**
 * Device link (docs/ONBOARDING.md §4): approving an agent's key as yours. These calls name the
 * link by its code, not by chain, so they use the plain API URL.
 */

export interface DeviceLinkInfo {
  userCode: string
  agentWallet: string
  chainId: string
  role: 'buyer' | 'seller'
  label: string
  expiresAt: string
  /** The EIP-4361 message to sign; present when the lookup named the wallet that will sign. */
  message?: string
}

async function readError(res: Response, fallback: string): Promise<never> {
  let reason = fallback
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body.error === 'string') reason = body.error
  } catch {
    // keep the fallback
  }
  throw new Error(reason)
}

/** What a code stands for (and, with `address`, the message that wallet signs to approve it). */
export async function lookupDeviceLink(code: string, address?: string): Promise<DeviceLinkInfo> {
  const query = address ? `?address=${address}` : ''
  const res = await fetch(`${API_URL}/device-links/by-code/${encodeURIComponent(code)}${query}`, { cache: 'no-store' })
  if (!res.ok) return readError(res, 'No pending link with that code')
  return res.json()
}

export async function approveDeviceLink(code: string, address: string, message: string, signature: string): Promise<{ agentWallet: string }> {
  const res = await fetch(`${API_URL}/device-links/by-code/${encodeURIComponent(code)}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, message, signature }),
  })
  if (!res.ok) return readError(res, 'The approval was refused')
  return res.json()
}
