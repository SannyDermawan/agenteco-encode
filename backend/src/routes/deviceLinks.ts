import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { recoverMessageAddress } from 'viem'
import { createSiweMessage, parseSiweMessage } from 'viem/siwe'
import { z } from 'zod'
import { prisma } from '../db.ts'
import { isAgentOwnerWallet, verifyOwnerAuth } from '../auth.ts'
import { requireViewer } from '../access.ts'
import { UnknownChainError, chainConfig, chainFamily, resolveServedChainId } from '../chains.ts'
import { FRONTEND_HOSTS, FRONTEND_ORIGINS } from '../origins.ts'
import { agentProofMessage } from '../../../agent-runtime/src/shared/deviceLink.ts'

/**
 * Device link (docs/ONBOARDING.md §4): a person approves an agent's key as theirs, in a browser,
 * with their own wallet, so the agent can be listed under their account without any password or
 * token being pasted anywhere. The link grants no spending authority either way.
 *
 *   agent  POST /device-links               proves control of its key, gets a short code
 *   person GET  /device-links/by-code/:code the page shows what is being approved (+ the message to sign)
 *   person POST /device-links/by-code/:code/approve   signs an EIP-4361 message naming the code, the agent wallet, the chain
 *   agent  GET  /device-links/:id           polls with its device secret until approved
 */
export const deviceLinksRouter = Router()
export const accountLinksRouter = Router()

const TTL_MS = 10 * 60_000
const MAX_ATTEMPTS = 5
// 32 unambiguous characters (no I, O, 0, 1): 8 of them are 40 bits.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CLOCK_SKEW_MS = 5 * 60_000
export const LINK_STATEMENT =
  'Approve this agent wallet as yours on AgentEco. It lists the agent under your account; it cannot spend your funds, and you can unlink it at any time.'

const WALLET = /^0x[a-fA-F0-9]{40}$/

function newCode(): string {
  const chars = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}

/** "k7qp m2xd" → "K7QP-M2XD"; null when it cannot be a code. */
export function normalizeCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (raw.length !== 8 || [...raw].some((c) => !ALPHABET.includes(c))) return null
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export { agentProofMessage }

const resourcesFor = (agentWallet: string, chainId: string) => [`agenteco:agent-wallet:${agentWallet.toLowerCase()}`, `agenteco:chain:${chainId}`]

const appUrl = () => (process.env.PUBLIC_APP_URL?.trim().replace(/\/+$/, '') || FRONTEND_ORIGINS[0] || 'http://localhost:3000')

type Link = NonNullable<Awaited<ReturnType<typeof prisma.deviceLink.findUnique>>>
const effectiveStatus = (link: Link) => (link.status === 'pending' && link.expiresAt.getTime() <= Date.now() ? 'expired' : link.status)

const createSchema = z.object({
  agentWallet: z.string().regex(WALLET),
  role: z.enum(['buyer', 'seller']),
  label: z.string().trim().min(1).max(60),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  deviceSecret: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
})

deviceLinksRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const { agentWallet, role, label, nonce, signature, deviceSecret } = parsed.data
  let chainId: string
  try {
    chainId = resolveServedChainId((req.body as { chainId?: string }).chainId)
  } catch (error) {
    if (error instanceof UnknownChainError) return res.status(400).json({ error: error.message })
    throw error
  }
  // The owner approves with an EIP-4361 message that names an EVM chain: not available for Solana agents yet.
  if (chainFamily(chainId) !== 'evm') return res.status(400).json({ error: `Linking an agent to a person is not available on ${chainId} yet` })

  try {
    const recovered = await recoverMessageAddress({ message: agentProofMessage(nonce, chainId, agentWallet), signature: signature as `0x${string}` })
    if (recovered.toLowerCase() !== agentWallet.toLowerCase()) return res.status(401).json({ error: 'The signature is not from the agent wallet' })
  } catch {
    return res.status(401).json({ error: 'Malformed signature' })
  }

  // One pending link per agent wallet: asking again replaces the earlier code.
  await prisma.deviceLink.deleteMany({ where: { agentWallet: agentWallet.toLowerCase(), status: 'pending' } })
  const expiresAt = new Date(Date.now() + TTL_MS)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const link = await prisma.deviceLink.create({
        data: { userCode: newCode(), agentWallet: agentWallet.toLowerCase(), chainId, role, label, secretHash: sha256(deviceSecret), expiresAt },
      })
      return res.status(201).json({ id: link.id, userCode: link.userCode, verifyUrl: `${appUrl()}/app/link`, expiresAt, intervalSeconds: 2 })
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error // a code collision: draw another
    }
  }
  res.status(503).json({ error: 'Could not allocate a code, try again' })
})

