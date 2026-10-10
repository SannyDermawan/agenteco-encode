import { buildAuthHeaders, type WalletSigner } from './authHeaders'
import { readHeaders } from './session'
import { API_URL, chainFetch as fetch } from './base'


/** Why a listing is reported (backend/src/routes/moderation.ts). */
export const REPORT_CATEGORIES = [
  { id: 'fake_results', label: 'Fake or useless results' },
  { id: 'scam', label: 'Scam or fraud' },
  { id: 'spam', label: 'Spam or misleading listing' },
  { id: 'harmful', label: 'Harmful content' },
  { id: 'other', label: 'Other' },
] as const
export type ReportCategory = (typeof REPORT_CATEGORIES)[number]['id']

export const reportCategoryLabel = (id: string) => REPORT_CATEGORIES.find((c) => c.id === id)?.label ?? id

export interface ModerationVote {
  voter: string
  vote: string
  at: string
}
interface CaseAgent {
  id: string
  name: string
  capabilities: string[]
  ownerWallet: string
  walletAddress: string | null
  delistedAt: string | null
  delistReason: string | null
  taskStatus: string | null
}
export interface ReportCase {
  id: string
  agentId: string
  reporterWallet: string
  category: ReportCategory
  reason: string
  hadOrder: boolean
  status: 'open' | 'delisted' | 'dismissed'
  createdAt: string
  resolvedAt: string | null
  agent: CaseAgent
  votes: ModerationVote[]
  openReportsForAgent: number
}
export interface AppealCase {
  id: string
  agentId: string
  ownerWallet: string
  reason: string
  status: 'open' | 'reinstated' | 'upheld'
  createdAt: string
  resolvedAt: string | null
  agent: CaseAgent
  votes: ModerationVote[]
}
export interface ModerationQueue {
  threshold: number
  members: string[]
  reports: ReportCase[]
  appeals: AppealCase[]
}
export interface AgentModeration {
  delistedAt: string | null
  delistReason: string | null
  appeals: { id: string; reason: string; status: AppealCase['status']; createdAt: string; resolvedAt: string | null }[]
}

async function parseOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const message = typeof body?.error === 'string' ? body.error : body?.error?.formErrors?.join(', ') || Object.values(body?.error?.fieldErrors ?? {}).flat().join(', ')
    throw new Error(message || `Request failed (${res.status})`)
  }
  return res.json()
}

async function signedPost<T>(signer: WalletSigner, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await buildAuthHeaders(signer)) },
    body: JSON.stringify(body),
  })
  return parseOrThrow<T>(res)
}

export function reportAgent(signer: WalletSigner, input: { agentId: string; category: ReportCategory; reason: string }) {
  return signedPost<{ id: string; status: string; hadOrder: boolean }>(signer, '/moderation/reports', input)
}

export function appealDelisting(signer: WalletSigner, input: { agentId: string; reason: string }) {
  return signedPost<{ id: string; status: string }>(signer, '/moderation/appeals', input)
}

export function voteOnReport(signer: WalletSigner, reportId: string, vote: 'delist' | 'dismiss') {
  return signedPost<{ status: string; delist: number; dismiss: number; threshold: number }>(signer, `/moderation/reports/${reportId}/vote`, { vote })
}

export function voteOnAppeal(signer: WalletSigner, appealId: string, vote: 'reinstate' | 'uphold') {
  return signedPost<{ status: string; reinstate: number; uphold: number; threshold: number }>(signer, `/moderation/appeals/${appealId}/vote`, { vote })
}

/** The council's queue (needs a read session from a council member). */
export async function getModerationQueue(): Promise<ModerationQueue> {
  return parseOrThrow(await fetch(`${API_URL}/moderation`, { cache: 'no-store', headers: readHeaders() }))
}

/** An agent's delisting and appeals, for its owner or the council (needs a read session). */
export async function getAgentModeration(agentId: string): Promise<AgentModeration> {
  return parseOrThrow(await fetch(`${API_URL}/moderation/agents/${agentId}`, { cache: 'no-store', headers: readHeaders() }))
}
