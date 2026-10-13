import type { Hex } from 'viem'
import { buildAuthHeaders, type WalletAccount } from './authHeaders.ts'
import { withChain } from './chainQuery.ts'
import type { ChainAdapter } from './chain/types.ts'
import { createAndFundEscrow } from './onchain/escrow.ts'
import type { OnchainClients } from './onchain/clients.ts'

/** A stored task (backend/prisma: Task). `preimage` re-hashes to `taskHash`. */
export interface RegistryTask {
  id: string
  /** The chain its escrow lives on (CAIP-2). */
  chainId?: string
  capability: string
  brief: unknown
  criteria: string
  price: string
  buyer: string
  seller: string
  nonce: string
  preimage: string
  taskHash: Hex
  escrowId: string | null
  verified: boolean
}

async function parseOrThrow<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) throw new Error(`${action} failed (${res.status}): ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function createTask(
  apiUrl: string,
  buyer: WalletAccount,
  input: { capability: string; brief: unknown; criteria?: string | null; price: string | number; seller: string; chainId?: string }
): Promise<RegistryTask> {
  const res = await fetch(`${apiUrl}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await buildAuthHeaders(buyer)) },
    body: JSON.stringify({ ...input, criteria: input.criteria ?? undefined }),
  })
  return parseOrThrow(res, 'Creating task')
}

/** What linking returns, never the brief (the caller already has it). */
export type TaskLinkReceipt = Pick<RegistryTask, 'id' | 'chainId' | 'escrowId' | 'taskHash' | 'verified'>

export async function linkTaskEscrow(apiUrl: string, buyer: WalletAccount, taskId: string, escrowId: string): Promise<TaskLinkReceipt> {
  const res = await fetch(`${apiUrl}/tasks/${taskId}/escrow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await buildAuthHeaders(buyer)) },
    body: JSON.stringify({ escrowId }),
  })
  return parseOrThrow(res, 'Linking task to escrow')
}

/**
 * The task behind an escrow, or null when none was linked. Private to the
 * escrow's buyer, seller and arbiter, so the reader signs the request.
 */
export async function getTaskByEscrow(apiUrl: string, escrowId: string, reader: WalletAccount, chainId?: string): Promise<RegistryTask | null> {
  const res = await fetch(withChain(`${apiUrl}/tasks/by-escrow/${escrowId}`, chainId), { headers: await buildAuthHeaders(reader) })
  if (res.status === 404) return null
  return parseOrThrow(res, 'Reading task')
}

/**
 * A buyer agent's whole hire, in the order spec §5 requires: store the task
 * (the API returns its taskHash) → createEscrow with that hash + fund → link
 * the escrow to the task (the API checks the chain agrees). With `chain`, the
 * escrow is created on that chain (the adapter signs as `clients.account`);
 * without it, on the process's primary chain.
 */
export async function hireWithTask(
  apiUrl: string,
  clients: { account: WalletAccount } & Partial<Omit<OnchainClients, 'account'>>,
  input: { capability: string; brief: unknown; criteria?: string | null; price: string; seller: string },
  chain?: ChainAdapter
): Promise<{ escrowId: bigint; task: RegistryTask }> {
  const task = await createTask(apiUrl, clients.account, chain ? { ...input, chainId: chain.chainId } : input)
  const escrowId = chain
    ? await chain.createAndFundEscrow({ seller: input.seller, amount: input.price, taskHash: task.taskHash })
    : await createAndFundEscrow(clients as OnchainClients, input.seller as `0x${string}`, input.price, task.taskHash)
  const linked = await linkTaskEscrow(apiUrl, clients.account, task.id, escrowId.toString())
  return { escrowId, task: { ...task, ...linked } }
}
