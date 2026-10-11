import { privateKeyToAccount } from 'viem/accounts'
import type { Address, LocalAccount } from 'viem'
import { buildAuthHeaders } from '../../../agent-runtime/src/authHeaders.ts'
import {
  DemoAgentRuntime,
  respondToNegotiation,
  listNegotiationsForAgent,
  countOffersBySide,
  isMyTurn,
  publishEscrowResult,
  getDispute,
  submitDisputeResponseText,
} from '../../../agent-runtime/src/index.ts'
import { withChain } from '../../../agent-runtime/src/chainQuery.ts'
import type { EscrowBasic, EvmAdapter } from '../../../agent-runtime/src/chain/evm.ts'
import { SELLER_RESPONSE_WINDOW_SECONDS } from '../../../agent-runtime/src/durations.ts'
import { defendDispute } from '../ai/judge.ts'
import { NEGOTIATION_ROUNDS } from '../../../agent-runtime/src/runtime.ts'
import { getTaskByEscrow } from '../../../agent-runtime/src/tasksClient.ts'
import { hashPreimage, resultHash, textHash } from '../../../agent-runtime/src/shared/hashes.ts'
import { isCapabilityId } from '../../../agent-runtime/src/shared/capabilities/definitions.ts'
import { prepareJob, runJob } from '../capabilities/execute.ts'
import { decideTurn } from '../ai/negotiate.ts'
import { buildNegotiationExtras } from './negotiationContext.ts'
import { decryptAgentKey } from '../agentKeyCrypto.ts'
import { prisma, prismaWithAgentKey } from '../db.ts'
import { log, logError } from '../log.ts'
import { warnIfLowGas } from '../gasWatch.ts'
import { API_URL, refundLeftover } from './buyerTaskHost.ts'
import { readChain, servedChainIdsOf, signerChain } from '../chains.ts'
import { registerHostedIdentity } from '../erc8004.ts'

// AgentEco.sol OrderStatus enum ordering.
const ON_CHAIN_CREATED = 0
const ON_CHAIN_FUNDED = 1
const ON_CHAIN_EXECUTING = 2
const ON_CHAIN_DELIVERED = 3
const ON_CHAIN_DISPUTED = 4
const ON_CHAIN_SETTLED = 5

export interface HostedSellerAgentRow {
  id: string
  /** The chain this seller trades on — its wallet, escrows and payouts are there. */
  chainId: string
  name: string
  capabilities: string[]
  price: unknown // Prisma.Decimal
  minimumPrice: unknown
  walletAddress: string | null
  agentWalletKey: string | null
  depositorWallet: string | null
  escrowScanBlock: bigint | null
  /** Seller's style guide for the model (≤ 500 chars) — see prompts/execute.ts. */
  customInstructions: string | null
  /** ERC-8004 identity on its chain, once registered. */
  erc8004AgentId: string | null
}

/** One hosted seller at work: its row, its signing adapter on its chain, and its account. */
interface Seller {
  row: HostedSellerAgentRow
  chain: EvmAdapter
  account: LocalAccount
  label: string
}

/** Escrow ids are numbered per chain: every in-memory record below is keyed by both. */
const key = (chain: EvmAdapter, escrowId: bigint) => `${chain.chainId}:${escrowId}`

/**
 * Escrows each seller has nothing left to do on, in memory only. After a host
 * restart everything is re-checked once — every step below is idempotent
 * against on-chain status, so that never double-executes anything.
 */
const finishedEscrows = new Map<string, Set<bigint>>()

/**
 * Results already committed on-chain (markDelivered) whose publish to the API
 * failed. The model's output isn't reproducible, so the exact object is kept
 * here and retried every cycle until the API has it.
 */
const unpublished = new Map<string, { capability: string; result: Record<string, unknown> }>()

/** Funded escrows already logged as waiting for their brief — logged once, not every cycle. */
const waitingForTask = new Set<string>()

/** Disputes this seller has answered, or decided not to answer. */
const defended = new Set<string>()
/** Responses committed on-chain whose text hasn't reached the API yet (exact string, retried). */
const pendingResponses = new Map<string, string>()
/** Delivered escrows logged as missing their published result. */
const missingResultLogged = new Set<string>()
/** Sellers on a chain this host does not serve, logged once. */
const unservedLogged = new Set<string>()

const ZERO_HASH = `0x${'0'.repeat(64)}`

async function hasPublishedResult(s: Seller, escrowId: bigint): Promise<boolean> {
  const res = await fetch(withChain(`${API_URL}/escrow-results/${escrowId}`, s.chain.chainId), { headers: await buildAuthHeaders(s.account) })
  return res.ok
}

