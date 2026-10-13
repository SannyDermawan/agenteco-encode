import { isHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { canRule, type EvmAdapter } from '../../../agent-runtime/src/chain/evm.ts'
import { signerSolana, solanaSignerFromFile, solanaSignerFromSecret } from '../../../agent-runtime/src/chain/solana-registry.ts'
import type { ChainAdapter, EscrowBasic } from '../../../agent-runtime/src/chain/types.ts'
import { normalizeWallet } from '../../../agent-runtime/src/shared/wallets.ts'
import { ARBITER_OVERRIDE_WINDOW_SECONDS, SELLER_RESPONSE_WINDOW_SECONDS } from '../../../agent-runtime/src/durations.ts'
import { buildRationalePreimage, hashPreimage, type RationaleInput } from '../../../agent-runtime/src/shared/hashes.ts'
import { getCapability } from '../capabilityRegistry.ts'
import { recommendRuling, shouldAutoResolve } from '../ai/judge.ts'
import { ARBITER_AUTO_MIN_CONFIDENCE } from '../ai/config.ts'
import { prisma } from '../db.ts'
import { log, logError } from '../log.ts'
import { warnIfLowGas } from '../gasWatch.ts'
import { chainFamily, readAdapter, readChain, servedChainIds, servedChainIdsOf, signerChain, type ChainId } from '../chains.ts'

/**
 * The AI arbiter (spec §11 steps 3–5), run by the host process: it already has
 * the database, the AI providers and the API, while the keeper stays a
 * permissionless timeout bot with no secrets beyond its gas wallet.
 *
 * Per disputed escrow: once the seller has answered (or its response window
 * has passed), the arbiter model recommends a ruling; the human arbiter then
 * has ARBITER_OVERRIDE_WINDOW_SECONDS to approve or reverse it on the Disputes
 * page. After that, a confident recommendation (≥ ARBITER_AUTO_MIN_CONFIDENCE)
 * with ≥ 60 s left before the on-chain deadline is executed here with
 * ARBITER_PRIVATE_KEY. Anything else waits for the human or the timeout refund.
 *
 * From AgentEco v2 the arbiter is an ArbiterCouncil and ARBITER_PRIVATE_KEY is
 * one of its members: the AI's ruling is its vote, which executes at once
 * when the council's ruling threshold is 1, or waits for a human's matching vote.
 * Each deployment has its own council (v2's, v3's); disputes on an older one
 * are still recommended and ruled there, through that deployment's council.
 *
 * Every served chain is worked the same way, with the same key: on each chain it
 * rules only where it is that chain's arbiter or a member of its council.
 *
 * Solana: the program has one arbiter pubkey and no council. When SOLANA_ARBITER_SECRET_KEY (or
 * SOLANA_ARBITER_KEYPAIR, a file) is that pubkey, the AI's ruling is the program's resolve_dispute,
 * signed here; otherwise it only recommends there too.
 */

// AgentEco.sol OrderStatus
const DISPUTED = 4
const SETTLED = 5
const REFUNDED = 6
const ZERO_HASH = `0x${'0'.repeat(64)}`

/** What `rulable` holds for the one Solana program of a chain (EVM chains list their AgentEco addresses). */
const SOLANA_ECO = 'solana'

interface ChainArbiter {
  /** Signs rulings on this chain; null = recommendations only. */
  signer: ChainAdapter | null
  /** AgentEco deployments (lowercase) on this chain whose disputes the key can rule. */
  rulable: Set<string>
}

let arbiters: Map<ChainId, ChainArbiter> | undefined

function arbiterKey(): Hex | null {
  const raw = process.env.ARBITER_PRIVATE_KEY?.trim()
  const key = raw && !raw.startsWith('0x') ? `0x${raw}` : raw
  return key && isHex(key) && key.length === 66 ? key : null
}

/**
 * On every served chain: the arbiter wallet, if ARBITER_PRIVATE_KEY is set and is
 * that chain's contract arbiter or a member of its council; otherwise recommend-only.
 */
export async function initArbiter(): Promise<void> {
  const key = arbiterKey()
  const next = new Map<ChainId, ChainArbiter>()
  if (!key) {
    for (const chainId of servedChainIdsOf('evm')) next.set(chainId, { signer: null, rulable: new Set() })
    log('Arbiter: no ARBITER_PRIVATE_KEY — AI recommendations only, no automatic rulings on the EVM chains.', 'HOST')
  } else {
    const account = privateKeyToAccount(key)
    for (const chainId of servedChainIdsOf('evm')) {
      const reader = readChain(chainId)
      const setup = await reader.arbiterSetupAt()
      if (!canRule(setup, account.address)) {
        next.set(chainId, { signer: null, rulable: new Set() })
        const who = setup.council ? `a member of the arbiter council ${setup.council.address}` : `the contract's arbiter (${setup.arbiter})`
        log(`Arbiter (${chainId}): ARBITER_PRIVATE_KEY is ${account.address}, which is not ${who} — recommendations only.`, 'HOST')
        continue
      }
      const rulable = new Set([reader.config.agentEco.toLowerCase()])
      for (const eco of reader.allAgentEcoAddresses.slice(1)) {
        try {
          if (canRule(await reader.arbiterSetupAt(eco), account.address)) rulable.add(eco.toLowerCase())
        } catch (error) {
          logError(`Arbiter (${chainId}): could not read the arbiter of ${eco}`, error, 'HOST')
        }
      }
      next.set(chainId, { signer: signerChain(chainId, key), rulable })
      const via = setup.council
        ? `, voting in ArbiterCouncil ${setup.council.address} (${setup.council.rulingThreshold} of ${setup.council.members.length} votes rule)`
        : ''
      log(
        `Arbiter (${chainId}): ${account.address}${via} — auto-rules at confidence ≥ ${ARBITER_AUTO_MIN_CONFIDENCE} after a ${ARBITER_OVERRIDE_WINDOW_SECONDS}s override window.`,
        'HOST'
      )
    }
  }
  await initSolanaArbiters(next)
  arbiters = next
}

/**
 * The Solana arbiter's signer: SOLANA_ARBITER_SECRET_KEY (a JSON array of 64 bytes, or base58: for a host that
 * keeps its secrets in variables) or SOLANA_ARBITER_KEYPAIR (a keypair file). Null when neither is set.
 */
async function solanaArbiterSigner() {
  const secret = process.env.SOLANA_ARBITER_SECRET_KEY?.trim()
  if (secret) return solanaSignerFromSecret(secret)
  const file = process.env.SOLANA_ARBITER_KEYPAIR?.trim()
  return file ? solanaSignerFromFile(file) : null
}

/** On every served Solana chain: the arbiter signer, when it is the program's configured arbiter; otherwise recommend-only. */
async function initSolanaArbiters(next: Map<ChainId, ChainArbiter>): Promise<void> {
  const chains = servedChainIdsOf('solana')
  if (chains.length === 0) return
  let signer: Awaited<ReturnType<typeof solanaArbiterSigner>> = null
  try {
    signer = await solanaArbiterSigner()
  } catch (error) {
    logError('Arbiter (solana): the Solana arbiter key could not be read', error, 'HOST')
  }
  for (const chainId of chains) {
    if (!signer) {
      next.set(chainId, { signer: null, rulable: new Set() })
      log(`Arbiter (${chainId}): no SOLANA_ARBITER_SECRET_KEY or SOLANA_ARBITER_KEYPAIR — recommendations only.`, 'HOST')
      continue
    }
    const setup = await readAdapter(chainId).getArbiterSetup()
    if (setup.arbiter !== signer.address) {
      next.set(chainId, { signer: null, rulable: new Set() })
      log(`Arbiter (${chainId}): the Solana arbiter key is ${signer.address}, which is not the program's arbiter (${setup.arbiter}) — recommendations only.`, 'HOST')
      continue
    }
    next.set(chainId, { signer: signerSolana(chainId, signer), rulable: new Set([SOLANA_ECO]) })
    log(
      `Arbiter (${chainId}): ${signer.address}, the program's arbiter — auto-rules at confidence ≥ ${ARBITER_AUTO_MIN_CONFIDENCE} after a ${ARBITER_OVERRIDE_WINDOW_SECONDS}s override window.`,
      'HOST'
    )
  }
}

const nowSec = () => Math.floor(Date.now() / 1000)
/** Waiting reasons already logged per escrow, so a long wait logs once. */
const loggedWait = new Map<string, string>()

function logOnce(chainId: ChainId, escrowId: string, key: string, message: string): void {
  const k = `${chainId}:${escrowId}`
  if (loggedWait.get(k) === key) return
  loggedWait.set(k, key)
  log(message)
}

const where = (chainId: ChainId, escrowId: string) => ({ chainId_escrowId: { chainId, escrowId } })

async function recommend(chain: ChainAdapter, escrow: EscrowBasic, disputedAt: number): Promise<void> {
  const chainId = chain.chainId
  const id = escrow.id.toString()
  const responseWindowOver = nowSec() >= disputedAt + SELLER_RESPONSE_WINDOW_SECONDS

  let row = await prisma.dispute.findUnique({ where: where(chainId, id) })
  if (!row) {
    // The buyer's text never arrived (only its hash is on-chain): after the
    // response window, judge without it rather than let the deadline lapse.
    if (!responseWindowOver) return
    const { disputeReasonHash } = await chain.getEscrowHashes(escrow.id)
    row = await prisma.dispute.create({ data: { chainId, escrowId: id, buyerWallet: normalizeWallet(escrow.buyer), reason: '', reasonHash: disputeReasonHash } })
  }

  const { disputeResponseHash } = await chain.getEscrowHashes(escrow.id)
  const responded = disputeResponseHash !== ZERO_HASH
  // Wait for the seller's answer (and its text) until the window closes.
  if (!responseWindowOver && (!responded || !row.sellerResponse)) {
    logOnce(chainId, id, 'awaiting-response', `[arbiter] ${chainId} escrow #${id}: waiting for the seller's response…`)
    return
  }

  const [task, result] = await Promise.all([
    prisma.task.findUnique({ where: where(chainId, id) }),
    prisma.escrowResult.findUnique({ where: where(chainId, id) }),
  ])
  // Platform or community capability — a community one is judged by its published rubric.
  const capability = task ? await getCapability(task.capability) : null
  const rec =
    task && result?.resultJson && capability
      ? await recommendRuling(
          {
            capability: task.capability,
            label: capability.name,
            rubric: capability.rubric,
            examples: capability.examples,
            brief: task.brief,
            criteria: task.criteria,
            result: JSON.parse(result.resultJson),
          },
          row.reason || null,
          row.sellerResponse ?? null
        )
      : null

  const recommendedAt = new Date()
  if (!rec) {
    await prisma.dispute.update({ where: where(chainId, id), data: { recUnavailable: true, recommendedAt } })
    log(`[arbiter] ${chainId} escrow #${id}: AI recommendation unavailable — waiting for the arbiter or the timeout.`)
    return
  }
  await prisma.dispute.update({
    where: where(chainId, id),
    data: {
      recVerdict: rec.verdict,
      recConfidence: rec.confidence,
      recRationale: rec.rationale,
      recProvider: rec.provider,
      recModel: rec.model,
      recommendedAt,
      recUnavailable: false,
      overrideDeadline: new Date(recommendedAt.getTime() + ARBITER_OVERRIDE_WINDOW_SECONDS * 1000),
    },
  })
  log(
    `[arbiter] ${chainId} escrow #${id}: AI recommends ${rec.verdict} (${rec.confidence}% confident, ${rec.provider}/${rec.model}); override window ${ARBITER_OVERRIDE_WINDOW_SECONDS}s.`
  )
}

async function autoResolve(chain: ChainAdapter, escrow: EscrowBasic, disputeDeadline: number): Promise<void> {
  const chainId = chain.chainId
  const id = escrow.id.toString()
  const row = await prisma.dispute.findUnique({ where: where(chainId, id) })
  if (!row?.recommendedAt || row.recUnavailable || !row.recVerdict || row.recConfidence === null || !row.recRationale || !row.overrideDeadline) return
  const arbiter = arbiters?.get(chainId)
  if (!arbiter?.signer) return
  const eco = chain.family === 'evm' ? (chain as EvmAdapter).agentEcoFor(escrow.id) : SOLANA_ECO
  if (!arbiter.rulable.has(eco.toLowerCase())) {
    logOnce(chainId, id, 'not-rulable', `[arbiter] ${chainId} escrow #${id}: this key is not the arbiter of ${eco} — left to its arbiter or the timeout.`)
    return
  }

  const decision = shouldAutoResolve({
    confidence: row.recConfidence,
    nowSec: nowSec(),
    overrideDeadlineSec: Math.floor(row.overrideDeadline.getTime() / 1000),
    disputeDeadlineSec: disputeDeadline,
  })
  if (!decision.ok) {
    if (decision.reason === 'low-confidence')
      logOnce(chainId, id, 'low-confidence', `[arbiter] ${chainId} escrow #${id}: confidence ${row.recConfidence}% is below ${ARBITER_AUTO_MIN_CONFIDENCE}% — left to the arbiter or the timeout.`)
    if (decision.reason === 'too-late')
      logOnce(chainId, id, 'too-late', `[arbiter] ${chainId} escrow #${id}: too close to the dispute deadline to rule — the timeout refunds the buyer.`)
    return
  }

  const rationale: RationaleInput = {
    verdict: row.recVerdict as 'seller' | 'buyer',
    confidence: row.recConfidence,
    rationale: row.recRationale,
    decidedBy: 'ai-auto',
  }
  const preimage = buildRationalePreimage(rationale)
  const toSeller = rationale.verdict === 'seller'
  log(`[arbiter] ${chainId} escrow #${id}: executing the AI ruling for the ${rationale.verdict}…`)
  const outcome = await arbiter.signer.ruleDispute(escrow.id, toSeller, hashPreimage(preimage))
  if (outcome.kind !== 'executed') {
    // Council with a ruling threshold above 1: the AI's vote waits for a human's.
    logOnce(
      chainId,
      id,
      'council-vote',
      `[arbiter] ${chainId} escrow #${id}: AI voted ${rationale.verdict} in the arbiter council (${outcome.votes}/${outcome.needed}) — waiting for another member.`
    )
    return
  }
  const tx = outcome.hash
  await prisma.dispute.update({
    where: where(chainId, id),
    data: {
      resolution: 'ai-auto',
      releasedToSeller: toSeller,
      rationalePreimage: preimage,
      rationaleHash: hashPreimage(preimage),
      resolutionTx: tx,
      resolvedAt: new Date(),
    },
  })
  log(`[arbiter] ${chainId} escrow #${id}: resolved for the ${rationale.verdict} (tx ${tx}).`)
}

/**
 * Records disputes that ended without us: the keeper's timeout refund, or a
 * manual ruling whose rationale text the browser never posted (hash only).
 */
async function sweepEnded(chain: ChainAdapter, statusById: Map<string, number>): Promise<void> {
  const chainId = chain.chainId
  const open = await prisma.dispute.findMany({ where: { chainId, resolution: null } })
  for (const row of open) {
    const status = statusById.get(row.escrowId)
    if (status !== SETTLED && status !== REFUNDED) continue
    const { resolutionHash } = await chain.getEscrowHashes(BigInt(row.escrowId))
    const timedOut = resolutionHash === ZERO_HASH
    await prisma.dispute.update({
      where: where(chainId, row.escrowId),
      data: {
        resolution: timedOut ? 'timeout' : 'arbiter-manual',
        releasedToSeller: status === SETTLED,
        ...(timedOut ? {} : { rationaleHash: resolutionHash }),
        resolvedAt: new Date(),
      },
    })
    log(`[arbiter] ${chainId} escrow #${row.escrowId}: dispute ended by ${timedOut ? 'timeout (buyer refunded)' : 'the arbiter'}.`)
  }
}

async function runChain(chainId: ChainId): Promise<void> {
  const chain = readAdapter(chainId)
  const escrows = await chain.listEscrows()
  const statusById = new Map(escrows.map((e) => [e.id.toString(), e.status]))

  // Disputes on every deployment get a recommendation; autoResolve rules only where this key can.
  const disputed = escrows.filter((e) => e.status === DISPUTED)
  const signer = arbiters?.get(chainId)?.signer
  if (disputed.length && signer?.signer && signer.family === 'evm') await warnIfLowGas(signer as EvmAdapter, signer.signer as `0x${string}`, 'arbiter')
  for (const escrow of disputed) {
    try {
      const info = await chain.getEscrowDisputeInfo(escrow.id)
      const row = await prisma.dispute.findUnique({ where: where(chainId, escrow.id.toString()), select: { recommendedAt: true } })
      if (!row?.recommendedAt) await recommend(chain, escrow, Number(info.disputedAt))
      else await autoResolve(chain, escrow, Number(info.disputeDeadline))
    } catch (error) {
      logError(`[arbiter] ${chainId} escrow #${escrow.id} failed this cycle`, error, 'HOST')
    }
  }

  try {
    await sweepEnded(chain, statusById)
  } catch (error) {
    logError(`[arbiter] ${chainId}: sweep failed`, error, 'HOST')
  }
}

/**
 * A Solana chain is read escrow by escrow over a public RPC with a rate limit (HTTP 429), so it is scanned
 * every SOLANA_SCAN_MS rather than on every pass of the host loop. EVM chains read their escrows in a few calls.
 */
const SOLANA_SCAN_MS = Number(process.env.SOLANA_ARBITER_SCAN_MS ?? 30_000)
const lastSolanaScan = new Map<ChainId, number>()

export async function runArbiterCycleOnce(): Promise<void> {
  if (arbiters === undefined) await initArbiter()
  for (const chainId of servedChainIds()) {
    if (chainFamily(chainId) === 'solana') {
      if (Date.now() - (lastSolanaScan.get(chainId) ?? 0) < SOLANA_SCAN_MS) continue
      lastSolanaScan.set(chainId, Date.now())
    }
    try {
      await runChain(chainId)
    } catch (error) {
      logError(`[arbiter] ${chainId}: cycle failed`, error, 'HOST')
    }
  }
}
