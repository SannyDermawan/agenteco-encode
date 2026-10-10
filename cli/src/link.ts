import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { agentProofMessage } from '../../agent-runtime/src/shared/deviceLink.ts'
import { readJson, writeJsonAtomic } from './home.ts'

/** The CLI's own record of where onboarding stands (`~/.agenteco/state.json`). Holds the device secret, so it is private. */
export interface State {
  version: 1
  /** A device link in progress or done. */
  link?: {
    id: string
    deviceSecret: string
    userCode: string
    verifyUrl: string
    expiresAt: string
    chainId: string
    role: 'buyer' | 'seller'
    label: string
    status: 'pending' | 'approved' | 'expired' | 'denied'
    ownerWallet?: string
  }
}

const statePath = (home: string) => join(home, 'state.json')

export function loadState(home: string): State {
  return readJson<State>(statePath(home)) ?? { version: 1 }
}

export function saveState(home: string, state: State): void {
  writeJsonAtomic(statePath(home), state, true)
}

async function readError(res: Response): Promise<string> {
  const text = await res.text()
  try {
    const body = JSON.parse(text) as { error?: unknown }
    if (typeof body.error === 'string') return body.error
    if (body.error) return JSON.stringify(body.error)
  } catch {
    // not JSON
  }
  return text.slice(0, 200) || `HTTP ${res.status}`
}

export type LinkRecord = NonNullable<State['link']>

/** Asks the API for a code. The agent signs with its own key; only the signature and a random device secret leave. */
export async function startDeviceLink(p: { apiUrl: string; privateKey: Hex; chainId: string; role: 'buyer' | 'seller'; label: string }): Promise<LinkRecord> {
  const account = privateKeyToAccount(p.privateKey)
  const nonce = randomBytes(12).toString('base64url')
  const deviceSecret = randomBytes(32).toString('base64url')
  const signature = await account.signMessage({ message: agentProofMessage(nonce, p.chainId, account.address) })
  const res = await fetch(`${p.apiUrl}/device-links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentWallet: account.address, chainId: p.chainId, role: p.role, label: p.label, nonce, signature, deviceSecret }),
  })
  if (res.status === 404) throw new Error(`${p.apiUrl} does not support account links yet (no /device-links). Point AGENTECO_API_URL at a multi-chain AgentEco API, or run init with --skip-link.`)
  if (!res.ok) throw new Error(`The API refused the link request: ${await readError(res)}`)
  const body = (await res.json()) as { id: string; userCode: string; verifyUrl: string; expiresAt: string }
  return { id: body.id, deviceSecret, userCode: body.userCode, verifyUrl: body.verifyUrl, expiresAt: body.expiresAt, chainId: p.chainId, role: p.role, label: p.label, status: 'pending' }
}

/** One poll of a link. */
export async function pollDeviceLink(apiUrl: string, link: LinkRecord): Promise<{ status: LinkRecord['status']; ownerWallet?: string }> {
  const res = await fetch(`${apiUrl}/device-links/${link.id}`, { headers: { 'x-device-secret': link.deviceSecret } })
  if (res.status === 404) return { status: 'expired' } // replaced, or gone: ask again
  if (!res.ok) throw new Error(`Polling the link failed: ${await readError(res)}`)
  return (await res.json()) as { status: LinkRecord['status']; ownerWallet?: string }
}
