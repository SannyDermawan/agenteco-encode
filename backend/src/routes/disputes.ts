import { Router } from 'express'
import { prisma } from '../db.ts'
import { optionalChainFilter, readChain, requestChain, type ChainId } from '../chains.ts'
import { verifyOwnerAuth } from '../auth.ts'
import { arbiterChains, guardEscrow, requireViewer } from '../access.ts'
import { buildRationalePreimage, hashPreimage, textHash } from '../../../agent-runtime/src/shared/hashes.ts'
import { disputeReasonSchema, disputeResolutionSchema, disputeResponseSchema } from '../schemas/dispute.ts'

export const disputesRouter = Router()

// AgentEco.sol OrderStatus
const DISPUTED = 4
const SETTLED = 5
const REFUNDED = 6

async function readEscrow(chainId: ChainId, escrowId: string) {
  const id = BigInt(escrowId)
  const chain = readChain(chainId)
  const [basic, hashes] = await Promise.all([chain.getEscrowBasic(id), chain.getEscrowHashes(id)])
  return {
    buyer: basic.buyer,
    seller: basic.seller,
    status: basic.status,
    reasonHash: hashes.disputeReasonHash,
    responseHash: hashes.disputeResponseHash,
    resolutionHash: hashes.resolutionHash,
  }
}

function badId(escrowId: string): boolean {
  return !/^\d+$/.test(escrowId)
}

// Dispute texts are private to the escrow's buyer, seller and the arbiter,
// who can re-hash them against the chain. The full list is the arbiter's queue:
// every dispute on the chains whose arbiter (or council member) the viewer is.
disputesRouter.get('/', async (req, res) => {
  const viewer = await requireViewer(req, res)
  if (!viewer) return
  const only = optionalChainFilter(typeof req.query.chain === 'string' ? req.query.chain : undefined, res)
  if (only === null) return
  const chains = (await arbiterChains(viewer)).filter((c) => !only || c === only)
  if (!chains.length) return res.status(403).json({ error: 'Only the arbiter can list every dispute' })
  res.json(await prisma.dispute.findMany({ where: { chainId: { in: chains } }, orderBy: { createdAt: 'desc' } }))
})

disputesRouter.get('/:escrowId', async (req, res) => {
  const access = await guardEscrow(req, res, req.params.escrowId)
  if (!access) return
  const dispute = await prisma.dispute.findUnique({ where: { chainId_escrowId: { chainId: access.chainId, escrowId: req.params.escrowId } } })
  if (!dispute) return res.status(404).json({ error: 'No dispute recorded for this escrow' })
  res.json(dispute)
})

/**
 * The buyer's reason. On-chain first: raiseDispute(id, keccak256(reason)) —
 * then the text comes here and is accepted only if it hashes to exactly that.
 */
disputesRouter.put('/:escrowId', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })
  const { escrowId } = req.params
  if (badId(escrowId)) return res.status(400).json({ error: 'escrowId must be a number' })
  const chainId = requestChain(req, res)
  if (!chainId) return

  const parsed = disputeReasonSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid reason' })

  let escrow: Awaited<ReturnType<typeof readEscrow>>
  try {
    escrow = await readEscrow(chainId, escrowId)
  } catch {
    return res.status(400).json({ error: 'Could not read this escrow on-chain — is the id correct?' })
  }
  if (escrow.buyer.toLowerCase() !== auth.wallet.toLowerCase()) {
    return res.status(403).json({ error: "Only this escrow's buyer can describe its dispute" })
  }
  const reasonHash = textHash(parsed.data.reason)
  if (reasonHash.toLowerCase() !== escrow.reasonHash.toLowerCase()) {
    return res.status(400).json({ error: 'This reason does not match the reason hash committed on-chain by raiseDispute.' })
  }

  const saved = await prisma.dispute.upsert({
    where: { chainId_escrowId: { chainId, escrowId } },
    create: { chainId, escrowId, buyerWallet: auth.wallet.toLowerCase(), reason: parsed.data.reason, reasonHash },
    // Fills in a placeholder the arbiter made while the text was missing (same hash, so same text).
    update: { reason: parsed.data.reason, reasonHash },
  })
  res.json(saved)
})

