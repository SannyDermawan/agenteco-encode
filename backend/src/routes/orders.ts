import { Router } from 'express'
import { prisma } from '../db.ts'
import { isAuthorizedForAgent, verifyOwnerAuth } from '../auth.ts'
import { UUID_REGEX, agentView, isArbiter, isPartyOf, partyFilter, requireViewer } from '../access.ts'
import { fundOrderSchema, listOrdersQuerySchema } from '../schemas/order.ts'
import { optionalChainFilter } from '../chains.ts'

export const ordersRouter = Router()

const fullInclude = {
  buyerAgent: true,
  sellerAgent: true,
  negotiation: { include: { messages: { orderBy: { createdAt: 'asc' as const } } } },
}

ordersRouter.param('id', (_req, res, next, id: string) => {
  if (!UUID_REGEX.test(id)) return res.status(404).json({ error: 'Order not found' })
  next()
})

type AgentLike = Parameters<typeof agentView>[0]
type OrderWithAgents = { chainId: string; buyerAgent: AgentLike; sellerAgent: AgentLike }

/** Each side's private agent settings stay hidden from the other side. */
function orderView<T extends OrderWithAgents>(order: T, viewer: string): T {
  return { ...order, buyerAgent: agentView(order.buyerAgent, viewer), sellerAgent: agentView(order.sellerAgent, viewer) }
}

async function canViewOrder(viewer: string, order: OrderWithAgents): Promise<boolean> {
  return isPartyOf(viewer, order.buyerAgent) || isPartyOf(viewer, order.sellerAgent) || isArbiter(viewer, order.chainId)
}

// Only the viewer's own orders — ownerWallet / agentId just narrow them further.
ordersRouter.get('/', async (req, res) => {
  const viewer = await requireViewer(req, res)
  if (!viewer) return
  const parsed = listOrdersQuerySchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const { agentId, ownerWallet, status } = parsed.data
  const chainId = optionalChainFilter(parsed.data.chain, res)
  if (chainId === null) return
  if (ownerWallet && ownerWallet.toLowerCase() !== viewer) {
    return res.status(403).json({ error: 'You can only list your own orders' })
  }

  const orders = await prisma.order.findMany({
    where: {
      AND: [
        partyFilter(viewer),
        ...(agentId ? [{ OR: [{ buyerAgentId: agentId }, { sellerAgentId: agentId }] }] : []),
      ],
      ...(status && { status }),
      ...(chainId && { chainId }),
    },
    include: fullInclude,
    orderBy: { createdAt: 'desc' },
  })
  res.json(orders.map((order) => orderView(order, viewer)))
})

ordersRouter.get('/:id', async (req, res) => {
  const viewer = await requireViewer(req, res)
  if (!viewer) return
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: fullInclude })
  if (!order) return res.status(404).json({ error: 'Order not found' })
  if (!(await canViewOrder(viewer, order))) {
    return res.status(403).json({ error: 'This order is private — only its buyer, seller and the arbiter can see it.' })
  }
  res.json(orderView(order, viewer))
})

// Called once the buyer actually funds the on-chain escrow (RequestServiceCard
// or, later, the buyer agent itself). From here AgentEco.sol is the source of
// truth for status — this just remembers which escrowId belongs to which order.
ordersRouter.patch('/:id/escrow', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })

  const parsed = fundOrderSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { buyerAgent: true, sellerAgent: true } })
  if (!order) return res.status(404).json({ error: 'Order not found' })
  if (order.status === 'funded') return res.status(400).json({ error: 'Order is already funded' })

  if (!isAuthorizedForAgent(auth.wallet, order.buyerAgent)) {
    return res.status(403).json({ error: 'Only the buyer agent owner (or the agent itself) can attach an escrow to this order' })
  }

  // The task was linked to this escrow (and checked on-chain) just before —
  // see routes/tasks.ts. It must be this order's deal on this order's chain: its
  // buyer is this order's buyer (the agent or its owner) and its seller this
  // order's seller, so nobody can pin someone else's escrow onto their order.
  const task = await prisma.task.findUnique({
    where: { chainId_escrowId: { chainId: order.chainId, escrowId: parsed.data.escrowId } },
    select: { id: true, buyer: true, seller: true, verified: true },
  })
  if (!task?.verified) {
    return res.status(400).json({ error: `Escrow #${parsed.data.escrowId} has no task linked to it yet — link the task first.` })
  }
  if (!isPartyOf(task.buyer.toLowerCase(), order.buyerAgent) || task.seller.toLowerCase() !== order.sellerAgent.walletAddress?.toLowerCase()) {
    return res.status(400).json({ error: `Escrow #${parsed.data.escrowId} belongs to a different buyer or seller than this order.` })
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { status: 'funded', escrowId: parsed.data.escrowId, taskId: task.id },
    include: fullInclude,
  })
  res.json(orderView(updated, auth.wallet.toLowerCase()))
})