async function publishPending(s: Seller, escrowId: bigint): Promise<boolean> {
  const k = key(s.chain, escrowId)
  const pending = unpublished.get(k)
  if (!pending) return false
  try {
    await publishEscrowResult(API_URL, escrowId.toString(), pending.capability, pending.result, s.chain.chainId)
    unpublished.delete(k)
    log(`[host:${s.label}] escrow #${escrowId}: result published.`)
    return true
  } catch (error) {
    logError(`[host:${s.label}] escrow #${escrowId}: result publish failed — will retry`, error, 'HOST')
    return false
  }
}

/**
 * Works one escrow as far as it can go this cycle (spec §7, §8.3):
 * FUNDED → read the task from the API, check it against the on-chain
 * taskHash, validate the brief and compute the code part → startExecution →
 * AI → markDelivered(resultHash) → publish the result. Returns true once
 * there's nothing left for the seller to do on it.
 *
 * Never starting execution on a bad task is deliberate: the accept timeout
 * then refunds the buyer. Once started, a job that can't be delivered
 * (translation without AI) is left to the execution timeout.
 */
async function advanceEscrow(s: Seller, escrowId: bigint): Promise<boolean> {
  const { chain, label } = s
  const k = key(chain, escrowId)
  const status = await chain.getEscrowStatus(escrowId)

  if (status === ON_CHAIN_FUNDED || status === ON_CHAIN_EXECUTING) {
    // The buyer links the task right after funding — until then, wait.
    const task = await getTaskByEscrow(API_URL, escrowId.toString(), s.account, chain.chainId)
    if (!task) {
      if (!waitingForTask.has(k)) log(`[host:${label}] escrow #${escrowId} is funded — waiting for its task brief…`)
      waitingForTask.add(k)
      return false
    }

    const { taskHash: expected } = await chain.getEscrowHashes(escrowId)
    if (hashPreimage(task.preimage).toLowerCase() !== expected.toLowerCase()) {
      log(`[host:${label}] escrow #${escrowId}: stored task does not match the on-chain taskHash — not starting.`)
      return true
    }
    if (task.seller.toLowerCase() !== s.account.address.toLowerCase()) {
      log(`[host:${label}] escrow #${escrowId}: task names a different seller — not starting.`)
      return true
    }
    if (!isCapabilityId(task.capability) || !s.row.capabilities.includes(task.capability)) {
      log(`[host:${label}] escrow #${escrowId}: this seller does not offer "${task.capability}" — not starting.`)
      return true
    }

    // Capabilities that read the chain (the transaction explainer) read this seller's chain.
    const ctx = { publicClient: chain.client, agentEcoAddress: chain.config.agentEco }
    const prepared = await prepareJob(task.capability, task.brief, ctx)
    if (!prepared.ok) {
      log(`[host:${label}] escrow #${escrowId}: ${prepared.reason} — not starting; the accept timeout refunds the buyer.`)
      return true
    }

    if (status === ON_CHAIN_FUNDED) {
      log(`[host:${label}] escrow #${escrowId}: brief is valid — starting execution…`)
      await chain.startExecution(escrowId)
    }

    const outcome = await runJob(prepared.job, {
      ...ctx,
      agentId: s.row.id,
      customInstructions: s.row.customInstructions,
      criteria: task.criteria,
    })
    if (!outcome.deliver) {
      log(`[host:${label}] escrow #${escrowId}: ${outcome.reason} The execution timeout refunds the buyer.`)
      return true
    }

    const result = outcome.result as Record<string, unknown>
    await chain.markDelivered(escrowId, resultHash(result))
    log(`[host:${label}] escrow #${escrowId} marked delivered (${outcome.ai.provider}/${outcome.ai.model}).`)
    unpublished.set(k, { capability: task.capability, result })
    await publishPending(s, escrowId)
    // Keep watching: the buyer can still dispute a delivered result.
    return false
  }

  if (status === ON_CHAIN_DELIVERED || status === ON_CHAIN_SETTLED || status === ON_CHAIN_DISPUTED) {
    if (unpublished.has(k)) {
      await publishPending(s, escrowId)
    } else if (!missingResultLogged.has(k) && !(await hasPublishedResult(s, escrowId))) {
      // Delivered before a restart whose publish never landed: the exact
      // result is gone, so there's nothing to re-send.
      missingResultLogged.add(k)
      log(`[host:${label}] escrow #${escrowId}: delivered but its result was never published and is no longer in memory.`)
    }
    if (status === ON_CHAIN_DISPUTED) await defendIfDue(s, escrowId)
    // Done once paid out; a delivered or disputed escrow is still open.
    return status === ON_CHAIN_SETTLED && !unpublished.has(k)
  }

  // CREATED (not funded yet) keeps waiting; REFUNDED is terminal.
  return status !== ON_CHAIN_CREATED
}

