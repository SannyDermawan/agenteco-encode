import type { DemoAgentRuntime } from '../../../agent-runtime/src/runtime.ts'
import { callLLM, type LLMRequest, type LLMResult } from './llm.ts'
import { negotiationPrompt, type NegotiationTurnInput } from './prompts/negotiation.ts'
import { negotiationDecision, type NegotiationDecision } from './schemas.ts'
import { filterLimitHints, filterLimitLeak, filterStrayPrices } from './sanitize.ts'

export interface NegotiationMove {
  action: 'counter' | 'accept' | 'reject'
  price?: number
  /** Null for rule-based moves (spec §9, guardrail 5). */
  reason: string | null
  source: 'ai' | 'rule'
  /** A guardrail changed the model's price or action. */
  adjusted: boolean
}

export interface TurnContext extends Omit<NegotiationTurnInput, 'role' | 'privateLimit' | 'round' | 'maxRounds' | 'listingPrice'> {
  runtime: DemoAgentRuntime
  /** Offers this agent already made in the session (a buyer's opening counts). */
  myPriorOfferCount: number
  listingPrice: number
  maxRounds: number
  agentId?: string
  llm?: <T>(req: LLMRequest<T>) => Promise<LLMResult<T> | null>
}

const cents = (n: number) => Math.round(n * 100) / 100

/**
 * One negotiation turn: the model proposes, deterministic guardrails decide
 * what is actually sent (spec §9):
 * 1. prices outside this side's limits are clamped to the limit (adjusted);
 * 2. an "accept" of an offer outside the limits becomes a counter at the limit;
 * 3. if the old concession policy already accepts the offer, accept;
 * 4. a reason that leaks the private limit is replaced by a generic one;
 * 5. no model answer → the old policy, source "rule", no reason.
 * The old policy also still ends the session after the last round.
 *
 * Every move then passes finishMove: counters in whole cents, accepts at the
 * exact offer, and a reason that hints at the limit in words or quotes a price
 * that isn't on the table is replaced too.
 */
export async function decideTurn(ctx: TurnContext): Promise<NegotiationMove> {
  return finishMove(ctx, await proposeMove(ctx))
}

/** Strips float noise (0.07000000000000001) without rounding a real 0.085 away. */
const exact = (n: number) => Number(n.toFixed(6))

function finishMove(ctx: TurnContext, move: NegotiationMove): NegotiationMove {
  const price = move.price === undefined ? undefined : move.action === 'accept' ? exact(move.price) : cents(move.price)
  let reason = move.reason
  if (reason) {
    reason = filterLimitHints(reason).reason
    const onTheTable = [
      price ?? NaN,
      ctx.offeredPrice,
      ctx.listingPrice,
      ...ctx.history.map((m) => m.price ?? NaN),
      ...(ctx.otherSellerPrices ?? []),
    ]
    reason = filterStrayPrices(reason, onTheTable).reason
  }
  return { ...move, ...(price !== undefined && { price }), reason }
}

async function proposeMove(ctx: TurnContext): Promise<NegotiationMove> {
  const { role, basePrice, minimumPrice, maxBudget } = ctx.runtime.config
  const isSeller = role === 'seller'
  // Seller: floor = its minimum. Buyer: ceiling = its max budget, and never above the listing.
  const floor = isSeller ? (minimumPrice ?? basePrice) : 0
  const ceiling = isSeller ? Math.max(ctx.listingPrice, basePrice) : Math.min(maxBudget ?? basePrice, ctx.listingPrice)
  const privateLimit = isSeller ? floor : ceiling
  const withinLimits = (p: number) => (isSeller ? p >= floor : p <= ceiling)

  const rule = ctx.runtime.decideOnOffer(ctx.offeredPrice, ctx.myPriorOfferCount)
  const ruleMove: NegotiationMove = { ...rule, reason: null, source: 'rule', adjusted: false }

  // Guardrail 3, the old policy's accept stands. Rounds are over when the
  // old policy says reject: the session ends there.
  if (rule.action === 'accept') return { action: 'accept', price: ctx.offeredPrice, reason: null, source: 'rule', adjusted: false }

  const prompt = negotiationPrompt({
    role: isSeller ? 'seller' : 'buyer',
    capability: ctx.capability,
    listingPrice: ctx.listingPrice,
    privateLimit,
    offeredPrice: ctx.offeredPrice,
    history: ctx.history,
    round: Math.min(ctx.myPriorOfferCount + 1, ctx.maxRounds),
    maxRounds: ctx.maxRounds,
    brief: ctx.brief,
    seller: ctx.seller,
    otherSellerPrices: ctx.otherSellerPrices,
  })
  const ai = await (ctx.llm ?? callLLM)({ task: 'negotiation', ...prompt, schema: negotiationDecision, agentId: ctx.agentId })
  if (!ai) return ruleMove // guardrail 5

  const decision: NegotiationDecision = ai.data
  const { reason } = filterLimitLeak(decision.reason, [privateLimit]) // guardrail 4

  if (rule.action === 'reject') {
    // Out of rounds: the deal ends whatever the model says.
    return { action: 'reject', reason: decision.action === 'reject' ? reason : null, source: decision.action === 'reject' ? 'ai' : 'rule', adjusted: false }
  }

  if (decision.action === 'reject') return { action: 'reject', reason, source: 'ai', adjusted: false }

  if (decision.action === 'accept') {
    if (withinLimits(ctx.offeredPrice)) return { action: 'accept', price: ctx.offeredPrice, reason, source: 'ai', adjusted: false }
    // Guardrail 2, accepting outside the limits becomes a counter at the limit.
    return { action: 'counter', price: cents(privateLimit), reason, source: 'ai', adjusted: true }
  }

  // Counter. Guardrail 1, clamp to this side's limits.
  let price = cents(decision.price)
  let adjusted = false
  if (price < floor) {
    price = cents(floor)
    adjusted = true
  }
  if (price > ceiling) {
    price = cents(ceiling)
    adjusted = true
  }
  // A counter at least as good for us as the offer already on the table is an accept.
  if (isSeller ? price <= ctx.offeredPrice : price >= ctx.offeredPrice) {
    return withinLimits(ctx.offeredPrice)
      ? { action: 'accept', price: ctx.offeredPrice, reason, source: 'ai', adjusted }
      : { action: 'counter', price: cents(privateLimit), reason, source: 'ai', adjusted: true }
  }
  return { action: 'counter', price, reason, source: 'ai', adjusted }
}
