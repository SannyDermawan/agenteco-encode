import { DemoAgentRuntime } from '../runtime.ts'
import { PRIMARY_CHAIN_ID } from '../chain/registry.ts'
import { chainFamily } from '../chain/multi.ts'
import type { EvmAdapter } from '../chain/evm.ts'
import type { ChainAdapter, ChainId } from '../chain/types.ts'
import { registerOrSyncSelf } from '../registryClient.ts'
import { countOffersBySide, isMyTurn, listNegotiationsForAgent, respondToNegotiation } from '../negotiationClient.ts'
import { hashPreimage, resultHash, textHash } from '../shared/hashes.ts'
import { isCapabilityId } from '../shared/capabilities/definitions.ts'
import { mentionsAiUnavailable, prepareJob, type PreparedJob } from '../capabilities/prepare.ts'
import { getTaskByEscrow } from '../tasksClient.ts'
import { getEscrowResult, publishEscrowResult } from '../resultsClient.ts'
import { getDispute, submitDisputeResponseText } from '../disputesClient.ts'
import { HEARTBEAT_SECONDS, SELLER_RESPONSE_WINDOW_SECONDS } from '../durations.ts'
import { buildAuthHeaders, type WalletAccount } from '../authHeaders.ts'
import { sameWallet } from '../shared/wallets.ts'
import { resolveCapability } from './capability.ts'
import { defendWithAi, runPlatformJob, type AiModel } from './ai.ts'
import { apiErc8004Registries } from './common.ts'
import { DEFAULT_API_URL, type Logger, consoleLogger, sleep } from './common.ts'
import { chainFor, openEvmWallet, openWallet, walletAddress, type Wallet, type WalletKey } from './wallet.ts'

/** One paid job, handed to your code once the escrow is funded and the brief checks out. */
export interface Job {
  escrowId: bigint
  capability: string
  /** The buyer's brief, already validated against the capability's input schema. */
  brief: unknown
  /** What the buyer said a good result must satisfy ("" when none). */
  criteria: string
  /** The agreed price, in the settlement token (e.g. "0.08"). */
  price: string
  buyer: string
  /** Platform capabilities only: the data AgentEco's code computed (CSV stats, market data, tx facts). */
  prepared?: PreparedJob
}

export interface DisputeContext {
  escrowId: bigint
  job: Job
  /** What you delivered. */
  result: Record<string, unknown>
  /** The buyer's reason, when it has reached the API. */
  reason: string | null
}

/** A buyer's offer, handed to your `onOffer` when it is your turn to answer. */
export interface Offer {
  negotiationId: string
  capability: string
  buyerAgentId: string
  /** The buyer's latest offer, in the settlement token. */
  price: number
  /** Your listing price. */
  listPrice: number
  /** How many counter-offers you have already made in this negotiation. */
  countersSoFar: number
  /** Every move so far, oldest first. */
  history: { side: 'buyer' | 'seller'; action: string; price: number | null; reason: string | null }[]
}

/** Your answer to an offer. Accept takes the buyer's price; a counter needs a positive price. A reason (up to 280 characters) is shown to the buyer. */
export type OfferDecision =
  | { action: 'accept'; reason?: string }
  | { action: 'counter'; price: number; reason?: string }
  | { action: 'reject'; reason?: string }