async function sendPendingResponse(s: Seller, escrowId: bigint): Promise<void> {
  const k = key(s.chain, escrowId)
  const response = pendingResponses.get(k)
  if (!response) return
  try {
    await submitDisputeResponseText(API_URL, s.account, escrowId.toString(), response, 'ai', s.chain.chainId)
    pendingResponses.delete(k)
    defended.add(k)
    log(`[host:${s.label}] escrow #${escrowId}: dispute response saved.`)
  } catch (error) {
    logError(`[host:${s.label}] escrow #${escrowId}: dispute response not saved yet — will retry`, error, 'HOST')
  }
}

/**
 * The hosted seller's side of a dispute (spec §11 step 2): once the buyer's
 * reason is readable, the model writes a response grounded in the brief and
 * the result; its hash goes on-chain, then the text to the API. Only within
 * SELLER_RESPONSE_WINDOW_SECONDS — after that the arbiter decides without it.
 */
async function defendIfDue(s: Seller, escrowId: bigint): Promise<void> {
  const { chain, label } = s
  const k = key(chain, escrowId)
  if (pendingResponses.has(k)) return sendPendingResponse(s, escrowId)
  if (defended.has(k)) return

  const { disputeResponseHash } = await chain.getEscrowHashes(escrowId)
  if (disputeResponseHash !== ZERO_HASH) {
    defended.add(k) // answered before a restart
    return
  }
  const { disputedAt } = await chain.getEscrowDisputeInfo(escrowId)
  if (BigInt(Math.floor(Date.now() / 1000)) > disputedAt + BigInt(SELLER_RESPONSE_WINDOW_SECONDS)) {
    defended.add(k)
    log(`[host:${label}] escrow #${escrowId}: the response window has passed — not responding.`)
    return
  }

  // The buyer's reason reaches the API right after raiseDispute.
  const dispute = await getDispute(API_URL, escrowId.toString(), s.account, chain.chainId)
  if (!dispute) return
  const [task, resultRes] = await Promise.all([
    getTaskByEscrow(API_URL, escrowId.toString(), s.account, chain.chainId),
    fetch(withChain(`${API_URL}/escrow-results/${escrowId}`, chain.chainId), { headers: await buildAuthHeaders(s.account) }),
  ])
  const stored = resultRes.ok ? ((await resultRes.json()) as { resultJson: string | null }) : null
  if (!task || !stored?.resultJson || !isCapabilityId(task.capability)) {
    defended.add(k)
    log(`[host:${label}] escrow #${escrowId}: brief or result unavailable — not responding.`)
    return
  }

  const defense = await defendDispute(
    { capability: task.capability, brief: task.brief, criteria: task.criteria, result: JSON.parse(stored.resultJson) },
    dispute.reason,
    { agentId: s.row.id }
  )
  if (!defense) {
    defended.add(k)
    log(`[host:${label}] escrow #${escrowId}: AI unavailable — no dispute response; the arbiter sees "no response".`)
    return
  }
  log(`[host:${label}] escrow #${escrowId}: answering the dispute (${defense.provider}/${defense.model})…`)
  await chain.submitDisputeResponse(escrowId, textHash(defense.response))
  pendingResponses.set(k, defense.response)
  await sendPendingResponse(s, escrowId)
}

/**
 * @param myEscrows every escrow naming this agent's wallet as seller on its chain — read
 *   from contract state by the caller, once per cycle for all sellers of that chain.
 */
