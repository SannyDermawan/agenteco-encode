import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { parseUnits } from 'viem'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db.ts'
import { verifyOwnerAuth } from '../auth.ts'
import { UUID_REGEX, canViewParties, guardEscrow, requireViewer } from '../access.ts'
import { chainFamily, readAdapter, requestChain } from '../chains.ts'
import { buildTaskPreimage, canonicalize, hashPreimage, normalizePrice } from '../../../agent-runtime/src/shared/hashes.ts'
import { CAPABILITIES, isCapabilityId } from '../../../agent-runtime/src/shared/capabilities/definitions.ts'
import { validateWithSchema } from '../../../agent-runtime/src/shared/capabilities/custom.ts'
import { getCapability } from '../capabilityRegistry.ts'
import { createTaskSchema, linkTaskEscrowSchema } from '../schemas/task.ts'
import { normalizeWallet, walletFamily } from '../../../agent-runtime/src/shared/wallets.ts'

export const tasksRouter = Router()

/**
 * Step 1 of every hire (spec §5): store the task before createEscrow. The
 * server builds the preimage itself with the shared helper — the buyer is the
 * signed-in wallet, never a body field — and returns the taskHash the buyer
 * must pass to createEscrow. The task belongs to one chain (body chainId,
 * default: the default chain); its escrow must be created there.
 */
tasksRouter.post('/', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })
  const chainId = requestChain(req, res)
  if (!chainId) return

  const parsed = createTaskSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const { capability, criteria, seller } = parsed.data

  // Platform capabilities validate with their zod schemas; community ones with their published JSON Schema.
  let brief: { data: unknown }
  if (isCapabilityId(capability)) {
    const checked = CAPABILITIES[capability].input.safeParse(parsed.data.brief)
    if (!checked.success) {
      return res.status(400).json({ error: `Invalid ${capability} brief: ${checked.error.issues.map((i) => i.message).join('; ')}` })
    }
    brief = checked
  } else {
    const info = await getCapability(capability)
    if (!info) return res.status(400).json({ error: `Unknown capability "${capability}" — publish it in the registry first.` })
    const checked = validateWithSchema(info.inputSchema, parsed.data.brief)
    if (!checked.ok) return res.status(400).json({ error: `Invalid ${capability} brief: ${checked.error}` })
    brief = checked
  }

  // Both parties must be wallets of the chain's family: an EVM address cannot be a party on a Solana chain, nor the reverse.
  const family = chainFamily(chainId)
  if (walletFamily(auth.wallet) !== family || walletFamily(seller) !== family) {
    return res.status(400).json({ error: `On ${chainId} both the buyer and the seller must be ${family === 'solana' ? 'Solana' : 'EVM'} wallets` })
  }

  let price: string
  try {
    price = normalizePrice(parsed.data.price)
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message })
  }

  const input = {
    capability,
    brief: brief.data,
    criteria: criteria?.trim() ?? '',
    price,
    buyer: auth.wallet,
    seller,
    nonce: parsed.data.nonce ?? randomUUID(),
  }
  const preimage = buildTaskPreimage(input)
  const taskHash = hashPreimage(preimage)

  const task = await prisma.task.create({
    data: {
      chainId,
      capability,
      brief: canonicalize(brief.data) as Prisma.InputJsonValue,
      criteria: input.criteria,
      price,
      buyer: normalizeWallet(auth.wallet),
      seller: normalizeWallet(seller),
      nonce: input.nonce,
      preimage,
      taskHash,
    },
  })
  res.status(201).json(task)
})

/**
 * Step 2, after createEscrow: link the escrow on the task's own chain. Accepted only when the chain
 * agrees — same taskHash, buyer, seller and amount — so a task can never be
 * attached to someone else's escrow or a different price. That on-chain
 * check is the proof, so no signature is needed: the buyer's browser saves a
 * wallet prompt, and anyone can finish a link a closed tab left undone.
 */
tasksRouter.post('/:id/escrow', async (req, res) => {
  const parsed = linkTaskEscrowSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'escrowId must be a number' })

  if (!UUID_REGEX.test(req.params.id)) return res.status(404).json({ error: 'Task not found' })
  const task = await prisma.task.findUnique({ where: { id: req.params.id } })
  if (!task) return res.status(404).json({ error: 'Task not found' })
  if (task.escrowId) {
    return task.escrowId === parsed.data.escrowId ? res.json(linkReceipt(task)) : res.status(409).json({ error: 'Task already linked to another escrow' })
  }

  const escrowId = BigInt(parsed.data.escrowId)
  const chain = readAdapter(task.chainId)
  let onchain: { buyer: string; seller: string; amount: bigint; taskHash: string }
  try {
    const [{ buyer, seller, amount }, { taskHash }] = await Promise.all([chain.getEscrowBasic(escrowId), chain.getEscrowHashes(escrowId)])
    onchain = { buyer, seller, amount, taskHash }
  } catch {
    return res.status(400).json({ error: 'Could not read this escrow on-chain — is the id correct?' })
  }

  const { decimals } = await chain.token()
  const problems = [
    onchain.taskHash.toLowerCase() !== task.taskHash.toLowerCase() && 'taskHash',
    normalizeWallet(onchain.buyer) !== task.buyer && 'buyer',
    normalizeWallet(onchain.seller) !== task.seller && 'seller',
    onchain.amount !== parseUnits(task.price, decimals) && 'amount',
  ].filter(Boolean)
  if (problems.length) {
    return res.status(400).json({ error: `Escrow #${escrowId} does not match this task (${problems.join(', ')} differ).` })
  }

  const linked = await prisma.task.update({ where: { id: task.id }, data: { escrowId: parsed.data.escrowId, verified: true } })
  res.json(linkReceipt(linked))
})

/** What an unsigned link call gets back: never the brief itself. */
function linkReceipt(task: { id: string; chainId: string; escrowId: string | null; taskHash: string; verified: boolean }) {
  return { id: task.id, chainId: task.chainId, escrowId: task.escrowId, taskHash: task.taskHash, verified: task.verified }
}

// The brief and its preimage — only for the escrow's buyer, seller and the
// arbiter, who can re-hash it against the chain.
tasksRouter.get('/by-escrow/:escrowId', async (req, res) => {
  const access = await guardEscrow(req, res, req.params.escrowId)
  if (!access) return
  const task = await prisma.task.findUnique({ where: { chainId_escrowId: { chainId: access.chainId, escrowId: req.params.escrowId } } })
  if (!task) return res.status(404).json({ error: 'No task linked to this escrow' })
  res.json(task)
})

tasksRouter.get('/:id', async (req, res) => {
  const viewer = await requireViewer(req, res)
  if (!viewer) return
  if (!UUID_REGEX.test(req.params.id)) return res.status(404).json({ error: 'Task not found' })
  const task = await prisma.task.findUnique({ where: { id: req.params.id } })
  if (!task) return res.status(404).json({ error: 'Task not found' })
  if (!(await canViewParties(viewer, { buyer: task.buyer, seller: task.seller }, task.chainId))) {
    return res.status(403).json({ error: 'This task is private — only its buyer, seller and the arbiter can see it.' })
  }
  res.json(task)
})
