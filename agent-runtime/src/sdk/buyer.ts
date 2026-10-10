import type { Hex } from 'viem'
import { DemoAgentRuntime } from '../runtime.ts'
import { PRIMARY_CHAIN_ID, normalizeChainId, signerChain } from '../chain/registry.ts'
import { discoverAgents, registerOrSyncSelf, type DiscoveredAgent } from '../registryClient.ts'
import { countOffersBySide, isMyTurn, listNegotiationsForAgent, openNegotiation, respondToNegotiation } from '../negotiationClient.ts'
import { attachEscrowToOrder, listOrdersForAgent } from '../ordersClient.ts'
import { hireWithTask } from '../tasksClient.ts'
import { privateKeyToAccount } from 'viem/accounts'
import { getEscrowResult } from '../resultsClient.ts'
import { submitDisputeReason } from '../disputesClient.ts'
import { hashPreimage, textHash } from '../shared/hashes.ts'
import { resolveCapability } from './capability.ts'
import { scoreWithAi, type AiModel } from './ai.ts'
import { DEFAULT_API_URL, type Logger, apiErc8004Registries, consoleLogger, sleep } from './common.ts'
import { dealFeedback } from '../shared/erc8004.ts'
import { checkDecision, type Offer, type OfferDecision } from './seller.ts'

export type Review =
  | { accept: true; /** Optional on-chain rating for the seller, 1–100. */ rating?: number }
  | { accept: false; /** Why — goes to the seller and the arbiter (≥ 10 characters). */ reason: string }

export interface HireOptions {
  /** The buyer's wallet: it pays into escrow (needs the token plus a little native gas). */
  privateKey: Hex
  /** AgentEco API. Default: AGENTECO_API_URL, else the public testnet API. */
  apiUrl?: string
  /**
   * The chain to buy on: a CAIP-2 id (eip155:84532), a network name (base-sepolia) or an EVM
   * chain id. Only sellers on this chain are considered. Default: a given `sellerId`'s chain,
   * else NETWORK (bsc-testnet).
   */
  chain?: string
  /** What to buy: a platform capability id or a community one from the registry. */
  capability: string
  /** The task, matching the capability's input schema — checked before anything is paid. */
  brief: unknown
  /** What a good result must satisfy; the seller, verifiers and arbiter read it. */
  criteria?: string
  /** The most you will pay. Never revealed to the seller. */
  maxBudget: number
  /** A specific seller (agent id). Default: the cheapest online seller of the capability whose opening offer fits the budget. */
  sellerId?: string
  /**
   * Your own model (see openAiCompatible), used as the verifier when you pass no
   * `review`: it scores the delivery 0–100 against the capability's rubric and your
   * criteria — the same verifier AgentEco's hosted buyers use — and accepts at 60 or
   * more (rating the seller with the score), otherwise disputes with its reasons.
   * AgentEco provides no model for self-hosted agents; this one is yours.
   */
  ai?: AiModel
  /**
   * Decide on the delivered result (already checked against the output schema
   * and the on-chain hash). Rejecting raises a dispute. Pass `review` or `ai`:
   * hire() never pays for a result nobody checked. To accept anything that fits
   * the schema, say so explicitly: `review: () => ({ accept: true })`.
   */
  review?: (result: Record<string, unknown>) => Promise<Review> | Review
  /**
   * Decide each counter-offer from the seller yourself (your own rules or model).
   * `offer.price` is the seller's latest price and `offer.listPrice` its listing.
   * Without it, the default policy opens at half the listing and concedes toward
   * min(maxBudget, listing). Never accept above `maxBudget`: hire() refuses to.
   */
  onOffer?: (offer: Offer) => Promise<OfferDecision> | OfferDecision
  /**
   * When you rate the seller and it has an ERC-8004 identity on this chain, also publish the
   * rating as ERC-8004 feedback from your wallet (one more transaction). Default true.
   */
  erc8004Feedback?: boolean
  /** Name of the buyer agent in the registry. Default "SDK buyer". */
  name?: string
  /** Give up waiting for a deal or a delivery after this long. Default 20 minutes. */
  timeoutMs?: number
  pollMs?: number
  log?: Logger
}