export interface SellerAgentOptions {
  /**
   * The seller's own wallet: it signs registry writes and on-chain moves, and is paid. Needs a little
   * native gas. An EVM private key (0x…) for an EVM chain, a Solana secret key (64 bytes) for a Solana chain.
   */
  privateKey: WalletKey
  /** AgentEco API. Default: AGENTECO_API_URL, else the public testnet API. */
  apiUrl?: string
  /**
   * The chain to trade on: a CAIP-2 id (eip155:84532, solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1), a
   * network name (base-sepolia, solana-devnet) or an EVM chain id. Default: an attached listing's
   * chain, else NETWORK (bsc-testnet) — or Solana devnet for a Solana key.
   */
  chain?: string
  /**
   * Register this listing's ERC-8004 identity on its chain (once, from this wallet, which then
   * owns it) when the API reports registries there (EVM chains only). Default false: it costs a transaction.
   */
  erc8004?: boolean
  /**
   * The listing you created on the app's Register Own Agent page. The agent attaches to it:
   * its name, description, capability and price come from the listing, and this key must be
   * the listing's agent wallet. Without `agentId`, the agent lists itself from `name`,
   * `description`, `capability` and `price`, owned by this key.
   */
  agentId?: string
  name?: string
  description?: string
  /** What you sell: a platform capability id, or one you published in the registry. */
  capability?: string
  /** Listing price, in the settlement token. */
  price?: number
  /**
   * The lowest you settle for, used by the default negotiation policy. It stays on your
   * machine: AgentEco never stores or sees it. Default: the listing price (no discount).
   */
  floor?: number
  /**
   * Decide each offer yourself (your own rules or model). Without it, the default policy
   * concedes from the listing price toward `floor` in up to three steps. AgentEco only
   * relays the moves; a side that stays silent too long lets the negotiation expire.
   */
  onOffer?: (offer: Offer) => Promise<OfferDecision> | OfferDecision
  category?: 'Research' | 'Data' | 'Content' | 'Automation'
  /**
   * Your work. Return the result object; it must match the capability's output
   * schema (checked before anything is committed on-chain). Required for a
   * community capability. For a platform capability, pass this or `ai`.
   */
  handle?: (job: Job) => Promise<Record<string, unknown>>
  /**
   * Your own model (see openAiCompatible). AgentEco gives self-hosted agents no AI:
   * a platform capability is served by the same prompts AgentEco's hosted sellers
   * use, running on YOUR model and key, and disputes are answered by it too (unless
   * you pass respondToDispute). The four platform capabilities need an AI: with
   * neither `ai` nor `handle`, createSellerAgent throws. If the model fails when a
   * job comes, nothing is delivered and the contract's timeout refunds the buyer.
   */
  ai?: AiModel
  /** Style and focus for your model's prose (≤ 500 chars) — never the output shape. */
  instructions?: string
  /** Answer a buyer's dispute (≤ 1000 characters). Return null to stay silent. */
  respondToDispute?: (ctx: DisputeContext) => Promise<string | null>
  /** How often to poll for negotiations and escrows. Default 3000 ms. */
  pollMs?: number
  log?: Logger
}

export interface SellerAgent {
  /** The seller wallet's address. */
  readonly address: string
  /** Registers (or attaches to) the listing, then serves until stop(). */
  start(): Promise<void>
  /** Stops serving and tells AgentEco the agent is offline. */
  stop(): void
  /** One pass over negotiations and escrows — for tests and custom loops. */
  runOnce(): Promise<void>
}

// AgentEco.sol OrderStatus
const FUNDED = 1
const EXECUTING = 2
const DISPUTED = 4
const SETTLED = 5
const REFUNDED = 6
const ZERO_HASH = `0x${'0'.repeat(64)}`

/**
 * An `onOffer` answer, checked before it is relayed, so a malformed answer never reaches the other side.
 * A counter that already meets the other side's offer is simply an accept.
 */
export function checkDecision(d: OfferDecision, offered: number, side: 'buyer' | 'seller'): OfferDecision {
  const reason = typeof d?.reason === 'string' && d.reason.trim() ? d.reason.trim().slice(0, 280) : undefined
  if (d?.action === 'accept') return { action: 'accept', reason }
  if (d?.action === 'reject') return { action: 'reject', reason }
  if (d?.action === 'counter' && typeof d.price === 'number' && Number.isFinite(d.price) && d.price > 0) {
    const price = Math.round(d.price * 1e6) / 1e6
    const meets = side === 'seller' ? price <= offered : price >= offered
    return meets ? { action: 'accept', reason } : { action: 'counter', price, reason }
  }
  throw new Error(`onOffer returned ${JSON.stringify(d)}; expected { action: 'accept' | 'reject' } or { action: 'counter', price }`)
}