/**
 * The seller's answer (hosted sellers sign with their agent wallet; a
 * self-hosted seller with its own). On-chain first:
 * submitDisputeResponse(id, keccak256(response)).
 */
disputesRouter.post('/:escrowId/response', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })
  const { escrowId } = req.params
  if (badId(escrowId)) return res.status(400).json({ error: 'escrowId must be a number' })
  const chainId = requestChain(req, res)
  if (!chainId) return

  const parsed = disputeResponseSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid response' })

  const dispute = await prisma.dispute.findUnique({ where: { chainId_escrowId: { chainId, escrowId } } })
  if (!dispute) return res.status(404).json({ error: 'The buyer has not submitted this dispute yet' })

  let escrow: Awaited<ReturnType<typeof readEscrow>>
  try {
    escrow = await readEscrow(chainId, escrowId)
  } catch {
    return res.status(400).json({ error: 'Could not read this escrow on-chain — is the id correct?' })
  }
  if (escrow.seller.toLowerCase() !== auth.wallet.toLowerCase()) {
    return res.status(403).json({ error: "Only this escrow's seller can answer its dispute" })
  }
  const responseHash = textHash(parsed.data.response)
  if (responseHash.toLowerCase() !== escrow.responseHash.toLowerCase()) {
    return res.status(400).json({ error: 'This response does not match the response hash committed on-chain.' })
  }

  const saved = await prisma.dispute.update({
    where: { chainId_escrowId: { chainId, escrowId } },
    data: {
      sellerResponse: parsed.data.response,
      responseHash,
      responseSource: dispute.responseSource ?? parsed.data.source,
      respondedAt: dispute.respondedAt ?? new Date(),
    },
  })
  res.json(saved)
})

/**
 * The arbiter's ruling. On-chain first: resolveDisputeFor*(id, rationaleHash)
 * — then the rationale object comes here and is accepted only if its
 * fixed-order JSON hashes to the on-chain resolutionHash. Anyone may submit
 * it (the hash is the proof); the backend's auto-arbiter does so too.
 */
disputesRouter.post('/:escrowId/resolution', async (req, res) => {
  const { escrowId } = req.params
  if (badId(escrowId)) return res.status(400).json({ error: 'escrowId must be a number' })
  const chainId = requestChain(req, res)
  if (!chainId) return
  const parsed = disputeResolutionSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid resolution' })

  let escrow: Awaited<ReturnType<typeof readEscrow>>
  try {
    escrow = await readEscrow(chainId, escrowId)
  } catch {
    return res.status(400).json({ error: 'Could not read this escrow on-chain — is the id correct?' })
  }
  if (escrow.status !== SETTLED && escrow.status !== REFUNDED) {
    return res.status(400).json({ error: escrow.status === DISPUTED ? 'The dispute is not resolved on-chain yet' : 'This escrow was not disputed' })
  }

  const { txHash, ...rationale } = parsed.data
  const preimage = buildRationalePreimage(rationale)
  const rationaleHash = hashPreimage(preimage)
  if (rationaleHash.toLowerCase() !== escrow.resolutionHash.toLowerCase()) {
    return res.status(400).json({ error: 'This rationale does not match the resolution hash committed on-chain.' })
  }

  const saved = await prisma.dispute.update({
    where: { chainId_escrowId: { chainId, escrowId } },
    data: {
      resolution: rationale.decidedBy,
      releasedToSeller: escrow.status === SETTLED,
      rationalePreimage: preimage,
      rationaleHash,
      ...(txHash && { resolutionTx: txHash }),
      resolvedAt: new Date(),
    },
  })
  // Unsigned route: confirm the ruling without echoing the private dispute texts.
  res.json({
    chainId: saved.chainId,
    escrowId: saved.escrowId,
    resolution: saved.resolution,
    releasedToSeller: saved.releasedToSeller,
    rationaleHash: saved.rationaleHash,
    resolvedAt: saved.resolvedAt,
  })
})
