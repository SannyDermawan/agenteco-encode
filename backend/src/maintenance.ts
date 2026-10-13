import { prisma } from './db.ts'
import { log, logError } from './log.ts'
import { NEGOTIATION_TURN_SECONDS, SELF_HOSTED_STALE_SECONDS } from '../../agent-runtime/src/durations.ts'

/**
 * Housekeeping the API runs every few seconds, so the marketplace never shows
 * an agent as available when nothing will answer:
 * - a self-hosted seller whose process stopped sending heartbeats goes offline;
 * - a negotiation whose turn-holder stayed silent too long expires, so the
 *   other side can move on.
 * Both are idempotent; running them twice changes nothing.
 */

const SWEEP_MS = 15_000

/** The time a negotiation has been waiting on its current turn, from its latest message. */
export function turnExpired(lastMessageAt: Date, now = new Date(), turnSeconds = NEGOTIATION_TURN_SECONDS): boolean {
  return now.getTime() - lastMessageAt.getTime() > turnSeconds * 1000
}

/** Self-hosted sellers (no hosted task) that have not sent a heartbeat recently. */
export async function takeStaleSelfHostedOffline(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SELF_HOSTED_STALE_SECONDS * 1000)
  const { count } = await prisma.agent.updateMany({
    where: {
      role: 'seller',
      taskStatus: null,
      isOnline: true,
      deletedAt: null,
      OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }],
    },
    data: { isOnline: false },
  })
  return count
}

/** Open negotiations whose latest message is older than the turn limit. */
export async function expireSilentNegotiations(now = new Date()): Promise<number> {
  const open = await prisma.negotiation.findMany({
    where: { status: 'open' },
    select: { id: true, messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } } },
  })
  const stale = open.filter((n) => n.messages[0] && turnExpired(n.messages[0].createdAt, now)).map((n) => n.id)
  if (!stale.length) return 0
  const { count } = await prisma.negotiation.updateMany({ where: { id: { in: stale }, status: 'open' }, data: { status: 'expired' } })
  return count
}

export function startMaintenance(): void {
  const run = async () => {
    try {
      const offline = await takeStaleSelfHostedOffline()
      const expired = await expireSilentNegotiations()
      if (offline) log(`${offline} self-hosted seller(s) stopped sending heartbeats, now offline`, 'API')
      if (expired) log(`${expired} negotiation(s) expired: the side whose turn it was stayed silent for ${NEGOTIATION_TURN_SECONDS}s`, 'API')
    } catch (error) {
      logError('Maintenance sweep failed', error, 'API')
    }
  }
  void run()
  setInterval(run, SWEEP_MS).unref()
}
