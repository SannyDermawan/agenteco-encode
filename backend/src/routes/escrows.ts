import { Router } from 'express'
import { checkEscrowAccess, isEscrowId, requireViewer } from '../access.ts'
import { requestChain } from '../chains.ts'

export const escrowsRouter = Router()

/**
 * May the signed-in viewer open this escrow's order page? Lets the website
 * show "private" instead of a half-empty page to anyone who isn't a party.
 * The escrow is on ?chain= (default: the default chain).
 */
escrowsRouter.get('/:escrowId/access', async (req, res) => {
  if (!isEscrowId(req.params.escrowId)) return res.status(400).json({ error: 'escrowId must be a number' })
  const chainId = requestChain(req, res)
  if (!chainId) return
  const viewer = await requireViewer(req, res)
  if (!viewer) return
  const access = await checkEscrowAccess(viewer, chainId, req.params.escrowId)
  if (access === 'not_found') return res.status(404).json({ error: 'Escrow not found' })
  res.json({ canView: access === 'ok' })
})
