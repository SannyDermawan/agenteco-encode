import { Router } from 'express'
import { prisma } from '../db.ts'
import { isAuthorizedForAgent, verifyOwnerAuth } from '../auth.ts'
import { UUID_REGEX, isArbiter, isPartyOf, partyFilter, requireViewer } from '../access.ts'
import { createNegotiationSchema, listNegotiationsQuerySchema, negotiationMessageSchema } from '../schemas/negotiation.ts'
import { turnExpired } from '../maintenance.ts'
import { optionalChainFilter } from '../chains.ts'
import { NEGOTIATION_TURN_SECONDS } from '../../../agent-runtime/src/durations.ts'

export const negotiationsRouter = Router()

const messagesOrderAsc = { messages: { orderBy: { createdAt: 'asc' as const } } }

negotiationsRouter.param('id', (_req, res, next, id: string) => {
  if (!UUID_REGEX.test(id)) return res.status(404).json({ error: 'Negotiation not found' })
  next()
})

// Only negotiations one of the viewer's agents takes part in.
negotiationsRouter.get('/', async (req, res) => {
  const viewer = await requireViewer(req, res)
  if (!viewer) return
  const parsed = listNegotiationsQuerySchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const { agentId, status } = parsed.data
  const chainId = optionalChainFilter(parsed.data.chain, res)
  if (chainId === null) return

  const negotiations = await prisma.negotiation.findMany({
    where: {
      AND: [
        partyFilter(viewer),
        ...(agentId ? [{ OR: [{ buyerAgentId: agentId }, { sellerAgentId: agentId }] }] : []),
      ],
      ...(status && { status }),
      ...(chainId && { chainId }),
    },
    include: messagesOrderAsc,
    orderBy: { updatedAt: 'desc' },
  })
  res.json(negotiations)
})

negotiationsRouter.get('/:id', async (req, res) => {
  const viewer = await requireViewer(req, res)
  if (!viewer) return
  const negotiation = await prisma.negotiation.findUnique({
    where: { id: req.params.id },
    include: { ...messagesOrderAsc, buyerAgent: true, sellerAgent: true },
  })
  if (!negotiation) return res.status(404).json({ error: 'Negotiation not found' })
  const { buyerAgent, sellerAgent, ...rest } = negotiation
  if (!isPartyOf(viewer, buyerAgent) && !isPartyOf(viewer, sellerAgent) && !(await isArbiter(viewer, negotiation.chainId))) {
    return res.status(403).json({ error: 'This negotiation is private, only its buyer, seller and the arbiter can see it.' })
  }
  res.json(rest)
})

// Buyer opens a negotiation with an opening offer (§11: Offer -> ...).
negotiationsRouter.post('/', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })

  const parsed = createNegotiationSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const { buyerAgentId, sellerAgentId, capability } = parsed.data
  const price = Number(parsed.data.price.toFixed(6))

  const [buyer, seller] = await Promise.all([
    prisma.agent.findUnique({ where: { id: buyerAgentId } }),
    prisma.agent.findUnique({ where: { id: sellerAgentId } }),
  ])
  if (!buyer) return res.status(404).json({ error: 'buyerAgentId not found' })
  if (!seller) return res.status(404).json({ error: 'sellerAgentId not found' })
  if (buyer.role !== 'buyer') return res.status(400).json({ error: 'buyerAgentId does not belong to a buyer agent' })
  if (seller.role !== 'seller') return res.status(400).json({ error: 'sellerAgentId does not belong to a seller agent' })
  // The deal is escrowed on one chain: both agents must trade there.
  if (buyer.chainId !== seller.chainId) {
    return res.status(400).json({ error: `The buyer agent is on ${buyer.chainId} but the seller agent is on ${seller.chainId}` })
  }
  if (!seller.capabilities.includes(capability)) {
    return res.status(400).json({ error: `Seller agent does not offer capability "${capability}"` })
  }
  if (seller.deletedAt || seller.delistedAt) {
    return res.status(400).json({ error: 'This seller is no longer listed in the marketplace' })
  }
  if (!seller.isOnline) {
    return res.status(400).json({ error: 'Seller agent is offline and not accepting new work' })
  }

  if (!isAuthorizedForAgent(auth.wallet, buyer)) {
    return res.status(403).json({ error: 'Only the buyer agent owner (or the agent itself) can open a negotiation on its behalf' })
  }

  const negotiation = await prisma.negotiation.create({
    data: {
      buyerAgentId,
      sellerAgentId,
      chainId: seller.chainId,
      capability,
      messages: {
        create: [{ side: 'buyer', action: 'offer', price, reason: parsed.data.reason ?? null, source: parsed.data.source, adjusted: parsed.data.adjusted }],
      },
    },
    include: messagesOrderAsc,
  })
  res.status(201).json(negotiation)
})

