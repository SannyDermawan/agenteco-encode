import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { CAPABILITIES, isCapabilityId } from '../../../agent-runtime/src/shared/capabilities/definitions.ts'
import { canonicalize } from '../../../agent-runtime/src/shared/hashes.ts'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { prisma, prismaWithAgentKey } from '../db.ts'
import { isAuthorizedForAgent, verifyOwnerAuth } from '../auth.ts'
import { UUID_REGEX, agentView, isAgentOwner, optionalViewer, visibleAgentsFilter } from '../access.ts'
import { encryptAgentKey } from '../agentKeyCrypto.ts'
import { findBlockingWork, withdrawHostedWallet } from '../agentDeletion.ts'
import { createAgentSchema, heartbeatSchema, listAgentsQuerySchema, updateAgentSchema } from '../schemas/agent.ts'
import { unknownCapabilities } from '../capabilityRegistry.ts'
import { UnknownChainError, readChain, requestChain, resolveServedChainId } from '../chains.ts'
import { registrationFileFor } from '../erc8004.ts'
import { z } from 'zod'

export const agentsRouter = Router()

// Postgres rejects a non-uuid id outright — that's a 404, not a server error.
agentsRouter.param('id', (_req, res, next, id: string) => {
  if (!UUID_REGEX.test(id)) return res.status(404).json({ error: 'Agent not found' })
  next()
})

// Sellers are the public marketplace; a buyer agent (and its task) is listed
// only to its owner. Private settings are stripped for everyone else.
agentsRouter.get('/', async (req, res) => {
  const viewer = await optionalViewer(req, res)
  if (viewer === undefined) return
  const parsed = listAgentsQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }
  const { role, isOnline, capability, ownerWallet, taskStatus, q, chain, groupId } = parsed.data
  // ?chain= narrows the listing to one chain's agents; without it, every served chain's.
  let chainId: string | undefined
  if (chain) {
    try {
      chainId = resolveServedChainId(chain)
    } catch (error) {
      if (error instanceof UnknownChainError) return res.status(400).json({ error: error.message })
      throw error
    }
  }

  const agents = await prisma.agent.findMany({
    where: {
      AND: [
        { deletedAt: null },
        visibleAgentsFilter(viewer),
        // A delisted agent is gone from the marketplace and from discovery; its owner still sees it.
        viewer ? { OR: [{ delistedAt: null }, { ownerWallet: { equals: viewer, mode: 'insensitive' as const } }] } : { delistedAt: null },
        ...(q
          ? [
              {
                OR: [
                  { name: { contains: q, mode: 'insensitive' as const } },
                  { description: { contains: q, mode: 'insensitive' as const } },
                  { service: { contains: q, mode: 'insensitive' as const } },
                ],
              },
            ]
          : []),
      ],
      ...(chainId && { chainId }),
      ...(groupId && { groupId }),
      ...(role && { role }),
      ...(isOnline !== undefined && { isOnline }),
      ...(capability && { capabilities: { has: capability } }),
      ...(ownerWallet && { ownerWallet: { equals: ownerWallet, mode: 'insensitive' } }),
      ...(taskStatus && { taskStatus }),
    },
    orderBy: { createdAt: 'desc' },
  })
  res.json(agents.map((agent) => agentView(agent, viewer)))
})

agentsRouter.get('/:id', async (req, res) => {
  const viewer = await optionalViewer(req, res)
  if (viewer === undefined) return
  const agent = await prisma.agent.findUnique({ where: { id: req.params.id } })
  if (!agent) return res.status(404).json({ error: 'Agent not found' })
  // A buyer agent is a private task: it does not exist for anyone but its owner.
  if (agent.role === 'buyer' && !isAgentOwner(viewer, agent)) return res.status(404).json({ error: 'Agent not found' })
  res.json(agentView(agent, viewer))
})

/**
 * The listing's ERC-8004 registration file — what its identity's URI points at
 * (https://eips.ethereum.org/EIPS/eip-8004#registration-v1). Sellers only: buyer agents are private.
 */
