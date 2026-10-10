import { buildAuthHeaders, type WalletSigner } from './authHeaders'
import { checkReadAccess, readHeaders } from './session'
import { API_URL, chainFetch as fetch } from './base'


/** A stored task (backend/prisma: Task). `preimage` re-hashes to `taskHash`. */
export interface ApiTask {
  id: string
  capability: string
  brief: unknown
  criteria: string
  price: string
  buyer: string
  seller: string
  nonce: string
  preimage: string
  taskHash: `0x${string}`
  escrowId: string | null
  verified: boolean
  createdAt: string
}

async function parseOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const error = body?.error
    const message =
      typeof error === 'string'
        ? error
        : [...(error?.formErrors ?? []), ...Object.values(error?.fieldErrors ?? {}).flat()].join(', ')
    throw new Error(message || `Request failed (${res.status})`)
  }
  return res.json()
}

/**
 * Step 1 of a hire (spec §5): the API stores the brief and returns the
 * taskHash to commit in createEscrow. The signed-in wallet is the buyer.
 */
export async function createTask(
  signer: WalletSigner,
  input: { capability: string; brief: unknown; criteria?: string; price: string; seller: string }
): Promise<ApiTask> {
  const res = await fetch(`${API_URL}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await buildAuthHeaders(signer)) },
    body: JSON.stringify({ ...input, criteria: input.criteria || undefined }),
  })
  return parseOrThrow(res)
}

/** What linking returns — never the brief (the caller already has it). */
export type TaskLinkReceipt = Pick<ApiTask, 'id' | 'escrowId' | 'taskHash' | 'verified'>

/** Step 3, after funding: the API checks the escrow on-chain before linking — no signature needed. */
export async function linkTaskEscrow(taskId: string, escrowId: string): Promise<TaskLinkReceipt> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/escrow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ escrowId }),
  })
  return parseOrThrow(res)
}

export async function getTaskByEscrow(escrowId: string): Promise<ApiTask | null> {
  const res = await fetch(`${API_URL}/tasks/by-escrow/${escrowId}`, { cache: 'no-store', headers: readHeaders() })
  if (res.status === 404) return null
  await checkReadAccess(res)
  return parseOrThrow(res)
}
