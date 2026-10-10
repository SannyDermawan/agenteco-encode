import type { LocalAccount } from 'viem'
import { submitDisputeReason } from '../../../agent-runtime/src/index.ts'
import type { EvmAdapter } from '../../../agent-runtime/src/chain/evm.ts'
import { withChain } from '../../../agent-runtime/src/chainQuery.ts'
import { getTaskByEscrow } from '../../../agent-runtime/src/tasksClient.ts'
import { buildAuthHeaders } from '../../../agent-runtime/src/authHeaders.ts'
import { REVIEW_WINDOW_SECONDS } from '../../../agent-runtime/src/durations.ts'
import { hashPreimage, textHash } from '../../../agent-runtime/src/shared/hashes.ts'
import { isCapabilityId } from '../../../agent-runtime/src/shared/capabilities/definitions.ts'
import { disputeReasonFrom, ratingScoreFrom, verifyResult } from '../ai/judge.ts'
import { prisma } from '../db.ts'
import { log, logError } from '../log.ts'
import { recordRatingsFromTx } from '../ratings.ts'
import { giveDealFeedback } from '../erc8004.ts'

// AgentEco.sol OrderStatus
const DELIVERED = 3
const DISPUTED = 4
const SETTLED = 5
const REFUNDED = 6

export type ReviewStep = 'waiting' | 'acted' | 'final'

interface Ctx {
  apiUrl: string
  agent: { id: string; name: string }
  /** The buyer agent's signing adapter on the escrow's chain. */
  chain: EvmAdapter
  account: LocalAccount
  escrowId: bigint
}

/** This escrow's key in the database: escrow ids are numbered per chain. */
const where = (ctx: Ctx) => ({ chainId_escrowId: { chainId: ctx.chain.chainId, escrowId: ctx.escrowId.toString() } })

/** The delivered result, only if its stored text hashes to the on-chain resultHash. */
async function readVerifiedResult(ctx: Ctx): Promise<{ capability: string; result: unknown } | null> {
  const res = await fetch(withChain(`${ctx.apiUrl}/escrow-results/${ctx.escrowId}`, ctx.chain.chainId), { headers: await buildAuthHeaders(ctx.account) })
  if (!res.ok) return null
  const stored = (await res.json()) as { capability: string; result: unknown; resultJson: string | null }
  if (!stored.resultJson) return null
  const { resultHash } = await ctx.chain.getEscrowHashes(ctx.escrowId)
  if (hashPreimage(stored.resultJson).toLowerCase() !== resultHash.toLowerCase()) return null
  return { capability: stored.capability, result: JSON.parse(stored.resultJson) }
}

/** Step 1 at DELIVERED: score the result once and store the Verification (spec §10.1). */
async function verifyDelivery(ctx: Ctx) {
  const existing = await prisma.verification.findUnique({ where: where(ctx) })
  if (existing) return existing

  const delivered = await readVerifiedResult(ctx)
  if (!delivered) {
    // A result hash with no matching plaintext can't be checked. Give the
    // seller half the review window to publish it, then dispute.
    const { deliveredAt } = await ctx.chain.getEscrowTimestamps(ctx.escrowId)
    const waited = BigInt(Math.floor(Date.now() / 1000)) - deliveredAt
    if (waited * BigInt(2) < REVIEW_WINDOW_SECONDS) return null
    return prisma.verification.create({
      data: {
        chainId: ctx.chain.chainId,
        escrowId: ctx.escrowId.toString(),
        score: 0,
        verdict: 'dispute',
        rationale: 'The seller committed a result hash on-chain but never published a result that matches it, so the delivery could not be checked.',
        provider: 'rule',
      },
    })
  }

  const task = await getTaskByEscrow(ctx.apiUrl, ctx.escrowId.toString(), ctx.account, ctx.chain.chainId)
  const capability = task?.capability ?? delivered.capability
  if (!isCapabilityId(capability)) throw new Error(`escrow #${ctx.escrowId}: unknown capability "${capability}"`)
  const outcome = await verifyResult(
    { capability, brief: task?.brief ?? null, criteria: task?.criteria ?? '', result: delivered.result },
    { agentId: ctx.agent.id }
  )
  log(
    `[host:${ctx.agent.name}] escrow #${ctx.escrowId}: verification ${outcome.score ?? 'unscored'}/100 → ${outcome.verdict}` +
      ` (${outcome.provider}${outcome.model ? `/${outcome.model}` : ''})`
  )
  return prisma.verification.create({
    data: {
      chainId: ctx.chain.chainId,
      escrowId: ctx.escrowId.toString(),
      score: outcome.score,
      verdict: outcome.verdict,
      rationale: outcome.rationale,
      provider: outcome.provider,
      model: outcome.model,
    },
  })
}