agentsRouter.get('/:id/registration.json', async (req, res) => {
  const agent = await prisma.agent.findUnique({ where: { id: req.params.id } })
  if (!agent || agent.role !== 'seller') return res.status(404).json({ error: 'Agent not found' })
  res.json(registrationFileFor(agent, `${req.protocol}://${req.get('host')}`))
})

/**
 * Records the listing's ERC-8004 identity. Nothing is trusted but the transaction hash: the
 * Registered event in its receipt (on the listing's chain, from that chain's Identity Registry)
 * must name the agent's own wallet (or its owner) as the identity's owner, and point at this
 * listing's registration file.
 */
agentsRouter.post('/:id/erc8004', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })
  const parsed = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'txHash must be a transaction hash' })

  const agent = await prisma.agent.findUnique({ where: { id: req.params.id } })
  if (!agent || agent.deletedAt) return res.status(404).json({ error: 'Agent not found' })
  if (!isAuthorizedForAgent(auth.wallet, agent)) return res.status(403).json({ error: "Only the agent's own wallet or its owner can record its identity" })
  const chain = readChain(agent.chainId)
  if (!chain.config.erc8004) return res.status(400).json({ error: `ERC-8004 is not configured on ${agent.chainId}` })

  let registered: Awaited<ReturnType<typeof chain.erc8004Registration>>
  try {
    registered = await chain.erc8004Registration(parsed.data.txHash)
  } catch {
    return res.status(400).json({ error: 'Could not read that transaction — is it mined yet?' })
  }
  if (!registered) return res.status(400).json({ error: `That transaction registered no agent in the Identity Registry on ${agent.chainId}` })
  const owner = registered.owner.toLowerCase()
  if (owner !== agent.walletAddress?.toLowerCase() && owner !== agent.ownerWallet.toLowerCase()) {
    return res.status(400).json({ error: "The registered identity is owned by neither the agent's wallet nor its owner" })
  }
  if (!registered.agentURI.endsWith(`/agents/${agent.id}/registration.json`)) {
    return res.status(400).json({ error: "The registered identity does not point at this listing's registration file" })
  }
  const agentId = registered.agentId.toString()
  if (agent.erc8004AgentId && agent.erc8004AgentId !== agentId) {
    return res.status(409).json({ error: `This listing already has ERC-8004 identity #${agent.erc8004AgentId}` })
  }
  const updated = await prisma.agent.update({ where: { id: agent.id }, data: { erc8004AgentId: agentId }, select: { id: true, chainId: true, erc8004AgentId: true } })
  res.json(updated)
})

// Creating an agent claims a wallet as its owner — that claim must be
// backed by a signature, or anyone could register agents "owned by"
// addresses they don't control.
agentsRouter.post('/', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })
  // The chain this listing trades on (body chainId, default: the default chain).
  const chainId = requestChain(req, res)
  if (!chainId) return

  const parsed = createAgentSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }

  const { hosted, ...agentData } = parsed.data
  const unknown = await unknownCapabilities(agentData.capabilities)
  if (unknown.length) {
    return res.status(400).json({ error: `Unknown capability "${unknown[0]}" — publish it in the capability registry first.` })
  }

  // A hosted buyer task (or a seller created with hosted: true) gets its own
  // wallet — the host runtime signs with it directly, so the human never has
  // to keep MetaMask open once it's funded. See agentKeyCrypto.ts for the
  // (testnet-only) custodial trade-off.
  const hostedFields: Partial<Prisma.AgentCreateInput> = {}
  // hosted: false = a self-hosted buyer (SDK, buyer-agent/) paying from its own key.
  if ((agentData.role === 'buyer' && hosted !== false) || hosted) {
    const agentPrivateKey = generatePrivateKey()
    const agentAccount = privateKeyToAccount(agentPrivateKey)
    hostedFields.walletAddress = agentAccount.address
    hostedFields.agentWalletKey = encryptAgentKey(agentPrivateKey)
    hostedFields.taskStatus = 'awaiting_deposit'
    hostedFields.depositorWallet = auth.wallet
  }
  if (agentData.role === 'seller' && hosted) {
    // Hidden from buyers until activated — nothing would answer them yet.
    hostedFields.isOnline = false
    hostedFields.escrowScanBlock = await readChain(chainId).head()
  }

  // Store the brief as its schema normalised it (trimmed text, lowercase coin
  // ids…) — exactly what the seller will execute.
  const capability = agentData.capabilities[0]
  if (agentData.taskBrief !== undefined && capability && isCapabilityId(capability)) {
    agentData.taskBrief = canonicalize(CAPABILITIES[capability].input.parse(agentData.taskBrief))
  }

  const agent = await prisma.agent.create({
    data: { ...agentData, chainId, ownerWallet: auth.wallet, ...hostedFields } as Prisma.AgentCreateInput,
  })
  res.status(201).json(agent)
})

