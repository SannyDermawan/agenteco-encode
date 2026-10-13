import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generatePrivateKey } from 'viem/accounts'
import { MAX_ATTEMPTS, checkDecision, createSellerAgent, retryDecision, type SellerAgentOptions } from './seller.ts'
import type { AiModel } from './ai.ts'

const base = (capability: string): SellerAgentOptions => ({
  privateKey: generatePrivateKey(),
  apiUrl: 'http://localhost:1',
  name: 'Test seller',
  description: 'A seller for tests.',
  capability,
  price: 0.1,
  floor: 0.05,
  log: () => {},
})
const ai: AiModel = async () => '{}'
const handle = async () => ({})

const PLATFORM = ['translation', 'data_analysis', 'crypto_market_brief', 'tx_explainer']

test('a platform capability cannot be sold without an AI or a handler, there is no code-only fallback', () => {
  for (const capability of PLATFORM) {
    assert.throws(() => createSellerAgent(base(capability)), /needs an AI/, capability)
  }
})

test('a platform capability is sold with an AI, or with your own handler', () => {
  for (const capability of PLATFORM) {
    assert.doesNotThrow(() => createSellerAgent({ ...base(capability), ai }), `${capability} with ai`)
    assert.doesNotThrow(() => createSellerAgent({ ...base(capability), handle }), `${capability} with handle`)
  }
})

test('a community capability still needs its own handler; an AI alone is not enough', () => {
  assert.throws(() => createSellerAgent(base('sentiment_score')), /community capability/)
  assert.throws(() => createSellerAgent({ ...base('sentiment_score'), ai }), /community capability/)
  assert.doesNotThrow(() => createSellerAgent({ ...base('sentiment_score'), handle }))
})

test('a failing job pauses longer each time, then is dropped', () => {
  // 5 s, 10 s, 20 s, 40 s: about 75 s of retries, a briefly rate-limited model recovers, a dead one costs 5 calls.
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => retryDecision(n, false)),
    [5_000, 10_000, 20_000, 40_000].map((waitMs) => ({ giveUp: false, waitMs }))
  )
  assert.deepEqual(retryDecision(MAX_ATTEMPTS, false), { giveUp: true })
})

test('once the on-chain deadline for the step has passed, the job is dropped at once', () => {
  assert.deepEqual(retryDecision(1, true), { giveUp: true })
})

test('a listing registered in the app is enough: name, capability and price come from it', () => {
  // With agentId, the listing is read when the agent starts; nothing is required up front.
  assert.doesNotThrow(() => createSellerAgent({ privateKey: generatePrivateKey(), apiUrl: 'http://localhost:1', agentId: '00000000-0000-4000-8000-000000000000', handle, log: () => {} }))
  // Without it, the agent lists itself and needs those fields.
  assert.throws(() => createSellerAgent({ privateKey: generatePrivateKey(), apiUrl: 'http://localhost:1', handle, log: () => {} }), /Pass name/)
})

test("an onOffer answer is checked before it is relayed", () => {
  assert.deepEqual(checkDecision({ action: 'accept' }, 0.08, 'seller'), { action: 'accept', reason: undefined })
  assert.deepEqual(checkDecision({ action: 'counter', price: 0.09, reason: '  fair  ' }, 0.08, 'seller'), { action: 'counter', price: 0.09, reason: 'fair' })
  // Asking a seller for less than the buyer already offers is an accept; same for a buyer offering more than asked.
  assert.equal(checkDecision({ action: 'counter', price: 0.07 }, 0.08, 'seller').action, 'accept')
  assert.equal(checkDecision({ action: 'counter', price: 0.09 }, 0.08, 'buyer').action, 'accept')
  assert.equal(checkDecision({ action: 'counter', price: 0.07000000000000001 }, 0.09, 'buyer').action === 'counter', true)
  assert.equal((checkDecision({ action: 'counter', price: 0.07000000000000001 }, 0.09, 'buyer') as { price: number }).price, 0.07)
  assert.equal(checkDecision({ action: 'reject', reason: 'x'.repeat(400) }, 0.08, 'seller').reason?.length, 280)
  for (const bad of [{ action: 'counter', price: 0 }, { action: 'counter', price: Number.NaN }, { action: 'maybe' }, null]) {
    assert.throws(() => checkDecision(bad as never, 0.08, 'seller'), /onOffer returned/)
  }
})
