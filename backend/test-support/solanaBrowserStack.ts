import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { startLocalValidatorChain, type ValidatorChain } from '../../agent-runtime/test-support/validator.ts'
import { startTestDb, type TestDb } from './db.ts'

/**
 * Everything the website needs on Solana, running locally: a solana-test-validator with the escrow program,
 * this API on an in-memory Postgres, the website (built and served, or in dev mode), and an SDK seller that
 * has a listing. Used by the browser end-to-end test and by anyone poking at the site by hand.
 */
export const FRONTEND = join(import.meta.dirname, '..', '..', 'frontend')
export const SOL = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const SUFFIX = SOL.replace(/[^A-Za-z0-9]/g, '_')
export const RESULT = { translatedText: 'Hello world', targetLanguage: 'en' }

export interface SolanaBrowserStack {
  chain: ValidatorChain
  db: TestDb
  site: string
  api: string
  listingId: string
  prisma: typeof import('../src/db.ts').prisma
  sdk: typeof import('../../agent-runtime/src/sdk/index.ts')
  kit: typeof import('../../agent-runtime/src/chain/kit.ts')
  stop(): Promise<void>
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

const NEXT_BIN = join(FRONTEND, 'node_modules', 'next', 'dist', 'bin', 'next')

/** Runs `next <args>` to its end; resolves with its output, rejects with it when it fails. */
function runNext(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NEXT_BIN, ...args], { cwd: FRONTEND, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`next ${args.join(' ')} exited ${code}:\n${out.slice(-3000)}`))))
  })
}

async function waitForHttp(url: string, ms = 120_000): Promise<void> {
  const until = Date.now() + ms
  for (;;) {
    try {
      if ((await fetch(url)).status < 500) return
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`${url} did not come up`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

/**
 * `mode: 'start'` builds the website and serves the build (what runs in production); `'dev'` serves it with hot
 * reload, for working on the pages. The site is built for this chain: NEXT_PUBLIC_* are inlined at build time.
 */
export async function startSolanaBrowserStack(options: { mode?: 'start' | 'dev'; log?: (line: string) => void } = {}): Promise<SolanaBrowserStack> {
  const mode = options.mode ?? 'start'
  const log = options.log ?? (() => {})
  const sitePort = await freePort()
  const site = `http://127.0.0.1:${sitePort}`
  log('starting validator and database')
  const [chain, db] = await Promise.all([startLocalValidatorChain(250), startTestDb()])
  Object.assign(process.env, {
    DATABASE_URL: db.url,
    CHAINS: 'solana-devnet',
    PUBLIC_API_URL: 'https://api.test',
    FRONTEND_ORIGIN: site,
    [`RPC_URL__${SUFFIX}`]: chain.rpcUrl,
    [`AGENT_ECO_PROGRAM__${SUFFIX}`]: chain.programId,
    [`TOKEN_MINT__${SUFFIX}`]: chain.mint,
  })
  const [{ app }, dbMod, sdk, kit] = await Promise.all([
    import('../src/app.ts'),
    import('../src/db.ts'),
    import('../../agent-runtime/src/sdk/index.ts'),
    import('../../agent-runtime/src/chain/kit.ts'),
  ])
  const prisma = dbMod.prisma
  const apiServer: Server = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
  const api = `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_DIST_DIR: '.next-e2e',
    NEXT_PUBLIC_API_URL: api,
    NEXT_PUBLIC_CHAINS: 'solana-devnet',
    [`NEXT_PUBLIC_AGENT_ECO_PROGRAM__${SUFFIX}`]: chain.programId,
    [`NEXT_PUBLIC_TOKEN_MINT__${SUFFIX}`]: chain.mint,
    [`NEXT_PUBLIC_RPC_URL__${SUFFIX}`]: chain.rpcUrl,
    [`NEXT_PUBLIC_RPC_FALLBACK_URLS__${SUFFIX}`]: 'none',
    NEXT_TELEMETRY_DISABLED: '1',
  }
  // `next build` / `next dev` add their output directory to tsconfig.json; put the file back afterwards.
  const tsconfigPath = join(FRONTEND, 'tsconfig.json')
  const tsconfigBefore = readFileSync(tsconfigPath, 'utf8')
  const restoreTsconfig = () => writeFileSync(tsconfigPath, tsconfigBefore)
  let nextProcess: ChildProcess | undefined
  try {
    if (mode === 'start') {
      log('building the website')
      await runNext(['build'], env)
    }
    log(`serving the website (${mode})`)
    nextProcess = spawn(process.execPath, [NEXT_BIN, mode, '-p', String(sitePort), '-H', '127.0.0.1'], { cwd: FRONTEND, env, stdio: 'ignore', detached: true })
    await waitForHttp(`${site}/`)
  } catch (error) {
    restoreTsconfig()
    throw error
  }

  // A seller on this chain: the SDK agent a person would run with `agenteco sell`.
  const agent = sdk.createSellerAgent({
    privateKey: chain.secretKeys.seller,
    apiUrl: api,
    chain: 'solana-devnet',
    name: 'Browser test seller',
    description: 'Translates text for the browser test.',
    capability: 'translation',
    price: 1,
    floor: 1,
    handle: async () => RESULT,
    pollMs: 200,
    log: () => {},
    respondToDispute: async () => 'The translation follows the brief exactly.',
  })
  void agent.start()
  let listingId = ''
  for (let i = 0; i < 300 && !listingId; i++) {
    listingId = (await prisma.agent.findFirst({ where: { walletAddress: chain.signers.seller.address, isOnline: true, deletedAt: null } }))?.id ?? ''
    if (!listingId) await new Promise((r) => setTimeout(r, 100))
  }
  if (!listingId) throw new Error('the seller never came online')
  await chain.mintTo(chain.signers.buyer.address, 50_000_000n) // 50 USDC

  return {
    chain,
    db,
    site,
    api,
    listingId,
    prisma,
    sdk,
    kit,
    async stop() {
      agent.stop()
      // The whole process group: `next` starts workers of its own.
      if (nextProcess?.pid) {
        try {
          process.kill(-nextProcess.pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
      restoreTsconfig()
      await new Promise((resolve) => apiServer.close(resolve))
      await prisma.$disconnect()
      await db.stop()
      chain.stop()
    },
  }
}
