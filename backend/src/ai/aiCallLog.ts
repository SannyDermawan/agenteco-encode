import { Router } from 'express'
import { prisma } from '../db.ts'
import { setLLMRecorder, type LLMEvent } from './llm.ts'

/**
 * Persists every AI attempt (task, provider, outcome, duration) so the load
 * test, or anyone debugging a slow demo, can count 429s and fallbacks per
 * stage across processes. Writes are fire-and-forget: a slow or failing
 * database never delays or breaks an AI call.
 */
export function installAiCallLog(): void {
  setLLMRecorder((e: LLMEvent) => {
    prisma.aiCall
      .create({ data: { task: e.task, provider: e.provider, model: e.model, outcome: e.outcome, ms: e.ms, agentId: e.agentId ?? null } })
      .catch(() => {})
  })
}

export interface AiCallStats {
  since: string
  /** Per task: how many attempts ended in each outcome, and the average time of the successful ones. */
  byTask: Record<string, Record<string, number> & { avgOkMs?: number }>
  /** Per provider: attempts by outcome. */
  byProvider: Record<string, Record<string, number>>
  totals: { attempts: number; ok: number; rateLimited: number; fallbacks: number }
}

export async function aiCallStats(since: Date): Promise<AiCallStats> {
  const rows = await prisma.aiCall.findMany({ where: { createdAt: { gte: since } }, select: { task: true, provider: true, outcome: true, ms: true } })
  const byTask: AiCallStats['byTask'] = {}
  const byProvider: AiCallStats['byProvider'] = {}
  const okMs: Record<string, number[]> = {}
  for (const r of rows) {
    const t = (byTask[r.task] ??= {} as AiCallStats['byTask'][string])
    t[r.outcome] = (t[r.outcome] ?? 0) + 1
    if (r.provider !== 'none') {
      const p = (byProvider[r.provider] ??= {})
      p[r.outcome] = (p[r.outcome] ?? 0) + 1
    }
    if (r.outcome === 'ok' && r.ms !== null) (okMs[r.task] ??= []).push(r.ms)
  }
  for (const [task, times] of Object.entries(okMs)) {
    byTask[task].avgOkMs = Math.round(times.reduce((a, b) => a + b, 0) / times.length)
  }
  const count = (o: string) => rows.filter((r) => r.outcome === o).length
  return {
    since: since.toISOString(),
    byTask,
    byProvider,
    totals: { attempts: rows.filter((r) => r.provider !== 'none').length, ok: count('ok'), rateLimited: count('rate_limited'), fallbacks: count('fallback') },
  }
}

export const aiCallsRouter = Router()

// Public and content-free: counts only, never prompts or answers.
aiCallsRouter.get('/stats', async (req, res) => {
  const raw = typeof req.query.since === 'string' ? new Date(req.query.since) : new Date(Date.now() - 60 * 60 * 1000)
  if (Number.isNaN(raw.getTime())) return res.status(400).json({ error: 'since must be an ISO date' })
  res.json(await aiCallStats(raw))
})