deviceLinksRouter.get('/by-code/:code', async (req, res) => {
  const code = normalizeCode(req.params.code)
  const link = code ? await prisma.deviceLink.findUnique({ where: { userCode: code } }) : null
  if (!link || effectiveStatus(link) !== 'pending') return res.status(404).json({ error: 'No pending link with that code — it may have expired. Start again from the terminal.' })

  const info = { userCode: link.userCode, agentWallet: link.agentWallet, chainId: link.chainId, role: link.role, label: link.label, expiresAt: link.expiresAt }
  const address = typeof req.query.address === 'string' ? req.query.address : undefined
  if (!address || !WALLET.test(address)) return res.json(info)

  const message = createSiweMessage({
    address: address as `0x${string}`,
    chainId: chainConfig(link.chainId).chain.id,
    domain: FRONTEND_HOSTS[0] ?? 'localhost:3000',
    uri: appUrl(),
    version: '1',
    statement: LINK_STATEMENT,
    nonce: randomBytes(8).toString('hex'),
    issuedAt: new Date(),
    expirationTime: link.expiresAt,
    requestId: link.userCode,
    resources: resourcesFor(link.agentWallet, link.chainId),
  })
  res.json({ ...info, message })
})

const approveSchema = z.object({
  address: z.string().regex(WALLET),
  message: z.string().min(1).max(2000),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
})

/** Why an approval message is not acceptable for this link, or null when it is. */
async function approvalProblem(link: Link, body: z.infer<typeof approveSchema>): Promise<string | null> {
  const fields = parseSiweMessage(body.message)
  const now = Date.now()
  if (!fields.address || fields.address.toLowerCase() !== body.address.toLowerCase()) return 'The message names another wallet'
  if (!fields.domain || !FRONTEND_HOSTS.includes(fields.domain.toLowerCase())) return 'The message was written for another website'
  if (fields.statement !== LINK_STATEMENT) return 'Unexpected statement'
  if (fields.requestId !== link.userCode) return 'The message is for another code'
  const resources = fields.resources ?? []
  const expected = resourcesFor(link.agentWallet, link.chainId)
  if (resources.length !== expected.length || !expected.every((r) => resources.includes(r))) return 'The message names another agent or chain'
  const issuedAt = fields.issuedAt?.getTime()
  const expiresAt = fields.expirationTime?.getTime()
  if (issuedAt === undefined || expiresAt === undefined || Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) return 'The message has no issue or expiry time'
  if (issuedAt > now + CLOCK_SKEW_MS || now - issuedAt > TTL_MS + CLOCK_SKEW_MS) return 'The message is too old or from the future'
  if (expiresAt <= now || expiresAt > link.expiresAt.getTime() + CLOCK_SKEW_MS) return 'The message has expired'
  try {
    const recovered = await recoverMessageAddress({ message: body.message, signature: body.signature as `0x${string}` })
    if (recovered.toLowerCase() !== body.address.toLowerCase()) return 'The signature does not match the wallet'
  } catch {
    return 'Malformed signature'
  }
  return null
}

