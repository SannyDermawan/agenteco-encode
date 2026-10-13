import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { escrowContract } from '../chains.ts'
import { CliError, type Ctx } from '../ctx.ts'
import type { JobRecord } from '../jobs.ts'
import { SpendCapError } from '../spend.ts'
import { UNTRUSTED_NOTICE, wrapUntrusted } from '../untrusted.ts'

const RESTING = ['delivered', 'unpublished', 'settled', 'disputed', 'refunded', 'failed']

function describe(job: JobRecord): string {
  const parts = [`job ${job.id}: ${job.stage}`, `${job.capability} on ${job.chainId}`]
  if (job.price) parts.push(`price ${job.price}`)
  if (job.handle) parts.push(`escrow #${job.handle.escrowId} with ${job.handle.seller.name}`)
  if (job.reviewDeadline && job.stage === 'delivered') parts.push(`the contract pays the seller at ${job.reviewDeadline} if nobody decides`)
  if (job.error) parts.push(`note: ${job.error}`)
  return parts.join('. ')
}

export function printJob(ctx: Ctx, job: JobRecord, withResult = true): void {
  const { io } = ctx
  io.out(describe(job))
  if (job.handle) {
    io.out(`contract: ${escrowContract(job.chainId).url}`)
  }
  if (withResult && job.result && (job.stage === 'delivered' || job.stage === 'settled' || job.stage === 'disputed')) {
    io.out(job.problems?.length ? `automatic checks FAILED: ${job.problems.join('; ')}` : 'automatic checks passed (hash matches the chain, output fits the capability schema)')
    io.out(UNTRUSTED_NOTICE)
    io.out(wrapUntrusted(job.result))
  }
  if (job.stage === 'delivered') {
    io.out(job.problems?.length ? `Decide: agenteco job dispute ${job.id} --reason "…"` : `Decide: agenteco job settle ${job.id} [--rating 1-100]   or   agenteco job dispute ${job.id} --reason "…"`)
  }
  if (job.stage === 'unpublished') io.out(`The seller never published a result for its committed hash. Dispute it: agenteco job dispute ${job.id}`)
}

/** `agenteco hire`: starts a job and follows it until there is something to decide (or it ends, or time runs out). */
export async function hire(ctx: Ctx, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      capability: { type: 'string' },
      brief: { type: 'string' },
      'brief-file': { type: 'string' },
      criteria: { type: 'string' },
      'max-budget': { type: 'string' },
      seller: { type: 'string' },
      chain: { type: 'string' },
      wait: { type: 'string', default: '180' },
      'auto-accept': { type: 'boolean', default: false },
      rating: { type: 'string' },
    },
  })
  if (!values.capability || !values['max-budget'] || (!values.brief && !values['brief-file'])) {
    throw new CliError('Usage: agenteco hire --capability <id> --brief \'<json>\' (or --brief-file <path>) --max-budget <n> [--criteria "…"] [--seller <id>] [--chain <c>] [--wait <s>] [--auto-accept [--rating <1-100>]]', 64)
  }
  let brief: unknown
  try {
    brief = JSON.parse(values.brief ?? readFileSync(values['brief-file']!, 'utf8'))
  } catch (error) {
    throw new CliError(`The brief is not valid JSON: ${(error as Error).message.split('\n')[0]}`, 64)
  }
  const jobs = ctx.jobs()
  let job: JobRecord
  try {
    job = jobs.start({
      capability: values.capability,
      brief,
      criteria: values.criteria,
      maxBudget: Number(values['max-budget']),
      sellerId: values.seller,
      chain: values.chain ?? ctx.config.defaultChain,
    })
  } catch (error) {
    if (error instanceof SpendCapError) throw new CliError(error.message, 77)
    throw error
  }
  ctx.io.out(`job ${job.id} started on ${job.chainId} (budget ${job.maxBudget}). It is stored in ${ctx.io.home}/jobs, so it survives this process.`)
  return follow(ctx, job.id, Number(values.wait) || 0, values['auto-accept'], values.rating ? Number(values.rating) : undefined)
}

/** Prints each stage change of a job, until it reaches a resting stage or the time is up. */
async function follow(ctx: Ctx, id: string, waitSeconds: number, autoAccept = false, rating?: number): Promise<number> {
  const jobs = ctx.jobs()
  const until = Date.now() + waitSeconds * 1000
  let last = ''
  for (;;) {
    const job = jobs.get(id)
    if (!job) throw new CliError(`No job ${id}.`)
    if (job.stage !== last) {
      ctx.io.out(`  … ${job.stage}${job.price ? ` (price ${job.price})` : ''}`)
      last = job.stage
    }
    if (RESTING.includes(job.stage)) {
      if (job.stage === 'delivered' && autoAccept && !job.problems?.length) {
        const settled = await jobs.settle(id, { rating })
        printJob(ctx, settled)
        return 0
      }
      printJob(ctx, job)
      return job.stage === 'failed' ? 1 : job.stage === 'refunded' ? 1 : 0
    }
    if (Date.now() >= until) {
      ctx.io.out(`Still ${job.stage}. Follow it with: agenteco job wait ${id}`)
      return 3
    }
    await jobs.wait(id, Math.min(30, Math.max(1, (until - Date.now()) / 1000)))
  }
}

/** `agenteco job list|show|wait|settle|dispute`. */
export async function job(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, id, ...rest] = args
  const { io } = ctx
  const jobs = ctx.jobs()
  jobs.resume() // a job a previous process left in the middle is picked up again
  if (sub === 'list' || sub === undefined) {
    const all = jobs.list()
    if (!all.length) io.out('No jobs yet.')
    for (const j of all) io.out(describe(j))
    return 0
  }
  if (!id) throw new CliError(`Usage: agenteco job ${sub} <id>`, 64)
  if (sub === 'show') {
    const j = jobs.get(id)
    if (!j) throw new CliError(`No job ${id}.`)
    printJob(ctx, j)
    return 0
  }
  if (sub === 'wait') {
    const { values } = parseArgs({ args: rest, options: { wait: { type: 'string', default: '300' } } })
    return follow(ctx, id, Number(values.wait) || 0)
  }
  if (sub === 'settle') {
    const { values } = parseArgs({ args: rest, options: { rating: { type: 'string' } } })
    printJob(ctx, await jobs.settle(id, { rating: values.rating ? Number(values.rating) : undefined }), false)
    return 0
  }
  if (sub === 'dispute') {
    const { values } = parseArgs({ args: rest, options: { reason: { type: 'string' } } })
    printJob(ctx, await jobs.dispute(id, values.reason), false)
    return 0
  }
  throw new CliError('Usage: agenteco job list | show <id> | wait <id> | settle <id> [--rating n] | dispute <id> --reason "…"', 64)
}
