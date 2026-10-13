import type { AgentConfig, NegotiationDecision } from './types.ts'

// How many concession steps each side takes from its opening price to its
// limit before giving up on a negotiation.
export const NEGOTIATION_ROUNDS = 3

/**
 * Generic runtime for a buyer or seller agent, configuration in, no
 * per-agent-pair hardcoding: capability matching, price policy, and the
 * concession policy that backs the AI negotiator's guardrails (spec §9).
 * Task execution lives in ./capabilities.
 */
export class DemoAgentRuntime {
  constructor(public readonly config: AgentConfig) {
    const { role, basePrice, minimumPrice, maxBudget } = config
    if (role === 'seller' && minimumPrice !== undefined && minimumPrice > basePrice) {
      throw new Error('minimumPrice cannot be greater than basePrice for a seller agent.')
    }
    if (role === 'buyer' && maxBudget !== undefined && maxBudget < basePrice) {
      throw new Error('maxBudget cannot be less than basePrice for a buyer agent.')
    }
  }

  /** Capability Handler, does this agent offer/need the requested capability? */
  matchesCapability(requested: string): boolean {
    return this.config.capabilities.includes(requested)
  }

  /**
   * Policy, is this price allowed at all, per this agent's role? A seller
   * never settles below its minimumPrice; a buyer never pays above its
   * maxBudget. This is a boundary check only, the actual offer/counter-offer
   * negotiation sequence is built on top of it in the Negotiation phase.
   */
  checkPolicy(price: number): boolean {
    const { role, basePrice, minimumPrice, maxBudget } = this.config
    if (role === 'seller') return price >= (minimumPrice ?? basePrice)
    return price <= (maxBudget ?? basePrice)
  }

  /**
   * This agent's asking price at concession step `step` (0 = its opening
   * position): walks linearly from basePrice to its limit (a seller's
   * minimumPrice, a buyer's maxBudget) over NEGOTIATION_ROUNDS steps,
   * rounded to cents and never past the limit.
   */
  private offerAtStep(step: number): number {
    const { role, basePrice, minimumPrice, maxBudget } = this.config
    const limit = role === 'seller' ? (minimumPrice ?? basePrice) : (maxBudget ?? basePrice)
    const raw = basePrice + ((limit - basePrice) * Math.min(step, NEGOTIATION_ROUNDS)) / NEGOTIATION_ROUNDS
    const rounded = Math.round(raw * 100) / 100
    return role === 'seller' ? Math.max(rounded, limit) : Math.min(rounded, limit)
  }

  /**
   * Negotiation (§11), decide what to do with a price the other side just
   * offered. `myPriorOfferCount` is how many offers *this* agent has already
   * made in this session (a buyer's opening offer counts as one), passed in
   * by the caller from the negotiation's message history, since the runtime
   * itself holds no session state.
   *
   * Each side concedes a step toward its limit per round, accepting as soon
   * as the other side's price is at least as good as its own next counter.
   * An offer outside policy isn't rejected outright, it gets countered, so
   * the other side has room to move, and only once this agent has used up
   * every concession step does it give up. Reproduces the §11 example
   * (seller asks 0.20, buyer offers 0.15, seller counters 0.18, buyer accepts).
   */
  decideOnOffer(offeredPrice: number, myPriorOfferCount = 0): NegotiationDecision {
    const { role, basePrice } = this.config
    const isIdeal = role === 'seller' ? offeredPrice >= basePrice : offeredPrice <= basePrice
    if (isIdeal) return { action: 'accept' }

    // A seller's listed price is its implicit opening (step 0), buyers
    // always open the session, so the seller's first counter is step 1.
    const nextStep = role === 'seller' ? myPriorOfferCount + 1 : myPriorOfferCount
    if (nextStep > NEGOTIATION_ROUNDS) {
      return this.checkPolicy(offeredPrice) ? { action: 'accept' } : { action: 'reject' }
    }

    const counterPrice = this.offerAtStep(nextStep)
    const goodEnough = role === 'seller' ? offeredPrice >= counterPrice : offeredPrice <= counterPrice
    if (goodEnough && this.checkPolicy(offeredPrice)) return { action: 'accept' }

    return { action: 'counter', price: counterPrice }
  }
}
