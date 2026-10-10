import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { after, before, describe, test } from 'node:test'
import { parseUnits, type Hex, type LocalAccount } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvilUnavailable, startTestChain, type TestChain } from '../../agent-runtime/test-support/anvil.ts'
import { startTestDb, type TestDb } from '../test-support/db.ts'

/**
 * The API on two chains at once, against two real local chains and a real (in-memory)
 * Postgres: BSC Testnet's id (97, MockUSDT with 18 decimals) as the default chain, and Base
 * Sepolia's id (84532) settling in a 6-decimal token like USDC. Escrow #1 exists on both and
 * the two never mix: tasks, results, disputes, ratings and access are all per chain.
 */
const skip = anvilUnavailable() ?? false

const A = 'eip155:97'
const B = 'eip155:84532'
const BRIEF = { text: 'Halo dunia', targetLanguage: 'en' }
const RESULT = { translatedText: 'Hello world', targetLanguage: 'en' }

describe('one API, two chains', { skip }, () => {
  let chainA: TestChain
  let chainB: TestChain
  let db: TestDb
  let server: Server
  let api: string
  let rt: {
    signerChain: typeof import('../../agent-runtime/src/chain/registry.ts').signerChain
    buildAuthHeaders: typeof import('../../agent-runtime/src/authHeaders.ts').buildAuthHeaders
    resultHash: typeof import('../../agent-runtime/src/shared/hashes.ts').resultHash
    textHash: typeof import('../../agent-runtime/src/shared/hashes.ts').textHash
  }
  let prisma: typeof import('./db.ts').prisma
  let sellerOnBId = ''

  const acct = (key: Hex): LocalAccount => privateKeyToAccount(key)

  async function call(method: string, path: string, body?: unknown, as?: LocalAccount) {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(as ? await rt.buildAuthHeaders(as) : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  /** Task → escrow → fund → link on one chain, the way every hire goes. Returns the escrow id. */
  async function hire(chain: TestChain, chainId: string | undefined, price: string): Promise<{ escrowId: bigint; taskId: string }> {
    const buyer = acct(chain.keys.buyer)
    const created = await call('POST', '/tasks', { ...(chainId && { chainId }), capability: 'translation', brief: BRIEF, price, seller: chain.addresses.seller }, buyer)
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const escrowId = await rt
      .signerChain(chainId ?? A, chain.keys.buyer)
      .createAndFundEscrow({ seller: chain.addresses.seller, amount: price, taskHash: created.body.taskHash })
    const linked = await call('POST', `/tasks/${created.body.id}/escrow`, { escrowId: escrowId.toString() })
    assert.equal(linked.status, 200, JSON.stringify(linked.body))
    assert.equal(linked.body.verified, true)
    return { escrowId, taskId: created.body.id }
  }

  async function deliver(chain: TestChain, chainId: string, escrowId: bigint) {
    const seller = rt.signerChain(chainId, chain.keys.seller)
    await seller.startExecution(escrowId)
    await seller.markDelivered(escrowId, rt.resultHash(RESULT))
  }

  before(async () => {
    ;[chainA, chainB, db] = await Promise.all([startTestChain({ chainId: 97 }), startTestChain({ chainId: 84532, tokenDecimals: 6, erc8004: true }), startTestDb()])
    Object.assign(process.env, {
      DATABASE_URL: db.url,
      CHAINS: 'bsc-testnet,base-sepolia',
      RPC_URL: chainA.rpcUrl,
      RPC_FALLBACK_URLS: 'none',
      AGENT_ECO_ADDRESS: chainA.agentEco,
      USDT_ADDRESS: chainA.usdt,
      RPC_URL__eip155_84532: chainB.rpcUrl,
      RPC_FALLBACK_URLS__eip155_84532: 'none',
      AGENT_ECO_ADDRESS__eip155_84532: chainB.agentEco,
      USDT_ADDRESS__eip155_84532: chainB.usdt,
      ERC8004_IDENTITY_REGISTRY__eip155_84532: chainB.erc8004!.identity,
      ERC8004_REPUTATION_REGISTRY__eip155_84532: chainB.erc8004!.reputation,
      PUBLIC_API_URL: 'https://api.test',
    })
    const [{ app }, registry, auth, hashes, dbMod] = await Promise.all([
      import('./app.ts'),
      import('../../agent-runtime/src/chain/registry.ts'),
      import('../../agent-runtime/src/authHeaders.ts'),
      import('../../agent-runtime/src/shared/hashes.ts'),
      import('./db.ts'),
    ])
    rt = { signerChain: registry.signerChain, buildAuthHeaders: auth.buildAuthHeaders, resultHash: hashes.resultHash, textHash: hashes.textHash }
    prisma = dbMod.prisma
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address() as { port: number }
    api = `http://127.0.0.1:${address.port}`

    await chainA.mint(chainA.addresses.buyer, parseUnits('100', 18))
    await chainB.mint(chainB.addresses.buyer, parseUnits('100', 6))
  })

  after(async () => {
    await new Promise((resolve) => server?.close(resolve))
    await prisma?.$disconnect()
    await db?.stop()
    chainA?.stop()
    chainB?.stop()
  })

  test('GET /chains lists both, the default first', async () => {
    const { body } = await call('GET', '/chains')
    assert.deepEqual(
      body.map((c: { chainId: string; default: boolean }) => [c.chainId, c.default]),
      [
        [A, true],
        [B, false],
      ]
    )
    assert.equal(body[1].token.symbol, 'USDC')
    // The default chain (id 97) carries the official registries of its preset; chain B's come from the settings above.
    assert.equal(body[0].erc8004.identity, '0x8004A818BFB912233c491871b3d84c89A494BD9e')
    assert.equal(body[1].erc8004.identity.toLowerCase(), chainB.erc8004!.identity.toLowerCase())
    assert.equal(body[1].agentEco.toLowerCase(), chainB.agentEco.toLowerCase())
  })

  test('an unknown or unserved chain is a 400, never a silent fallback', async () => {
    const buyer = acct(chainA.keys.buyer)
    const r1 = await call('POST', '/tasks', { chainId: 'eip155:1', capability: 'translation', brief: BRIEF, price: '1', seller: chainA.addresses.seller }, buyer)
    assert.equal(r1.status, 400)
    assert.match(r1.body.error, /not served here/)
    const r2 = await call('GET', '/tasks/by-escrow/1?chain=bot-testnet', undefined, buyer)
    assert.equal(r2.status, 400)
    const r3 = await call('GET', '/agents?chain=nonsense')
    assert.equal(r3.status, 400)
  })

  test('a deal on the 6-decimal chain: the escrow amount, the link check and the result all line up', async () => {
    const { escrowId } = await hire(chainB, B, '1.5')
    assert.equal(escrowId, BigInt(1))
    const basic = await rt.signerChain(B, chainB.keys.buyer).getEscrowBasic(escrowId)
    assert.equal(basic.amount, BigInt(1_500_000)) // 1.5 USDC in 6 decimals

    await deliver(chainB, B, escrowId)
    const published = await call('POST', '/escrow-results', { chainId: B, escrowId: '1', capability: 'translation', result: RESULT })
    assert.equal(published.status, 201, JSON.stringify(published.body))
    assert.equal(published.body.chainId, B)
  })

  test('escrow #1 on the default chain is a different escrow with its own task', async () => {
    const { escrowId } = await hire(chainA, undefined, '2')
    assert.equal(escrowId, BigInt(1))

    const onB = await call('GET', `/tasks/by-escrow/1?chain=${B}`, undefined, acct(chainB.keys.buyer))
    assert.equal(onB.status, 200)
    assert.equal(onB.body.chainId, B)
    assert.equal(onB.body.price, '1.5')
    const onA = await call('GET', '/tasks/by-escrow/1', undefined, acct(chainA.keys.buyer))
    assert.equal(onA.status, 200)
    assert.equal(onA.body.chainId, A)
    assert.equal(onA.body.price, '2')

    // Chain A's buyer is no party to chain B's escrow #1, and the reverse.
    assert.equal((await call('GET', `/tasks/by-escrow/1?chain=${B}`, undefined, acct(chainA.keys.buyer))).status, 403)
    assert.equal((await call('GET', '/escrow-results/1', undefined, acct(chainB.keys.buyer))).status, 403)

    // Chain B's result does not belong to chain A's escrow #1 (nothing delivered there).
    const wrong = await call('POST', '/escrow-results', { escrowId: '1', capability: 'translation', result: RESULT })
    assert.equal(wrong.status, 400)
    // …while on chain B it is there, for its buyer.
    const mine = await call('GET', `/escrow-results/1?chain=${B}`, undefined, acct(chainB.keys.buyer))
    assert.equal(mine.status, 200)
    assert.equal(mine.body.result.translatedText, 'Hello world')
  })

  test('a dispute lives on its chain, and each chain arbiter sees only its own', async () => {
    const { escrowId } = await hire(chainB, B, '1')
    await deliver(chainB, B, escrowId)
    const reason = 'The translation misses the requested tone entirely.'
    await rt.signerChain(B, chainB.keys.buyer).raiseDispute(escrowId, rt.textHash(reason))

    const put = await call('PUT', `/disputes/${escrowId}?chain=${B}`, { reason }, acct(chainB.keys.buyer))
    assert.equal(put.status, 200, JSON.stringify(put.body))
    assert.equal(put.body.chainId, B)
    // The same text against the default chain's escrow of that id fails: no such dispute there.
    assert.equal((await call('PUT', `/disputes/${escrowId}`, { reason }, acct(chainB.keys.buyer))).status, 400)

    const forB = await call('GET', '/disputes', undefined, acct(chainB.keys.arbiter))
    assert.equal(forB.status, 200)
    assert.deepEqual(
      forB.body.map((d: { chainId: string; escrowId: string }) => `${d.chainId}#${d.escrowId}`),
      [`${B}#${escrowId}`]
    )
    const forA = await call('GET', '/disputes', undefined, acct(chainA.keys.arbiter))
    assert.equal(forA.status, 200)
    assert.deepEqual(forA.body, [])
    assert.equal((await call('GET', '/disputes', undefined, acct(chainB.keys.buyer))).status, 403)
  })

  test('ratings are read from the right chain and summarised per chain', async () => {
    const seller = rt.signerChain(A, chainA.keys.seller)
    const buyer = rt.signerChain(A, chainA.keys.buyer)
    await seller.startExecution(BigInt(1))
    await seller.markDelivered(BigInt(1), rt.resultHash(RESULT))
    await buyer.acceptAndSettle(BigInt(1))
    const tx = await buyer.rateSeller(BigInt(1), 80)

    // The transaction is on chain A: chain B's RPC has never seen it.
    assert.equal((await call('POST', '/ratings', { txHash: tx, chainId: B })).status, 400)
    const stored = await call('POST', '/ratings', { txHash: tx, chainId: A })
    assert.equal(stored.status, 201)
    assert.equal(stored.body.stored, 1)

    const onA = await call('GET', `/ratings?sellers=${chainA.addresses.seller}&chain=${A}`)
    assert.equal(onA.body[0].count, 1)
    assert.equal(onA.body[0].avgScore, 80)
    const onB = await call('GET', `/ratings?sellers=${chainA.addresses.seller}&chain=base-sepolia`)
    assert.equal(onB.body[0].count, 0)
  })

  test('agents belong to a chain; a negotiation across chains is refused', async () => {
    const owner = acct(chainA.keys.other)
    const sellerOnB = await call(
      'POST',
      '/agents',
      { chainId: B, name: 'Translator B', description: 'Translates on Base', role: 'seller', capabilities: ['translation'], price: 1, walletAddress: chainB.addresses.seller },
      owner
    )
    assert.equal(sellerOnB.status, 201, JSON.stringify(sellerOnB.body))
    assert.equal(sellerOnB.body.chainId, B)
    sellerOnBId = sellerOnB.body.id
    const buyerOnA = await call('POST', '/agents', { name: 'Buyer A', role: 'buyer', capabilities: ['translation'], price: 1, maxBudget: 2, hosted: false }, owner)
    assert.equal(buyerOnA.status, 201, JSON.stringify(buyerOnA.body))
    assert.equal(buyerOnA.body.chainId, A)

    const listedB = await call('GET', '/agents?role=seller&chain=base-sepolia')
    assert.deepEqual(
      listedB.body.map((a: { name: string }) => a.name),
      ['Translator B']
    )
    assert.equal((await call('GET', '/agents?role=seller&chain=eip155:97')).body.length, 0)

    const nego = await call('POST', '/negotiations', { buyerAgentId: buyerOnA.body.id, sellerAgentId: sellerOnB.body.id, capability: 'translation', price: 0.5 }, owner)
    assert.equal(nego.status, 400)
    assert.match(nego.body.error, /buyer agent is on eip155:97 but the seller agent is on eip155:84532/)
  })

  test('ERC-8004: the seller registers, the API checks the registration, a rated deal becomes feedback', async () => {
    const owner = acct(chainA.keys.other)
    const sellerChain = rt.signerChain(B, chainB.keys.seller)
    // A registration that points elsewhere is refused…
    const elsewhere = await sellerChain.erc8004Register('https://example.com/some-other-agent.json')
    const refused = await call('POST', `/agents/${sellerOnBId}/erc8004`, { txHash: elsewhere.txHash }, owner)
    assert.equal(refused.status, 400)
    assert.match(refused.body.error, /registration file/)

    const { agentId, txHash } = await sellerChain.erc8004Register(`https://api.test/agents/${sellerOnBId}/registration.json`)
    const recorded = await call('POST', `/agents/${sellerOnBId}/erc8004`, { txHash }, owner)
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body))
    assert.equal(recorded.body.erc8004AgentId, agentId.toString())

    const file = await call('GET', `/agents/${sellerOnBId}/registration.json`)
    assert.equal(file.body.type, 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1')
    assert.equal(file.body.services[0].endpoint, `https://api.test/agents/${sellerOnBId}`)
    assert.deepEqual(file.body.registrations, [{ agentId: Number(agentId), agentRegistry: `eip155:84532:${chainB.erc8004!.identity}` }])

    // Escrow #1 on chain B (delivered earlier) is settled and rated, then published as feedback.
    const buyerChain = rt.signerChain(B, chainB.keys.buyer)
    await buyerChain.acceptAndSettle(BigInt(1))
    const rateTx = await buyerChain.rateSeller(BigInt(1), 90)
    assert.equal((await call('POST', '/ratings', { txHash: rateTx, chainId: B })).status, 201)
    // A transaction that registered nothing is no proof of an identity.
    const noRegistration = await call('POST', `/agents/${sellerOnBId}/erc8004`, { txHash: rateTx }, owner)
    assert.equal(noRegistration.status, 400)
    assert.match(noRegistration.body.error, /registered no agent/)
    const { giveDealFeedback } = await import('./erc8004.ts')
    const tx = await giveDealFeedback(buyerChain, { escrowId: BigInt(1), score: 90, capability: 'translation', seller: chainB.addresses.seller })
    assert.match(tx ?? '', /^0x[0-9a-f]{64}$/)
    const feedback = await buyerChain.erc8004LastFeedback(agentId, chainB.addresses.buyer)
    assert.equal(feedback?.value, BigInt(90))
    assert.equal(feedback?.tag1, 'translation')
    assert.equal(feedback?.tag2, `agenteco:${B}:1`)
    const rating = await prisma.rating.findUnique({ where: { chainId_escrowId: { chainId: B, escrowId: '1' } } })
    assert.equal(rating?.erc8004FeedbackTx, tx)
    // Once given, never twice for the same deal.
    assert.equal(await giveDealFeedback(buyerChain, { escrowId: BigInt(1), score: 90, capability: 'translation', seller: chainB.addresses.seller }), null)
  })
})
