import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createSellerAgent, type Job } from '../../../agent-runtime/src/sdk/index.ts'
import { CliError, type Ctx } from '../ctx.ts'
import { assertChainAllowed } from '../config.ts'

/**
 * `agenteco sell`: serves a capability from this machine until stopped. The work itself is a module
 * you write, `export default async (job) => result`, so the CLI holds no model or secret of yours.
 */
export async function sell(ctx: Ctx, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      capability: { type: 'string' },
      price: { type: 'string' },
      floor: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      handler: { type: 'string' },
      chain: { type: 'string' },
      erc8004: { type: 'boolean', default: false },
    },
  })
  if (!values.capability || !values.price || !values.handler) {
    throw new CliError('Usage: agenteco sell --capability <id> --price <n> --handler <file.mjs> [--floor <n>] [--name "…"] [--description "…"] [--chain <c>] [--erc8004]', 64)
  }
  const chainId = ctx.chain(values.chain)
  assertChainAllowed(ctx.config, chainId)
  const module = (await import(pathToFileURL(resolve(values.handler)).href)) as { default?: (job: Job) => Promise<Record<string, unknown>> }
  if (typeof module.default !== 'function') throw new CliError(`${values.handler} must export a default async function (job) that returns the result object.`, 64)

  const price = Number(values.price)
  if (!(price > 0)) throw new CliError('--price must be above zero.', 64)
  const agent = createSellerAgent({
    privateKey: ctx.keyFor(chainId).privateKey,
    apiUrl: ctx.api,
    chain: chainId,
    name: values.name ?? `${values.capability} seller`,
    description: values.description ?? `${values.capability} seller (AgentEco CLI)`,
    capability: values.capability,
    price,
    floor: values.floor ? Number(values.floor) : undefined,
    handle: module.default,
    erc8004: values.erc8004,
    log: (m) => ctx.io.out(`[seller] ${m}`),
  })
  ctx.io.out(`Serving ${values.capability} at ${price} on ${chainId} as ${agent.address}. Ctrl+C stops it.`)
  process.once('SIGINT', () => agent.stop())
  await agent.start()
  return 0
}
