import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.ts'
import { isAuthorizedForAgent, verifyOwnerAuth } from '../auth.ts'
import { UUID_REGEX, getArbiterSetup, requireViewer } from '../access.ts'
import { defaultChainId } from '../chains.ts'

/**
 * Listing moderation. Anyone signed in can report a seller; the arbiter
 * council decides. A report needs the council's admin threshold of matching
 * votes (2 of 3 today) to delist the agent or to dismiss the report. A
 * delisted agent disappears from the marketplace and from discovery, and takes
 * no new negotiations — escrows already funded still finish, so nobody's money
 * is stuck. Its owner can appeal, and the council votes the same way to
 * reinstate it or uphold the delisting.
 */
export const moderationRouter = Router()

export const REPORT_CATEGORIES = ['fake_results', 'scam', 'spam', 'harmful', 'other'] as const
const CATEGORY_LABEL: Record<(typeof REPORT_CATEGORIES)[number], string> = {
  fake_results: 'Fake or useless results',
  scam: 'Scam or fraud',
  spam: 'Spam or misleading listing',
  harmful: 'Harmful content',
  other: 'Other',
}
/** Reports one wallet may file per day. */
const DAILY_REPORT_LIMIT = 10
/** After an appeal is upheld, the owner waits this long before appealing again. */
const APPEAL_COOLDOWN_MS = 24 * 60 * 60 * 1000

const reportSchema = z.object({
  agentId: z.string().regex(UUID_REGEX, 'not an agent id'),
  category: z.enum(REPORT_CATEGORIES),
  reason: z.string().trim().min(10).max(1000),
})
const reportVoteSchema = z.object({ vote: z.enum(['delist', 'dismiss']) })
const appealSchema = z.object({
  agentId: z.string().regex(UUID_REGEX, 'not an agent id'),
  reason: z.string().trim().min(10).max(1000),
})
const appealVoteSchema = z.object({ vote: z.enum(['reinstate', 'uphold']) })

moderationRouter.param('id', (_req, res, next, id: string) => {
  if (!UUID_REGEX.test(id)) return res.status(404).json({ error: 'Not found' })
  next()
})

/**
 * Council members (lowercase) and how many matching votes decide a case. Listings are moderated
 * once for every chain, by the arbiter council of the default (first served) chain.
 */
async function council(): Promise<{ members: string[]; threshold: number }> {
  const setup = await getArbiterSetup(defaultChainId())
  if (setup.council) return { members: setup.council.members.map((m) => m.toLowerCase()), threshold: setup.council.adminThreshold }
  return { members: [setup.arbiter.toLowerCase()], threshold: 1 }
}

/** Votes on a case from current council members, counted by choice. */
async function tally(caseType: 'report' | 'appeal', caseId: string, members: string[]) {
  const votes = await prisma.moderationVote.findMany({ where: { caseType, caseId } })
  const counted = votes.filter((v) => members.includes(v.voterWallet))
  const count = (choice: string) => counted.filter((v) => v.vote === choice).length
  return { votes: counted.map((v) => ({ voter: v.voterWallet, vote: v.vote, at: v.createdAt })), count }
}

// ------------------------------------------------------------------ reports

moderationRouter.post('/reports', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })
  const parsed = reportSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const { agentId, category, reason } = parsed.data
  const reporter = auth.wallet.toLowerCase()

  const agent = await prisma.agent.findUnique({ where: { id: agentId } })
  if (!agent || agent.deletedAt || agent.role !== 'seller') return res.status(404).json({ error: 'Seller not found' })
  if (agent.delistedAt) return res.status(409).json({ error: 'This agent is already delisted' })
  if (isAuthorizedForAgent(auth.wallet, agent)) return res.status(400).json({ error: "You can't report your own agent" })

  const existing = await prisma.report.findFirst({ where: { agentId, reporterWallet: reporter, status: 'open' } })
  if (existing) return res.status(409).json({ error: 'You already reported this agent; the council is reviewing it' })
  const today = await prisma.report.count({ where: { reporterWallet: reporter, createdAt: { gt: new Date(Date.now() - 86_400_000) } } })
  if (today >= DAILY_REPORT_LIMIT) return res.status(429).json({ error: `At most ${DAILY_REPORT_LIMIT} reports a day` })

  // Someone who actually hired this seller is the strongest witness.
  const hadOrder =
    (await prisma.order.count({
      where: {
        sellerAgentId: agentId,
        buyerAgent: { OR: [{ ownerWallet: { equals: reporter, mode: 'insensitive' } }, { walletAddress: { equals: reporter, mode: 'insensitive' } }] },
      },
    })) > 0

  const report = await prisma.report.create({ data: { agentId, reporterWallet: reporter, category, reason, hadOrder } })
  res.status(201).json({ id: report.id, status: report.status, hadOrder })
})

