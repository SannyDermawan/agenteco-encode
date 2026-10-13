import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db.ts'
import { buildResultPreimage, hashPreimage } from '../../../agent-runtime/src/shared/hashes.ts'
import { readAdapter, requestChain } from '../chains.ts'
import { createEscrowResultSchema } from '../schemas/escrowResult.ts'
import { guardEscrow } from '../access.ts'
import { checkResultShape } from '../capabilityRegistry.ts'
import { mentionsAiUnavailable } from '../../../agent-runtime/src/capabilities/prepare.ts'
import { isCapabilityId } from '../../../agent-runtime/src/shared/capabilities/definitions.ts'

export const escrowResultsRouter = Router()

// The delivered work belongs to the deal: only its buyer, seller and the
// arbiter can read it (and re-hash it against the chain).
escrowResultsRouter.get('/:escrowId', async (req, res) => {
  const access = await guardEscrow(req, res, req.params.escrowId)
  if (!access) return
  const result = await prisma.escrowResult.findUnique({ where: { chainId_escrowId: { chainId: access.chainId, escrowId: req.params.escrowId } } })
  if (!result) return res.status(404).json({ error: 'No result recorded for this escrow' })
  res.json(result)
})

// Anyone can attempt to submit one too, instead of an owner-wallet check,
// this verifies the result actually hashes to what the seller already
// committed on-chain via markDelivered. A mismatched or premature submission
// is rejected by that check, not by who's asking.
escrowResultsRouter.post('/', async (req, res) => {
  const parsed = createEscrowResultSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const chainId = requestChain(req, res)
  if (!chainId) return
  const { escrowId, result } = parsed.data
  // The task behind the escrow fixes the capability; a claim in the body can't dodge its schema.
  const task = await prisma.task.findUnique({ where: { chainId_escrowId: { chainId, escrowId } }, select: { capability: true } })
  if (task && task.capability !== parsed.data.capability) {
    return res.status(400).json({ error: `This escrow is for ${task.capability}, not ${parsed.data.capability}.` })
  }
  const capability = task?.capability ?? parsed.data.capability

  // A platform capability's prose is written by a model. A result that says no model answered
  // ("AI unavailable") is not a delivery: the buyer is never shown it, and the contract's
  // timeouts (or a dispute) decide the escrow. Checked first, it needs no chain read.
  if (isCapabilityId(capability) && mentionsAiUnavailable(capability, result)) {
    return res.status(400).json({ error: `A ${capability} result must be written by an AI model; "AI unavailable" results are not accepted.` })
  }

  let onChainHash: `0x${string}`
  try {
    onChainHash = await readAdapter(chainId).getResultHash(BigInt(escrowId))
  } catch {
    return res.status(400).json({ error: 'Could not read this escrow on-chain, is the id correct?' })
  }

  // Hash the exact JSON text and keep it: jsonb reorders keys, so only the
  // stored text lets anyone re-hash the result against the chain later.
  const resultJson = buildResultPreimage(result)
  const computedHash = hashPreimage(resultJson)
  if (computedHash.toLowerCase() !== onChainHash.toLowerCase()) {
    return res.status(400).json({
      error: 'Result does not match the hash already committed on-chain for this escrow (markDelivered must run first).',
    })
  }

  const shape = await checkResultShape(capability, result)
  if (!shape.ok) {
    return res.status(400).json({ error: `The result does not match the ${capability} output schema: ${shape.error}` })
  }

  const saved = await prisma.escrowResult.upsert({
    where: { chainId_escrowId: { chainId, escrowId } },
    create: { chainId, escrowId, capability, result: result as Prisma.InputJsonValue, resultJson, resultHash: computedHash },
    update: { capability, result: result as Prisma.InputJsonValue, resultJson, resultHash: computedHash },
  })
  res.status(201).json(saved)
})