// A self-hosted agent's own process says it is running (online: true) or stopping
// (online: false). Signed by the agent's wallet (the SDK) or its owner. Hosted
// agents are run by AgentEco, so they never beat. See maintenance.ts.
agentsRouter.post('/:id/heartbeat', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })
  const parsed = heartbeatSchema.safeParse(req.body ?? {})
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const agent = await prisma.agent.findUnique({ where: { id: req.params.id } })
  if (!agent || agent.deletedAt) return res.status(404).json({ error: 'Agent not found' })
  if (agent.taskStatus !== null) return res.status(400).json({ error: 'This agent is hosted by AgentEco and needs no heartbeat' })
  if (!isAuthorizedForAgent(auth.wallet, agent)) {
    return res.status(403).json({ error: "Only the agent's own wallet or its owner can report it running" })
  }
  // Online means "the agent is running": only the process holding the agent's key can say so.
  // The owner may still take it offline (e.g. after stopping it elsewhere).
  const fromAgent = !!agent.walletAddress && auth.wallet.toLowerCase() === agent.walletAddress.toLowerCase()
  if (parsed.data.online && !fromAgent) {
    return res.status(403).json({ error: "Only the running agent, signing with its own wallet, can put it online" })
  }
  const updated = await prisma.agent.update({
    where: { id: agent.id },
    data: { isOnline: parsed.data.online, lastSeenAt: new Date() },
    select: { id: true, isOnline: true, lastSeenAt: true, delistedAt: true },
  })
  res.json(updated)
})

// The human confirms they've sent the deposit to the agent's wallet — a
// buyer needs the token (maxBudget) plus a little native gas for the host
// runtime's own transactions; a seller only needs the gas. Verified on-chain here,
// not just trusted — the same "prove it, don't claim it" pattern as
// everything else that moves money in this app.
agentsRouter.post('/:id/activate', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })

  const agent = await prisma.agent.findUnique({ where: { id: req.params.id } })
  if (!agent || agent.deletedAt) return res.status(404).json({ error: 'Agent not found' })
  if (!agent.walletAddress || agent.taskStatus === null) {
    return res.status(400).json({ error: 'This agent is not hosted by AgentEco' })
  }
  if (auth.wallet.toLowerCase() !== agent.ownerWallet.toLowerCase()) {
    return res.status(403).json({ error: 'Only the agent owner can activate it' })
  }
  if (agent.taskStatus !== 'awaiting_deposit') {
    return res.status(400).json({ error: `Agent is already ${agent.taskStatus}` })
  }

  const { checkHostedDeposit } = await import('../hostedDeposit.ts')
  const isSeller = agent.role === 'seller'
  const requiredUsdt = isSeller ? '0' : agent.maxBudget!.toString()
  const check = await checkHostedDeposit(agent.chainId, agent.walletAddress as `0x${string}`, requiredUsdt)
  if (!check.ok) return res.status(400).json({ error: check.error })

  const updated = await prisma.agent.update({
    where: { id: agent.id },
    // A hosted seller goes live in the marketplace only now that the host can actually serve it.
    data: { taskStatus: 'active', ...(isSeller && { isOnline: true }) },
  })
  res.json(updated)
})

