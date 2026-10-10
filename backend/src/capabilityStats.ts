import { prisma } from './db.ts'
import { rankScore, type CapabilityStats } from '../../agent-runtime/src/shared/capabilities/custom.ts'

/**
 * How each capability is doing in the marketplace — what the Capabilities page
 * ranks by. Read from the registry's own records (tasks, delivered results,
 * ratings, disputes, sellers), so it needs no extra bookkeeping. Ratings
 * between agents of the same owner are left out, like everywhere else.
 */

const TTL_MS = 30_000
let cache: { at: number; stats: Map<string, CapabilityStats> } | null = null

export async function capabilityStats(): Promise<Map<string, CapabilityStats>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.stats

  const [tasks, results, disputes, ratings, sellers] = await Promise.all([
    prisma.task.findMany({ where: { escrowId: { not: null } }, select: { capability: true, chainId: true, escrowId: true } }),
    prisma.escrowResult.findMany({ select: { chainId: true, escrowId: true } }),
    prisma.dispute.findMany({ select: { chainId: true, escrowId: true } }),
    prisma.rating.findMany({ where: { sameOwner: false }, select: { chainId: true, escrowId: true, score: true } }),
    prisma.agent.findMany({ where: { role: 'seller', deletedAt: null }, select: { capabilities: true, isOnline: true } }),
  ])

  // Escrow ids are numbered per chain.
  const key = (r: { chainId: string; escrowId: string }) => `${r.chainId}:${r.escrowId}`
  const capabilityOf = new Map<string, string>()
  for (const t of tasks) if (t.escrowId) capabilityOf.set(key({ chainId: t.chainId, escrowId: t.escrowId }), t.capability)

  const blank = (): CapabilityStats => ({ sellers: 0, onlineSellers: 0, hires: 0, delivered: 0, disputes: 0, ratings: 0, avgRating: null, disputeRatePct: null, score: 0 })
  const stats = new Map<string, CapabilityStats>()
  const of = (id: string) => {
    let s = stats.get(id)
    if (!s) stats.set(id, (s = blank()))
    return s
  }
  const ratingSum = new Map<string, number>()

  for (const t of tasks) of(t.capability).hires++
  for (const r of results) {
    const id = capabilityOf.get(key(r))
    if (id) of(id).delivered++
  }
  for (const d of disputes) {
    const id = capabilityOf.get(key(d))
    if (id) of(id).disputes++
  }
  for (const r of ratings) {
    const id = capabilityOf.get(key(r))
    if (!id) continue
    of(id).ratings++
    ratingSum.set(id, (ratingSum.get(id) ?? 0) + r.score)
  }
  for (const a of sellers) {
    for (const id of a.capabilities) {
      of(id).sellers++
      if (a.isOnline) of(id).onlineSellers++
    }
  }
  for (const [id, s] of stats) {
    s.avgRating = s.ratings ? Math.round(((ratingSum.get(id) ?? 0) / s.ratings) * 10) / 10 : null
    s.disputeRatePct = s.delivered ? Math.round(Math.min(100, (s.disputes / s.delivered) * 100)) : null
    s.score = rankScore(s, ratingSum.get(id) ?? 0)
  }

  cache = { at: Date.now(), stats }
  return stats
}

/** Empty stats for a capability nobody has used yet. */
export function emptyStats(): CapabilityStats {
  const s: CapabilityStats = { sellers: 0, onlineSellers: 0, hires: 0, delivered: 0, disputes: 0, ratings: 0, avgRating: null, disputeRatePct: null, score: 0 }
  s.score = rankScore(s, 0)
  return s
}
