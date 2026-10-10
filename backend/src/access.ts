import type { Request, Response } from 'express'
import { zeroAddress, type Address } from 'viem'
import type { Prisma } from '@prisma/client'
import { READ_SESSION_HEADER } from '../../agent-runtime/src/shared/session.ts'
import { verifyOwnerAuth, type AuthResult } from './auth.ts'
import { prisma } from './db.ts'
import { canRule, type ArbiterSetup } from '../../agent-runtime/src/chain/evm.ts'
import { readChain, requestChain, servedChainIds, servedEvmChainIds, type ChainId } from './chains.ts'
import { FRONTEND_HOSTS } from './origins.ts'
import { verifyReadSession } from './session.ts'

/**
 * Who may read what. Everything behind an order — the task brief, the
 * negotiation, the result, the verification, the dispute and the rating — is
 * visible only to that order's buyer and seller (their wallets, or the owner
 * of the hosted agent acting for them) and to the arbiter of that escrow's chain.
 * Being signed in is not enough on its own.
 */

/**
 * The caller's proven wallet: a read session from the website, or the
 * per-request signature headers agents already send (see auth.ts).
 */
export async function authenticateViewer(req: Request): Promise<AuthResult | null> {
  const session = req.header(READ_SESSION_HEADER)
  if (session) return verifyReadSession(session, { domains: FRONTEND_HOSTS, chainId: servedEvmChainIds() })
  if (req.header('x-owner-wallet')) return verifyOwnerAuth(req)
  return null
}

/** The viewer's wallet (lowercase), or null for an anonymous request. A bad credential is answered with 401. */
export async function optionalViewer(req: Request, res: Response): Promise<string | null | undefined> {
  const auth = await authenticateViewer(req)
  if (!auth) return null
  if (!auth.ok) {
    res.status(401).json({ error: auth.error })
    return undefined
  }
  return auth.wallet.toLowerCase()
}

/** Like optionalViewer, but an anonymous request is answered with 401 too. Undefined = already answered. */
export async function requireViewer(req: Request, res: Response): Promise<string | undefined> {
  const viewer = await optionalViewer(req, res)
  if (viewer === null) {
    res.status(401).json({ error: 'Sign in to view this — it is only visible to the parties of the order.' })
    return undefined
  }
  return viewer
}

const arbiterSetups = new Map<string, { at: number; setup: Promise<ArbiterSetup> }>()
// The arbiter role can be handed over (and council members change by vote), so re-read now and then.
const ARBITER_TTL_MS = 60_000

/**
 * A deployment's arbiter on a chain: a wallet, or an ArbiterCouncil and its members.
 * The chain's current deployment by default. Cached for a minute.
 */
export function getArbiterSetup(chainId: ChainId, agentEco?: Address): Promise<ArbiterSetup> {
  const reader = readChain(chainId)
  const eco = agentEco ?? reader.config.agentEco
  const key = `${chainId}:${eco.toLowerCase()}`
  const cached = arbiterSetups.get(key)
  if (cached && Date.now() - cached.at <= ARBITER_TTL_MS) return cached.setup
  const setup = reader.arbiterSetupAt(eco).catch((error) => {
    arbiterSetups.delete(key) // retry on the next request
    throw error
  })
  arbiterSetups.set(key, { at: Date.now(), setup })
  return setup
}

/**
 * The arbiter wallet itself, or any member of the arbiter council: on `chainId` (of the
 * deployment holding `escrowId`, or of the current one when none is given), or on any
 * served chain when no chain is given.
 */
export async function isArbiter(viewer: string, chainId?: ChainId, escrowId?: string): Promise<boolean> {
  for (const chain of chainId ? [chainId] : servedChainIds()) {
    try {
      const eco = escrowId !== undefined && isEscrowId(escrowId) ? readChain(chain).agentEcoFor(BigInt(escrowId)) : undefined
      if (canRule(await getArbiterSetup(chain, eco), viewer)) return true
    } catch {
      // An unreadable chain grants nothing.
    }
  }
  return false
}

/** The served chains whose current arbiter (wallet or council member) this viewer is. */
export async function arbiterChains(viewer: string): Promise<ChainId[]> {
  const chains: ChainId[] = []
  for (const chain of servedChainIds()) if (await isArbiter(viewer, chain)) chains.push(chain)
  return chains
}

export interface EscrowParties {
  buyer: string
  seller: string
}

// Buyer and seller never change once an escrow exists.
const partiesCache = new Map<string, EscrowParties>()
const PARTIES_CACHE_LIMIT = 10_000

export function isEscrowId(value: string): boolean {
  return /^\d{1,30}$/.test(value)
}

/** Buyer and seller (lowercase) of an escrow on a chain, or null if it does not exist. */
export async function escrowParties(chainId: ChainId, escrowId: string): Promise<EscrowParties | null> {
  const key = `${chainId}:${escrowId}`
  const cached = partiesCache.get(key)
  if (cached) return cached

  // A linked task was checked against the chain when it was linked (routes/tasks.ts).
  const task = await prisma.task.findUnique({
    where: { chainId_escrowId: { chainId, escrowId } },
    select: { buyer: true, seller: true, verified: true },
  })
  let parties: EscrowParties
  if (task?.verified) {
    parties = { buyer: task.buyer.toLowerCase(), seller: task.seller.toLowerCase() }
  } else {
    const { buyer, seller } = await readChain(chainId).getEscrowBasic(BigInt(escrowId))
    if (buyer === zeroAddress) return null
    parties = { buyer: buyer.toLowerCase(), seller: seller.toLowerCase() }
  }
  if (partiesCache.size >= PARTIES_CACHE_LIMIT) partiesCache.clear()
  partiesCache.set(key, parties)
  return parties
}

