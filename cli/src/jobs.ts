import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { chainConfig, signerChain } from '../../agent-runtime/src/chain/registry.ts'
import {
  UNPUBLISHED_REASON,
  awaitDelivery,
  disputeHire,
  openHire,
  settleHire,
  type HireContext,
  type HireHandle,
  type SettleOutcome,
} from '../../agent-runtime/src/sdk/index.ts'
import { resolveChain, assertChainAllowed, tokenSymbolFor, type Config } from './config.ts'
import { ensureDir, readJson, writeJsonAtomic } from './home.ts'
import { SpendCapError, release, reserve, settleReservation } from './spend.ts'

/**
 * A hire as a long-lived job: started now, worked in the background, decided later — by a person
 * at a terminal or by the agent calling the MCP server. Each job is one file, so a restart resumes
 * it. The reviewer is whoever calls settle/dispute: nothing here ever pays for a result by itself.
 */
export type JobStage =
  | 'negotiating' // finding a seller, agreeing a price, funding the escrow
  | 'awaiting_delivery' // the escrow is funded; the seller is working
  | 'delivered' // a checked result is waiting for settle or dispute
  | 'unpublished' // the seller committed a hash but never published the result: dispute
  | 'settled'
  | 'disputed'
  | 'refunded' // the seller did not deliver and the contract refunded the buyer
  | 'failed' // nothing was escrowed (see `error`), or the deal could not be followed up

export interface JobRecord {
  id: string
  createdAt: string
  updatedAt: string
  stage: JobStage
  chainId: string
  capability: string
  maxBudget: number
  /** The agreed price, once there is one. */
  price?: string
  handle?: HireHandle
  /** The delivered result and every failed automatic check; present from `delivered` on. */
  result?: Record<string, unknown>
  problems?: string[]
  /** When the contract pays the seller if nobody settles or disputes (ISO time), once delivered. */
  reviewDeadline?: string
  settle?: SettleOutcome
  error?: string
}

export interface StartOptions {
  capability: string
  brief: unknown
  criteria?: string
  maxBudget: number
  sellerId?: string
  chain?: string
}

export interface JobsOptions {
  home: string
  config: Config
  privateKey: Hex
  apiUrl: string
  pollMs?: number
  log?: (message: string) => void
}

export class JobError extends Error {}

const jobsDir = (home: string) => join(home, 'jobs')
const jobPath = (home: string, id: string) => join(jobsDir(home), `${id}.json`)
const TERMINAL: JobStage[] = ['settled', 'disputed', 'refunded', 'failed']

export class Jobs {
  private readonly running = new Map<string, Promise<void>>()

  constructor(private readonly o: JobsOptions) {}

  private ctx(): HireContext {
    return { privateKey: this.o.privateKey, apiUrl: this.o.apiUrl, pollMs: this.o.pollMs, timeoutMs: 24 * 60 * 60_000, log: this.o.log ?? (() => {}) }
  }

  private save(job: JobRecord, patch: Partial<JobRecord>): JobRecord {
    const next = { ...job, ...patch, updatedAt: new Date().toISOString() }
    writeJsonAtomic(jobPath(this.o.home, job.id), next)
    return next
  }

  get(id: string): JobRecord | null {
    if (!/^[a-z0-9]{6,32}$/.test(id)) return null
    return readJson<JobRecord>(jobPath(this.o.home, id))
  }

  list(): JobRecord[] {
    if (!existsSync(jobsDir(this.o.home))) return []
    return readdirSync(jobsDir(this.o.home))
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<JobRecord>(join(jobsDir(this.o.home), f)))
      .filter((j): j is JobRecord => !!j)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Starts a hire in the background. Throws before anything happens when a cap or an argument forbids it. */
  start(opts: StartOptions): JobRecord {
    if (!(opts.maxBudget > 0)) throw new JobError('maxBudget must be above zero.')
    const chainId = resolveChain(opts.chain ?? this.o.config.defaultChain ?? 'bsc-testnet')
    assertChainAllowed(this.o.config, chainId)
    const id = randomBytes(6).toString('hex')
    reserve(this.o.home, this.o.config, { jobId: id, chainId, amount: opts.maxBudget, symbol: tokenSymbolFor(chainId) })
    ensureDir(jobsDir(this.o.home))
    const now = new Date().toISOString()
    const job: JobRecord = { id, createdAt: now, updatedAt: now, stage: 'negotiating', chainId, capability: opts.capability, maxBudget: opts.maxBudget }
    writeJsonAtomic(jobPath(this.o.home, id), job)
    this.running.set(id, this.open(job, opts).finally(() => this.running.delete(id)))
    return job
  }

