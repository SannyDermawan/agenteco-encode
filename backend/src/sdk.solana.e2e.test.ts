import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { after, before, describe, test } from 'node:test'
import { generatePrivateKey } from 'viem/accounts'
import { SOL, solanaSkip as skip, startRig, type Rig } from '../test-support/solanaRig.ts'
import { startTestDb, type TestDb } from '../test-support/db.ts'

/**
 * The SDK's two halves on Solana, end to end: createSellerAgent and hire() trading through the real
 * API (served over a Solana chain only), a real (in-memory) database and the escrow program (litesvm,
 * or a real validator with SOLANA_LOCAL_VALIDATOR=1). Keys are Solana secret keys; the wallets sign
 * API requests with ed25519 and the chain moves with the SolanaAdapter. The EVM twin is sdk.hire.e2e.test.ts.
 */
const RESULT = { translatedText: 'Hello world', targetLanguage: 'en' }
const FUNDED = 1
const DELIVERED = 3
const DISPUTED = 4
const SETTLED = 5
const quiet = process.env.SDK_TEST_LOG ? (m: string) => console.log('[sdk]', m) : () => {}
const USDC = 1_000_000n // the test mint has 6 decimals

describe('hire() against createSellerAgent on Solana', { skip }, () => {
  let chain: Rig
  let db: TestDb
  let server: Server
  let api: string
  let sdk: typeof import('../../agent-runtime/src/sdk/index.ts')
  let registry: typeof import('../../agent-runtime/src/chain/solana-registry.ts')
  let authHeaders: typeof import('../../agent-runtime/src/authHeaders.ts')
  let sol: typeof import('../../agent-runtime/src/chain/solana.ts')
  let prisma: typeof import('./db.ts').prisma
  const running: { stop(): void }[] = []

  const adapter = (role: keyof Rig['signers']) => registry.signerSolana(SOL, chain.signers[role])
  const address = (role: keyof Rig['signers']) => chain.signers[role].address
  const balance = (role: keyof Rig['signers']) => adapter(role).tokenBalance(address(role))
  const units = (price: string) => BigInt(Math.round(Number(price) * 1e6))

  async function startSeller(role: 'seller' | 'other', options: Partial<Parameters<typeof sdk.createSellerAgent>[0]> = {}) {
    const agent = sdk.createSellerAgent({
      privateKey: chain.secretKeys[role],
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
    for (let i = 0; i < 300; i++) {
      const listed = await prisma.agent.findFirst({ where: { walletAddress: address(role), isOnline: true, deletedAt: null } })
      if (listed) return { agent, listing: listed }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('the seller never came online')
  }

  async function stopSellers() {
    for (const a of running.splice(0)) a.stop()
    await prisma.agent.updateMany({ data: { isOnline: false } })
  }

  const hireOptions = (overrides: Record<string, unknown> = {}) => ({
    privateKey: chain.secretKeys.buyer,
    apiUrl: api,
    capability: 'translation',
    brief: { text: 'Halo dunia', targetLanguage: 'en' },
    maxBudget: 1.2,
    pollMs: 100,
    log: quiet,
    ...overrides,
  })

  before(async () => {
    ;[chain, db] = await Promise.all([startRig(), startTestDb()])
    Object.assign(process.env, { DATABASE_URL: db.url, CHAINS: 'solana-devnet', PUBLIC_API_URL: 'https://api.test' })
    ;[sdk, registry, authHeaders, sol] = await Promise.all([
      import('../../agent-runtime/src/sdk/index.ts'),
      import('../../agent-runtime/src/chain/solana-registry.ts'),
      import('../../agent-runtime/src/authHeaders.ts'),
      import('../../agent-runtime/src/chain/solana.ts'),
    ])
    chain.configureApi(registry)
    const [{ app }, dbMod] = await Promise.all([import('./app.ts'), import('./db.ts')])
    prisma = dbMod.prisma
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    api = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await chain.mintTo(address('buyer'), 100n * USDC)
  })

  after(async () => {
    await stopSellers()
    await new Promise((resolve) => server?.close(resolve))
    await prisma?.$disconnect()
    await db?.stop()
    chain?.stop()
  })

  test('a key of the other family is refused before anything happens', async () => {
    const review = () => ({ accept: true as const })
    await assert.rejects(sdk.hire(hireOptions({ review, privateKey: generatePrivateKey(), chain: 'solana-devnet' })), /Solana chain, but this key is an EVM private key/)
    // An EVM key without a chain trades on the default EVM chain, which this API does not serve.
    await assert.rejects(sdk.hire(hireOptions({ review, privateKey: generatePrivateKey() })), /eip155:97 is not served here/)
    await assert.rejects(sdk.hire(hireOptions({ review, chain: 'bsc-testnet' })), /EVM chain, but this key is a Solana secret key/)
    await assert.rejects(sdk.hire(hireOptions({ review, chain: 'eip155:1' })), /Unknown chain/)
    assert.throws(() => sdk.createSellerAgent({ privateKey: generatePrivateKey(), apiUrl: api, chain: 'solana-devnet', capability: 'translation', name: 'x', description: 'x', price: 1, handle: async () => RESULT }), /Solana chain, but this key is an EVM private key/)
  })

  test('tx_explainer reads EVM transactions, so a Solana seller cannot sell it', () => {
    assert.throws(
      () => sdk.createSellerAgent({ privateKey: chain.secretKeys.seller, apiUrl: api, name: 'x', description: 'x', capability: 'tx_explainer', price: 1, handle: async () => ({}) }),
      /cannot be sold on a Solana chain/
    )
  })

  test('a deal settles: negotiate, escrow, deliver, check, pay, rate — on the Solana default chain', async () => {
    const { listing, agent } = await startSeller('seller')
    assert.equal(agent.address, address('seller'))
    const before = await balance('buyer')
    const sellerBefore = await balance('seller')
    const seen: Record<string, unknown>[] = []

    // No `chain` given: a Solana key trades on Solana.
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
    assert.deepEqual(seen, [RESULT])
    assert.equal(result.seller.id, listing.id)
    assert.equal(result.seller.wallet, address('seller'), 'the seller wallet keeps its case')
    const price = Number(result.price)
    assert.ok(price >= 0.8 && price <= 1.2, `agreed price ${price}`)
    const eco = adapter('buyer')
    assert.equal(await eco.getEscrowStatus(result.escrowId), SETTLED)
    assert.equal((await eco.getEscrowBasic(result.escrowId)).amount, units(result.price))
    // The buyer paid the price; the seller got it minus the 2.5% fee.
    assert.equal(before - (await balance('buyer')), units(result.price))
    assert.equal((await balance('seller')) - sellerBefore, (units(result.price) * 975n) / 1000n)

    // The off-chain records, keyed by the Solana chain id and the wallets exactly as base58.
    const task = await prisma.task.findUnique({ where: { chainId_escrowId: { chainId: SOL, escrowId: result.escrowId.toString() } } })
    assert.equal(task?.verified, true)
    assert.equal(task?.buyer, address('buyer'))
    assert.equal(task?.seller, address('seller'))
    const stored = await prisma.escrowResult.findUnique({ where: { chainId_escrowId: { chainId: SOL, escrowId: result.escrowId.toString() } } })
    assert.deepEqual(stored?.result, RESULT)
    const rating = await prisma.rating.findUnique({ where: { chainId_escrowId: { chainId: SOL, escrowId: result.escrowId.toString() } } })
    assert.equal(rating?.score, 90)
    assert.equal(rating?.seller, address('seller'))
    const rep = await eco.getReputation(address('seller'))
    assert.deepEqual([rep.completedJobs, rep.ratingCount, rep.avgRatingScore], [1, 1, 90])

    // Named by its preset, and by a specific seller: the same chain.
    const again = await sdk.hire(hireOptions({ review: () => ({ accept: true }), chain: 'solana-devnet', sellerId: listing.id }))
    assert.equal(again.outcome, 'settled')
    assert.equal(again.escrowId, result.escrowId + 1n)
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
    const before = await balance('buyer')
    const reason = 'The tone is wrong: the brief asked for a formal register.'

    const result = await sdk.hire(hireOptions({ sellerId: listing.id, review: () => ({ accept: false, reason }) }))

    assert.equal(result.outcome, 'disputed')
    assert.deepEqual(result.result, RESULT)
    const eco = adapter('buyer')
    assert.equal(await eco.getEscrowStatus(result.escrowId), DISPUTED)

    const buyerAccount = sol.solanaWalletAccount(chain.signers.buyer)
    let dispute: { reason: string; sellerResponse: string | null } | null = null
    for (let i = 0; i < 300 && !dispute?.sellerResponse; i++) {
      const res = await fetch(`${api}/disputes/${result.escrowId}`, { headers: await authHeaders.buildAuthHeaders(buyerAccount) })
      dispute = res.ok ? ((await res.json()) as { reason: string; sellerResponse: string | null }) : null
      if (!dispute?.sellerResponse) await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(dispute?.reason, reason)
    assert.equal(dispute?.sellerResponse, 'The translation follows the brief exactly.')
    assert.deepEqual(answered, [reason])

    const ruling = await adapter('arbiter').ruleDispute(result.escrowId, false, `0x${'ab'.repeat(32)}`)
    assert.equal(ruling.kind, 'executed')
    assert.equal(await balance('buyer'), before, 'the buyer is whole again')
    await stopSellers()
  })

  test('the stages: open, save the handle, resume from it, settle; and a short dispute reason is refused', async () => {
    const { listing } = await startSeller('seller')
    const ctx = { privateKey: chain.secretKeys.buyer, apiUrl: api, pollMs: 100, log: quiet }
    const before = await balance('buyer')

    const opened = await sdk.openHire(hireOptions({ sellerId: listing.id }))
    assert.equal(opened.chainId, SOL)
    assert.equal(opened.seller.wallet, address('seller'))
    assert.ok((await adapter('buyer').getEscrowStatus(BigInt(opened.escrowId))) >= FUNDED, 'the escrow is funded')

    // The handle is plain data: it survives being written to disk and read back by another process.
    const handle = JSON.parse(JSON.stringify(opened)) as typeof opened
    const delivery = await sdk.awaitDelivery(handle, ctx)
    assert.equal(delivery.state, 'delivered')
    if (delivery.state !== 'delivered') return
    assert.deepEqual(delivery.result, RESULT)
    assert.deepEqual(delivery.problems, [])

    await assert.rejects(sdk.disputeHire(handle, ctx, 'too short'), /at least 10 characters/)
    assert.equal(await adapter('buyer').getEscrowStatus(BigInt(handle.escrowId)), DELIVERED, 'a refused reason changes nothing on-chain')

    const outcome = await sdk.settleHire(handle, ctx, { rating: 77 })
    assert.deepEqual(outcome, { rated: 77, erc8004FeedbackTx: null })
    assert.equal(await adapter('buyer').getEscrowStatus(BigInt(handle.escrowId)), SETTLED)
    assert.equal(before - (await balance('buyer')), units(handle.price))
    const rating = await prisma.rating.findUnique({ where: { chainId_escrowId: { chainId: SOL, escrowId: handle.escrowId } } })
    assert.equal(rating?.score, 77)
    await stopSellers()
  })

  test('the stages: a delivery can be disputed later', async () => {
    const { listing } = await startSeller('seller')
    const ctx = { privateKey: chain.secretKeys.buyer, apiUrl: api, pollMs: 100, log: quiet }
    const handle = await sdk.openHire(hireOptions({ sellerId: listing.id }))
    assert.equal((await sdk.awaitDelivery(handle, ctx)).state, 'delivered')
    await sdk.disputeHire(handle, ctx, 'The register is wrong: the brief asked for formal.')
    assert.equal(await adapter('buyer').getEscrowStatus(BigInt(handle.escrowId)), DISPUTED)
    const dispute = await prisma.dispute.findUnique({ where: { chainId_escrowId: { chainId: SOL, escrowId: handle.escrowId } } })
    assert.equal(dispute?.reason, 'The register is wrong: the brief asked for formal.')
    await stopSellers()
  })

  test('a seller that never delivers is refunded by the program, not paid', async () => {
    const { listing } = await startSeller('other', { handle: async () => new Promise<Record<string, unknown>>(() => {}) })
    const before = await balance('buyer')
    const ctx = { privateKey: chain.secretKeys.buyer, apiUrl: api, pollMs: 100, log: quiet }
    const handle = await sdk.openHire(hireOptions({ sellerId: listing.id }))
    // The seller started and never delivers; past the execution window anyone claims the timeout.
    await new Promise((r) => setTimeout(r, 600))
    await chain.advance(400)
    const claim = await adapter('keeper').claimTimeout(BigInt(handle.escrowId), 'claimExecutionTimeout')
    assert.equal(claim.success, true)
    assert.deepEqual(await sdk.awaitDelivery(handle, ctx), { state: 'refunded' })
    assert.equal(await balance('buyer'), before, 'the buyer is whole again')
    await stopSellers()
  })
})
