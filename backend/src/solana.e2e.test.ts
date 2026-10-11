import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { after, before, describe, test } from 'node:test'
import { solanaUnavailable, startSolanaTestChain, type SolanaTestChain } from '../../agent-runtime/test-support/litesvm.ts'
import { localValidatorUnavailable, startLocalValidatorChain, VALIDATOR_TIMERS } from '../../agent-runtime/test-support/validator.ts'
import { startTestDb, type TestDb } from '../test-support/db.ts'

/**
 * The API serving a Solana chain as its DEFAULT chain next to an EVM one, in one process: the escrow
 * program runs in litesvm (default) or on a real solana-test-validator (SOLANA_LOCAL_VALIDATOR=1, ~2 min,
 * and then the chain comes from the environment through SolanaRpcBackend, exactly as in production); the
 * database is an in-memory Postgres. Wallets are base58 and sign with ed25519; every escrow-keyed route
 * reads the chain through the ChainAdapter interface.
 */
const useValidator = process.env.SOLANA_LOCAL_VALIDATOR === '1'
const skip = (useValidator ? localValidatorUnavailable() : solanaUnavailable()) ?? false

/** What the tests need of a chain, whichever kind it is. */
interface Rig {
  signers: SolanaTestChain['signers']
  programId: string
  mint: string
  /** Seconds a funded escrow waits for its seller before it can be refunded. */
  acceptTimeout: number
  mintTo(owner: string, amount: bigint): Promise<void>
  advance(seconds: number): Promise<void>
  /** Make the API's registry serve this chain (the settings an operator would set, or an in-process backend). */
  configureApi(registry: typeof import('../../agent-runtime/src/chain/solana-registry.ts')): void
  stop(): void
}

async function startRig(): Promise<Rig> {
  if (useValidator) {
    const v = await startLocalValidatorChain(250)
    const suffix = SOL.replace(/[^A-Za-z0-9]/g, '_')
    return {
      signers: v.signers,
      programId: v.programId,
      mint: v.mint,
      acceptTimeout: VALIDATOR_TIMERS.acceptTimeout,
      mintTo: (owner, amount) => v.mintTo(owner as never, amount),
      advance: (seconds) => new Promise((resolve) => setTimeout(resolve, (seconds + 1) * 1000)),
      configureApi: () => {
        Object.assign(process.env, {
          [`RPC_URL__${suffix}`]: v.rpcUrl,
          [`AGENT_ECO_PROGRAM__${suffix}`]: v.programId,
          [`TOKEN_MINT__${suffix}`]: v.mint,
        })
      },
      stop: v.stop,
    }
  }
  const c = await startSolanaTestChain({ feeBps: 250 })
  return {
    signers: c.signers,
    programId: c.programId,
    mint: c.mint,
    acceptTimeout: 120,
    mintTo: (owner, amount) => c.mintTo(owner as never, amount),
    advance: (seconds) => c.advance(seconds),
    // The in-process chain stands in for the cluster: the config a preset would build, a litesvm backend.
    configureApi: (registry) =>
      registry.registerSolanaChain({
        config: {
          chainId: SOL,
          programId: c.programId,
          mint: c.mint,
          tokenSymbol: 'USDC',
          nativeSymbol: 'SOL',
          explorerUrl: 'https://explorer.solana.com',
          explorerName: 'Solana Explorer',
          explorerQuery: '?cluster=devnet',
          executionWindow: BigInt(300),
          reviewWindow: BigInt(600),
          firstEscrowId: BigInt(1),
        },
        rpcUrl: 'memory://litesvm',
        testnet: true,
        name: 'Solana Devnet (test)',
        backend: c.backend,
      }),
    stop: () => {},
  }
}

const SOL = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const EVM = 'eip155:97'
const BRIEF = { text: 'Halo dunia', targetLanguage: 'en' }
const RESULT = { translatedText: 'Hello world', targetLanguage: 'en' }

