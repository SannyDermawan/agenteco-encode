import type { RatingEvent } from '../../agent-runtime/src/chain/types.ts'
import { chainFamily, readAdapter, readChain, type ChainId } from './chains.ts'
import { prisma } from './db.ts'
import { log } from './log.ts'
import { normalizeWallet } from '../../agent-runtime/src/shared/wallets.ts'

/**
 * Ratings index (spec §10.3). The contract keeps only ratingSum/ratingCount
 * per seller; the per-escrow score lives in the SellerRated event. Each one
 * is stored with its chain, where it came from (a hosted agent's AI
 * verification, or a human) and whether buyer and seller belong to the same
 * owner — those are left out of the displayed average and out of seller
 * selection, so nobody can pump their own seller.
 */

/** The owner behind an address on a chain: the agent it belongs to, or the address itself (a human wallet). */
async function ownerOf(chainId: ChainId, address: string): Promise<{ owner: string; hostedAgent: boolean }> {
  const agent = await prisma.agent.findFirst({ where: { chainId, walletAddress: { equals: address, mode: 'insensitive' } } })
  if (!agent) return { owner: normalizeWallet(address), hostedAgent: false }
  // Agents linked to one person are one owner, whatever keys they sign with.
  return { owner: normalizeWallet(agent.accountWallet ?? agent.ownerWallet), hostedAgent: agent.taskStatus !== null }
}

async function saveRating(chainId: ChainId, event: RatingEvent): Promise<void> {
  const [buyer, seller] = await Promise.all([ownerOf(chainId, event.buyer), ownerOf(chainId, event.seller)])
  const data = {
    seller: normalizeWallet(event.seller),
    buyer: normalizeWallet(event.buyer),
    score: Number(event.score),
    source: buyer.hostedAgent ? 'ai' : 'user',
    sameOwner: buyer.owner === seller.owner,
    txHash: event.txHash,
  }
  const escrowId = event.escrowId.toString()
  await prisma.rating.upsert({
    where: { chainId_escrowId: { chainId, escrowId } },
    create: { chainId, escrowId, ...data },
    update: { ...data, txHash: event.txHash ?? undefined },
  })
}

/** Records the SellerRated event(s) in one transaction on a chain. Returns how many were stored. */
export async function recordRatingsFromTx(chainId: ChainId, txHash: string): Promise<number> {
  const events = await readAdapter(chainId).ratingsInTx(txHash)
  for (const e of events) await saveRating(chainId, e)
  return events.length
}

// Where each chain's background scan continues from (in memory: a restart rescans a recent window).
const scannedTo = new Map<ChainId, bigint>()
// Public RPCs prune logs after ~80k blocks; ratings older than that are only on-chain.
const INITIAL_LOOKBACK = BigInt(20_000)
const SOLANA_SCAN_SPAN = BigInt(100_000)

/**
 * Catches ratings made outside our own flows (self-hosted buyers, direct
 * contract calls): scans a chain's recent blocks for SellerRated, in log-range chunks.
 */
export async function indexRecentRatings(chainId: ChainId): Promise<void> {
  const chain = readAdapter(chainId)
  const head = await chain.head()
  const last = scannedTo.get(chainId)
  let from = last === undefined ? (head > INITIAL_LOOKBACK ? head - INITIAL_LOOKBACK : BigInt(0)) : last + BigInt(1)
  // Nothing was emitted before the contract existed, and a public node may have pruned that far back: a chain
  // whose contract is younger than the lookback starts at its deployment block instead.
  if (last === undefined && chainFamily(chainId) === 'evm') {
    const deployed = readChain(chainId).config.deploymentBlock
    if (deployed !== null && from < deployed) from = deployed
  }
  // EVM: what the RPC allows per getLogs call. Solana: slots per pass (the RPC backend pages through the program's signatures itself).
  const span = chainFamily(chainId) === 'evm' ? readChain(chainId).config.logRange : SOLANA_SCAN_SPAN
  let stored = 0
  while (from <= head) {
    const to = from + span - BigInt(1) < head ? from + span - BigInt(1) : head
    for (const event of await chain.ratings(from, to)) {
      await saveRating(chainId, event)
      stored++
    }
    scannedTo.set(chainId, to)
    from = to + BigInt(1)
  }
  if (stored) log(`[ratings] ${chainId}: indexed ${stored} SellerRated event(s)`)
}

export interface RatingSummary {
  seller: string
  /** Ratings counted in the displayed average (same-owner ratings excluded). */
  count: number
  /** Average score 0–100 of those, or null with none. */
  avgScore: number | null
  /** Same-owner ratings left out. */
  excluded: number
}

/** Displayed rating per seller address (lowercased) on a chain, same-owner ratings excluded. */
export async function ratingSummaries(sellers: string[], chainId: ChainId): Promise<RatingSummary[]> {
  const addrs = [...new Set(sellers.map((s) => normalizeWallet(s)))]
  if (addrs.length === 0) return []
  const rows = await prisma.rating.findMany({ where: { chainId, seller: { in: addrs } }, select: { seller: true, score: true, sameOwner: true } })
  return addrs.map((seller) => {
    const mine = rows.filter((r) => r.seller === seller)
    const counted = mine.filter((r) => !r.sameOwner)
    return {
      seller,
      count: counted.length,
      avgScore: counted.length ? counted.reduce((sum, r) => sum + r.score, 0) / counted.length : null,
      excluded: mine.length - counted.length,
    }
  })
}