/** The dispute reason for a stored verification — rebuilt identically every time it's needed. */
function reasonFor(v: { score: number | null; rationale: string; provider: string; model: string | null }): string {
  return disputeReasonFrom({ score: v.score, verdict: 'dispute', rationale: v.rationale, provider: v.provider, model: v.model })
}

/** Sends the reason text if the API doesn't have it yet, after checking it matches the on-chain hash. */
async function ensureReasonSaved(ctx: Ctx): Promise<void> {
  const res = await fetch(withChain(`${ctx.apiUrl}/disputes/${ctx.escrowId}`, ctx.chain.chainId), { headers: await buildAuthHeaders(ctx.account) })
  if (res.ok) return
  const v = await prisma.verification.findUnique({ where: where(ctx) })
  if (!v) return
  const reason = reasonFor(v)
  const { disputeReasonHash } = await ctx.chain.getEscrowHashes(ctx.escrowId)
  if (textHash(reason).toLowerCase() !== disputeReasonHash.toLowerCase()) {
    log(`[host:${ctx.agent.name}] escrow #${ctx.escrowId}: rebuilt dispute reason no longer matches its hash — cannot re-send it.`)
    return
  }
  await submitDisputeReason(ctx.apiUrl, ctx.account, ctx.escrowId.toString(), reason, ctx.chain.chainId)
  log(`[host:${ctx.agent.name}] escrow #${ctx.escrowId}: dispute reason saved.`)
}

/** Rates the seller with the verification score once the escrow is final (spec §10.1 step 4). */
async function rateIfDue(ctx: Ctx): Promise<void> {
  const v = await prisma.verification.findUnique({ where: where(ctx) })
  // Unscored (AI unavailable) or rule-made verifications don't rate.
  if (!v || v.score === null || v.provider === 'none' || v.provider === 'rule') return
  const [{ rated }, { deliveredAt }] = await Promise.all([ctx.chain.getEscrowDisputeInfo(ctx.escrowId), ctx.chain.getEscrowTimestamps(ctx.escrowId)])
  if (rated || deliveredAt === BigInt(0)) return
  const score = ratingScoreFrom(v.score)
  const hash = await ctx.chain.rateSeller(ctx.escrowId, score)
  log(`[host:${ctx.agent.name}] escrow #${ctx.escrowId}: rated the seller ${score}/100.`)
  try {
    await recordRatingsFromTx(ctx.chain.chainId, hash)
  } catch (error) {
    // The background SellerRated scan picks it up later.
    logError(`[host:${ctx.agent.name}] escrow #${ctx.escrowId}: rating not indexed yet`, error, 'HOST')
  }
  // The same rating as ERC-8004 feedback from this buyer's wallet, where the seller has an identity.
  const task = await prisma.task.findUnique({ where: where(ctx), select: { capability: true, seller: true } })
  if (task) {
    const tx = await giveDealFeedback(ctx.chain, { escrowId: ctx.escrowId, score, capability: task.capability, seller: task.seller })
    if (tx) log(`[host:${ctx.agent.name}] escrow #${ctx.escrowId}: ERC-8004 feedback given (tx ${tx}).`)
  }
}

/**
 * One step of a hosted buyer's review of its funded escrow:
 * DELIVERED → verify → acceptAndSettle, or raiseDispute(reasonHash) + reason;
 * DISPUTED  → make sure the reason reached the API, then wait for the ruling;
 * SETTLED / REFUNDED → rate the seller (if a model scored it) — 'final'.
 */
export async function reviewEscrow(
  apiUrl: string,
  agent: { id: string; name: string },
  chain: EvmAdapter,
  account: LocalAccount,
  escrowId: bigint
): Promise<ReviewStep> {
  const ctx: Ctx = { apiUrl, agent, chain, account, escrowId }
  const status = await chain.getEscrowStatus(escrowId)

  if (status === DELIVERED) {
    const v = await verifyDelivery(ctx)
    if (!v) return 'waiting'
    if (v.verdict === 'accept') {
      log(`[host:${agent.name}] escrow #${escrowId}: accepting & settling…`)
      await chain.acceptAndSettle(escrowId)
      return 'acted'
    }
    const reason = reasonFor(v)
    log(`[host:${agent.name}] escrow #${escrowId}: raising a dispute…`)
    await chain.raiseDispute(escrowId, textHash(reason))
    try {
      await submitDisputeReason(apiUrl, account, escrowId.toString(), reason, chain.chainId)
    } catch (error) {
      logError(`[host:${agent.name}] escrow #${escrowId}: dispute reason not saved yet — will retry`, error, 'HOST')
    }
    return 'acted'
  }

  if (status === DISPUTED) {
    await ensureReasonSaved(ctx)
    return 'waiting'
  }

  if (status === SETTLED || status === REFUNDED) {
    await rateIfDue(ctx)
    return 'final'
  }

  return 'waiting'
}
