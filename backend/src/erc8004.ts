import type { EvmAdapter } from '../../agent-runtime/src/chain/evm.ts'
import { buildRegistrationFile, dealFeedback, type RegistrationFile } from '../../agent-runtime/src/shared/erc8004.ts'
import { chainConfig } from './chains.ts'
import { prisma } from './db.ts'
import { log, logError } from './log.ts'

/**
 * ERC-8004 on the backend side (see agent-runtime/src/shared/erc8004.ts):
 * - every listing has a registration file at /agents/:id/registration.json — the URI its
 *   identity points at;
 * - hosted sellers register their own identity on chains with registries (the host signs
 *   with the agent wallet, which then owns the identity);
 * - after a deal is rated, the buyer's wallet gives the matching ERC-8004 feedback.
 * The public URL of this API (PUBLIC_API_URL) is needed for the URI; without it nothing is
 * registered.
 */

/** This API's public base URL (no trailing slash), or null when not configured. */
export function publicApiUrl(): string | null {
  const raw = process.env.PUBLIC_API_URL?.trim().replace(/\/+$/, '')
  return raw && /^https?:\/\//i.test(raw) ? raw : null
}

/** The URI an agent's ERC-8004 identity points at, or null without PUBLIC_API_URL. */
export function registrationUrl(agentId: string): string | null {
  const base = publicApiUrl()
  return base ? `${base}/agents/${agentId}/registration.json` : null
}

interface ListingRow {
  id: string
  chainId: string
  name: string
  description: string
  capabilities: string[]
  endpoint: string | null
  isOnline: boolean
  delistedAt: Date | null
  deletedAt: Date | null
  erc8004AgentId: string | null
}

export function registrationFileFor(agent: ListingRow, requestBaseUrl: string): RegistrationFile {
  const base = publicApiUrl() ?? requestBaseUrl
  const config = chainConfig(agent.chainId)
  return buildRegistrationFile({
    name: agent.name,
    description: agent.description,
    capabilities: agent.capabilities,
    agentUrl: `${base}/agents/${agent.id}`,
    endpoint: agent.endpoint,
    active: agent.isOnline && !agent.delistedAt && !agent.deletedAt,
    registration:
      agent.erc8004AgentId && config.erc8004
        ? { agentId: agent.erc8004AgentId, evmChainId: config.chain.id, identityRegistry: config.erc8004.identity }
        : null,
  })
}

/** Hosted sellers whose registration failed, with when to try again (in memory). */
const retryAt = new Map<string, number>()
const RETRY_MS = 10 * 60_000

/**
 * A hosted agent registers its ERC-8004 identity once, on chains that have the registries.
 * `chain` signs as the agent's own wallet. Never throws: a failure is retried later.
 */
export async function registerHostedIdentity(chain: EvmAdapter, agent: { id: string; name: string; erc8004AgentId: string | null }): Promise<void> {
  if (agent.erc8004AgentId || !chain.config.erc8004) return
  const uri = registrationUrl(agent.id)
  if (!uri) return
  if (Date.now() < (retryAt.get(agent.id) ?? 0)) return
  try {
    const { agentId, txHash } = await chain.erc8004Register(uri)
    await prisma.agent.update({ where: { id: agent.id }, data: { erc8004AgentId: agentId.toString() } })
    log(`[erc8004] "${agent.name}" registered as agent #${agentId} on ${chain.chainId} (tx ${txHash}).`)
  } catch (error) {
    retryAt.set(agent.id, Date.now() + RETRY_MS)
    logError(`[erc8004] "${agent.name}": registration on ${chain.chainId} failed — retrying later`, error, 'HOST')
  }
}

/**
 * After the buyer rated escrow `escrowId`, the same rating as ERC-8004 feedback from the
 * buyer's wallet (`chain` signs as the buyer), when the seller has an identity on that chain
 * and the two are not the same owner. Records the transaction on the rating. Never throws.
 */
export async function giveDealFeedback(chain: EvmAdapter, params: { escrowId: bigint; score: number; capability: string; seller: string }): Promise<string | null> {
  if (!chain.config.erc8004) return null
  const escrowId = params.escrowId.toString()
  try {
    const [seller, rating] = await Promise.all([
      prisma.agent.findFirst({
        where: { chainId: chain.chainId, role: 'seller', walletAddress: { equals: params.seller, mode: 'insensitive' }, erc8004AgentId: { not: null } },
        select: { erc8004AgentId: true },
      }),
      prisma.rating.findUnique({ where: { chainId_escrowId: { chainId: chain.chainId, escrowId } } }),
    ])
    // No identity to review, or a rating between two agents of one owner (never published).
    if (!seller?.erc8004AgentId || rating?.sameOwner || rating?.erc8004FeedbackTx) return null
    const tx = await chain.erc8004GiveFeedback(
      BigInt(seller.erc8004AgentId),
      dealFeedback({ score: params.score, capability: params.capability, chainId: chain.chainId, escrowId: params.escrowId })
    )
    if (rating) await prisma.rating.update({ where: { id: rating.id }, data: { erc8004FeedbackTx: tx } })
    return tx
  } catch (error) {
    logError(`[erc8004] escrow #${escrowId} on ${chain.chainId}: feedback not given`, error, 'HOST')
    return null
  }
}
