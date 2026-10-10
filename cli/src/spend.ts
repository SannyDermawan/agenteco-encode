import { join } from 'node:path'
import { capsFor, type Config } from './config.ts'
import { readJson, writeJsonAtomic } from './home.ts'

/**
 * The spend caps, enforced where a hire starts. A job reserves its budget when it starts (so two
 * jobs started together cannot both fit under the daily cap), the reservation shrinks to the
 * agreed price once the escrow is funded, and it is released if the job fails before any money moved.
 *
 * These are guardrails, not a security boundary: a person (or an agent with file access) can edit
 * config.json. The real boundary is that the agent wallet only holds what it was given.
 */
export class SpendCapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpendCapError'
  }
}

interface Entry {
  jobId: string
  chainId: string
  amount: number
  /** UTC day, YYYY-MM-DD. */
  day: string
}

const ledgerPath = (home: string) => join(home, 'spend.json')
const dayOf = (now: Date) => now.toISOString().slice(0, 10)
const round = (n: number) => Math.round(n * 1e6) / 1e6

function read(home: string, now: Date): Entry[] {
  // Only today matters; older entries are dropped when the file is next written.
  return (readJson<{ entries: Entry[] }>(ledgerPath(home))?.entries ?? []).filter((e) => e.day === dayOf(now))
}

function write(home: string, entries: Entry[]): void {
  writeJsonAtomic(ledgerPath(home), { entries })
}

export function spentToday(home: string, chainId: string, now = new Date()): number {
  return round(read(home, now).filter((e) => e.chainId === chainId).reduce((sum, e) => sum + e.amount, 0))
}

/** Reserves `amount` of today's budget for a job, or throws SpendCapError saying which cap it hit. */
export function reserve(home: string, config: Config, job: { jobId: string; chainId: string; amount: number; symbol: string }, now = new Date()): void {
  const caps = capsFor(config, job.chainId)
  if (!(job.amount > 0)) throw new SpendCapError('The budget must be above zero.')
  if (caps.maxPerJob <= 0 || caps.maxPerDay <= 0) {
    throw new SpendCapError(`Spending is off on ${job.chainId} (maxPerJob ${caps.maxPerJob}, maxPerDay ${caps.maxPerDay}). A person turns it on by raising the caps in ${join(home, 'config.json')}.`)
  }
  if (job.amount > caps.maxPerJob) {
    throw new SpendCapError(`This job's budget is ${job.amount} ${job.symbol}, above the per-job cap of ${caps.maxPerJob} on ${job.chainId}. Lower the budget, or a person raises "maxPerJob" in ${join(home, 'config.json')}.`)
  }
  const entries = read(home, now)
  const spent = round(entries.filter((e) => e.chainId === job.chainId).reduce((sum, e) => sum + e.amount, 0))
  if (spent + job.amount > caps.maxPerDay) {
    throw new SpendCapError(`Today's cap on ${job.chainId} is ${caps.maxPerDay} ${job.symbol}; ${spent} is already reserved or spent, so ${job.amount} more does not fit. It resets at 00:00 UTC, or a person raises "maxPerDay" in ${join(home, 'config.json')}.`)
  }
  write(home, [...entries, { jobId: job.jobId, chainId: job.chainId, amount: round(job.amount), day: dayOf(now) }])
}

/** The agreed price replaces the budget that was reserved. */
export function settleReservation(home: string, jobId: string, amount: number, now = new Date()): void {
  write(home, read(home, now).map((e) => (e.jobId === jobId ? { ...e, amount: round(amount) } : e)))
}

/** The job failed before any money moved: its reservation is returned. */
export function release(home: string, jobId: string, now = new Date()): void {
  write(home, read(home, now).filter((e) => e.jobId !== jobId))
}
