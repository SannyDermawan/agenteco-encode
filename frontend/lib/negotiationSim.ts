/**
 * Browser copy of the negotiation engine the hosted agents actually run,
 * agent-runtime/src/runtime.ts (DemoAgentRuntime.decideOnOffer) plus the
 * buyer's opening/ceiling rules from backend/src/host/buyerTaskHost.ts.
 * The landing page's simulator uses it so visitors see the exact rounds a
 * real buyer/seller pair would produce. Keep the three in sync.
 */

// Concession steps each side takes from its opening price to its limit.
const NEGOTIATION_ROUNDS = 3
// A hosted buyer opens at this fraction of the seller's listed price.
const OPENING_OFFER_RATIO = 0.5

type Role = 'buyer' | 'seller'

interface Position {
  role: Role
  /** Opening price: the seller's listing, or the buyer's first offer. */
  basePrice: number
  /** Seller: lowest acceptable price. Buyer: highest acceptable price. */
  limit: number
}

export type SimAction = 'offer' | 'counter' | 'accept' | 'reject'

export interface SimRound {
  side: Role
  action: SimAction
  price: number
}

export type SimResult =
  | { kind: 'skipped' } // even the buyer's opening offer is above its max budget, never approached
  | { kind: 'deal'; price: number; rounds: SimRound[] }
  | { kind: 'no-deal'; rounds: SimRound[] }

const roundCents = (value: number) => Math.round(value * 100) / 100

function checkPolicy(p: Position, price: number): boolean {
  return p.role === 'seller' ? price >= p.limit : price <= p.limit
}

function offerAtStep(p: Position, step: number): number {
  const raw = p.basePrice + ((p.limit - p.basePrice) * Math.min(step, NEGOTIATION_ROUNDS)) / NEGOTIATION_ROUNDS
  const rounded = roundCents(raw)
  return p.role === 'seller' ? Math.max(rounded, p.limit) : Math.min(rounded, p.limit)
}

function decideOnOffer(p: Position, offeredPrice: number, myPriorOfferCount: number): SimRound {
  const isIdeal = p.role === 'seller' ? offeredPrice >= p.basePrice : offeredPrice <= p.basePrice
  if (isIdeal) return { side: p.role, action: 'accept', price: offeredPrice }

  const nextStep = p.role === 'seller' ? myPriorOfferCount + 1 : myPriorOfferCount
  if (nextStep > NEGOTIATION_ROUNDS) {
    return { side: p.role, action: checkPolicy(p, offeredPrice) ? 'accept' : 'reject', price: offeredPrice }
  }

  const counterPrice = offerAtStep(p, nextStep)
  const goodEnough = p.role === 'seller' ? offeredPrice >= counterPrice : offeredPrice <= counterPrice
  if (goodEnough && checkPolicy(p, offeredPrice)) return { side: p.role, action: 'accept', price: offeredPrice }
  return { side: p.role, action: 'counter', price: counterPrice }
}

/** Plays a full hosted-buyer-vs-hosted-seller negotiation, buyer opening. */
export function simulateNegotiation(input: { sellerPrice: number; sellerFloor: number; buyerBudget: number }): SimResult {
  const { sellerPrice, buyerBudget } = input
  const sellerFloor = Math.min(input.sellerFloor, sellerPrice)
  // Approached only if the buyer can afford its own opening offer, a seller
  // listed above the budget may still settle within it.
  const openingOffer = roundCents(sellerPrice * OPENING_OFFER_RATIO)
  if (openingOffer > buyerBudget) return { kind: 'skipped' }

  const ceiling = Math.min(buyerBudget, sellerPrice)
  const opening = Math.min(openingOffer, ceiling)
  const buyer: Position = { role: 'buyer', basePrice: opening, limit: ceiling }
  const seller: Position = { role: 'seller', basePrice: sellerPrice, limit: sellerFloor }

  const rounds: SimRound[] = [{ side: 'buyer', action: 'offer', price: opening }]
  const offers = { buyer: 1, seller: 0 }
  let price = opening
  let turn: Role = 'seller'

  // Both sides run out of concession steps well before this cap.
  for (let i = 0; i < 12; i++) {
    const decision = decideOnOffer(turn === 'seller' ? seller : buyer, price, offers[turn])
    rounds.push(decision)
    if (decision.action === 'accept') return { kind: 'deal', price, rounds }
    if (decision.action === 'reject') return { kind: 'no-deal', rounds }
    price = decision.price
    offers[turn]++
    turn = turn === 'seller' ? 'buyer' : 'seller'
  }
  return { kind: 'no-deal', rounds }
}
