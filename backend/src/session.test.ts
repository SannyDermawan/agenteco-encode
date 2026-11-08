import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'
import { accountOf } from '../../agent-runtime/src/sdk/wallet.ts'
import { generateSolanaSecretKey } from '../../agent-runtime/src/chain/solana-keys.ts'
import { READ_SESSION_STATEMENT, createSolanaSessionMessage, parseSolanaSessionMessage, solanaChainLabel, type SolanaSessionFields } from '../../agent-runtime/src/shared/session.ts'
import { verifyReadSession } from './session.ts'

const account = privateKeyToAccount(generatePrivateKey())
const other = privateKeyToAccount(generatePrivateKey())
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0)
const HOUR = 60 * 60 * 1000
const rules = { domains: ['agenteco-bnb.vercel.app'], chainId: 97, now: NOW }

async function session(overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {}, signer = account) {
  const message = createSiweMessage({
    domain: 'agenteco-bnb.vercel.app',
    address: account.address,
    statement: READ_SESSION_STATEMENT,
    uri: 'https://agenteco-bnb.vercel.app',
    version: '1',
    chainId: 97,
    nonce: 'abcdefgh12345678',
    issuedAt: new Date(NOW - HOUR),
    expirationTime: new Date(NOW + HOUR),
    ...overrides,
  })
  const signature = await signer.signMessage({ message })
  return Buffer.from(JSON.stringify({ message, signature })).toString('base64')
}

test('a valid session proves its wallet', async () => {
  const result = await verifyReadSession(await session(), rules)
  assert.deepEqual(result, { ok: true, wallet: account.address })
})

test('a session signed by another key is rejected', async () => {
  const result = await verifyReadSession(await session({}, other), rules)
  assert.equal(result.ok, false)
})

test('a session for another website is rejected', async () => {
  const result = await verifyReadSession(await session({ domain: 'evil.example', uri: 'https://evil.example' }), rules)
  assert.deepEqual(result, { ok: false, error: 'Session was signed for another website' })
})

test('a session for another chain is rejected', async () => {
  const result = await verifyReadSession(await session({ chainId: 56 }), rules)
  assert.equal(result.ok, false)
})

test('a sign-in message for something else (other statement) is rejected', async () => {
  const result = await verifyReadSession(await session({ statement: 'Sign in to some other app.' }), rules)
  assert.deepEqual(result, { ok: false, error: 'Unexpected session statement' })
})

test('an expired session is rejected', async () => {
  const result = await verifyReadSession(await session({ issuedAt: new Date(NOW - 3 * HOUR), expirationTime: new Date(NOW - HOUR) }), rules)
  assert.deepEqual(result, { ok: false, error: 'Session expired, sign in again' })
})

test('a session without an expiry, or living over 24 h, is rejected', async () => {
  assert.equal((await verifyReadSession(await session({ expirationTime: undefined }), rules)).ok, false)
  const long = await session({ issuedAt: new Date(NOW - HOUR), expirationTime: new Date(NOW + 30 * HOUR) })
  assert.deepEqual(await verifyReadSession(long, rules), { ok: false, error: 'Session lasts too long' })
})

test('garbage is rejected, never thrown', async () => {
  assert.equal((await verifyReadSession('not base64 json', rules)).ok, false)
  assert.equal((await verifyReadSession(Buffer.from('{"message":1}').toString('base64'), rules)).ok, false)
  assert.equal((await verifyReadSession('x'.repeat(5000), rules)).ok, false)
})

// --- A Solana wallet signs the same session as text, once, with ed25519 ---

const SOL = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const solRules = { ...rules, solanaChainIds: [SOL] }
const solSigner = await accountOf(generateSolanaSecretKey())
const otherSolSigner = await accountOf(generateSolanaSecretKey())

async function solSession(overrides: Partial<SolanaSessionFields> = {}, signer = solSigner, text?: (message: string) => string) {
  const fields: SolanaSessionFields = {
    domain: 'agenteco-bnb.vercel.app',
    address: solSigner.address,
    statement: READ_SESSION_STATEMENT,
    uri: 'https://agenteco-bnb.vercel.app',
    chainId: SOL,
    nonce: 'abcdefgh12345678',
    issuedAt: new Date(NOW - HOUR),
    expirationTime: new Date(NOW + HOUR),
    ...overrides,
  }
  const message = text ? text(createSolanaSessionMessage(fields)) : createSolanaSessionMessage(fields)
  const signature = await signer.signMessage({ message })
  return Buffer.from(JSON.stringify({ family: 'solana', message, signature })).toString('base64')
}

test('Solana: a valid session proves its wallet, and an EVM session still works beside it', async () => {
  assert.deepEqual(await verifyReadSession(await solSession(), solRules), { ok: true, wallet: solSigner.address })
  assert.deepEqual(await verifyReadSession(await session(), solRules), { ok: true, wallet: account.address })
})

test('Solana: the message round-trips, and only that exact text is read', () => {
  const fields: SolanaSessionFields = {
    domain: 'localhost:3000',
    address: solSigner.address,
    statement: READ_SESSION_STATEMENT,
    uri: 'http://localhost:3000',
    chainId: SOL,
    nonce: 'abcdefgh12345678',
    issuedAt: new Date(NOW),
    expirationTime: new Date(NOW + HOUR),
  }
  const text = createSolanaSessionMessage(fields)
  assert.deepEqual(parseSolanaSessionMessage(text), fields)
  assert.equal(parseSolanaSessionMessage(`${text}\nResources: x`), null, 'an extra line is refused')
  assert.equal(parseSolanaSessionMessage(text.replace('Version: 1', 'Version: 2')), null)
  assert.equal(parseSolanaSessionMessage(text.replace(/Nonce: \w+/, 'Nonce: short')), null)
  assert.equal(parseSolanaSessionMessage(text.replace(/Issued At: \S+/, 'Issued At: 2026-09-29')), null, 'only the exact ISO form is read')
})