moderationRouter.post('/reports/:id/vote', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })
  const parsed = reportVoteSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const { members, threshold } = await council()
  const voter = auth.wallet.toLowerCase()
  if (!members.includes(voter)) return res.status(403).json({ error: 'Only members of the arbiter council can vote' })

  const report = await prisma.report.findUnique({ where: { id: req.params.id } })
  if (!report) return res.status(404).json({ error: 'Report not found' })
  if (report.status !== 'open') return res.status(409).json({ error: `This report is already ${report.status}` })

  await prisma.moderationVote.upsert({
    where: { caseType_caseId_voterWallet: { caseType: 'report', caseId: report.id, voterWallet: voter } },
    create: { caseType: 'report', caseId: report.id, voterWallet: voter, vote: parsed.data.vote },
    update: { vote: parsed.data.vote },
  })
  const { count } = await tally('report', report.id, members)

  let status = 'open'
  if (count('delist') >= threshold) {
    const now = new Date()
    const delistReason = `${CATEGORY_LABEL[report.category as (typeof REPORT_CATEGORIES)[number]] ?? 'Reported'}: ${report.reason}`.slice(0, 500)
    await prisma.$transaction([
      prisma.agent.update({ where: { id: report.agentId }, data: { delistedAt: now, delistReason } }),
      // Every open report against this agent is answered by the same decision.
      prisma.report.updateMany({ where: { agentId: report.agentId, status: 'open' }, data: { status: 'delisted', resolvedAt: now } }),
      // No new deals: open negotiations end. Funded escrows are untouched and finish as usual.
      prisma.negotiation.updateMany({ where: { sellerAgentId: report.agentId, status: 'open' }, data: { status: 'rejected' } }),
    ])
    status = 'delisted'
  } else if (count('dismiss') >= threshold) {
    await prisma.report.update({ where: { id: report.id }, data: { status: 'dismissed', resolvedAt: new Date() } })
    status = 'dismissed'
  }
  res.json({ status, delist: count('delist'), dismiss: count('dismiss'), threshold })
})

// ------------------------------------------------------------------ appeals

moderationRouter.post('/appeals', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })
  const parsed = appealSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const { agentId, reason } = parsed.data

  const agent = await prisma.agent.findUnique({ where: { id: agentId } })
  if (!agent || agent.deletedAt) return res.status(404).json({ error: 'Agent not found' })
  if (auth.wallet.toLowerCase() !== agent.ownerWallet.toLowerCase()) return res.status(403).json({ error: 'Only the agent owner can appeal' })
  if (!agent.delistedAt) return res.status(400).json({ error: 'This agent is not delisted' })

  const last = await prisma.appeal.findFirst({ where: { agentId }, orderBy: { createdAt: 'desc' } })
  if (last?.status === 'open') return res.status(409).json({ error: 'An appeal for this agent is already with the council' })
  if (last?.status === 'upheld' && last.resolvedAt && Date.now() - last.resolvedAt.getTime() < APPEAL_COOLDOWN_MS) {
    return res.status(429).json({ error: 'You can appeal again 24 hours after the last decision' })
  }

  const appeal = await prisma.appeal.create({ data: { agentId, ownerWallet: auth.wallet.toLowerCase(), reason } })
  res.status(201).json({ id: appeal.id, status: appeal.status })
})

