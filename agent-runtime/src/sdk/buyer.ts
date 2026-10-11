import { DemoAgentRuntime } from '../runtime.ts'
import type { WalletAccount } from '../authHeaders.ts'
import type { EvmAdapter } from '../chain/evm.ts'
import { PRIMARY_CHAIN_ID } from '../chain/registry.ts'
import type { ChainAdapter } from '../chain/types.ts'
import { discoverAgents, registerOrSyncSelf, type DiscoveredAgent } from '../registryClient.ts'
import { countOffersBySide, isMyTurn, listNegotiationsForAgent, openNegotiation, respondToNegotiation } from '../negotiationClient.ts'
import { attachEscrowToOrder, listOrdersForAgent } from '../ordersClient.ts'
import { hireWithTask } from '../tasksClient.ts'
import { getEscrowResult } from '../resultsClient.ts'
import { submitDisputeReason } from '../disputesClient.ts'
import { hashPreimage, textHash } from '../shared/hashes.ts'
import { resolveCapability } from './capability.ts'
import { scoreWithAi, type AiModel } from './ai.ts'
import { DEFAULT_API_URL, type Logger, apiErc8004Registries, consoleLogger, sleep } from './common.ts'
import { dealFeedback } from '../shared/erc8004.ts'
import { checkDecision, type Offer, type OfferDecision } from './seller.ts'
import { accountOf, chainFor, openWallet, type WalletKey } from './wallet.ts'

export type Review =
  | { accept: true; /** Optional on-chain rating for the seller, 1–100. */ rating?: number }
  | { accept: false; /** Why — goes to the seller and the arbiter (≥ 10 characters). */ reason: string }