test('Solana: a session signed by another key, for another website, chain, statement or lifetime is rejected', async () => {
  assert.equal((await verifyReadSession(await solSession({}, otherSolSigner), solRules)).ok, false)
  assert.deepEqual(await verifyReadSession(await solSession({ domain: 'evil.example', uri: 'https://evil.example' }), solRules), { ok: false, error: 'Session was signed for another website' })
  assert.deepEqual(await verifyReadSession(await solSession({ chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }), solRules), { ok: false, error: 'Session was signed for another chain' })
  assert.deepEqual(await verifyReadSession(await solSession({ statement: 'Sign in to some other app.' }), solRules), { ok: false, error: 'Unexpected session statement' })
  assert.deepEqual(await verifyReadSession(await solSession({ issuedAt: new Date(NOW - 3 * HOUR), expirationTime: new Date(NOW - HOUR) }), solRules), { ok: false, error: 'Session expired, sign in again' })
  assert.deepEqual(await verifyReadSession(await solSession({ issuedAt: new Date(NOW - HOUR), expirationTime: new Date(NOW + 30 * HOUR) }), solRules), { ok: false, error: 'Session lasts too long' })
  assert.deepEqual(await verifyReadSession(await solSession({ issuedAt: new Date(NOW + HOUR), expirationTime: new Date(NOW + 2 * HOUR) }), solRules), { ok: false, error: 'Session is issued in the future' })
})

test('Solana: a server that serves no Solana chain refuses a Solana session, and a lowercased address is another wallet', async () => {
  assert.equal((await verifyReadSession(await solSession(), rules)).ok, false)
  // The signature covers the exact text: the same message with the wallet lowercased is not the one that was signed.
  const lowered = await solSession({ address: solSigner.address.toLowerCase() })
  assert.equal((await verifyReadSession(lowered, solRules)).ok, false)
})

test('Solana: a payload that claims Solana but is not, is rejected, never thrown', async () => {
  const bad = (payload: object) => Buffer.from(JSON.stringify(payload)).toString('base64')
  assert.equal((await verifyReadSession(bad({ family: 'solana', message: 'hello', signature: 'abc' }), solRules)).ok, false)
  assert.equal((await verifyReadSession(bad({ family: 'solana', message: 1, signature: 2 }), solRules)).ok, false)
  // An EVM session whose payload says "solana" is read as a Solana one, and fails there.
  const evm = JSON.parse(Buffer.from(await session(), 'base64').toString('utf8'))
  assert.equal((await verifyReadSession(bad({ ...evm, family: 'solana' }), solRules)).ok, false)
})

// --- Phantom shows a Sign-In With Solana message only with a cluster name as its Chain ID (`devnet`), not a CAIP-2 id ---

const asDevnet = (message: string) => message.replace(`Chain ID: ${SOL}`, 'Chain ID: devnet')

test('Solana: a session whose Chain ID is the cluster name is read as that cluster, and the CAIP-2 form still works', async () => {
  assert.deepEqual(await verifyReadSession(await solSession({}, solSigner, asDevnet), solRules), { ok: true, wallet: solSigner.address })
  assert.deepEqual(await verifyReadSession(await solSession(), solRules), { ok: true, wallet: solSigner.address }, 'the old spelling is unchanged')
})

test('Solana: the cluster name parses to the CAIP-2 id, and each spelling is read only exactly', () => {
  const fields: SolanaSessionFields = {
    domain: 'localhost:3000',
    address: solSigner.address,
    statement: READ_SESSION_STATEMENT,
    uri: 'http://localhost:3000',
    chainId: SOL,
    nonce: 'abcdefgh12345678',
    issuedAt: new Date(NOW),
    expirationTime: new Date(NOW + HOUR),
  }
  const named = asDevnet(createSolanaSessionMessage(fields))
  assert.ok(named.includes('Chain ID: devnet'))
  assert.deepEqual(parseSolanaSessionMessage(named), fields, 'the id comes back as CAIP-2')
  assert.equal(parseSolanaSessionMessage(named.replace('Chain ID: devnet', 'Chain ID: Devnet')), null, 'another capitalisation is refused')
  assert.equal(parseSolanaSessionMessage(named.replace('Chain ID: devnet', 'Chain ID: solana:devnet')), null)
  assert.equal(parseSolanaSessionMessage(named.replace('Chain ID: devnet', 'Chain ID: localnet')), null, 'only devnet and mainnet have a name')
  assert.equal(parseSolanaSessionMessage(named.replace('Chain ID: devnet', 'Chain ID: devnet ')), null)
})

test('Solana: the cluster name is still checked against the chains the server serves', async () => {
  const asMainnet = (message: string) => message.replace(`Chain ID: ${SOL}`, 'Chain ID: mainnet')
  assert.deepEqual(await verifyReadSession(await solSession({}, solSigner, asMainnet), solRules), { ok: false, error: 'Session was signed for another chain' })
  const both = { ...rules, solanaChainIds: [SOL, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'] }
  assert.equal((await verifyReadSession(await solSession({}, solSigner, asMainnet), both)).ok, true)
})

test('Solana: solanaChainLabel names the two known clusters and leaves any other id alone', () => {
  assert.equal(solanaChainLabel(SOL), 'devnet')
  assert.equal(solanaChainLabel('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'), 'mainnet')
  assert.equal(solanaChainLabel('solana:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'solana:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
})
