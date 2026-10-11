import type { DiscoveredAgent } from '../../../agent-runtime/src/index.ts'
import type { EvmAdapter } from '../../../agent-runtime/src/chain/evm.ts'
import { ratingSummaries } from '../ratings.ts'
import { normalizeWallet } from '../../../agent-runtime/src/shared/wallets.ts'

export interface SellerFilters {
  minSuccessRate: number | null
  minCompletedJobs: number | null
  /**
   * Minimum average buyer rating on the contract's 1–100 scale (the UI shows
   * it as stars × 20). Stored in the agent's minReputation column.
   */
  minReputation: number | null
}

/**
 * "Recommended" (all three filters null) just picks the cheapest agent the
 * buyer can afford to open a negotiation with (see `checkPolicy`); if that one
 * walks away, the host tries the next. "Custom" additionally requires live on-chain reputation
 * meeting the buyer's thresholds — reputation is never trusted from the
 * registry row: jobs and success come from AgentEco.sol, and the rating is
 * the indexed average without same-owner ratings (spec §10.3).
 */
export async function selectSeller(
  chain: EvmAdapter,
  candidates: DiscoveredAgent[],
  checkPolicy: (price: number) => boolean,
  filters: SellerFilters
): Promise<DiscoveredAgent | null> {
  const affordable = candidates.filter((c) => checkPolicy(Number(c.price)))
  const hasCustomFilter =
    filters.minSuccessRate !== null || filters.minCompletedJobs !== null || filters.minReputation !== null

  let qualified = affordable
  if (hasCustomFilter) {
    const wallets = affordable.map((c) => c.walletAddress).filter((w): w is string => !!w)
    const ratings = new Map((await ratingSummaries(wallets, chain.chainId)).map((r) => [r.seller, r.avgScore]))
    const checked = await Promise.all(
      affordable.map(async (candidate) => {
        if (!candidate.walletAddress) return null
        const rep = await chain.getReputation(candidate.walletAddress)
        const okSuccess = filters.minSuccessRate === null || rep.successRatePct >= filters.minSuccessRate
        const okCompleted = filters.minCompletedJobs === null || rep.completedJobs >= filters.minCompletedJobs
        // A minimum rating excludes sellers nobody has rated yet.
        const avgScore = ratings.get(normalizeWallet(candidate.walletAddress)) ?? null
        const okRating = filters.minReputation === null || (avgScore !== null && avgScore >= filters.minReputation)
        return okSuccess && okCompleted && okRating ? candidate : null
      })
    )
    qualified = checked.filter((c): c is DiscoveredAgent => c !== null)
  }

  if (qualified.length === 0) return null
  return [...qualified].sort((a, b) => Number(a.price) - Number(b.price))[0]
}
