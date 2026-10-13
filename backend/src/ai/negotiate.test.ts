import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DemoAgentRuntime } from '../../../agent-runtime/src/runtime.ts'
import { decideTurn, type TurnContext } from './negotiate.ts'
import { GENERIC_REASON } from './sanitize.ts'

// Seller lists 0.30 with a 0.24 floor; buyer opens 0.15 with a 0.28 ceiling.
const seller = new DemoAgentRuntime({ name: 'S', role: 'seller', capabilities: ['translation'], description: 'd', basePrice: 0.3, minimumPrice: 0.24 })
const buyer = new DemoAgentRuntime({ name: 'B', role: 'buyer', capabilities: ['translation'], description: 'd', basePrice: 0.15, maxBudget: 0.28 })

const ai = (action: string, price: number, reason = 'Fair for the work.') =>
  (async () => ({ data: { action, price, reason }, provider: 'fake', model: 'm' })) as unknown as TurnContext['llm']
const noAI = (async () => null) as TurnContext['llm']

function ctx(runtime: DemoAgentRuntime, offeredPrice: number, llm: TurnContext['llm'], myPriorOfferCount = 0): TurnContext {
  return { runtime, offeredPrice, myPriorOfferCount, listingPrice: 0.3, maxRounds: 3, capability: 'translation', history: [], llm }
}

test('guardrail 1: a seller counter below its floor is clamped up to the floor', async () => {
  const move = await decideTurn(ctx(seller, 0.15, ai('counter', 0.2)))
  assert.deepEqual(move, { action: 'counter', price: 0.24, reason: 'Fair for the work.', source: 'ai', adjusted: true })
})

test('guardrail 1: a buyer counter above its ceiling is clamped down', async () => {
  const move = await decideTurn(ctx(buyer, 0.3, ai('counter', 0.29), 1))
  assert.equal(move.price, 0.28)
  assert.equal(move.adjusted, true)
})

test('guardrail 2: accepting an offer below the seller floor becomes a counter at the floor', async () => {
  const move = await decideTurn(ctx(seller, 0.2, ai('accept', 0.2)))
  assert.deepEqual(move, { action: 'counter', price: 0.24, reason: 'Fair for the work.', source: 'ai', adjusted: true })
})

test('guardrail 2: accepting within limits goes through at the offered price', async () => {
  // Round 2: the old policy would counter 0.26, but 0.25 is above the floor, so the model may accept it.
  const move = await decideTurn(ctx(seller, 0.25, ai('accept', 0.25), 1))
  assert.deepEqual(move, { action: 'accept', price: 0.25, reason: 'Fair for the work.', source: 'ai', adjusted: false })
})

test('guardrail 3: when the old policy already accepts, accept, whatever the model says', async () => {
  // 0.30 is the seller's listing price: ideal for the seller.
  const move = await decideTurn(ctx(seller, 0.3, ai('counter', 0.35)))
  assert.deepEqual(move, { action: 'accept', price: 0.3, reason: null, source: 'rule', adjusted: false })
})

test('guardrail 4: a reason that leaks the private limit is replaced', async () => {
  const move = await decideTurn(ctx(seller, 0.15, ai('counter', 0.27, "I can't go under 0.24, sorry.")))
  assert.equal(move.reason, GENERIC_REASON)
  assert.equal(move.price, 0.27)
})

test('guardrail 5: no model answer → the old concession policy, rule-based, no reason', async () => {
  const move = await decideTurn(ctx(seller, 0.15, noAI))
  assert.deepEqual(move, { action: 'counter', price: 0.28, reason: null, source: 'rule', adjusted: false })
})

test('a counter at least as good as the offer on the table becomes an accept', async () => {
  // The model "counters" 0.24 against a buyer offer of 0.25, just take the 0.25.
  const move = await decideTurn(ctx(seller, 0.25, ai('counter', 0.24), 1))
  assert.equal(move.action, 'accept')
  assert.equal(move.price, 0.25)
})

test('after the last round the session ends even if the model wants to continue', async () => {
  // Seller already made 3 offers; 0.2 is under its floor → the policy rejects.
  const move = await decideTurn(ctx(seller, 0.2, ai('counter', 0.25), 3))
  assert.equal(move.action, 'reject')
  assert.equal(move.source, 'rule')
})

test('a reason that calls the price its minimum is replaced, even without the number', async () => {
  const move = await decideTurn(ctx(seller, 0.25, ai('accept', 0.25, 'Your offer matches our minimum acceptable price.'), 1))
  assert.equal(move.action, 'accept')
  assert.equal(move.reason, GENERIC_REASON)
})

test('a reason quoting a price that is not on the table is replaced (0.287 said, 0.29 sent)', async () => {
  const move = await decideTurn(ctx(seller, 0.2, ai('counter', 0.287, 'I can meet you at 0.287 for this job.')))
  assert.equal(move.price, 0.29)
  assert.equal(move.reason, GENERIC_REASON)
})

test('a reason quoting the price actually sent or the offer on the table stays', async () => {
  const move = await decideTurn(ctx(seller, 0.2, ai('counter', 0.28, 'You offered 0.2; I can do 0.28 for this job.')))
  assert.equal(move.price, 0.28)
  assert.equal(move.reason, 'You offered 0.2; I can do 0.28 for this job.')
})

test('prices leave without float noise: counters in cents, accepts at the exact offer', async () => {
  const counter = await decideTurn(ctx(seller, 0.2, ai('counter', 0.1 + 0.18, 'Fair for the work.')))
  assert.equal(counter.price, 0.28)
  const accept = await decideTurn(ctx(seller, 0.1 + 0.15000000000000002, ai('accept', 0.25, 'Fair for the work.'), 1))
  assert.equal(accept.price, 0.25)
})
