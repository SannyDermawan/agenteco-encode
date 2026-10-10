import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.ts'
import { requestChain } from '../chains.ts'
import { ratingSummaries, recordRatingsFromTx } from '../ratings.ts'
import { guardEscrow } from '../access.ts'

export const ratingsRouter = Router()
export const verificationsRouter = Router()

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * Displayed ratings for a set of sellers on a chain: ?sellers=0xa,0xb[&chain=…]. Same-owner
 * ratings are excluded; the raw on-chain numbers come from getReputation.
 */
ratingsRouter.get('/', async (req, res) => {
  const chainId = requestChain(req, res)
  if (!chainId) return
  const sellers = String(req.query.sellers ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => ADDRESS.test(s))
    .slice(0, 100)
  res.json(await ratingSummaries(sellers, chainId))
})

ratingsRouter.get('/escrow/:escrowId', async (req, res) => {
  const access = await guardEscrow(req, res, req.params.escrowId)
  if (!access) return
  const rating = await prisma.rating.findUnique({ where: { chainId_escrowId: { chainId: access.chainId, escrowId: req.params.escrowId } } })
  if (!rating) return res.status(404).json({ error: 'This escrow has not been rated' })
  res.json(rating)
})

/**
 * Report a rateSeller transaction (the frontend does after a human rates).
 * Nothing is trusted from the body but the tx hash and its chain: the score,
 * buyer and seller are read from the SellerRated event in its receipt.
 */
ratingsRouter.post('/', async (req, res) => {
  const parsed = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'txHash must be a transaction hash' })
  const chainId = requestChain(req, res)
  if (!chainId) return
  try {
    const stored = await recordRatingsFromTx(chainId, parsed.data.txHash)
    if (stored === 0) return res.status(400).json({ error: 'That transaction has no SellerRated event from AgentEco' })
    res.status(201).json({ stored })
  } catch {
    res.status(400).json({ error: 'Could not read that transaction — is it mined yet?' })
  }
})

// The hosted buyer's AI verification of a delivered result (spec §10.1). Private to the deal, like results.
verificationsRouter.get('/:escrowId', async (req, res) => {
  const access = await guardEscrow(req, res, req.params.escrowId)
  if (!access) return
  const verification = await prisma.verification.findUnique({ where: { chainId_escrowId: { chainId: access.chainId, escrowId: req.params.escrowId } } })
  if (!verification) return res.status(404).json({ error: 'No verification for this escrow' })
  res.json(verification)
})