deviceLinksRouter.post('/by-code/:code/approve', async (req, res) => {
  const parsed = approveSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const code = normalizeCode(req.params.code)
  const link = code ? await prisma.deviceLink.findUnique({ where: { userCode: code } }) : null
  if (!link || effectiveStatus(link) !== 'pending') return res.status(404).json({ error: 'No pending link with that code — it may have expired. Start again from the terminal.' })
  if (link.attempts >= MAX_ATTEMPTS) return res.status(429).json({ error: 'Too many wrong attempts for this code. Start again from the terminal.' })

  const problem = await approvalProblem(link, parsed.data)
  if (problem) {
    const failed = await prisma.deviceLink.update({ where: { id: link.id }, data: { attempts: { increment: 1 } } })
    if (failed.attempts >= MAX_ATTEMPTS) await prisma.deviceLink.update({ where: { id: link.id }, data: { status: 'denied' } })
    return res.status(400).json({ error: problem })
  }

  const owner = parsed.data.address.toLowerCase()
  await prisma.$transaction(async (tx) => {
    // Single use: only a still-pending link can be approved (a second request finds nothing to update).
    const claimed = await tx.deviceLink.updateMany({ where: { id: link.id, status: 'pending' }, data: { status: 'approved', ownerWallet: owner, approvedAt: new Date() } })
    if (claimed.count !== 1) throw new Error('already-used')
    await tx.accountLink.upsert({
      where: { agentWallet: link.agentWallet },
      create: { agentWallet: link.agentWallet, ownerWallet: owner },
      update: { ownerWallet: owner, revokedAt: null },
    })
    // Agents this key registered before the link belong to the person too.
    await tx.agent.updateMany({ where: { ownerWallet: { equals: link.agentWallet, mode: 'insensitive' }, deletedAt: null }, data: { accountWallet: owner } })
  }).catch((error: Error) => {
    if (error.message === 'already-used') return null
    throw error
  })
  const done = await prisma.deviceLink.findUnique({ where: { id: link.id } })
  if (done?.status !== 'approved') return res.status(409).json({ error: 'This code was already used' })
  res.json({ status: 'approved', agentWallet: link.agentWallet, ownerWallet: owner })
})

deviceLinksRouter.get('/:id', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'Not found' })
  const secret = req.header('x-device-secret') ?? ''
  const link = await prisma.deviceLink.findUnique({ where: { id: req.params.id } })
  const expected = Buffer.from(link?.secretHash ?? sha256('no such link'), 'hex')
  const given = Buffer.from(sha256(secret), 'hex')
  if (!link || expected.length !== given.length || !timingSafeEqual(expected, given)) return res.status(404).json({ error: 'Not found' })
  res.json({
    status: effectiveStatus(link),
    agentWallet: link.agentWallet,
    chainId: link.chainId,
    expiresAt: link.expiresAt,
    ...(link.status === 'approved' && { ownerWallet: link.ownerWallet }),
  })
})

// --- Account links: what a person sees and can undo ---------------------------------------------

/** The agent wallets linked to the signed-in person. */
accountLinksRouter.get('/', async (req, res) => {
  const viewer = await requireViewer(req, res)
  if (!viewer) return
  const links = await prisma.accountLink.findMany({ where: { ownerWallet: viewer, revokedAt: null }, orderBy: { createdAt: 'desc' } })
  res.json(links.map((l) => ({ agentWallet: l.agentWallet, createdAt: l.createdAt })))
})

/** Unlink an agent wallet: its agents keep working, listed under the key alone again. */
accountLinksRouter.delete('/:agentWallet', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })
  if (!WALLET.test(req.params.agentWallet)) return res.status(400).json({ error: 'agentWallet must be an address' })
  const agentWallet = req.params.agentWallet.toLowerCase()
  const link = await prisma.accountLink.findUnique({ where: { agentWallet } })
  if (!link || link.revokedAt || !isAgentOwnerWallet(auth.wallet, { ownerWallet: link.ownerWallet })) return res.status(404).json({ error: 'No such link' })
  await prisma.$transaction([
    prisma.accountLink.update({ where: { agentWallet }, data: { revokedAt: new Date() } }),
    prisma.agent.updateMany({ where: { ownerWallet: { equals: agentWallet, mode: 'insensitive' }, accountWallet: link.ownerWallet }, data: { accountWallet: null } }),
  ])
  res.status(204).end()
})