export interface HireOptions {
  /**
   * The buyer's wallet: it pays into escrow (needs the token plus a little native gas). An EVM
   * private key (0x…) for an EVM chain, a Solana secret key (64 bytes) for a Solana chain.
   */
  privateKey: WalletKey
  /** AgentEco API. Default: AGENTECO_API_URL, else the public testnet API. */
  apiUrl?: string
  /**
   * The chain to buy on: a CAIP-2 id (eip155:84532, solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1), a
   * network name (base-sepolia, solana-devnet) or an EVM chain id. Only sellers on this chain are
   * considered. Default: a given `sellerId`'s chain, else NETWORK (bsc-testnet) — or Solana devnet
   * for a Solana key.
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

/** The reason sent when a seller commits a result hash but never publishes a result that matches it. */
export const UNPUBLISHED_REASON =
  'The seller committed a result hash on-chain but never published a result that matches it, so the delivery could not be checked.'

/**
 * A hire in progress, as plain data: it can be saved (every field is JSON) and resumed later by
 * awaitDelivery / settleHire / disputeHire. The escrow id is a string for that reason.
 */
export interface HireHandle {
  version: 1
  /** The chain the escrow lives on (CAIP-2). */
  chainId: string
  escrowId: string
  seller: { id: string; name: string; wallet: string; erc8004AgentId: string | null }
  capability: string
  /** The agreed price, in token units. */
  price: string
  /** The brief as the capability's schema normalised it, and the criteria — for a verifier. */
  brief: unknown
  criteria: string
}

/** What every stage after openHire needs: the buyer's key and the API. */
export interface HireContext {
  privateKey: WalletKey
  apiUrl?: string
  /** How often to poll. Default 3000 ms. */
  pollMs?: number
  /** Give up waiting after this long (per stage). Default 20 minutes. */
  timeoutMs?: number
  log?: Logger
}

/** The delivery of a hire, after it was checked against the chain and the capability's schema. */
export type Delivery =
  /** `problems` lists every failed automatic check (hash, schema); empty means the result can be trusted as delivered. */
  | { state: 'delivered'; result: Record<string, unknown>; problems: string[] }
  /** The seller committed a hash but did not publish the result in time: dispute with UNPUBLISHED_REASON. */
  | { state: 'unpublished' }
  /** The escrow was refunded: the seller did not take or finish the job. */
  | { state: 'refunded' }

interface Stage {
  apiUrl: string
  account: WalletAccount
  chain: ChainAdapter
  chainId: string
  log: Logger
  pollMs: number
  deadline: number
  waitStep(what: string): Promise<void>
}

async function stageFor(handle: Pick<HireHandle, 'chainId'>, ctx: HireContext, deadline?: number): Promise<Stage> {
  const apiUrl = ctx.apiUrl ?? DEFAULT_API_URL
  const log = ctx.log ?? consoleLogger('SDK buyer')
  const pollMs = ctx.pollMs ?? 3000
  const until = deadline ?? Date.now() + (ctx.timeoutMs ?? 20 * 60_000)
  const wallet = await openWallet(handle.chainId, ctx.privateKey)
  return {
    apiUrl,
    account: wallet.account,
    chain: wallet.adapter,
    chainId: handle.chainId,
    log,
    pollMs,
    deadline: until,
    waitStep: async (what) => {
      if (Date.now() > until) throw new Error(`Timed out waiting for ${what}.`)
      await sleep(pollMs)
    },
  }
}

/** The options of the opening stages: everything of hire() except the decision about the result. */
export type OpenHireOptions = Omit<HireOptions, 'review' | 'ai'>

/**
 * Stages 1–4 of a hire: check the brief, pick a seller, negotiate within the budget, then store the
 * task and lock the agreed price in escrow. Resolves once the escrow is funded; nothing is delivered yet.
 */
export async function openHire(options: OpenHireOptions): Promise<HireHandle> {
  return openStage(options, undefined)
}

async function openStage(options: OpenHireOptions, deadline: number | undefined): Promise<HireHandle> {
  const apiUrl = options.apiUrl ?? DEFAULT_API_URL
  const name = options.name ?? 'SDK buyer'
  const log = options.log ?? consoleLogger(name)
  const pollMs = options.pollMs ?? 3000
  const until = deadline ?? Date.now() + (options.timeoutMs ?? 20 * 60_000)
  const account = await accountOf(options.privateKey)
  const chosenChain = options.chain === undefined ? null : chainFor(options.privateKey, options.chain, PRIMARY_CHAIN_ID)
  let chainId = chosenChain ?? chainFor(options.privateKey, undefined, PRIMARY_CHAIN_ID)
  const waitStep = async (what: string) => {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}.`)
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
  const chain = (await openWallet(chainId, options.privateKey)).adapter
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
      seller: seller.walletAddress,
    },
    chain
  )
  if (order) await attachEscrowToOrder(apiUrl, account, order.id, escrowId.toString())
  log(`escrow #${escrowId} funded — waiting for delivery`)

  return {
    version: 1,
    chainId,
    escrowId: escrowId.toString(),
    seller: { id: seller.id, name: seller.name, wallet: seller.walletAddress, erc8004AgentId: seller.erc8004AgentId ?? null },
    capability: options.capability,
    price,
    brief: brief.brief,
    criteria: options.criteria ?? '',
  }
}

/**
 * Waits for the seller's delivery and checks it: the result must hash to what the seller committed
 * on-chain and fit the capability's output schema. Never pays or disputes by itself. A seller that
 * committed a hash but has not published the result within half the review window comes back as
 * `unpublished` — waiting longer would let the window run out, and the contract would then pay the
 * seller for a result nobody could check.
 */
export async function awaitDelivery(handle: HireHandle, ctx: HireContext): Promise<Delivery> {
  return deliveryStage(handle, await stageFor(handle, ctx))
}

async function deliveryStage(handle: HireHandle, s: Stage): Promise<Delivery> {
  const escrowId = BigInt(handle.escrowId)
  for (;;) {
    const status = await s.chain.getEscrowStatus(escrowId)
    if (status === DELIVERED) break
    if (status === REFUNDED) return { state: 'refunded' }
    await s.waitStep(`escrow #${escrowId} to be delivered`)
  }
  const [{ deliveredAt }, { reviewWindow }] = await Promise.all([s.chain.getEscrowTimestamps(escrowId), s.chain.getEscrowWindows(escrowId)])
  const publishBy = Number(deliveredAt + reviewWindow / BigInt(2)) * 1000
  let published = await getEscrowResult(s.apiUrl, handle.escrowId, s.account, s.chainId)
  while (!published) {
    if (Date.now() >= publishBy) return { state: 'unpublished' }
    await s.waitStep(`the result of escrow #${escrowId}`)
    published = await getEscrowResult(s.apiUrl, handle.escrowId, s.account, s.chainId)
  }
  // The exact committed text: the API's `result` object comes from jsonb, with its keys reordered.
  const committedJson = published.resultJson ?? JSON.stringify(published.result)
  const result = JSON.parse(committedJson) as Record<string, unknown>

  // Trust nothing: the result must hash to what the seller committed, and fit the schema.
  const { resultHash: onchainHash } = await s.chain.getEscrowHashes(escrowId)
  const problems: string[] = []
  if (hashPreimage(committedJson).toLowerCase() !== onchainHash.toLowerCase()) problems.push('the result does not match the hash committed on-chain')
  const capability = await resolveCapability(s.apiUrl, handle.capability)
  const shape = capability.checkResult(result)
  if (!shape.ok) problems.push(`the result does not match the ${handle.capability} output schema (${shape.error})`)
  return { state: 'delivered', result, problems }
}

/** What settling did. */
export interface SettleOutcome {
  /** The rating given to the seller (1–100), when one was. */
  rated: number | null
  /** The ERC-8004 feedback transaction, when the seller had an identity and one was given. */
  erc8004FeedbackTx: string | null
}

/**
 * Accepts the delivered result and pays the seller. With a `rating` (1–100) it also rates the seller on-chain
 * and, when the seller has an ERC-8004 identity on the chain, publishes the rating as feedback
 * (unless `erc8004Feedback` is false).
 */
export async function settleHire(handle: HireHandle, ctx: HireContext, opts: { rating?: number; erc8004Feedback?: boolean } = {}): Promise<SettleOutcome> {
  return settleStage(handle, await stageFor(handle, ctx), opts)
}

async function settleStage(handle: HireHandle, s: Stage, opts: { rating?: number; erc8004Feedback?: boolean }): Promise<SettleOutcome> {
  const escrowId = BigInt(handle.escrowId)
  await s.chain.acceptAndSettle(escrowId)
  s.log(`escrow #${escrowId}: accepted — ${handle.price} paid to ${handle.seller.name}`)
  const outcome: SettleOutcome = { rated: null, erc8004FeedbackTx: null }
  if (opts.rating === undefined) return outcome
  const score = Math.max(1, Math.min(100, Math.round(opts.rating)))
  const tx = await s.chain.rateSeller(escrowId, score)
  await fetch(`${s.apiUrl}/ratings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash: tx, chainId: s.chainId }) }).catch(() => {})
  s.log(`rated ${score}/100`)
  outcome.rated = score
  const registries = handle.seller.erc8004AgentId && opts.erc8004Feedback !== false ? await apiErc8004Registries(s.apiUrl, s.chainId) : null
  if (registries && handle.seller.erc8004AgentId && s.chain.family === 'evm') {
    try {
      outcome.erc8004FeedbackTx = await (s.chain as EvmAdapter)
        .withErc8004(registries)
        .erc8004GiveFeedback(BigInt(handle.seller.erc8004AgentId), dealFeedback({ score, capability: handle.capability, chainId: s.chainId, escrowId }))
      s.log(`ERC-8004 feedback given (tx ${outcome.erc8004FeedbackTx})`)
    } catch (error) {
      s.log(`ERC-8004 feedback not given: ${(error as Error).message.split('\n')[0]}`)
    }
  }
  return outcome
}

/** Disputes the delivery: the reason (at least 10 characters) goes on-chain as a hash and to the API as text. */
export async function disputeHire(handle: HireHandle, ctx: HireContext, reason: string): Promise<void> {
  return disputeStage(handle, await stageFor(handle, ctx), reason)
}

async function disputeStage(handle: HireHandle, s: Stage, reasonText: string): Promise<void> {
  const reason = reasonText.trim()
  if (reason.length < 10) throw new Error('A dispute reason needs at least 10 characters.')
  const escrowId = BigInt(handle.escrowId)
  await s.chain.raiseDispute(escrowId, textHash(reason))
  await submitDisputeReason(s.apiUrl, s.account, handle.escrowId, reason, s.chainId)
  s.log(`escrow #${escrowId}: disputed — the arbiter decides`)
}

/**
 * Hire an agent in one call: find a seller, negotiate within your budget,
 * store the task and lock the agreed price in escrow, wait for delivery,
 * check the result against the on-chain hash and the capability's output
 * schema, then settle (or dispute). Resolves with the result.
 *
 * It is the stages above in a row — openHire, awaitDelivery, then settleHire or disputeHire —
 * with `review` / `ai` deciding between the last two. Use the stages to decide later, elsewhere,
 * or from another process.
 */
export async function hire(options: HireOptions): Promise<HireResult> {
  if (!options.review && !options.ai) {
    throw new Error('Pass review(result) or ai (your own model): hire() never pays for a result nobody checked. To accept anything that fits the schema: review: () => ({ accept: true }).')
  }
  // One deadline for the whole deal, as before.
  const deadline = Date.now() + (options.timeoutMs ?? 20 * 60_000)
  const handle = await openStage(options, deadline)
  const s = await stageFor(handle, { ...options, log: options.log ?? consoleLogger(options.name ?? 'SDK buyer') }, deadline)
  const escrowId = BigInt(handle.escrowId)
  const sellerInfo = { id: handle.seller.id, name: handle.seller.name, wallet: handle.seller.wallet }
  const base = { escrowId, seller: sellerInfo, price: handle.price }

  const delivery = await deliveryStage(handle, s)
  if (delivery.state === 'refunded') throw new Error(`Escrow #${escrowId} was refunded — the seller did not take or finish the job.`)
  if (delivery.state === 'unpublished') {
    await disputeStage(handle, s, UNPUBLISHED_REASON)
    s.log(`escrow #${escrowId}: the seller never published its result — disputed`)
    return { ...base, result: null, outcome: 'disputed' }
  }
  const { result, problems } = delivery

  let review: Review
  if (problems.length) {
    review = { accept: false, reason: `Automatic check failed: ${problems.join('; ')}.` }
  } else if (options.review) {
    review = await options.review(result)
  } else if (options.ai) {
    const capability = await resolveCapability(s.apiUrl, handle.capability)
    const verdict = await scoreWithAi(
      options.ai,
      { capability: handle.capability, label: capability.name, rubric: capability.rubric, examples: capability.examples, brief: handle.brief, criteria: handle.criteria, result },
      { log: s.log }
    )
    if (!verdict) {
      // Like a hosted buyer without a model: accept, unscored, and don't rate.
      s.log('the verifier model did not answer — accepting without a score')
      review = { accept: true }
    } else {
      s.log(`verifier: ${verdict.score}/100 — ${verdict.rationale}`)
      review = verdict.accept
        ? { accept: true, rating: verdict.score }
        : { accept: false, reason: `AI verification scored ${verdict.score}/100 (accept threshold 60). ${verdict.rationale}`.slice(0, 1000) }
    }
  } else {
    review = { accept: true }
  }

  if (!review.accept) {
    await disputeStage(handle, s, review.reason)
    return { ...base, result, outcome: 'disputed' }
  }
  await settleStage(handle, s, { rating: review.rating, erc8004Feedback: options.erc8004Feedback })
  return { ...base, result, outcome: 'settled' }
}
