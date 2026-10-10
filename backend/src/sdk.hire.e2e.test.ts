import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { after, before, describe, test } from 'node:test'
import { parseUnits, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvilUnavailable, startTestChain, type TestChain } from '../../agent-runtime/test-support/anvil.ts'
import { startTestDb, type TestDb } from '../test-support/db.ts'

/**
 * The SDK's two halves against each other, end to end: a self-hosted seller (createSellerAgent)
 * and a buyer (hire()) trading through the real API, a real (in-memory) database and a real local
 * chain. It pins the behaviour of hire() and createSellerAgent as users see it — settle, dispute,
 * attach to a listing, budget and argument checks — whatever code sits underneath.
 */
const skip = anvilUnavailable() ?? false

const RESULT = { translatedText: 'Hello world', targetLanguage: 'en' }
const SETTLED = 5
const DISPUTED = 4
const REFUNDED = 6
const quiet = process.env.SDK_TEST_LOG ? (m: string) => console.log('[sdk]', m) : () => {}

describe('hire() against createSellerAgent', { skip }, () => {
  let chain: TestChain
  let db: TestDb
  let server: Server
  let api: string
  let sdk: typeof import('../../agent-runtime/src/sdk/index.ts')
  let signerChain: typeof import('../../agent-runtime/src/chain/registry.ts').signerChain
  let buildAuthHeaders: typeof import('../../agent-runtime/src/authHeaders.ts').buildAuthHeaders
  let prisma: typeof import('./db.ts').prisma
  const running: { stop(): void }[] = []

  const key = (role: 'buyer' | 'seller' | 'other' | 'arbiter'): Hex => chain.keys[role]
  const adapter = (role: 'buyer' | 'seller' | 'other' | 'arbiter') => signerChain('eip155:97', key(role))
  const buyerBalance = () => adapter('buyer').tokenBalance(chain.addresses.buyer)

  /** A seller serving `translation` from the SDK; resolves once its listing is online. */
  async function startSeller(role: 'seller' | 'other', options: Partial<Parameters<typeof sdk.createSellerAgent>[0]> = {}) {
    const agent = sdk.createSellerAgent({
      privateKey: key(role),
      apiUrl: api,
      name: `Translator ${role}`,
      description: 'Translates text',
      capability: 'translation',
      price: 1,
      floor: 0.8,
      handle: async () => RESULT,
      pollMs: 100,
      log: quiet,
      ...options,
    })
    running.push(agent)
    void agent.start()
    const wallet = chain.addresses[role]
    for (let i = 0; i < 100; i++) {
      const listed = await prisma.agent.findFirst({ where: { walletAddress: { equals: wallet, mode: 'insensitive' }, isOnline: true, deletedAt: null } })
      if (listed) return { agent, listing: listed }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('the seller never came online')
  }

  /** Online-ness is the seller process's heartbeat: stop it, and take the listing offline at once. */
  async function stopSellers() {
    for (const a of running.splice(0)) a.stop()
    await prisma.agent.updateMany({ data: { isOnline: false } })
  }

  const hireOptions = (overrides: Record<string, unknown> = {}) => ({
    privateKey: key('buyer'),
    apiUrl: api,
    capability: 'translation',
    brief: { text: 'Halo dunia', targetLanguage: 'en' },
    maxBudget: 1.2,
    pollMs: 100,
    log: quiet,
    ...overrides,
  })

  before(async () => {
    ;[chain, db] = await Promise.all([startTestChain({ chainId: 97 }), startTestDb()])
    Object.assign(process.env, {
      DATABASE_URL: db.url,
      RPC_URL: chain.rpcUrl,
      RPC_FALLBACK_URLS: 'none',
      AGENT_ECO_ADDRESS: chain.agentEco,
      USDT_ADDRESS: chain.usdt,
    })
    const [{ app }, registry, auth, sdkMod, dbMod] = await Promise.all([
      import('./app.ts'),
      import('../../agent-runtime/src/chain/registry.ts'),
      import('../../agent-runtime/src/authHeaders.ts'),
      import('../../agent-runtime/src/sdk/index.ts'),
      import('./db.ts'),
    ])
    signerChain = registry.signerChain
    buildAuthHeaders = auth.buildAuthHeaders
    sdk = sdkMod
    prisma = dbMod.prisma
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    api = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await chain.mint(chain.addresses.buyer, parseUnits('100', 18))
  })

  after(async () => {
    await stopSellers()
    await new Promise((resolve) => server?.close(resolve))
    await prisma?.$disconnect()
    await db?.stop()
    chain?.stop()
  })

  test('hire() refuses to pay for a result nobody checks', async () => {
    await assert.rejects(sdk.hire(hireOptions()), /never pays for a result nobody checked/)
  })

  test('an unknown chain is refused before anything happens', async () => {
    await assert.rejects(sdk.hire(hireOptions({ review: () => ({ accept: true }), chain: 'solana:devnet' })), /Unknown chain/)
    await assert.rejects(sdk.hire(hireOptions({ review: () => ({ accept: true }), chain: 'eip155:1' })), /Unknown chain/)
  })

  test('a budget below every seller is refused up front', async () => {
    await startSeller('seller', { price: 5, floor: 5 })
    await assert.rejects(sdk.hire(hireOptions({ review: () => ({ accept: true }), maxBudget: 1 })), /No online seller of "translation" fits a budget of 1/)
    await stopSellers()
  })

  test('a deal settles: negotiate, escrow, deliver, check, pay, rate', async () => {
    const { listing } = await startSeller('seller')
    const before = await buyerBalance()
    const seen: Record<string, unknown>[] = []

    const result = await sdk.hire(
      hireOptions({
        review: (r: Record<string, unknown>) => {
          seen.push(r)
          return { accept: true, rating: 90 }
        },
      })
    )

    assert.equal(result.outcome, 'settled')
    assert.deepEqual(result.result, RESULT)
    assert.deepEqual(seen, [RESULT], 'the review function saw exactly the delivered result')
    assert.equal(result.seller.id, listing.id)
    assert.equal(result.seller.wallet.toLowerCase(), chain.addresses.seller.toLowerCase())
    // The price lies between the seller's floor and the buyer's budget, and is what the chain holds.
    const price = Number(result.price)
    assert.ok(price >= 0.8 && price <= 1.2, `agreed price ${price}`)
    const eco = adapter('buyer')
    assert.equal(await eco.getEscrowStatus(result.escrowId), SETTLED)
    assert.equal((await eco.getEscrowBasic(result.escrowId)).amount, parseUnits(result.price, 18))
    // The buyer paid the price; the seller got it minus the 2.5% fee.
    assert.equal(before - (await buyerBalance()), parseUnits(result.price, 18))
    assert.equal(await eco.tokenBalance(chain.addresses.seller), (parseUnits(result.price, 18) * BigInt(975)) / BigInt(1000))

    // The deal's off-chain records: task, result, the rating (stored from the rate transaction).
    const task = await prisma.task.findUnique({ where: { chainId_escrowId: { chainId: 'eip155:97', escrowId: result.escrowId.toString() } } })
    assert.equal(task?.verified, true)
    assert.equal(task?.price, result.price)
    assert.equal(task?.buyer, chain.addresses.buyer.toLowerCase())
    const order = await prisma.order.findFirst({ where: { escrowId: result.escrowId.toString() } })
    assert.equal(order?.status, 'funded')
    assert.equal(order?.sellerAgentId, listing.id)
    const stored = await prisma.escrowResult.findUnique({ where: { chainId_escrowId: { chainId: 'eip155:97', escrowId: result.escrowId.toString() } } })
    assert.deepEqual(stored?.result, RESULT)
    const rating = await prisma.rating.findUnique({ where: { chainId_escrowId: { chainId: 'eip155:97', escrowId: result.escrowId.toString() } } })
    assert.equal(rating?.score, 90)
    assert.equal(rating?.seller, chain.addresses.seller.toLowerCase())
    const rep = await eco.getReputation(chain.addresses.seller)
    assert.deepEqual([rep.completedJobs, rep.ratingCount, rep.avgRatingScore], [1, 1, 90])

    // The named chain works the same way (an alias of the one chain served here).
    const again = await sdk.hire(hireOptions({ review: () => ({ accept: true }), chain: 'bsc-testnet', sellerId: listing.id }))
    assert.equal(again.outcome, 'settled')
    assert.equal(again.escrowId, result.escrowId + BigInt(1))
    await stopSellers()
  })

  test('a result the reviewer rejects becomes a dispute the seller answers and the arbiter rules', async () => {
    const answered: (string | null)[] = []
    const { listing } = await startSeller('seller', {
      respondToDispute: async ({ reason }) => {
        answered.push(reason)
        return 'The translation follows the brief exactly.'
      },
    })
    const before = await buyerBalance()
    const reason = 'The tone is wrong: the brief asked for a formal register.'

    const result = await sdk.hire(hireOptions({ sellerId: listing.id, review: () => ({ accept: false, reason }) }))

    assert.equal(result.outcome, 'disputed')
    assert.deepEqual(result.result, RESULT)
    const eco = adapter('buyer')
    assert.equal(await eco.getEscrowStatus(result.escrowId), DISPUTED)
    const hashes = await eco.getEscrowHashes(result.escrowId)
    assert.notEqual(hashes.disputeReasonHash, `0x${'0'.repeat(64)}`)

    // The buyer's reason reached the API (hash-checked against the chain); the seller answers on its own.
    const buyer = privateKeyToAccount(key('buyer'))
    let dispute: { reason: string; sellerResponse: string | null } | null = null
    for (let i = 0; i < 100 && !dispute?.sellerResponse; i++) {
      const res = await fetch(`${api}/disputes/${result.escrowId}`, { headers: await buildAuthHeaders(buyer) })
      dispute = res.ok ? await res.json() : null
      if (!dispute?.sellerResponse) await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(dispute?.reason, reason)
    assert.equal(dispute?.sellerResponse, 'The translation follows the brief exactly.')
    assert.deepEqual(answered, [reason])
    assert.notEqual((await eco.getEscrowHashes(result.escrowId)).disputeResponseHash, `0x${'0'.repeat(64)}`)

    // The arbiter rules for the buyer: the escrow is refunded and the buyer is whole again.
    const ruling = await adapter('arbiter').ruleDispute(result.escrowId, false, `0x${'ab'.repeat(32)}`)
    assert.equal(ruling.kind, 'executed')
    assert.equal(await eco.getEscrowStatus(result.escrowId), REFUNDED)
    assert.equal(await buyerBalance(), before)
    await stopSellers()
  })

  test('a seller attaches to the listing its owner registered, but only with that listing’s key', async () => {
    const seller = privateKeyToAccount(key('seller'))
    const res = await fetch(`${api}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await buildAuthHeaders(seller)) },
      body: JSON.stringify({
        name: 'Listed first',
        description: 'Translates text',
        role: 'seller',
        capabilities: ['translation'],
        price: 1,
        walletAddress: chain.addresses.seller,
        hosted: false,
        isOnline: false,
      }),
    })
    assert.equal(res.status, 201)
    const listing = (await res.json()) as { id: string; chainId: string }
    assert.equal(listing.chainId, 'eip155:97')

    // Another wallet cannot run this listing…
    const wrong = sdk.createSellerAgent({ privateKey: key('other'), apiUrl: api, agentId: listing.id, handle: async () => RESULT, pollMs: 100, log: quiet })
    await assert.rejects(wrong.runOnce(), /names the agent wallet/)

    // …its own key can, and the listing's name, capability and price are what is served.
    const { agent } = await startSeller('seller', { agentId: listing.id, name: undefined, description: undefined, capability: undefined, price: undefined })
    const done = await sdk.hire(hireOptions({ sellerId: listing.id, maxBudget: 1.5, review: () => ({ accept: true }) }))
    assert.equal(done.outcome, 'settled')
    assert.equal(done.seller.name, 'Listed first')
    assert.equal(agent.address.toLowerCase(), chain.addresses.seller.toLowerCase())
    await stopSellers()
  })

  test('a seller that never delivers is refunded by the contract, not paid', async () => {
    let started = false
    const { listing } = await startSeller('other', {
      // The handler hangs: the job starts (execution begins on-chain) but nothing is ever delivered.
      handle: async () => {
        started = true
        return new Promise<Record<string, unknown>>(() => {})
      },
    })
    const hiring = sdk.hire(hireOptions({ sellerId: listing.id, review: () => ({ accept: true }), timeoutMs: 3000 }))
    await assert.rejects(hiring, /Timed out waiting for escrow #\d+ to be delivered/)
    assert.equal(started, true)
    const eco = adapter('buyer')
    const ids = await eco.escrowIds()
    const last = ids[ids.length - 1]
    // Past the execution window, anyone claims the timeout: the buyer is refunded.
    await chain.advance(400)
    const claim = await adapter('arbiter').claimTimeout(last, 'claimExecutionTimeout')
    assert.equal(claim.success, true)
    assert.equal(await eco.getEscrowStatus(last), REFUNDED)
    await stopSellers()
  })
})