agentsRouter.patch('/:id', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })

  const parsed = updateAgentSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }
  const existing = await prisma.agent.findUnique({ where: { id: req.params.id } })
  if (!existing || existing.deletedAt) return res.status(404).json({ error: 'Agent not found' })

  if (auth.wallet.toLowerCase() !== existing.ownerWallet.toLowerCase()) {
    return res.status(403).json({ error: 'Only the agent owner can update this agent' })
  }
  if (parsed.data.capabilities) {
    const unknown = await unknownCapabilities(parsed.data.capabilities)
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown capability "${unknown[0]}" — publish it in the capability registry first.` })
    }
    // Hosted agents run on AgentEco's executors, which only know the platform capabilities.
    if (existing.taskStatus !== null && parsed.data.capabilities.some((c) => !isCapabilityId(c))) {
      return res.status(400).json({ error: 'Hosted agents run platform capabilities only.' })
    }
  }
  if (parsed.data.isOnline && existing.role === 'seller' && existing.taskStatus === 'awaiting_deposit') {
    return res.status(400).json({ error: 'Deposit gas and activate this agent before putting it online' })
  }
  // A self-hosted seller is online while its own process (signing with the agent's wallet) runs, not by a switch.
  const fromAgent = !!existing.walletAddress && auth.wallet.toLowerCase() === existing.walletAddress.toLowerCase()
  if (parsed.data.isOnline && existing.role === 'seller' && existing.taskStatus === null && !existing.isOnline && !fromAgent) {
    return res.status(400).json({ error: 'A self-hosted seller goes online by running it: its SDK reports it online with its heartbeat' })
  }
  // AgentEco generated a hosted agent's wallet and holds its key; pointing the
  // agent at another address would let its owner pass as that wallet.
  if (
    parsed.data.walletAddress !== undefined &&
    existing.taskStatus !== null &&
    parsed.data.walletAddress.toLowerCase() !== existing.walletAddress?.toLowerCase()
  ) {
    return res.status(400).json({ error: "A hosted agent's wallet is managed by AgentEco and cannot be changed" })
  }

  const agent = await prisma.agent.update({
    where: { id: req.params.id },
    data: parsed.data as Prisma.AgentUpdateInput,
  })
  res.json(agent)
})

// Soft delete (see schema.prisma) — refused while the agent is mid-deal, so
// no counterparty is left stranded. A hosted agent's own wallet is emptied
// back to its funder first; its key stays encrypted in the row, unused.
agentsRouter.delete('/:id', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })

  // The only route allowed to read agentWalletKey — it has to sign the withdrawal.
  const agent = await prismaWithAgentKey.agent.findUnique({ where: { id: req.params.id } })
  if (!agent || agent.deletedAt) return res.status(404).json({ error: 'Agent not found' })
  if (auth.wallet.toLowerCase() !== agent.ownerWallet.toLowerCase()) {
    return res.status(403).json({ error: 'Only the agent owner can delete this agent' })
  }

  const blocking = await findBlockingWork(agent)
  if (blocking) return res.status(409).json({ error: blocking })

  if (agent.agentWalletKey && agent.depositorWallet) {
    try {
      await withdrawHostedWallet(agent.chainId, agent.agentWalletKey, agent.depositorWallet as `0x${string}`, agent.name)
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : 'unknown error'
      return res.status(502).json({ error: `Could not return the agent wallet's funds, so nothing was deleted: ${reason}` })
    }
  }

  await prisma.$transaction([
    prisma.negotiation.updateMany({
      where: { status: 'open', OR: [{ buyerAgentId: agent.id }, { sellerAgentId: agent.id }] },
      data: { status: 'rejected' },
    }),
    prisma.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date(), isOnline: false } }),
  ])
  res.status(204).end()
})