/** Tries per escrow before a failing job is dropped (each try may cost a model call). */
export const MAX_ATTEMPTS = 5
const FIRST_PAUSE_MS = 5_000
const MAX_PAUSE_MS = 60_000

/**
 * What to do after a job failed `failures` times in a row: pause and retry —
 * 5 s, then 10, 20, 40 (capped at 60), so a briefly rate-limited model has
 * time to recover — or give up, after MAX_ATTEMPTS failures or as soon as the
 * on-chain deadline for the step has passed (no retry can help then).
 */
export function retryDecision(failures: number, deadlinePassed: boolean): { giveUp: true } | { giveUp: false; waitMs: number } {
  if (deadlinePassed || failures >= MAX_ATTEMPTS) return { giveUp: true }
  return { giveUp: false, waitMs: Math.min(MAX_PAUSE_MS, FIRST_PAUSE_MS * 2 ** (failures - 1)) }
}

/**
 * A self-hosted seller agent in a few lines: it lists itself in the
 * marketplace, haggles within your floor, and for every funded escrow naming
 * its wallet checks the task against the on-chain hash, accepts the job, runs
 * your handler, commits the result's hash and publishes the result.
 */
export function createSellerAgent(options: SellerAgentOptions): SellerAgent {
  const apiUrl = options.apiUrl ?? DEFAULT_API_URL
  const log = options.log ?? consoleLogger(options.name ?? 'seller')
  const pollMs = options.pollMs ?? 3000
  const address = walletAddress(options.privateKey)
  const chosenChain = options.chain === undefined ? null : chainFor(options.privateKey, options.chain, PRIMARY_CHAIN_ID)
  /** Where this agent's escrows live; an attached listing may move it to the listing's chain. */
  let chainId: ChainId = chosenChain ?? chainFor(options.privateKey, undefined, PRIMARY_CHAIN_ID)
  // Opened on first use: a Solana signer is derived asynchronously, and createSellerAgent is not.
  let account!: WalletAccount
  let chain!: ChainAdapter
  let openedOn: ChainId | null = null
  function use(wallet: Wallet): void {
    account = wallet.account
    chain = wallet.adapter
    chainId = wallet.chainId
    openedOn = wallet.chainId
  }
  async function openOn(id: ChainId): Promise<void> {
    if (openedOn === id) return
    use(typeof options.privateKey === 'string' ? openEvmWallet(id, options.privateKey) : await openWallet(id, options.privateKey))
  }
  // An EVM chain nobody configured fails here, as it always did; only a Solana signer must wait.
  if (typeof options.privateKey === 'string') use(openEvmWallet(chainId, options.privateKey))

  function checkWorker(capability: string) {
    if (!options.handle && !isCapabilityId(capability)) {
      throw new Error(`"${capability}" is a community capability — pass a handle(job) that produces its result.`)
    }
    if (capability === 'tx_explainer' && chainFamily(chainId) !== 'evm') {
      throw new Error('"tx_explainer" explains EVM transactions and cannot be sold on a Solana chain.')
    }
    // The four platform capabilities are written by an AI: bring one (or your own handler).
    if (!options.handle && !options.ai) {
      throw new Error(`"${capability}" needs an AI: pass ai (e.g. openAiCompatible({ baseUrl, apiKey, model })) or your own handle(job).`)
    }
  }

  if (!options.agentId) {
    for (const field of ['name', 'description', 'capability', 'price'] as const) {
      if (options[field] === undefined) throw new Error(`Pass ${field}, or the agentId of the listing you registered in the app.`)
    }
    checkWorker(options.capability!)
  }

  /** What this agent sells and asks: from the options, or from the listing it attaches to. */
  let listing: { name: string; capability: string; price: number } | null = options.agentId
    ? null
    : { name: options.name!, capability: options.capability!, price: options.price! }
  let runtime: DemoAgentRuntime | null = null

  let agentId: string | null = null
  let lastBeat = 0
  let running = false
  /** Escrows whose last try failed: when the next try may run, and how many failed in a row (see retryDecision). */
  const retries = new Map<bigint, { failures: number; nextTryAt: number }>()
  /** Escrows with nothing left to do. Every step is idempotent against on-chain status, so a restart just re-checks. */
  const finished = new Set<bigint>()
  /** Results whose on-chain hash is committed, kept until the API has the plaintext. */
  const unpublished = new Map<bigint, { capability: string; result: Record<string, unknown> }>()

  /** The listing registered in the app: this key must be its agent wallet. */
  async function attach(id: string): Promise<{ name: string; capability: string; price: number }> {
    const res = await fetch(`${apiUrl}/agents/${id}`)
    if (!res.ok) throw new Error(`Listing ${id} not found (${res.status}). Copy the agent id from the Register Own Agent page.`)
    const agent = (await res.json()) as {
      role: string
      name: string
      capabilities: string[]
      price: string
      walletAddress: string | null
      taskStatus: string | null
      chainId?: string
    }
    if (agent.role !== 'seller') throw new Error(`Listing ${id} is not a seller.`)
    if (agent.chainId && agent.chainId !== chainId) {
      if (chosenChain) throw new Error(`Listing ${id} trades on ${agent.chainId}, not ${chosenChain}.`)
      await openOn(agent.chainId)
    }
    if (agent.taskStatus !== null) throw new Error(`Listing ${id} is hosted by AgentEco; a self-hosted agent cannot run it.`)
    if (!agent.walletAddress || !sameWallet(agent.walletAddress, address)) {
      throw new Error(`Listing ${id} names the agent wallet ${agent.walletAddress}, but this key is ${address}. Use that wallet's key, or register this one.`)
    }
    if (options.capability && options.capability !== agent.capabilities[0]) {
      throw new Error(`Listing ${id} sells "${agent.capabilities[0]}", not "${options.capability}".`)
    }
    return { name: agent.name, capability: agent.capabilities[0], price: Number(agent.price) }
  }

  async function register(): Promise<string> {
    let id: string
    if (options.agentId) {
      listing = await attach(options.agentId)
      checkWorker(listing.capability)
      id = options.agentId
    } else {
      // The floor is not sent: it is this agent's private business, kept on this machine.
      const agent = await registerOrSyncSelf(
        {
          name: options.name!,
          role: 'seller',
          capabilities: [options.capability!],
          description: options.description!,
          category: options.category ?? 'Automation',
          service: options.name!,
          basePrice: options.price!,
        },
        { apiUrl, account, walletAddress: address, chainId: chain.chainId }
      )
      id = agent.id
    }
    // Tried once per run: a failure is logged, never retried in a loop (no duplicate identities).
    if (options.erc8004) await registerIdentity(id).catch((error) => log(`ERC-8004 registration failed: ${(error as Error).message.split('\n')[0]}`))
    const l = listing!
    runtime = new DemoAgentRuntime({
      name: l.name,
      role: 'seller',
      capabilities: [l.capability],
      description: '',
      basePrice: l.price,
      minimumPrice: options.floor ?? l.price,
    })
    const how = options.onOffer ? 'your own negotiation logic' : `floor ${options.floor ?? l.price}, kept on this machine`
    log(`${options.agentId ? 'attached to' : 'listed as'} ${id} — ${l.capability} at ${l.price} (${how})`)
    return id
  }

  /**
   * This listing's ERC-8004 identity: registered once from this wallet, pointing at the
   * listing's registration file, then recorded with the API (which checks it on-chain).
   */
  async function registerIdentity(id: string): Promise<void> {
    if (chain.family !== 'evm') {
      log(`ERC-8004: not available on ${chain.chainId} — skipped`)
      return
    }
    const registries = await apiErc8004Registries(apiUrl, chain.chainId)
    if (!registries) {
      log(`ERC-8004: no registries on ${chain.chainId} — skipped`)
      return
    }
    const res = await fetch(`${apiUrl}/agents/${id}`)
    const current = res.ok ? ((await res.json()) as { erc8004AgentId?: string | null }) : null
    if (current?.erc8004AgentId) return
    const { agentId, txHash } = await (chain as EvmAdapter).withErc8004(registries).erc8004Register(`${apiUrl}/agents/${id}/registration.json`)
    const recorded = await fetch(`${apiUrl}/agents/${id}/erc8004`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await buildAuthHeaders(account)) },
      body: JSON.stringify({ txHash }),
    })
    if (!recorded.ok) throw new Error(`Recording the ERC-8004 identity failed (${recorded.status}): ${await recorded.text()}`)
    log(`ERC-8004: registered as agent #${agentId} on ${chain.chainId}`)
  }

  /** Tells AgentEco this agent is running (or stopping): the marketplace shows it online only while it beats. */
  async function heartbeat(id: string, online: boolean): Promise<void> {
    const res = await fetch(`${apiUrl}/agents/${id}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await buildAuthHeaders(account)) },
      body: JSON.stringify({ online }),
    })
    if (!res.ok) throw new Error(`heartbeat failed (${res.status}): ${await res.text()}`)
    lastBeat = Date.now()
  }

  async function negotiate(id: string): Promise<void> {
    for (const n of await listNegotiationsForAgent(apiUrl, account, id, 'open')) {
      if (!isMyTurn(n, 'seller')) continue
      const offered = Number(n.messages[n.messages.length - 1].price)
      const countersSoFar = countOffersBySide(n, 'seller')
      let decision: OfferDecision
      let source: 'rule' | 'agent' = 'rule'
      if (options.onOffer) {
        try {
          decision = checkDecision(
            await options.onOffer({
              negotiationId: n.id,
              capability: n.capability,
              buyerAgentId: n.buyerAgentId,
              price: offered,
              listPrice: listing!.price,
              countersSoFar,
              history: n.messages.map((m) => ({ side: m.side, action: m.action, price: m.price === null ? null : Number(m.price), reason: m.reason ?? null })),
            }),
            offered,
            'seller'
          )
          source = 'agent'
        } catch (error) {
          // Tried again next poll; if it keeps failing, the negotiation expires and the buyer moves on.
          log(`negotiation ${n.id.slice(0, 8)}: onOffer failed (${(error as Error).message}) — will retry`)
          continue
        }
      } else {
        decision = runtime!.decideOnOffer(offered, countersSoFar)
      }
      log(`negotiation ${n.id.slice(0, 8)}: buyer offers ${offered} → ${decision.action}${decision.action === 'counter' ? ` ${decision.price}` : ''}`)
      await respondToNegotiation(apiUrl, account, n.id, {
        side: 'seller',
        action: decision.action,
        ...(decision.action === 'counter' ? { price: decision.price } : {}),
        ...(decision.reason ? { reason: decision.reason } : {}),
        source,
      })
    }
  }

  async function publish(escrowId: bigint): Promise<void> {
    const pending = unpublished.get(escrowId)
    if (!pending) return
    try {
      await publishEscrowResult(apiUrl, escrowId.toString(), pending.capability, pending.result, chain.chainId)
      unpublished.delete(escrowId)
      log(`escrow #${escrowId}: result published`)
    } catch (error) {
      log(`escrow #${escrowId}: publishing the result failed — will retry (${(error as Error).message})`)
    }
  }

  /** Reads the task behind an escrow and checks it before any commitment. Null = never take this job. */
  async function checkedJob(escrowId: bigint): Promise<Job | null | 'wait'> {
    const task = await getTaskByEscrow(apiUrl, escrowId.toString(), account, chain.chainId)
    if (!task) return 'wait' // the buyer links the task right after funding
    const { taskHash } = await chain.getEscrowHashes(escrowId)
    if (hashPreimage(task.preimage).toLowerCase() !== taskHash.toLowerCase()) {
      log(`escrow #${escrowId}: the task does not match the on-chain taskHash — not taking it`)
      return null
    }
    if (!sameWallet(task.seller, address) || task.capability !== listing!.capability) {
      log(`escrow #${escrowId}: the task is for another seller or capability — not taking it`)
      return null
    }
    const capability = await resolveCapability(apiUrl, task.capability)
    const brief = capability.checkBrief(task.brief)
    if (!brief.ok) {
      log(`escrow #${escrowId}: invalid brief (${brief.error}) — not taking it; the accept timeout refunds the buyer`)
      return null
    }
    const job: Job = { escrowId, capability: task.capability, brief: brief.brief, criteria: task.criteria, price: task.price, buyer: task.buyer }
    if (isCapabilityId(task.capability)) {
      const evm = chain.family === 'evm' ? (chain as EvmAdapter) : null
      const prepared = await prepareJob(task.capability, task.brief, { publicClient: evm?.client, agentEcoAddress: evm?.config.agentEco })
      if (!prepared.ok) {
        log(`escrow #${escrowId}: ${prepared.reason} — not taking it`)
        return null
      }
      job.prepared = prepared.job
    }
    return job
  }

  async function work(job: Job): Promise<Record<string, unknown>> {
    // No fallback: when the model never answers, nothing is delivered. The job is retried with
    // growing pauses (see retryDecision), then dropped, and the contract's timeout refunds the buyer.
    const raw = options.handle
      ? await options.handle(job)
      : await runPlatformJob(job.prepared!, options.ai!, { criteria: job.criteria, instructions: options.instructions, log })
    if (!raw) throw new Error(`${job.capability} needs the model, and it did not answer`)
    // The API refuses this too; catching it here keeps it from being committed on-chain.
    if (isCapabilityId(job.capability) && mentionsAiUnavailable(job.capability, raw)) {
      throw new Error('the result says "AI unavailable" — a platform capability must be written by a model')
    }
    const capability = await resolveCapability(apiUrl, job.capability)
    const checked = capability.checkResult(raw)
    if (!checked.ok) throw new Error(`the result does not match the ${job.capability} output schema: ${checked.error}`)
    // Commit exactly the object returned: its hash goes on-chain, the same object to the API.
    return raw
  }

  /** Once per dispute, inside the response window: the job and result come from the API, so this survives restarts. */
  async function answerDispute(escrowId: bigint): Promise<void> {
    if (!options.respondToDispute && !options.ai) return
    const [{ disputeResponseHash }, info] = await Promise.all([chain.getEscrowHashes(escrowId), chain.getEscrowDisputeInfo(escrowId)])
    if (disputeResponseHash !== ZERO_HASH) return
    if (Math.floor(Date.now() / 1000) > Number(info.disputedAt) + SELLER_RESPONSE_WINDOW_SECONDS) return
    const [task, delivered, dispute] = await Promise.all([
      getTaskByEscrow(apiUrl, escrowId.toString(), account, chain.chainId),
      getEscrowResult(apiUrl, escrowId.toString(), account, chain.chainId),
      getDispute(apiUrl, escrowId.toString(), account, chain.chainId),
    ])
    if (!task || !delivered) return
    const job: Job = { escrowId, capability: task.capability, brief: task.brief, criteria: task.criteria, price: task.price, buyer: task.buyer }
    const reason = dispute?.reason || null
    let text: string | null
    if (options.respondToDispute) {
      text = await options.respondToDispute({ escrowId, job, result: delivered.result, reason })
    } else {
      const capability = await resolveCapability(apiUrl, task.capability)
      text = await defendWithAi(
        options.ai!,
        { capability: task.capability, label: capability.name, rubric: capability.rubric, examples: capability.examples, brief: task.brief, criteria: task.criteria, result: delivered.result },
        reason ?? 'The buyer gave no reason.',
        log
      )
    }
    if (!text?.trim()) return
    const response = text.trim().slice(0, 1000)
    await chain.submitDisputeResponse(escrowId, textHash(response))
    await submitDisputeResponseText(apiUrl, account, escrowId.toString(), response, 'api', chain.chainId)
    log(`escrow #${escrowId}: answered the dispute`)
  }

  /** Moves one escrow as far as it can go. True once nothing is left to do. */
  async function advance(escrowId: bigint): Promise<boolean> {
    const status = await chain.getEscrowStatus(escrowId)
    if (status === DISPUTED) {
      await answerDispute(escrowId)
      return false
    }
    if (status !== FUNDED && status !== EXECUTING) {
      // CREATED waits for funding; DELIVERED stays watched in case of a dispute.
      await publish(escrowId)
      return (status === SETTLED || status === REFUNDED) && !unpublished.has(escrowId)
    }

    const job = await checkedJob(escrowId)
    if (job === 'wait') return false
    if (!job) return true

    if (status === FUNDED) {
      await chain.startExecution(escrowId)
      log(`escrow #${escrowId}: accepted (${job.price}) — working…`)
    }
    const result = await work(job)
    await chain.markDelivered(escrowId, resultHash(result))
    unpublished.set(escrowId, { capability: job.capability, result })
    log(`escrow #${escrowId}: delivered`)
    await publish(escrowId)
    return false // stays watched until settled, refunded or disputed
  }

  async function runOnce(): Promise<void> {
    await openOn(chainId)
    agentId ??= await register()
    if (Date.now() - lastBeat >= HEARTBEAT_SECONDS * 1000) await heartbeat(agentId, true)
    await negotiate(agentId)
    const mine = (await chain.listEscrows()).filter(
      (e) => sameWallet(e.seller, address) && !finished.has(e.id)
    )
    for (const { id } of mine) {
      const retry = retries.get(id)
      if (retry && Date.now() < retry.nextTryAt) continue
      try {
        if (await advance(id)) finished.add(id)
        retries.delete(id)
      } catch (error) {
        const failures = (retry?.failures ?? 0) + 1
        const decision = retryDecision(failures, await stepDeadlinePassed(id))
        const why = (error as Error).message
        if (decision.giveUp) {
          finished.add(id)
          retries.delete(id)
          log(`escrow #${id} failed ${failures} time(s) (${why}) — giving up; the contract's timeout refunds the buyer`)
        } else {
          retries.set(id, { failures, nextTryAt: Date.now() + decision.waitMs })
          log(`escrow #${id} failed (${why}) — retrying in ${Math.round(decision.waitMs / 1000)}s`)
        }
      }
    }
  }

  /** Whether the on-chain deadline for this escrow's current step is over: then no retry can help. */
  async function stepDeadlinePassed(escrowId: bigint): Promise<boolean> {
    try {
      const now = BigInt(Math.floor(Date.now() / 1000))
      const status = await chain.getEscrowStatus(escrowId)
      if (status === FUNDED) return now > (await chain.getEscrowDisputeInfo(escrowId)).acceptDeadline
      if (status === EXECUTING) return now > (await chain.getEscrowWindows(escrowId)).executionDeadline
      return false
    } catch {
      return false // the chain read failed too: let the attempt cap decide
    }
  }

  return {
    address,
    async start() {
      running = true
      await openOn(chainId)
      const where = chain.family === 'evm' ? `${(chain as EvmAdapter).config.chain.name} (${chain.chainId}), AgentEco ${(chain as EvmAdapter).config.agentEco}` : `Solana (${chain.chainId})`
      log(`wallet ${address}, ${where}`)
      while (running) {
        try {
          await runOnce()
        } catch (error) {
          log(`poll failed: ${(error as Error).message}`)
        }
        if (running) await sleep(pollMs)
      }
      log('stopped')
    },
    stop() {
      running = false
      if (agentId) heartbeat(agentId, false).catch((error) => log(`could not report going offline: ${(error as Error).message}`))
    },
    runOnce,
  }
}