moderationRouter.post('/appeals/:id/vote', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })
  const parsed = appealVoteSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const { members, threshold } = await council()
  const voter = auth.wallet.toLowerCase()
  if (!members.includes(voter)) return res.status(403).json({ error: 'Only members of the arbiter council can vote' })

  const appeal = await prisma.appeal.findUnique({ where: { id: req.params.id } })
  if (!appeal) return res.status(404).json({ error: 'Appeal not found' })
  if (appeal.status !== 'open') return res.status(409).json({ error: `This appeal is already ${appeal.status}` })

  await prisma.moderationVote.upsert({
    where: { caseType_caseId_voterWallet: { caseType: 'appeal', caseId: appeal.id, voterWallet: voter } },
    create: { caseType: 'appeal', caseId: appeal.id, voterWallet: voter, vote: parsed.data.vote },
    update: { vote: parsed.data.vote },
  })
  const { count } = await tally('appeal', appeal.id, members)

  let status = 'open'
  if (count('reinstate') >= threshold) {
    const now = new Date()
    await prisma.$transaction([
      prisma.agent.update({ where: { id: appeal.agentId }, data: { delistedAt: null, delistReason: null } }),
      prisma.appeal.update({ where: { id: appeal.id }, data: { status: 'reinstated', resolvedAt: now } }),
    ])
    status = 'reinstated'
  } else if (count('uphold') >= threshold) {
    await prisma.appeal.update({ where: { id: appeal.id }, data: { status: 'upheld', resolvedAt: new Date() } })
    status = 'upheld'
  }
  res.json({ status, reinstate: count('reinstate'), uphold: count('uphold'), threshold })
})

// ------------------------------------------------------------------ views

/** The council's queue: open cases first (most-reported agents and reporters who hired the seller on top), then recent decisions. */
moderationRouter.get('/', async (req, res) => {
  const viewer = await requireViewer(req, res)
  if (!viewer) return
  const { members, threshold } = await council()
  if (!members.includes(viewer)) return res.status(403).json({ error: 'Only members of the arbiter council can see the moderation queue' })

  const agentSelect = { id: true, name: true, capabilities: true, ownerWallet: true, walletAddress: true, delistedAt: true, delistReason: true, taskStatus: true }
  const [reports, appeals] = await Promise.all([
    prisma.report.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: { agent: { select: agentSelect } } }),
    prisma.appeal.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { agent: { select: agentSelect } } }),
  ])
  const openByAgent = new Map<string, number>()
  for (const r of reports) if (r.status === 'open') openByAgent.set(r.agentId, (openByAgent.get(r.agentId) ?? 0) + 1)

  const withVotes = async <T extends { id: string }>(caseType: 'report' | 'appeal', rows: T[]) =>
    Promise.all(rows.map(async (row) => ({ ...row, votes: (await tally(caseType, row.id, members)).votes })))

  const sortedReports = [...reports].sort((a, b) => {
    if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open' ? -1 : 1
    const weight = (r: (typeof reports)[number]) => (openByAgent.get(r.agentId) ?? 0) * 2 + (r.hadOrder ? 1 : 0)
    return weight(b) - weight(a) || b.createdAt.getTime() - a.createdAt.getTime()
  })
  res.json({
    threshold,
    members,
    reports: (await withVotes('report', sortedReports.slice(0, 100))).map((r) => ({ ...r, openReportsForAgent: openByAgent.get(r.agentId) ?? 0 })),
    appeals: await withVotes('appeal', [...appeals].sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open'))),
  })
})

/** An agent's moderation status for its owner (or the council): why it was delisted, and its appeals. */
moderationRouter.get('/agents/:id', async (req, res) => {
  const viewer = await requireViewer(req, res)
  if (!viewer) return
  const agent = await prisma.agent.findUnique({ where: { id: req.params.id } })
  if (!agent) return res.status(404).json({ error: 'Agent not found' })
  const { members } = await council()
  if (viewer !== agent.ownerWallet.toLowerCase() && !members.includes(viewer)) {
    return res.status(403).json({ error: 'Only the agent owner and the arbiter council can see this' })
  }
  const appeals = await prisma.appeal.findMany({ where: { agentId: agent.id }, orderBy: { createdAt: 'desc' } })
  res.json({ delistedAt: agent.delistedAt, delistReason: agent.delistReason, appeals })
})