export async function processHostedSellerTask(agentRow: HostedSellerAgentRow, myEscrows: EscrowBasic[]): Promise<void> {
  if (!agentRow.agentWalletKey || !agentRow.depositorWallet) return
  if (agentRow.capabilities.length === 0) return

  const privateKey = decryptAgentKey(agentRow.agentWalletKey)
  const account = privateKeyToAccount(privateKey)
  const chain = signerChain(agentRow.chainId, privateKey)
  const s: Seller = { row: agentRow, chain, account, label: agentRow.name }
  const tokenSymbol = chain.config.tokenSymbol
  await warnIfLowGas(chain, account.address, `hosted seller "${agentRow.name}"`, 'hosted')
  // Its ERC-8004 identity, once, where the chain has the registries (owned by the agent wallet).
  await registerHostedIdentity(chain, agentRow)

  const listingPrice = Number(agentRow.price)
  const runtime = new DemoAgentRuntime({
    name: agentRow.name,
    role: 'seller',
    capabilities: agentRow.capabilities,
    description: 'Hosted seller agent.',
    basePrice: listingPrice,
    minimumPrice: agentRow.minimumPrice != null ? Number(agentRow.minimumPrice) : undefined,
  })

  // 1. Answer every negotiation waiting on the seller. Isolated so an API
  //    outage never blocks step 2 — funded escrows are on-chain obligations
  //    with an execution deadline, and only need the chain to be worked.
  try {
    const negotiations = await listNegotiationsForAgent(API_URL, account, agentRow.id, 'open')
    for (const negotiation of negotiations) {
      if (!isMyTurn(negotiation, 'seller')) continue
      const lastMessage = negotiation.messages[negotiation.messages.length - 1]
      const offeredPrice = Number(lastMessage.price)

      // The buyer's brief only feeds the job's size to the model, never its
      // content. Read here, inside the backend: the API never shows a buyer's
      // brief to a seller before the deal.
      let taskBrief: unknown = null
      try {
        const buyer = await prisma.agent.findUnique({ where: { id: negotiation.buyerAgentId }, select: { taskBrief: true } })
        taskBrief = buyer?.taskBrief ?? null
      } catch {
        taskBrief = null
      }
      const extras = await buildNegotiationExtras(API_URL, chain, negotiation, {
        taskBrief,
        sellerWallet: account.address,
      })
      const move = await decideTurn({
        runtime,
        offeredPrice,
        myPriorOfferCount: countOffersBySide(negotiation, 'seller'),
        listingPrice,
        maxRounds: NEGOTIATION_ROUNDS,
        capability: negotiation.capability,
        agentId: agentRow.id,
        ...extras,
      })
      log(
        `[host:${agentRow.name}] negotiation ${negotiation.id}: incoming ${offeredPrice} ${tokenSymbol} -> ${move.action}` +
          (move.action === 'counter' ? ` (${move.price} ${tokenSymbol})` : '') +
          ` [${move.source}${move.adjusted ? ', adjusted' : ''}]`
      )
      await respondToNegotiation(API_URL, account, negotiation.id, { side: 'seller', ...move })
    }
  } catch (error) {
    logError(`[host:${agentRow.name}] negotiations skipped this cycle`, error, 'HOST')
  }

  // 2. Work every escrow naming this wallet as seller — negotiated orders and
  //    direct "Request Service" hires alike, straight from contract state.
  let finished = finishedEscrows.get(agentRow.id)
  if (!finished) finishedEscrows.set(agentRow.id, (finished = new Set()))
  for (const escrow of myEscrows) {
    if (finished.has(escrow.id)) continue
    try {
      if (await advanceEscrow(s, escrow.id)) finished.add(escrow.id)
    } catch (error) {
      // A transient RPC/API/CoinGecko failure — retried next cycle.
      logError(`[host:${agentRow.name}] escrow #${escrow.id} failed this cycle`, error, 'HOST')
    }
  }

  // 3. Sweep settled earnings out to the owner — the agent wallet is only
  //    an operating wallet, not where the seller's money should sit.
  await refundLeftover(chain, agentRow.depositorWallet as Address, agentRow.name, 'paid out earnings of')
}

export async function runSellerHostCycleOnce(): Promise<void> {
  // The only place (besides the buyer host) allowed to read agentWalletKey — see db.ts.
  const activeSellers = await prismaWithAgentKey.agent.findMany({ where: { role: 'seller', taskStatus: 'active', deletedAt: null } })
  if (activeSellers.length === 0) return

  const served = new Set(servedChainIdsOf('evm'))
  for (const chainId of new Set(activeSellers.map((a) => a.chainId))) {
    const sellers = activeSellers.filter((a) => a.chainId === chainId)
    if (!served.has(chainId)) {
      if (!unservedLogged.has(chainId)) log(`[host] ${sellers.length} hosted seller(s) on ${chainId}, which this host does not serve (CHAINS) — skipped.`)
      unservedLogged.add(chainId)
      continue
    }

    // One batched read of every escrow on this chain for all its sellers — no event logs,
    // so it keeps working on RPCs that prune history.
    const bySeller = new Map<string, EscrowBasic[]>()
    try {
      for (const escrow of await readChain(chainId).listEscrows()) {
        const k = escrow.seller.toLowerCase()
        bySeller.set(k, [...(bySeller.get(k) ?? []), escrow])
      }
    } catch (error) {
      logError(`[host] ${chainId}: escrow scan failed this cycle`, error, 'HOST')
      continue
    }

    for (const agentRow of sellers) {
      try {
        await processHostedSellerTask(agentRow, bySeller.get(agentRow.walletAddress?.toLowerCase() ?? '') ?? [])
      } catch (error) {
        logError(`[host:${agentRow.name}] cycle failed`, error, 'HOST')
      }
    }
  }
}