/**
 * The viewer is the buyer or seller wallet itself, the arbiter, or the owner
 * of a hosted agent whose wallet is the buyer or seller. Only hosted agents
 * count for that last case: their wallet was generated by this server, while
 * a self-custody agent's walletAddress is just a claim. The arbiter is that chain's.
 */
export async function canViewParties(viewer: string, parties: EscrowParties, chainId: ChainId): Promise<boolean> {
  if (viewer === parties.buyer || viewer === parties.seller) return true
  if (await isArbiter(viewer, chainId)) return true
  const owned = await prisma.agent.count({
    where: {
      ownerWallet: { equals: viewer, mode: 'insensitive' },
      agentWalletKey: { not: null },
      OR: [
        { walletAddress: { equals: parties.buyer, mode: 'insensitive' } },
        { walletAddress: { equals: parties.seller, mode: 'insensitive' } },
      ],
    },
  })
  return owned > 0
}

export type EscrowAccess = 'ok' | 'not_found' | 'forbidden'

export async function checkEscrowAccess(viewer: string, chainId: ChainId, escrowId: string): Promise<EscrowAccess> {
  let parties: EscrowParties | null
  try {
    parties = await escrowParties(chainId, escrowId)
  } catch {
    return 'not_found'
  }
  if (!parties) return 'not_found'
  return (await canViewParties(viewer, parties, chainId)) ? 'ok' : 'forbidden'
}

/**
 * Answers the request itself unless the viewer may see this escrow's off-chain records.
 * The chain comes from the request (?chain=, default: the default chain). Returns the
 * viewer and the chain when access is granted.
 */
export async function guardEscrow(req: Request, res: Response, escrowId: string): Promise<{ viewer: string; chainId: ChainId } | undefined> {
  if (!isEscrowId(escrowId)) {
    res.status(400).json({ error: 'escrowId must be a number' })
    return undefined
  }
  const chainId = requestChain(req, res)
  if (!chainId) return undefined
  const viewer = await requireViewer(req, res)
  if (!viewer) return undefined
  const access = await checkEscrowAccess(viewer, chainId, escrowId)
  if (access === 'not_found') {
    res.status(404).json({ error: 'Escrow not found' })
    return undefined
  }
  if (access === 'forbidden') {
    res.status(403).json({ error: 'This order is private — only its buyer, seller and the arbiter can see it.' })
    return undefined
  }
  return { viewer, chainId }
}

interface AgentParty {
  ownerWallet: string
  walletAddress: string | null
}

/** A negotiation or order's side is the viewer's own: the agent's owner, or the agent's wallet itself. */
export function isPartyOf(viewer: string, agent: AgentParty): boolean {
  return viewer === agent.ownerWallet.toLowerCase() || (!!agent.walletAddress && viewer === agent.walletAddress.toLowerCase())
}

/** Prisma filter: negotiations or orders one of whose agents belongs to the viewer. */
export function partyFilter(viewer: string) {
  const mine = {
    OR: [
      { ownerWallet: { equals: viewer, mode: 'insensitive' as const } },
      { walletAddress: { equals: viewer, mode: 'insensitive' as const } },
    ],
  }
  return { OR: [{ buyerAgent: mine }, { sellerAgent: mine }] }
}

/** Private settings of an agent: its negotiation limit, budget, brief and instructions. */
const PRIVATE_AGENT_FIELDS = [
  'minimumPrice',
  'maxBudget',
  'depositorWallet',
  'minSuccessRate',
  'minCompletedJobs',
  'minReputation',
  'customInstructions',
  'taskBrief',
  'acceptanceCriteria',
] as const

type AgentRow = AgentParty & { taskStatus: string | null } & Record<string, unknown>

/** The owner, or a hosted agent's own wallet (the host acting for it). */
export function isAgentOwner(viewer: string | null, agent: AgentRow): boolean {
  if (!viewer) return false
  if (viewer === agent.ownerWallet.toLowerCase()) return true
  return agent.taskStatus !== null && !!agent.walletAddress && viewer === agent.walletAddress.toLowerCase()
}

/** An agent as this viewer may see it: everything for its owner, the public profile for everyone else. */
export function agentView<T extends AgentRow>(agent: T, viewer: string | null): T {
  if (isAgentOwner(viewer, agent)) return agent
  const visible: Record<string, unknown> = { ...agent }
  for (const field of PRIVATE_AGENT_FIELDS) delete visible[field]
  return visible as T
}

/** Prisma filter: sellers are public; buyer agents are listed only to their owner. */
export function visibleAgentsFilter(viewer: string | null): Prisma.AgentWhereInput {
  if (!viewer) return { role: 'seller' }
  return { OR: [{ role: 'seller' }, { ownerWallet: { equals: viewer, mode: 'insensitive' } }] }
}

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