describe('one API, a Solana chain first and an EVM chain second', { skip }, () => {
  let chain: Rig
  let db: TestDb
  let server: Server
  let api: string
  let prisma: typeof import('./db.ts').prisma
  let sol: typeof import('../../agent-runtime/src/chain/solana.ts')
  let registry: typeof import('../../agent-runtime/src/chain/solana-registry.ts')
  let hashes: typeof import('../../agent-runtime/src/shared/hashes.ts')

  type Signer = Rig['signers']['buyer']
  const as = (role: keyof Rig['signers']): Signer => chain.signers[role]
  const adapter = (role: keyof Rig['signers']) => registry.signerSolana(SOL, as(role))

  async function call(method: string, path: string, body?: unknown, signer?: Signer) {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(signer ? await sol.buildSolanaAuthHeaders(signer) : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  /** Task → escrow → fund → link, the way every hire goes; the chain is the default one (no chainId sent). */
  async function hire(price: string): Promise<{ escrowId: bigint; taskId: string }> {
    const created = await call('POST', '/tasks', { capability: 'translation', brief: BRIEF, price, seller: as('seller').address }, as('buyer'))
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal(created.body.chainId, SOL)
    const escrowId = await adapter('buyer').createAndFundEscrow({ seller: as('seller').address, amount: price, taskHash: created.body.taskHash })
    const linked = await call('POST', `/tasks/${created.body.id}/escrow`, { escrowId: escrowId.toString() })
    assert.equal(linked.status, 200, JSON.stringify(linked.body))
    assert.equal(linked.body.verified, true)
    return { escrowId, taskId: created.body.id }
  }

  async function deliver(escrowId: bigint) {
    await adapter('seller').startExecution(escrowId)
    await adapter('seller').markDelivered(escrowId, hashes.resultHash(RESULT))
  }

  before(async () => {
    ;[chain, db] = await Promise.all([startRig(), startTestDb()])
    Object.assign(process.env, { DATABASE_URL: db.url, CHAINS: 'solana-devnet,bsc-testnet', PUBLIC_API_URL: 'https://api.test' })
    ;[sol, registry, hashes] = await Promise.all([
      import('../../agent-runtime/src/chain/solana.ts'),
      import('../../agent-runtime/src/chain/solana-registry.ts'),
      import('../../agent-runtime/src/shared/hashes.ts'),
    ])
    chain.configureApi(registry)
    const [{ app }, dbMod] = await Promise.all([import('./app.ts'), import('./db.ts')])
    prisma = dbMod.prisma
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    api = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await chain.mintTo(as('buyer').address, BigInt(100_000_000))
  })

  after(async () => {
    await new Promise((resolve) => server?.close(resolve))
    await prisma?.$disconnect()
    await db?.stop()
    chain?.stop()
  })

  test('GET /chains lists the Solana chain first (the default) and the EVM chain second, each with its family', async () => {
    const { body } = await call('GET', '/chains')
    assert.deepEqual(
      body.map((c: { chainId: string; family: string; default: boolean }) => [c.chainId, c.family, c.default]),
      [
        [SOL, 'solana', true],
        [EVM, 'evm', false],
      ]
    )
    assert.equal(body[0].evmChainId, null)
    assert.equal(body[0].agentEco, chain.programId)
    assert.deepEqual(body[0].token, { address: chain.mint, symbol: 'USDC' })
    assert.equal(body[0].erc8004, null)
    assert.equal(typeof body[1].evmChainId, 'number')
  })

  test('wallets sign with ed25519; a Solana address is case-sensitive', async () => {
    const seller = as('seller')
    // A signed request is accepted…
    assert.equal((await call('GET', '/disputes', undefined, seller)).status, 403, 'authenticated, but not an arbiter')
    // …a request with another wallet's signature is not…
    const headers = await sol.buildSolanaAuthHeaders(as('buyer'))
    const forged = await fetch(`${api}/disputes`, { headers: { ...headers, 'x-owner-wallet': seller.address } })
    assert.equal(forged.status, 401)
    // …and neither is the same address in another case: it is a different (and invalid) wallet.
    const lowered = await fetch(`${api}/disputes`, { headers: { ...(await sol.buildSolanaAuthHeaders(seller)), 'x-owner-wallet': seller.address.toLowerCase() } })
    assert.equal(lowered.status, 401)
    // A garbage signature is refused, not a crash.
    const garbage = await fetch(`${api}/disputes`, { headers: { ...(await sol.buildSolanaAuthHeaders(seller)), 'x-signature': 'not-a-signature' } })
    assert.equal(garbage.status, 401)
  })

  test('agents on the Solana chain: a self-hosted seller registers with its own key; hosted agents and EVM wallets are refused', async () => {
    const seller = as('seller')
    const created = await call(
      'POST',
      '/agents',
      { name: 'Translator SOL', description: 'Translates on Solana', role: 'seller', capabilities: ['translation'], price: 1, walletAddress: seller.address },
      seller
    )
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal(created.body.chainId, SOL)
    assert.equal(created.body.ownerWallet, seller.address, 'stored exactly as signed')
    assert.equal(created.body.walletAddress, seller.address)

    const hosted = await call('POST', '/agents', { name: 'Hosted', role: 'buyer', capabilities: ['translation'], price: 1, maxBudget: 2, taskBrief: BRIEF }, as('buyer'))
    assert.equal(hosted.status, 400)
    assert.match(hosted.body.error, /Hosted agents are not available on solana:/)
    const evmWallet = await call(
      'POST',
      '/agents',
      { name: 'Wrong family', description: 'A seller that signs with an EVM key', role: 'seller', capabilities: ['translation'], price: 1, walletAddress: `0x${'ab'.repeat(20)}` },
      as('buyer')
    )
    assert.equal(evmWallet.status, 400)
    assert.match(evmWallet.body.error, /must be a Solana address/)

    const listed = await call('GET', '/agents?role=seller')
    assert.deepEqual(
      listed.body.map((a: { name: string; chainId: string }) => [a.name, a.chainId]),
      [['Translator SOL', SOL]]
    )
    assert.equal((await call('GET', `/agents?role=seller&chain=${EVM}`)).body.length, 0)
    // ERC-8004 is an EVM standard; linking to a person (EIP-4361) is not available here yet.
    const erc = await call('POST', `/agents/${created.body.id}/erc8004`, { txHash: `0x${'0'.repeat(64)}` }, seller)
    assert.equal(erc.status, 400)
    assert.match(erc.body.error, /EVM standard/)
  })

  test('a deal: the task is checked against the program, the result against its hash, access is for the parties', async () => {
    const { escrowId } = await hire('1.5')
    assert.equal(escrowId, BigInt(1))
    const basic = await adapter('buyer').getEscrowBasic(escrowId)
    assert.equal(basic.amount, BigInt(1_500_000), '1.5 USDC at 6 decimals')

    await deliver(escrowId)
    const published = await call('POST', '/escrow-results', { escrowId: '1', capability: 'translation', result: RESULT })
    assert.equal(published.status, 201, JSON.stringify(published.body))
    assert.equal(published.body.chainId, SOL)

    const mine = await call('GET', '/escrow-results/1', undefined, as('buyer'))
    assert.equal(mine.status, 200)
    assert.equal(mine.body.result.translatedText, 'Hello world')
    assert.equal((await call('GET', '/escrow-results/1', undefined, as('seller'))).status, 200)
    assert.equal((await call('GET', '/escrow-results/1', undefined, as('other'))).status, 403, 'a stranger is no party')
    assert.equal((await call('GET', '/tasks/by-escrow/1', undefined, as('buyer'))).body.price, '1.5')

    // A result that is not the one the seller committed to is refused.
    const wrong = await call('POST', '/escrow-results', { escrowId: '1', capability: 'translation', result: { translatedText: 'Something else', targetLanguage: 'en' } })
    assert.equal(wrong.status, 400)
  })

  test('an escrow that does not exist is not found, not an error', async () => {
    const res = await call('GET', '/escrow-results/999', undefined, as('buyer'))
    assert.ok([403, 404].includes(res.status), `got ${res.status}`)
    const task = await call('POST', '/tasks', { capability: 'translation', brief: BRIEF, price: '1', seller: as('seller').address }, as('buyer'))
    assert.equal(task.status, 201)
    const unlinked = await call('POST', `/tasks/${task.body.id}/escrow`, { escrowId: '999' })
    assert.equal(unlinked.status, 400, 'a task cannot be linked to an escrow that was never created')
  })

  test('a dispute: the reason is checked against the hash on the program, and only the arbiter sees the list', async () => {
    const { escrowId } = await hire('1')
    await deliver(escrowId)
    const reason = 'The translation misses the requested tone entirely.'
    await adapter('buyer').raiseDispute(escrowId, hashes.textHash(reason))

    const put = await call('PUT', `/disputes/${escrowId}`, { reason }, as('buyer'))
    assert.equal(put.status, 200, JSON.stringify(put.body))
    assert.equal(put.body.chainId, SOL)
    // Text that does not hash to what the buyer committed to is refused.
    assert.equal((await call('PUT', `/disputes/${escrowId}`, { reason: 'Some other complaint entirely.' }, as('buyer'))).status, 400)
    // Only the buyer of that escrow may file it.
    assert.equal((await call('PUT', `/disputes/${escrowId}`, { reason }, as('seller'))).status, 403)

    const forArbiter = await call('GET', '/disputes', undefined, as('arbiter'))
    assert.equal(forArbiter.status, 200, JSON.stringify(forArbiter.body))
    assert.deepEqual(
      forArbiter.body.map((d: { chainId: string; escrowId: string }) => `${d.chainId}#${d.escrowId}`),
      [`${SOL}#${escrowId}`]
    )
    assert.equal((await call('GET', '/disputes', undefined, as('buyer'))).status, 403)

    // The arbiter's ruling is the program's: a refund to the buyer.
    await adapter('arbiter').resolveDispute(escrowId, false, hashes.textHash('rationale'))
    assert.equal(await adapter('buyer').getEscrowStatus(escrowId), 6)
  })

  test('ratings are read from the program\'s events: reported by signature, and found by the scanner', async () => {
    const { escrowId } = await hire('1')
    await deliver(escrowId)
    await adapter('buyer').acceptAndSettle(escrowId)
    const signature = await adapter('buyer').rateSeller(escrowId, 80)

    const stored = await call('POST', '/ratings', { txHash: signature })
    assert.equal(stored.status, 201, JSON.stringify(stored.body))
    assert.equal(stored.body.stored, 1)
    const summary = await call('GET', `/ratings?sellers=${as('seller').address}`)
    assert.equal(summary.body[0].seller, as('seller').address, 'the address keeps its case')
    assert.equal(summary.body[0].count, 1)
    assert.equal(summary.body[0].avgScore, 80)
    // A transaction that rated nothing is no rating.
    const transfer = await adapter('buyer').transferToken(as('other').address, BigInt(1))
    assert.equal((await call('POST', '/ratings', { txHash: transfer })).status, 400)

    // A rating made outside the API (a self-hosted buyer) is found by the periodic scan.
    const second = await hire('1')
    await deliver(second.escrowId)
    await adapter('buyer').acceptAndSettle(second.escrowId)
    await adapter('buyer').rateSeller(second.escrowId, 60)
    const { indexRecentRatings } = await import('./ratings.ts')
    await indexRecentRatings(SOL)
    const after = await call('GET', `/ratings?sellers=${as('seller').address}`)
    assert.equal(after.body[0].count, 2)
    assert.equal(after.body[0].avgScore, 70)
  })

  /** A funded escrow nobody has started (used where a transaction that rates nothing is needed). */
  async function openEscrow(): Promise<bigint> {
    return adapter('buyer').createAndFundEscrow({ seller: as('seller').address, amount: '1', taskHash: hashes.textHash(`open ${Math.random()}`) })
  }

  test('the keeper refunds a funded escrow the seller never started, through the same interface as on EVM', async () => {
    const id = await openEscrow()
    const keeper = registry.signerSolana(SOL, as('keeper'))
    const { runKeeperCycleOn } = await import('./keeper/escrowKeeper.ts')
    const config = { dryRun: false } as import('./config.ts').KeeperConfig

    await runKeeperCycleOn(keeper, config)
    assert.equal(await keeper.getEscrowStatus(id), 1, 'not due yet: still FUNDED')
    await chain.advance(chain.acceptTimeout + 1)
    await runKeeperCycleOn(keeper, config)
    assert.equal(await keeper.getEscrowStatus(id), 6, 'refunded after the accept timeout')
  })

  test('the Solana chain is part of the same listings and filters as every other', async () => {
    const orders = await call('GET', `/orders?chain=${SOL}`, undefined, as('buyer'))
    assert.ok([200, 403].includes(orders.status), `got ${orders.status}`)
    const bad = await call('GET', '/agents?chain=solana:notarealcluster11111111111111111111')
    assert.equal(bad.status, 400)
    const onEvm = await call('POST', '/tasks', { chainId: EVM, capability: 'translation', brief: BRIEF, price: '1', seller: as('seller').address }, as('buyer'))
    assert.equal(onEvm.status, 400, 'a Solana seller address is no EVM wallet')
  })
})