export interface HireResult {
  escrowId: bigint
  seller: { id: string; name: string; wallet: string }
  /** The agreed price. */
  price: string
  /** The delivered result; null when the seller committed a hash but never published the result. */
  result: Record<string, unknown> | null
  /** settled = paid; disputed = the arbiter (or the dispute timeout) decides. */
  outcome: 'settled' | 'disputed'
}

// AgentEco.sol OrderStatus
const DELIVERED = 3
const REFUNDED = 6

/** The buyer opens at half the listing, like hosted buyers (lib/negotiationSim.ts). */
const OPENING_RATIO = 0.5
const cents = (n: number) => Math.round(n * 100) / 100

/**
 * Hire an agent in one call: find a seller, negotiate within your budget,
 * store the task and lock the agreed price in escrow, wait for delivery,
 * check the result against the on-chain hash and the capability's output
 * schema, then settle (or dispute). Resolves with the result.
 */
export async function hire(options: HireOptions): Promise<HireResult> {
  const apiUrl = options.apiUrl ?? DEFAULT_API_URL
  const name = options.name ?? 'SDK buyer'
  const log = options.log ?? consoleLogger(name)
  const pollMs = options.pollMs ?? 3000
  const deadline = Date.now() + (options.timeoutMs ?? 20 * 60_000)
  if (!options.review && !options.ai) {
    throw new Error('Pass review(result) or ai (your own model): hire() never pays for a result nobody checked. To accept anything that fits the schema: review: () => ({ accept: true }).')
  }
  const account = privateKeyToAccount(options.privateKey)
  const chosenChain = options.chain === undefined ? null : normalizeChainId(options.chain)
  if (options.chain !== undefined && !chosenChain) throw new Error(`Unknown chain: ${options.chain}`)
  let chainId = chosenChain ?? PRIMARY_CHAIN_ID
  const waitStep = async (what: string) => {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await sleep(pollMs)
  }

  // 1. The brief must fit the capability before anyone is approached.
  const capability = await resolveCapability(apiUrl, options.capability)
  const brief = capability.checkBrief(options.brief)
  if (!brief.ok) throw new Error(`Invalid ${options.capability} brief: ${brief.error}`)

  // 2. A seller.
  let seller: DiscoveredAgent | undefined
  if (options.sellerId) {
    const res = await fetch(`${apiUrl}/agents/${options.sellerId}`)
    if (!res.ok) throw new Error(`Seller ${options.sellerId} not found (${res.status}).`)
    seller = (await res.json()) as DiscoveredAgent
    if (seller.chainId && seller.chainId !== chainId) {
      if (chosenChain) throw new Error(`Seller ${options.sellerId} trades on ${seller.chainId}, not ${chosenChain}.`)
      chainId = seller.chainId
    }
  } else {
    const sellers = await discoverAgents(apiUrl, { role: 'seller', capability: options.capability, onlineOnly: true, chainId })
    seller = sellers
      .filter((s) => s.walletAddress && cents(Number(s.price) * OPENING_RATIO) <= options.maxBudget)
      .sort((a, b) => Number(a.price) - Number(b.price))[0]
  }
  if (!seller?.walletAddress) throw new Error(`No online seller of "${options.capability}" fits a budget of ${options.maxBudget}.`)
  const chain = signerChain(chainId, options.privateKey)
  const listing = Number(seller.price)
  log(`seller: ${seller.name} (${seller.id.slice(0, 8)}) lists ${listing}`)

  // 3. Negotiate: open at half the listing, concede toward min(budget, listing).
  const ceiling = Math.min(options.maxBudget, listing)
  const opening = Math.min(cents(listing * OPENING_RATIO), ceiling)
  const buyerAgent = await registerOrSyncSelf(
    {
      name,
      role: 'buyer',
      capabilities: [options.capability],
      description: 'Self-hosted buyer agent (AgentEco SDK).',
      basePrice: opening,
      maxBudget: ceiling,
    },
    { apiUrl, account, hosted: false, chainId }
  )
  const policy = new DemoAgentRuntime({ name, role: 'buyer', capabilities: [options.capability], description: '', basePrice: opening, maxBudget: ceiling })
  let negotiation = await openNegotiation(apiUrl, account, {
    buyerAgentId: buyerAgent.id,
    sellerAgentId: seller.id,
    capability: options.capability,
    price: opening,
    source: 'rule',
  })
  log(`offered ${opening}`)
  while (negotiation.status === 'open') {
    await waitStep('the seller to answer')
    const open = await listNegotiationsForAgent(apiUrl, account, buyerAgent.id)
    negotiation = open.find((n) => n.id === negotiation.id) ?? negotiation
    if (!isMyTurn(negotiation, 'buyer')) continue
    const offered = Number(negotiation.messages[negotiation.messages.length - 1].price)
    const countersSoFar = countOffersBySide(negotiation, 'buyer')
    let decision: OfferDecision
    let source: 'rule' | 'agent' = 'rule'
    if (options.onOffer) {
      try {
        decision = checkDecision(
          await options.onOffer({
            negotiationId: negotiation.id,
            capability: options.capability,
            buyerAgentId: buyerAgent.id,
            price: offered,
            listPrice: listing,
            countersSoFar,
            history: negotiation.messages.map((m) => ({ side: m.side, action: m.action, price: m.price === null ? null : Number(m.price), reason: m.reason ?? null })),
          }),
          offered,
          'buyer'
        )
      } catch (error) {
        log(`onOffer failed (${(error as Error).message}) — will retry`)
        continue
      }
      // The budget is a hard limit, whatever the hook decides.
      if (decision.action === 'accept' && offered > options.maxBudget) decision = { action: 'reject', reason: decision.reason }
      if (decision.action === 'counter' && decision.price > options.maxBudget) {
        log(`onOffer countered ${decision.price}, above maxBudget ${options.maxBudget} — will retry`)
        continue
      }
      source = 'agent'
    } else {
      decision = policy.decideOnOffer(offered, countersSoFar)
    }
    log(`seller asks ${offered} → ${decision.action}${decision.action === 'counter' ? ` ${decision.price}` : ''}`)
    negotiation = await respondToNegotiation(apiUrl, account, negotiation.id, {
      side: 'buyer',
      action: decision.action,
      ...(decision.action === 'counter' ? { price: decision.price } : {}),
      ...(decision.reason ? { reason: decision.reason } : {}),
      source,
    })
  }
  if (negotiation.status === 'expired') throw new Error(`No deal with ${seller.name}: the negotiation expired (a side stayed silent too long).`)
  if (negotiation.status !== 'accepted') throw new Error(`No deal with ${seller.name}: the prices never met.`)
  // Float noise from the policy's arithmetic (0.07000000000000001) never reaches the escrow amount.
  const price = String(Number(Number(negotiation.agreedPrice).toFixed(6)))
  log(`deal at ${price}`)

  // 4. Task → escrow → fund → link (the API checks the chain agrees), and record it on the order.
  const order = (await listOrdersForAgent(apiUrl, account, buyerAgent.id, 'agreed')).find((o) => o.negotiationId === negotiation.id)
  const { escrowId } = await hireWithTask(
    apiUrl,
    { account },
    {
      capability: options.capability,
      brief: brief.brief,
      criteria: options.criteria ?? '',
      price,
      seller: seller.walletAddress as `0x${string}`,
    },
    chain
  )
  if (order) await attachEscrowToOrder(apiUrl, account, order.id, escrowId.toString())
  log(`escrow #${escrowId} funded — waiting for delivery`)

  // 5. Delivery, then the plaintext result (published right after the hash).
  for (;;) {
    const status = await chain.getEscrowStatus(escrowId)
    if (status === DELIVERED) break
    if (status === REFUNDED) throw new Error(`Escrow #${escrowId} was refunded — the seller did not take or finish the job.`)
    await waitStep(`escrow #${escrowId} to be delivered`)
  }
  const sellerInfo = { id: seller.id, name: seller.name, wallet: seller.walletAddress }

  // The plaintext must follow the hash. A seller that never publishes it gets half the review
  // window, then a dispute — like a hosted buyer. Waiting longer would let the window run out,
  // and the contract would then pay the seller for a result nobody could check.
  const [{ deliveredAt }, { reviewWindow }] = await Promise.all([chain.getEscrowTimestamps(escrowId), chain.getEscrowWindows(escrowId)])
  const publishBy = Number(deliveredAt + reviewWindow / BigInt(2)) * 1000
  let published = await getEscrowResult(apiUrl, escrowId.toString(), account, chainId)
  while (!published) {
    if (Date.now() >= publishBy) {
      const reason = 'The seller committed a result hash on-chain but never published a result that matches it, so the delivery could not be checked.'
      await chain.raiseDispute(escrowId, textHash(reason))
      await submitDisputeReason(apiUrl, account, escrowId.toString(), reason, chainId)
      log(`escrow #${escrowId}: the seller never published its result — disputed`)
      return { escrowId, seller: sellerInfo, price, result: null, outcome: 'disputed' }
    }
    await waitStep(`the result of escrow #${escrowId}`)
    published = await getEscrowResult(apiUrl, escrowId.toString(), account, chainId)
  }
  // The exact committed text: the API's `result` object comes from jsonb, with its keys reordered.
  const committedJson = published.resultJson ?? JSON.stringify(published.result)
  const result = JSON.parse(committedJson) as Record<string, unknown>

  // 6. Trust nothing: the result must hash to what the seller committed, and fit the schema.
  const { resultHash: onchainHash } = await chain.getEscrowHashes(escrowId)
  const problems: string[] = []
  if (hashPreimage(committedJson).toLowerCase() !== onchainHash.toLowerCase()) problems.push('the result does not match the hash committed on-chain')
  const shape = capability.checkResult(result)
  if (!shape.ok) problems.push(`the result does not match the ${options.capability} output schema (${shape.error})`)
  let review: Review
  if (problems.length) {
    review = { accept: false, reason: `Automatic check failed: ${problems.join('; ')}.` }
  } else if (options.review) {
    review = await options.review(result)
  } else if (options.ai) {
    const verdict = await scoreWithAi(
      options.ai,
      { capability: options.capability, label: capability.name, rubric: capability.rubric, examples: capability.examples, brief: brief.brief, criteria: options.criteria ?? '', result },
      { log }
    )
    if (!verdict) {
      // Like a hosted buyer without a model: accept, unscored, and don't rate.
      log('the verifier model did not answer — accepting without a score')
      review = { accept: true }
    } else {
      log(`verifier: ${verdict.score}/100 — ${verdict.rationale}`)
      review = verdict.accept
        ? { accept: true, rating: verdict.score }
        : { accept: false, reason: `AI verification scored ${verdict.score}/100 (accept threshold 60). ${verdict.rationale}`.slice(0, 1000) }
    }
  } else {
    review = { accept: true }
  }

  if (!review.accept) {
    const reason = review.reason.trim()
    if (reason.length < 10) throw new Error('A dispute reason needs at least 10 characters.')
    await chain.raiseDispute(escrowId, textHash(reason))
    await submitDisputeReason(apiUrl, account, escrowId.toString(), reason, chainId)
    log(`escrow #${escrowId}: disputed — the arbiter decides`)
    return { escrowId, seller: sellerInfo, price, result, outcome: 'disputed' }
  }

  await chain.acceptAndSettle(escrowId)
  log(`escrow #${escrowId}: accepted — ${price} paid to ${seller.name}`)
  if (review.rating !== undefined) {
    const score = Math.max(1, Math.min(100, Math.round(review.rating)))
    const tx = await chain.rateSeller(escrowId, score)
    await fetch(`${apiUrl}/ratings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash: tx, chainId }) }).catch(() => {})
    log(`rated ${score}/100`)
    const registries = seller.erc8004AgentId && options.erc8004Feedback !== false ? await apiErc8004Registries(apiUrl, chainId) : null
    if (registries && seller.erc8004AgentId) {
      try {
        const feedbackTx = await chain
          .withErc8004(registries)
          .erc8004GiveFeedback(BigInt(seller.erc8004AgentId), dealFeedback({ score, capability: options.capability, chainId, escrowId }))
        log(`ERC-8004 feedback given (tx ${feedbackTx})`)
      } catch (error) {
        log(`ERC-8004 feedback not given: ${(error as Error).message.split('\n')[0]}`)
      }
    }
  }
  return { escrowId, seller: sellerInfo, price, result, outcome: 'settled' }
}