  private async open(job: JobRecord, opts: StartOptions): Promise<void> {
    let current = job
    try {
      const handle = await openHire({
        ...this.ctx(),
        capability: opts.capability,
        brief: opts.brief,
        criteria: opts.criteria,
        maxBudget: opts.maxBudget,
        sellerId: opts.sellerId,
        chain: job.chainId,
      })
      settleReservation(this.o.home, job.id, Number(handle.price))
      current = this.save(current, { stage: 'awaiting_delivery', handle, price: handle.price, chainId: handle.chainId })
    } catch (error) {
      // Nothing was escrowed (the escrow is the last thing openHire does): the reservation is returned.
      release(this.o.home, job.id)
      this.save(current, { stage: 'failed', error: (error as Error).message.split('\n')[0] })
      return
    }
    await this.follow(current)
  }

  /** Waits for the delivery of a funded job and records what came. */
  private async follow(job: JobRecord): Promise<void> {
    if (!job.handle) return
    try {
      const delivery = await awaitDelivery(job.handle, this.ctx())
      if (delivery.state === 'refunded') this.save(job, { stage: 'refunded' })
      else if (delivery.state === 'unpublished') this.save(job, { stage: 'unpublished', reviewDeadline: await this.reviewDeadline(job.handle) })
      else this.save(job, { stage: 'delivered', result: delivery.result, problems: delivery.problems, reviewDeadline: await this.reviewDeadline(job.handle) })
    } catch (error) {
      // The escrow exists: keep the job open, say why following it failed, and let resume() try again.
      this.save(job, { error: (error as Error).message.split('\n')[0] })
    }
  }

  private async reviewDeadline(handle: HireHandle): Promise<string> {
    const chain = signerChain(handle.chainId, this.o.privateKey)
    const id = BigInt(handle.escrowId)
    const [{ deliveredAt }, { reviewWindow }] = await Promise.all([chain.getEscrowTimestamps(id), chain.getEscrowWindows(id)])
    return new Date(Number(deliveredAt + reviewWindow) * 1000).toISOString()
  }

  /**
   * Picks up every job a previous run left in the middle: funded jobs are followed again; a job
   * that had not got as far as an escrow is failed (nothing had been spent) and its budget returned.
   */
  resume(): void {
    for (const job of this.list()) {
      if (this.running.has(job.id) || TERMINAL.includes(job.stage)) continue
      if (job.stage === 'negotiating' && !job.handle) {
        release(this.o.home, job.id)
        this.save(job, { stage: 'failed', error: 'Interrupted before an escrow was created: nothing was spent.' })
      } else if (job.stage === 'awaiting_delivery') {
        this.running.set(job.id, this.follow(job).finally(() => this.running.delete(job.id)))
      }
    }
  }

  /** Resolves when the job leaves its current stage or `seconds` pass, with its latest record. */
  async wait(id: string, seconds: number): Promise<JobRecord | null> {
    const first = this.get(id)
    if (!first) return null
    const until = Date.now() + Math.min(Math.max(seconds, 0), 60) * 1000
    while (Date.now() < until) {
      const now = this.get(id)
      if (!now || now.stage !== first.stage) return now
      await new Promise((r) => setTimeout(r, Math.min(this.o.pollMs ?? 500, 1000)))
    }
    return this.get(id)
  }

  /** Waits for every background job to reach its next resting stage (tests, and the end of a CLI run). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running.values()])
  }

  private needDelivered(id: string, allowed: JobStage[]): JobRecord & { handle: HireHandle } {
    const job = this.get(id)
    if (!job) throw new JobError(`No job ${id}.`)
    if (!job.handle || !allowed.includes(job.stage)) {
      throw new JobError(`Job ${id} is "${job.stage}"${job.error ? ` (${job.error})` : ''}; this needs it to be ${allowed.join(' or ')}.`)
    }
    return job as JobRecord & { handle: HireHandle }
  }

  /** Accepts the delivered result and pays the seller. Refused when an automatic check failed: dispute instead. */
  async settle(id: string, opts: { rating?: number } = {}): Promise<JobRecord> {
    const job = this.needDelivered(id, ['delivered'])
    if (job.problems?.length) throw new JobError(`Job ${id} failed automatic checks (${job.problems.join('; ')}), so it cannot be accepted. Dispute it.`)
    const outcome = await settleHire(job.handle, this.ctx(), { rating: opts.rating })
    return this.save(job, { stage: 'settled', settle: outcome })
  }

  /** Disputes a delivered (or never-published) result; the arbiter decides. */
  async dispute(id: string, reason?: string): Promise<JobRecord> {
    const job = this.needDelivered(id, ['delivered', 'unpublished'])
    const text = reason?.trim() || (job.stage === 'unpublished' ? UNPUBLISHED_REASON : '')
    if (!text) throw new JobError('A dispute needs a reason (at least 10 characters).')
    await disputeHire(job.handle, this.ctx(), text)
    return this.save(job, { stage: 'disputed' })
  }
}

export { SpendCapError }
