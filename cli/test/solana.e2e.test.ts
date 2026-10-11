import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { formatUnits } from 'viem'
import { SOL, solanaSkip as skip, startRig, type Rig } from '../../backend/test-support/solanaRig.ts'
import { startTestDb, type TestDb } from '../../backend/test-support/db.ts'
import { captured, filesUnder, tempHome } from './helpers.ts'

/**
 * The CLI and the MCP server on a Solana chain, against the real API, an in-memory Postgres, the
 * escrow program (litesvm, or a real validator with SOLANA_LOCAL_VALIDATOR=1) and a real SDK seller:
 * onboarding with a Solana key, status, hires settled / disputed / auto-accepted, the spend caps, a
 * job resumed after a restart, and the same hire driven through MCP tools. The EVM twin is e2e.test.ts.
 */
const RESULT = { translatedText: 'Hello world', targetLanguage: 'en' }
const BRIEF = JSON.stringify({ text: 'Halo dunia', targetLanguage: 'en' })
const DELIVERED = 3
const DISPUTED = 4
const SETTLED = 5

describe('CLI and MCP on Solana', { skip }, () => {
  let chain: Rig
  let db: TestDb
  let server: Server
  let api: string
  let main: typeof import('../src/main.ts')
  let sdk: typeof import('../../agent-runtime/src/sdk/index.ts')
  let registry: typeof import('../../agent-runtime/src/chain/solana-registry.ts')
  let sol: typeof import('../../agent-runtime/src/chain/solana.ts')
  let ctxMod: typeof import('../src/ctx.ts')
  let mcpMod: typeof import('../src/mcp.ts')
  let spend: typeof import('../src/spend.ts')
  let config: typeof import('../src/config.ts')
  let prisma: typeof import('../../backend/src/db.ts').prisma
  const running: { stop(): void }[] = []
  const cleanups: (() => void)[] = []

  const env = () => ({ AGENTECO_API_URL: api, AGENTECO_POLL_MS: '100' })
  const adapter = (role: keyof Rig['signers']) => registry.signerSolana(SOL, chain.signers[role])
  const address = (role: keyof Rig['signers']) => chain.signers[role].address
  const statusOf = (escrowId: string) => adapter('buyer').getEscrowStatus(BigInt(escrowId))
  const units = (price: string) => BigInt(Math.round(Number(price) * 1e6))

  /** A home whose Solana key is the harness's funded buyer wallet, with caps for the test. */
  function buyerHome(caps = { maxPerJob: 1, maxPerDay: 10 }) {
    const h = tempHome()
    cleanups.push(h.cleanup)
    mkdirSync(join(h.home, 'keys'), { recursive: true })
    const file = { version: 1, family: 'solana', address: address('buyer'), secretKey: sol.secretKeyToBase58(chain.secretKeys.buyer), createdAt: new Date().toISOString() }
    writeFileSync(join(h.home, 'keys', 'default.solana.json'), JSON.stringify(file), { mode: 0o600 })
    config.saveConfig(h.home, { caps: { testnet: caps } })
    return h.home
  }

  async function startSeller(handle: () => Promise<Record<string, unknown>> = async () => RESULT, extra: Record<string, unknown> = {}) {
    const agent = sdk.createSellerAgent({
      privateKey: chain.secretKeys.seller,
      apiUrl: api,
      name: 'CLI test seller',
      description: 'Translates text',
      capability: 'translation',
      price: 1,
      floor: 0.8,
      handle,
      pollMs: 100,
      log: process.env.SDK_TEST_LOG ? (m: string) => console.log('[seller]', m) : () => {},
      respondToDispute: async () => 'The translation follows the brief.',
      ...extra,
    })
    running.push(agent)
    void agent.start()
    for (let i = 0; i < 300; i++) {
      if (await prisma.agent.findFirst({ where: { walletAddress: address('seller'), isOnline: true, deletedAt: null } })) return agent
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('the seller never came online')
  }

  async function stopSellers() {
    for (const a of running.splice(0)) a.stop()
    await prisma.agent.updateMany({ data: { isOnline: false } })
  }

  const run = async (home: string, argv: string[], extraEnv: Record<string, string> = {}) => {
    const c = captured(home, { ...env(), ...extraEnv })
    const code = await main.runCli(argv, c.io)
    return { code, out: c.all(), c }
  }
  const jobId = (out: string) => /job ([0-9a-f]{12}) started/.exec(out)?.[1] ?? assert.fail(`no job id in:\n${out}`)
  const jobFile = (home: string, id: string) => JSON.parse(readFileSync(join(home, 'jobs', `${id}.json`), 'utf8')) as { stage: string; chainId: string; handle: { escrowId: string; price: string; seller: { wallet: string } }; settle?: { rated: number } }

  before(async () => {
    ;[chain, db] = await Promise.all([startRig(), startTestDb()])
    // The API serves Solana only; the CLI process reaches the same chain through the registry.
    Object.assign(process.env, { DATABASE_URL: db.url, CHAINS: 'solana-devnet', PUBLIC_API_URL: 'https://api.test', FRONTEND_ORIGIN: 'http://localhost:3000' })
    const [{ app }, dbMod] = await Promise.all([import('../../backend/src/app.ts'), import('../../backend/src/db.ts')])
    ;[main, sdk, registry, sol, ctxMod, mcpMod, spend, config] = await Promise.all([
      import('../src/main.ts'),
      import('../../agent-runtime/src/sdk/index.ts'),
      import('../../agent-runtime/src/chain/solana-registry.ts'),
      import('../../agent-runtime/src/chain/solana.ts'),
      import('../src/ctx.ts'),
      import('../src/mcp.ts'),
      import('../src/spend.ts'),
      import('../src/config.ts'),
    ])
    chain.configureApi(registry)
    prisma = dbMod.prisma
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    api = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await chain.mintTo(address('buyer'), 100_000_000n)
  })

  after(async () => {
    await stopSellers()
    cleanups.forEach((c) => c())
    await new Promise((resolve) => server?.close(resolve))
    await prisma?.$disconnect()
    await db?.stop()
    chain?.stop()
  })

  test('init --chain solana-devnet: a Solana key (no EVM key), no account link, a listing, what to fund — and the key stays secret', async () => {
    const h = tempHome()
    cleanups.push(h.cleanup)
    const base = ['init', '--role', 'seller', '--chain', 'solana-devnet', '--name', 'Init seller', '--capability', 'translation', '--price', '1']

    const first = await run(h.home, base)
    assert.equal(first.code, 0, first.out)
    assert.match(first.out, /created the Solana agent wallet [1-9A-HJ-NP-Za-km-z]{32,44}/)
    assert.match(first.out, /account link: not available on Solana yet/)
    assert.match(first.out, /\[3\/4\] listing: "Init seller" is registered as a seller of translation at 1/)
    assert.match(first.out, /balance: 0 SOL, 0 USDC/)
    assert.match(first.out, /faucet\.solana\.com/)
    assert.match(first.out, /faucet\.circle\.com/)

    // One Solana key, readable only by the user; no EVM key and no link state were made.
    const keyPath = join(h.home, 'keys', 'default.solana.json')
    assert.equal(existsSync(join(h.home, 'keys', 'default.json')), false)
    assert.equal(statSync(keyPath).mode & 0o777, 0o600)
    const file = JSON.parse(readFileSync(keyPath, 'utf8')) as { address: string; secretKey: string }
    const secret = sol.secretKeyFromBase58(file.secretKey)
    assert.equal(secret.length, 64)
    assert.equal(sol.solanaAddressOfSecretKey(secret), file.address)
    assert.equal(existsSync(join(h.home, 'state.json')), false)

    // The listing is the agent's own, with the wallet exactly as base58, on the Solana chain.
    const listing = await prisma.agent.findFirst({ where: { name: 'Init seller' } })
    assert.equal(listing?.ownerWallet, file.address)
    assert.equal(listing?.chainId, SOL)

    // Idempotent: the key is reused, the listing synced rather than duplicated.
    const again = await run(h.home, base)
    assert.equal(again.code, 0, again.out)
    assert.match(again.out, /using the existing Solana agent wallet/)
    assert.equal(await prisma.agent.count({ where: { name: 'Init seller' } }), 1)

    // The secret is only in keys/: not in any output (as base58 or as a keypair array), not in any other file.
    const forms = [file.secretKey, JSON.stringify([...secret]), `[${[...secret].join(', ')}]`]
    for (const out of [first.out, again.out]) for (const form of forms) assert.equal(out.includes(form), false)
    for (const [path, content] of filesUnder(h.home)) if (!path.startsWith('keys/')) for (const form of forms) assert.equal(content.includes(form), false, path)

    // key address shows the address, never the secret; export needs a person at a terminal.
    const shown = await run(h.home, ['key', 'address'])
    assert.equal(shown.out, file.address)
    assert.equal((await run(h.home, ['key', 'address', '--chain', 'bsc-testnet'])).code, 1, 'there is no EVM key here')
    const exported = await run(h.home, ['key', 'export', '--chain', 'solana-devnet'])
    assert.equal(exported.code, 77)
    assert.equal(forms.some((f) => exported.out.includes(f)), false)

    // A hire on Solana with no Solana key says so before any budget is reserved.
    const evmOnly = tempHome()
    cleanups.push(evmOnly.cleanup)
    await run(evmOnly.home, ['init', '--role', 'buyer', '--chain', 'bsc-testnet', '--skip-link'])
    const refused = await run(evmOnly.home, ['hire', '--chain', 'solana-devnet', '--capability', 'translation', '--brief', BRIEF, '--max-budget', '1'])
    assert.notEqual(refused.code, 0)
    assert.match(refused.out, /No Solana key named "default"/)
    assert.equal(spend.spentToday(evmOnly.home, SOL), 0)
  })

  test('status: the Solana wallet, its balances (SOL has 9 decimals) and the caps', async () => {
    const home = buyerHome()
    const st = await run(home, ['status'])
    assert.equal(st.code, 0, st.out)
    assert.match(st.out, new RegExp(`agent wallet \\(Solana\\): ${address('buyer')}`))
    assert.match(st.out, /solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1: 100 SOL, 100 USDC; caps 1\/job, 10\/day/)
    assert.doesNotMatch(st.out, /eip155/, 'no EVM key, so no EVM chain is listed')
  })

  test('hire → read the result → settle with a rating (the reviewer decides; nothing pays by itself)', async () => {
    await startSeller()
    const home = buyerHome()
    const before = await adapter('buyer').tokenBalance(address('buyer'))

    const hired = await run(home, ['hire', '--chain', 'solana-devnet', '--capability', 'translation', '--brief', BRIEF, '--max-budget', '1', '--criteria', 'Natural English.', '--wait', '60'])
    assert.equal(hired.code, 0, hired.out)
    const id = jobId(hired.out)
    assert.match(hired.out, /… delivered \(price /)
    assert.match(hired.out, /automatic checks passed/)
    assert.match(hired.out, /<<<BEGIN SELLER OUTPUT \(untrusted\)>>>[\s\S]*Hello world[\s\S]*<<<END SELLER OUTPUT>>>/)
    // The explorer link names the escrow program on the right cluster.
    assert.match(hired.out, new RegExp(`contract: https://explorer\\.solana\\.com/address/${chain.programId}\\?cluster=devnet`))
    const job = jobFile(home, id)
    assert.equal(job.stage, 'delivered')
    assert.equal(job.chainId, SOL)
    assert.equal(job.handle.seller.wallet, address('seller'), 'the seller wallet keeps its case')
    assert.equal(await statusOf(job.handle.escrowId), DELIVERED, 'delivered, not paid: the funds are still in escrow')
    assert.equal(before - (await adapter('buyer').tokenBalance(address('buyer'))), units(job.handle.price))

    const settled = await run(home, ['job', 'settle', id, '--rating', '80'])
    assert.equal(settled.code, 0, settled.out)
    assert.equal(await statusOf(job.handle.escrowId), SETTLED)
    assert.equal((await prisma.rating.findFirst({ where: { escrowId: job.handle.escrowId, chainId: SOL } }))?.score, 80)
    const twice = await run(home, ['job', 'settle', id])
    assert.equal(twice.code, 1)
    assert.match(twice.out, /needs it to be delivered/)
    // The ledger holds the agreed price, not the budget.
    assert.equal(spend.spentToday(home, SOL), Number(job.handle.price))
    await stopSellers()
  })

  test('a delivery the reviewer does not like is disputed with a reason; --auto-accept pays when the checks pass', async () => {
    await startSeller()
    const home = buyerHome()
    const hired = await run(home, ['hire', '--chain', 'solana-devnet', '--capability', 'translation', '--brief', BRIEF, '--max-budget', '1', '--wait', '60'])
    assert.equal(hired.code, 0, hired.out)
    const id = jobId(hired.out)
    const escrowId = jobFile(home, id).handle.escrowId
    const short = await run(home, ['job', 'dispute', id, '--reason', 'bad'])
    assert.equal(short.code, 1)
    assert.match(short.out, /at least 10 characters/)
    const disputed = await run(home, ['job', 'dispute', id, '--reason', 'The register is wrong: the brief asked for formal.'])
    assert.equal(disputed.code, 0, disputed.out)
    assert.equal(await statusOf(escrowId), DISPUTED)
    assert.equal((await prisma.dispute.findFirst({ where: { escrowId, chainId: SOL } }))?.reason, 'The register is wrong: the brief asked for formal.')

    const auto = await run(home, ['hire', '--chain', 'solana-devnet', '--capability', 'translation', '--brief', BRIEF, '--max-budget', '1', '--wait', '60', '--auto-accept', '--rating', '90'])
    assert.equal(auto.code, 0, auto.out)
    const done = jobFile(home, jobId(auto.out))
    assert.equal(done.stage, 'settled')
    assert.equal(done.settle?.rated, 90)
    assert.equal(await statusOf(done.handle.escrowId), SETTLED)
    await stopSellers()
  })

  test('the caps apply on Solana: the default is 1 per job on a testnet, and a daily cap stops a second hire', async () => {
    const h = tempHome()
    cleanups.push(h.cleanup)
    mkdirSync(join(h.home, 'keys'), { recursive: true })
    writeFileSync(join(h.home, 'keys', 'default.solana.json'), JSON.stringify({ version: 1, family: 'solana', address: address('buyer'), secretKey: sol.secretKeyToBase58(chain.secretKeys.buyer), createdAt: '' }), { mode: 0o600 })
    const over = await run(h.home, ['hire', '--chain', 'solana-devnet', '--capability', 'translation', '--brief', BRIEF, '--max-budget', '5'])
    assert.equal(over.code, 77, over.out)
    assert.match(over.out, /per-job cap of 1 on solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/)

    await startSeller()
    const home = buyerHome({ maxPerJob: 1, maxPerDay: 1.5 })
    const first = await run(home, ['hire', '--chain', 'solana-devnet', '--capability', 'translation', '--brief', BRIEF, '--max-budget', '1', '--wait', '60'])
    assert.equal(first.code, 0, first.out)
    const second = await run(home, ['hire', '--chain', 'solana-devnet', '--capability', 'translation', '--brief', BRIEF, '--max-budget', '1', '--wait', '60'])
    assert.equal(second.code, 77)
    assert.match(second.out, /Today's cap on solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 is 1.5/)
    await stopSellers()
  })

  test('a job survives a restart: a new process picks it up and finishes following it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    await startSeller(async () => {
      await gate
      return RESULT
    })
    const home = buyerHome()
    const ctxA = new ctxMod.Ctx(captured(home, env()).io)
    const jobsA = ctxA.jobs()
    const started = jobsA.start({ capability: 'translation', brief: JSON.parse(BRIEF), maxBudget: 1, chain: 'solana-devnet' })
    for (let i = 0; i < 100 && jobsA.get(started.id)?.stage !== 'awaiting_delivery'; i++) await new Promise((r) => setTimeout(r, 100))
    assert.equal(jobsA.get(started.id)?.stage, 'awaiting_delivery')

    // "Restart": a brand-new Jobs over the same home knows nothing but the file.
    const jobsB = new ctxMod.Ctx(captured(home, env()).io).jobs()
    jobsB.resume()
    release()
    const finished = await jobsB.wait(started.id, 30)
    assert.equal(finished?.stage, 'delivered')
    assert.deepEqual(finished?.result, RESULT)
    assert.deepEqual(finished?.problems, [])
    assert.ok(finished?.reviewDeadline && new Date(finished.reviewDeadline) > new Date(), `review deadline ${finished?.reviewDeadline}`)
    await jobsA.idle()
    await jobsB.idle()
    await stopSellers()
  })

  test('MCP: find, hire, wait, read, settle on Solana — and the tools show the right wallet and contract', async () => {
    await startSeller()
    const home = buyerHome({ maxPerJob: 1, maxPerDay: 3 })
    const ctx = new ctxMod.Ctx(captured(home, env()).io)
    const server = mcpMod.buildMcpServer(ctx)
    const client = new Client({ name: 'test', version: '0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean }
      return { text: res.content[0].text, isError: !!res.isError, json: () => JSON.parse(res.content[0].text.split('\n\n')[0]) }
    }

    const who = await call('agenteco_whoami')
    assert.equal(who.json().address, address('buyer'))
    assert.equal(who.json().chains[0].chain, SOL)
    // SOL shows 9 decimals and USDC 6, whatever earlier tests spent.
    assert.equal(who.json().chains[0].native, `${formatUnits(await adapter('buyer').nativeBalance(address('buyer')), 9)} SOL`)
    assert.equal(who.json().chains[0].token, `${formatUnits(await adapter('buyer').tokenBalance(address('buyer')), 6)} USDC`)
    assert.equal(who.text.includes(sol.secretKeyToBase58(chain.secretKeys.buyer)), false, 'whoami never includes the key')
    const chains = await call('agenteco_chains')
    assert.equal(chains.json()[0].family, 'solana')

    const found = await call('agenteco_find_sellers', { capability: 'translation', maxPrice: 2, chain: 'solana-devnet' })
    assert.equal(found.json().token, 'USDC')
    const sellers = found.json().sellers as { sellerId: string; name: string; wallet: string; record: { completedJobs: number } }[]
    assert.equal(sellers.length, 1)
    assert.equal(sellers[0].wallet, address('seller'))

    const started = await call('agenteco_hire_start', { capability: 'translation', brief: JSON.parse(BRIEF), maxBudget: 1, sellerId: sellers[0].sellerId, chain: 'solana-devnet' })
    assert.equal(started.isError, false, started.text)
    const id = started.json().jobId as string
    let status = started.json()
    for (let i = 0; i < 30 && status.stage !== 'delivered'; i++) status = (await call('agenteco_job_status', { jobId: id, waitSeconds: 5 })).json()
    assert.equal(status.stage, 'delivered')
    assert.deepEqual(status.automaticChecks, { passed: true })
    assert.match(status.contract, new RegExp(`/address/${chain.programId}\\?cluster=devnet`))

    const escrowId = status.escrowId as string
    const verified = await call('agenteco_verify_escrow', { escrowId, chain: 'solana-devnet' })
    assert.equal(verified.json().status, 'DELIVERED')
    assert.equal(verified.json().buyer, address('buyer'))
    assert.equal(verified.json().seller, address('seller'))
    assert.equal(verified.json().token, 'USDC')
    assert.match(verified.json().contract, new RegExp(`/address/${chain.programId}\\?cluster=devnet`))

    const settled = await call('agenteco_job_settle', { jobId: id, rating: 85 })
    assert.equal(settled.isError, false, settled.text)
    assert.equal(settled.json().settled.rated, 85)
    assert.equal((await call('agenteco_verify_escrow', { escrowId, chain: 'solana-devnet' })).json().status, 'SETTLED')
    const record = await adapter('buyer').getReputation(address('seller'))
    assert.ok(record.ratingCount >= 1)

    await client.close()
    await stopSellers()
  })

  test('agenteco sell serves a capability from a Solana key until it is stopped', async () => {
    const h = tempHome()
    cleanups.push(h.cleanup)
    mkdirSync(join(h.home, 'keys'), { recursive: true })
    writeFileSync(join(h.home, 'keys', 'default.solana.json'), JSON.stringify({ version: 1, family: 'solana', address: address('other'), secretKey: sol.secretKeyToBase58(chain.secretKeys.other), createdAt: '' }), { mode: 0o600 })
    const handler = join(h.home, 'handler.mjs')
    writeFileSync(handler, `export default async () => (${JSON.stringify(RESULT)})\n`)
    const selling = run(h.home, ['sell', '--chain', 'solana-devnet', '--capability', 'translation', '--price', '1', '--floor', '0.8', '--handler', handler, '--name', 'CLI sells'])
    let listed = null
    for (let i = 0; i < 300 && !listed; i++) {
      listed = await prisma.agent.findFirst({ where: { name: 'CLI sells', isOnline: true, deletedAt: null } })
      if (!listed) await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(listed, 'the CLI seller never came online')
    assert.equal(listed.walletAddress, address('other'))
    assert.equal(listed.chainId, SOL)

    const result = await sdk.hire({ privateKey: chain.secretKeys.buyer, apiUrl: api, capability: 'translation', brief: JSON.parse(BRIEF), maxBudget: 1.2, sellerId: listed.id, pollMs: 100, log: () => {}, review: () => ({ accept: true }) })
    assert.equal(result.outcome, 'settled')
    assert.deepEqual(result.result, RESULT)

    process.emit('SIGINT')
    const out = await selling
    assert.equal(out.code, 0, out.out)
    assert.match(out.out, new RegExp(`Serving translation at 1 on ${SOL} as ${address('other')}`))
    await prisma.agent.updateMany({ data: { isOnline: false } })
  })
})
