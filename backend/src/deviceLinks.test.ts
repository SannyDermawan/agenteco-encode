import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { after, before, describe, test } from 'node:test'
import { createSiweMessage } from 'viem/siwe'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { startTestDb, type TestDb } from '../test-support/db.ts'

/**
 * The device link against the real API and an in-memory Postgres: an agent asks for a code, a
 * person approves it with their wallet, and the agent's listings become the person's — without
 * the agent's own ownership changing, and without any spending authority either way.
 */
describe('device link', () => {
  let db: TestDb
  let server: Server
  let api: string
  let prisma: typeof import('./db.ts').prisma
  let buildAuthHeaders: typeof import('../../agent-runtime/src/authHeaders.ts').buildAuthHeaders
  let agentProofMessage: typeof import('./routes/deviceLinks.ts').agentProofMessage
  let LINK_STATEMENT: string

  const CHAIN = 'eip155:97'
  const person = privateKeyToAccount(generatePrivateKey())
  const stranger = privateKeyToAccount(generatePrivateKey())

  async function call(method: string, path: string, body?: unknown, as?: PrivateKeyAccount, headers: Record<string, string> = {}) {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(as ? await buildAuthHeaders(as) : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  /** What `agenteco init` does: a fresh agent key asks for a link. */
  async function startLink(agent = privateKeyToAccount(generatePrivateKey()), overrides: Record<string, unknown> = {}) {
    const deviceSecret = randomBytes(32).toString('base64url')
    const nonce = randomBytes(12).toString('base64url')
    const signature = await agent.signMessage({ message: agentProofMessage(nonce, CHAIN, agent.address) })
    const res = await call('POST', '/device-links', { agentWallet: agent.address, role: 'seller', label: 'My translator', nonce, signature, deviceSecret, ...overrides })
    return { agent, deviceSecret, res, link: res.body as { id: string; userCode: string; verifyUrl: string; expiresAt: string; intervalSeconds: number } }
  }

  const poll = (id: string, secret: string) => call('GET', `/device-links/${id}`, undefined, undefined, { 'x-device-secret': secret })

  /** What the /link page does: fetch the message for the connected wallet, sign it, approve. */
  async function approve(code: string, signer: PrivateKeyAccount, edit: (message: string) => string = (m) => m) {
    const info = await call('GET', `/device-links/by-code/${code}?address=${signer.address}`)
    assert.equal(info.status, 200, JSON.stringify(info.body))
    const message = edit(info.body.message as string)
    return call('POST', `/device-links/by-code/${code}/approve`, { address: signer.address, message, signature: await signer.signMessage({ message }) })
  }

  before(async () => {
    db = await startTestDb()
    Object.assign(process.env, { DATABASE_URL: db.url, DEVICE_LINK_CREATE_LIMIT: '1000', FRONTEND_ORIGIN: 'http://localhost:3000' })
    const [{ app }, auth, links, dbMod] = await Promise.all([
      import('./app.ts'),
      import('../../agent-runtime/src/authHeaders.ts'),
      import('./routes/deviceLinks.ts'),
      import('./db.ts'),
    ])
    buildAuthHeaders = auth.buildAuthHeaders
    agentProofMessage = links.agentProofMessage
    LINK_STATEMENT = links.LINK_STATEMENT
    prisma = dbMod.prisma
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    api = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  after(async () => {
    await new Promise((resolve) => server?.close(resolve))
    await prisma?.$disconnect()
    await db?.stop()
  })

  test('the whole link: code, poll, approve, and the agent is listed under the person', async () => {
    const { agent, deviceSecret, res, link } = await startLink()
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.match(link.userCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    assert.equal(link.verifyUrl, 'http://localhost:3000/app/link')
    assert.equal(link.intervalSeconds, 2)

    assert.equal((await poll(link.id, deviceSecret)).body.status, 'pending')

    // The page sees what is being approved before anyone signs.
    const info = await call('GET', `/device-links/by-code/${link.userCode.toLowerCase().replace('-', ' ')}`)
    assert.deepEqual(
      { wallet: info.body.agentWallet, chain: info.body.chainId, role: info.body.role, label: info.body.label },
      { wallet: agent.address.toLowerCase(), chain: CHAIN, role: 'seller', label: 'My translator' }
    )
    assert.equal(info.body.message, undefined, 'no message to sign until a wallet is named')

    const approved = await approve(link.userCode, person)
    assert.equal(approved.status, 200, JSON.stringify(approved.body))
    assert.deepEqual(approved.body, { status: 'approved', agentWallet: agent.address.toLowerCase(), ownerWallet: person.address.toLowerCase() })

    const polled = await poll(link.id, deviceSecret)
    assert.equal(polled.body.status, 'approved')
    assert.equal(polled.body.ownerWallet, person.address.toLowerCase())

    // The agent registers as it always did (signed by its own key): the listing stays the agent's,
    // and is linked to the person.
    const listing = await call(
      'POST',
      '/agents',
      { name: 'My translator', description: 'Translates text', role: 'seller', capabilities: ['translation'], price: 1, walletAddress: agent.address, hosted: false },
      agent
    )
    assert.equal(listing.status, 201, JSON.stringify(listing.body))
    assert.equal(listing.body.ownerWallet.toLowerCase(), agent.address.toLowerCase())
    assert.equal(listing.body.accountWallet, person.address.toLowerCase())

    // The person finds it among their agents and may manage it; a stranger may not; the public profile hides the link.
    const mine = await call('GET', `/agents?ownerWallet=${person.address}`, undefined, person)
    assert.deepEqual(mine.body.map((a: { id: string }) => a.id), [listing.body.id])
    assert.equal((await call('PATCH', `/agents/${listing.body.id}`, { price: 2 }, person)).status, 200)
    assert.equal((await call('PATCH', `/agents/${listing.body.id}`, { price: 3 }, stranger)).status, 403)
    const publicView = await call('GET', `/agents/${listing.body.id}`)
    assert.equal('accountWallet' in publicView.body, false, 'who an agent is linked to is not public')
    // …and the agent still manages itself, exactly as before the link.
    assert.equal((await call('PATCH', `/agents/${listing.body.id}`, { price: 1.5 }, agent)).status, 200)
  })

  test('a linked buyer agent is visible to its person and to its own key, to nobody else', async () => {
    const { agent, deviceSecret, link } = await startLink(undefined, { role: 'buyer' })
    assert.equal((await approve(link.userCode, person)).status, 200)
    assert.equal((await poll(link.id, deviceSecret)).body.status, 'approved')
    const buyer = await call('POST', '/agents', { name: 'My buyer', role: 'buyer', capabilities: ['translation'], price: 1, maxBudget: 2, hosted: false }, agent)
    assert.equal(buyer.status, 201, JSON.stringify(buyer.body))
    const seen = async (as?: PrivateKeyAccount) => ((await call('GET', '/agents?role=buyer', undefined, as)).body as { id: string }[]).map((a) => a.id)
    assert.deepEqual(await seen(person), [buyer.body.id])
    assert.deepEqual(await seen(agent), [buyer.body.id])
    assert.deepEqual(await seen(stranger), [])
    assert.deepEqual(await seen(), [])
  })

  test('an agent that registered before the link is re-listed under the person when approved', async () => {
    const agent = privateKeyToAccount(generatePrivateKey())
    const early = await call('POST', '/agents', { name: 'Early', description: 'd', role: 'seller', capabilities: ['translation'], price: 1, walletAddress: agent.address, hosted: false }, agent)
    assert.equal(early.body.accountWallet, null)
    const { link } = await startLink(agent)
    assert.equal((await approve(link.userCode, person)).status, 200)
    const after = await prisma.agent.findUnique({ where: { id: early.body.id } })
    assert.equal(after?.accountWallet, person.address.toLowerCase())
  })

  test('only the agent with the secret can poll, and only a signature from the agent key creates a link', async () => {
    const { link, deviceSecret } = await startLink()
    assert.equal((await poll(link.id, 'x'.repeat(40))).status, 404)
    assert.equal((await call('GET', `/device-links/${link.id}`)).status, 404)
    assert.equal((await poll('not-a-uuid', deviceSecret)).status, 404)

    // Somebody else's key cannot ask for a link in the agent's name.
    const agent = privateKeyToAccount(generatePrivateKey())
    const nonce = randomBytes(12).toString('base64url')
    const forged = await stranger.signMessage({ message: agentProofMessage(nonce, CHAIN, agent.address) })
    const bad = await call('POST', '/device-links', { agentWallet: agent.address, role: 'seller', label: 'x', nonce, signature: forged, deviceSecret: randomBytes(32).toString('base64url') })
    assert.equal(bad.status, 401)
    // A signature for another chain's message does not count either.
    const wrongChain = await agent.signMessage({ message: agentProofMessage(nonce, 'eip155:84532', agent.address) })
    assert.equal((await call('POST', '/device-links', { agentWallet: agent.address, role: 'seller', label: 'x', nonce, signature: wrongChain, deviceSecret: randomBytes(32).toString('base64url') })).status, 401)
    // A chain this API does not serve is a 400.
    assert.equal((await startLink(undefined, { chainId: 'eip155:1' })).res.status, 400)
  })

  test('an approval that does not match the link is refused, and five wrong tries lock the code', async () => {
    const { agent, link } = await startLink()
    const other = await startLink()
    const code = link.userCode

    assert.match((await approve(code, person, (m) => m.replace(code, other.link.userCode))).body.error, /another code/)
    assert.match((await approve(code, person, (m) => m.replace(agent.address.toLowerCase(), other.agent.address.toLowerCase()))).body.error, /another agent or chain/)
    assert.match((await approve(code, person, (m) => m.replace(`eip155:97`, 'eip155:84532'))).body.error, /another agent or chain/)
    assert.match((await approve(code, person, (m) => m.replace('localhost:3000', 'evil.example'))).body.error, /another website/)
    // Signed by a wallet other than the one it names (on a link of its own, to keep this one's count).
    const info = await call('GET', `/device-links/by-code/${other.link.userCode}?address=${person.address}`)
    const forged = await call('POST', `/device-links/by-code/${other.link.userCode}/approve`, {
      address: person.address,
      message: info.body.message,
      signature: await stranger.signMessage({ message: info.body.message }),
    })
    assert.match(forged.body.error, /does not match the wallet/)
    // An old message (issued long ago) is refused.
    const old = createSiweMessage({
      address: person.address,
      chainId: 97,
      domain: 'localhost:3000',
      uri: 'http://localhost:3000',
      version: '1',
      statement: LINK_STATEMENT,
      nonce: 'abcdefgh12345678',
      issuedAt: new Date(Date.now() - 60 * 60_000),
      expirationTime: new Date(Date.now() + 5 * 60_000),
      requestId: code,
      resources: [`agenteco:agent-wallet:${agent.address.toLowerCase()}`, 'agenteco:chain:eip155:97'],
    })
    const tooOld = await call('POST', `/device-links/by-code/${code}/approve`, { address: person.address, message: old, signature: await person.signMessage({ message: old }) })
    assert.equal(tooOld.status, 400)

    // Five refusals so far: the code is locked, even for a correct approval.
    assert.equal((await call('GET', `/device-links/by-code/${code}`)).status, 404)
    const row = await prisma.deviceLink.findUnique({ where: { userCode: code } })
    assert.equal(row?.status, 'denied')
    assert.equal(await prisma.accountLink.findUnique({ where: { agentWallet: agent.address.toLowerCase() } }), null)
  })

  test('a code is single-use, expires, and asking again replaces the earlier code', async () => {
    const first = await startLink()
    assert.equal((await approve(first.link.userCode, person)).status, 200)
    // Used: nothing left to approve or look up.
    assert.equal((await call('GET', `/device-links/by-code/${first.link.userCode}`)).status, 404)
    const again = await call('POST', `/device-links/by-code/${first.link.userCode}/approve`, { address: person.address, message: 'x', signature: '0x00' })
    assert.equal(again.status, 404)

    // Expired: the page cannot find it, the agent's poll says so.
    const old = await startLink()
    await prisma.deviceLink.update({ where: { id: old.link.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    assert.equal((await call('GET', `/device-links/by-code/${old.link.userCode}`)).status, 404)
    assert.equal((await poll(old.link.id, old.deviceSecret)).body.status, 'expired')

    // Asking again from the same key: only the newest code works.
    const agent = privateKeyToAccount(generatePrivateKey())
    const one = await startLink(agent)
    const two = await startLink(agent)
    assert.equal((await call('GET', `/device-links/by-code/${one.link.userCode}`)).status, 404)
    assert.equal((await call('GET', `/device-links/by-code/${two.link.userCode}`)).status, 200)
  })

  test('the person can list and undo a link; the agent keeps working, unlinked', async () => {
    const { agent, link } = await startLink()
    assert.equal((await approve(link.userCode, person)).status, 200)
    const listing = await call('POST', '/agents', { name: 'Undo me', description: 'd', role: 'seller', capabilities: ['translation'], price: 1, walletAddress: agent.address, hosted: false }, agent)
    assert.equal(listing.body.accountWallet, person.address.toLowerCase())

    const links = await call('GET', '/account-links', undefined, person)
    assert.ok((links.body as { agentWallet: string }[]).some((l) => l.agentWallet === agent.address.toLowerCase()))
    assert.deepEqual((await call('GET', '/account-links', undefined, stranger)).body, [])

    assert.equal((await call('DELETE', `/account-links/${agent.address}`, undefined, stranger)).status, 404)
    assert.equal((await call('DELETE', `/account-links/${agent.address}`, undefined, person)).status, 204)
    assert.equal((await call('DELETE', `/account-links/${agent.address}`, undefined, person)).status, 404)

    const after = await prisma.agent.findUnique({ where: { id: listing.body.id } })
    assert.equal(after?.accountWallet, null)
    assert.equal((await call('PATCH', `/agents/${listing.body.id}`, { price: 2 }, person)).status, 403)
    assert.equal((await call('PATCH', `/agents/${listing.body.id}`, { price: 2 }, agent)).status, 200)
    // Registering again no longer links to the person.
    const next = await call('POST', '/agents', { name: 'After', description: 'd', role: 'seller', capabilities: ['translation'], price: 1, walletAddress: agent.address, hosted: false }, agent)
    assert.equal(next.body.accountWallet, null)
  })
})