// Either side responds: counter, accept, or reject (§11).
negotiationsRouter.post('/:id/messages', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })

  const parsed = negotiationMessageSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const { side, action, reason, source, adjusted } = parsed.data
  // Float noise (0.1 - 0.03 = 0.07000000000000001) never reaches the database.
  const price = parsed.data.price === undefined ? undefined : Number(parsed.data.price.toFixed(6))

  const negotiation = await prisma.negotiation.findUnique({
    where: { id: req.params.id },
    include: messagesOrderAsc,
  })
  if (!negotiation) return res.status(404).json({ error: 'Negotiation not found' })
  if (negotiation.status !== 'open') {
    return res.status(400).json({ error: `Negotiation is already ${negotiation.status}` })
  }

  const lastMessage = negotiation.messages[negotiation.messages.length - 1]
  // The turn-holder went silent too long: the negotiation is over (the sweep in maintenance.ts may not have run yet).
  if (turnExpired(lastMessage.createdAt)) {
    await prisma.negotiation.updateMany({ where: { id: negotiation.id, status: 'open' }, data: { status: 'expired' } })
    return res.status(400).json({ error: `Negotiation expired: no answer within ${NEGOTIATION_TURN_SECONDS}s of the last offer` })
  }
  if (lastMessage.side === side) {
    return res.status(400).json({ error: `It is not ${side}'s turn to respond` })
  }

  const respondingAgentId = side === 'buyer' ? negotiation.buyerAgentId : negotiation.sellerAgentId
  const respondingAgent = await prisma.agent.findUnique({ where: { id: respondingAgentId } })
  if (!respondingAgent || !isAuthorizedForAgent(auth.wallet, respondingAgent)) {
    return res.status(403).json({ error: `Only the ${side} agent owner (or the agent itself) can respond as ${side}` })
  }

  if (action === 'counter' && price === undefined) {
    return res.status(400).json({ error: 'price is required for a counter offer' })
  }

  const finalPrice = action === 'accept' ? (price ?? Number(lastMessage.price)) : price

  const updated = await prisma.$transaction(async (tx) => {
    await tx.negotiationMessage.create({
      data: { negotiationId: negotiation.id, side, action, price: finalPrice, reason: reason ?? null, source, adjusted },
    })
    const result = await tx.negotiation.update({
      where: { id: negotiation.id },
      data: {
        ...(action === 'accept' && { status: 'accepted', agreedPrice: finalPrice }),
        ...(action === 'reject' && { status: 'rejected' }),
      },
      include: messagesOrderAsc,
    })

    // §2/§26: an order is created the moment a deal is struck, no human
    // orchestration in between.
    if (action === 'accept') {
      await tx.order.create({
        data: {
          negotiationId: negotiation.id,
          buyerAgentId: negotiation.buyerAgentId,
          sellerAgentId: negotiation.sellerAgentId,
          chainId: negotiation.chainId,
          capability: negotiation.capability,
          price: finalPrice!,
        },
      })
    }

    return result
  })

  res.json(updated)
})
