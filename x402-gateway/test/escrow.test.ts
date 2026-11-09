import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { AgentService } from '../src/agents.ts'
import { parseBudget, priceNumber } from '../src/escrow.ts'
import { startGateway } from './helpers.ts'

const SOL = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'

const apiAgents = [
  { id: 'a-offline', name: 'Cheap but asleep', chainId: SOL, role: 'seller', capabilities: ['sentiment_score'], price: '0.04', isOnline: false },
  { id: 'a-online', name: 'Sentiment Scorer (Solana)', chainId: SOL, role: 'seller', capabilities: ['sentiment_score'], price: '0.06', isOnline: true },
  { id: 'a-evm', name: 'On another chain', chainId: 'eip155:97', role: 'seller', capabilities: ['sentiment_score'], price: '0.01', isOnline: true },
  { id: 'a-other', name: 'Another capability', chainId: SOL, role: 'seller', capabilities: ['taste_recommendations'], price: '0.08', isOnline: true },
  { id: 'a-buyer', name: 'A buyer', chainId: SOL, role: 'buyer', capabilities: ['sentiment_score'], price: '0', isOnline: true },
]

const fakeApi = (answer: () => Response): typeof fetch => (async () => answer()) as unknown as typeof fetch
const okApi = fakeApi(() => new Response(JSON.stringify(apiAgents), { status: 200 }))

interface Plan {
  capability: string
  budgetUsd: number
  thresholdUsd: number
  recommendedMode: 'x402' | 'escrow'
  x402: { endpoint: string; price: string } | null
  escrow: { chain: string; program: string; tokenMint: string; sellers: { id: string; price: number; isOnline: boolean }[]; cli: string; sdk: string }
  notes: string[]
}
const getPlan = (base: string, query: string) => fetch(`${base}/v1/escrow/plan?${query}`)

test('plan: a job below the threshold that the gateway sells is paid per call with x402', async () => {
  const h = await startGateway({ fetchImpl: okApi })
  try {
    const res = await getPlan(h.base, 'capability=sentiment_score&budgetUsd=0.01')
    assert.equal(res.status, 200)
    const plan = (await res.json()) as Plan
    assert.equal(plan.recommendedMode, 'x402')
    assert.deepEqual(plan.x402, { endpoint: '/v1/agents/sentiment_score', price: '$0.005' })
    assert.equal(plan.thresholdUsd, 0.15)
    assert.deepEqual(plan.escrow.sellers, [], 'no seller list is fetched for a job that does not use escrow')
    assert.ok(plan.notes.some((n) => /pay per call with x402/.test(n)))
  } finally {
    await h.close()
  }
})

test('plan: a job at or above the threshold goes through escrow, with the online Solana sellers of that capability first', async () => {
  const h = await startGateway({ fetchImpl: okApi })
  try {
    for (const budget of ['0.15', '0.2', '2']) {
      const plan = (await (await getPlan(h.base, `capability=sentiment_score&budgetUsd=${budget}`)).json()) as Plan
      assert.equal(plan.recommendedMode, 'escrow', `budget ${budget}`)
      assert.ok(plan.x402, 'the per-call price is still shown, so a buyer can compare')
    }
    const plan = (await (await getPlan(h.base, 'capability=sentiment_score&budgetUsd=0.2')).json()) as Plan
    assert.deepEqual(plan.escrow.sellers.map((s) => s.id), ['a-online', 'a-offline'], 'online first; other chains, other capabilities and buyers are left out')
    assert.equal(plan.escrow.chain, SOL)
    assert.equal(plan.escrow.program, '3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE')
    assert.equal(plan.escrow.tokenMint, '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
    assert.match(plan.escrow.cli, /^agenteco hire --capability sentiment_score --brief '<json>' --max-budget 0\.2 --chain solana-devnet$/)
    assert.match(plan.escrow.sdk, /hire\(\{ chain: 'solana-devnet', capability: 'sentiment_score'/)
  } finally {
    await h.close()
  }
})

test('plan: a capability the gateway does not sell goes through escrow, with no per-call price', async () => {
  const h = await startGateway({ fetchImpl: okApi })
  try {
    const plan = (await (await getPlan(h.base, 'capability=taste_recommendations&budgetUsd=0.01')).json()) as Plan
    assert.equal(plan.recommendedMode, 'escrow')
    assert.equal(plan.x402, null)
    assert.deepEqual(plan.escrow.sellers.map((s) => s.id), ['a-other'])
  } finally {
    await h.close()
  }
})

test('plan: an AgentEco API that is down or answers badly gives 200, no sellers and a note', async () => {
  const cases: [string, typeof fetch][] = [
    ['unreachable', (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch],
    ['http 503', fakeApi(() => new Response('down', { status: 503 }))],
    ['not json', fakeApi(() => new Response('<html>', { status: 200 }))],
  ]
  for (const [name, fetchImpl] of cases) {
    const h = await startGateway({ fetchImpl })
    try {
      const res = await getPlan(h.base, 'capability=sentiment_score&budgetUsd=1')
      assert.equal(res.status, 200, name)
      const plan = (await res.json()) as Plan
      assert.equal(plan.recommendedMode, 'escrow', name)
      assert.deepEqual(plan.escrow.sellers, [], name)
      assert.ok(plan.notes.some((n) => /seller list is empty|No Solana seller/.test(n)), name)
    } finally {
      await h.close()
    }
  }
})

test('plan: the answer carries no key, secret or credential', async () => {
  const h = await startGateway({ fetchImpl: okApi })
  try {
    const text = await (await getPlan(h.base, 'capability=sentiment_score&budgetUsd=1')).text()
    assert.doesNotMatch(text, /private|secret|api[_-]?key|password|token":|authorization|bearer/i)
    const plan = JSON.parse(text) as Plan
    assert.deepEqual(Object.keys(plan).sort(), ['budgetUsd', 'capability', 'escrow', 'notes', 'recommendedMode', 'thresholdUsd', 'x402'])
    assert.deepEqual(Object.keys(plan.escrow).sort(), ['chain', 'cli', 'program', 'sdk', 'sellers', 'tokenMint'])
  } finally {
    await h.close()
  }
})

test('plan: a missing or invalid budget or capability is 400', async () => {
  const h = await startGateway({ fetchImpl: okApi })
  try {
    for (const q of [
      'capability=sentiment_score',
      'capability=sentiment_score&budgetUsd=abc',
      'capability=sentiment_score&budgetUsd=0',
      'capability=sentiment_score&budgetUsd=-1',
      'capability=sentiment_score&budgetUsd=1e3',
      'capability=sentiment_score&budgetUsd=99999999',
      'capability=sentiment_score&budgetUsd=1&budgetUsd=2',
    ]) {
      const res = await getPlan(h.base, q)
      assert.equal(res.status, 400, q)
      assert.equal(((await res.json()) as { error: string }).error, 'invalid_budget', q)
    }
    for (const q of ['budgetUsd=1', "capability=x'%3Brm%20-rf%20%2F&budgetUsd=1", 'capability=Sentiment&budgetUsd=1', 'capability=a&budgetUsd=1']) {
      const res = await getPlan(h.base, q)
      assert.equal(res.status, 400, q)
      assert.equal(((await res.json()) as { error: string }).error, 'invalid_capability', q)
    }
  } finally {
    await h.close()
  }
})

test('plan: a budget below the per-call price is not sent to x402, and the threshold can be changed', async () => {
  const h = await startGateway({ fetchImpl: okApi })
  try {
    const plan = (await (await getPlan(h.base, 'capability=sentiment_score&budgetUsd=0.001')).json()) as Plan
    assert.equal(plan.recommendedMode, 'escrow')
    assert.ok(plan.notes.some((n) => /more than your/.test(n)))
  } finally {
    await h.close()
  }
  const high = await startGateway({ fetchImpl: okApi, escrowThresholdUsd: 1 })
  try {
    const plan = (await (await getPlan(high.base, 'capability=sentiment_score&budgetUsd=0.5')).json()) as Plan
    assert.equal(plan.recommendedMode, 'x402')
    assert.equal(plan.thresholdUsd, 1)
  } finally {
    await high.close()
  }
})

test('plan: asking for a plan never runs a paid agent or touches the facilitator', async () => {
  let runs = 0
  const agent: AgentService = {
    capability: 'sentiment_score',
    description: 'counting agent',
    priceUsd: '$0.005',
    input: z.object({ text: z.string() }),
    async run() {
      runs += 1
      return { score: 1 }
    },
  }
  const h = await startGateway({ fetchImpl: okApi }, [agent])
  try {
    await getPlan(h.base, 'capability=sentiment_score&budgetUsd=0.01')
    await getPlan(h.base, 'capability=sentiment_score&budgetUsd=5')
    assert.equal(runs, 0)
    assert.equal(h.facilitator.calls.verify + h.facilitator.calls.settle, 0)
  } finally {
    await h.close()
  }
})

test('pricing keeps its old fields and tells where the escrow path is', async () => {
  const h = await startGateway()
  try {
    const pricing = (await (await fetch(`${h.base}/v1/pricing`)).json()) as { network: string; payTo: string; agents: { capability: string; price: string; endpoint: string }[]; escrow: Record<string, unknown> }
    assert.deepEqual(pricing.agents.map((a) => a.capability), ['sentiment_score', 'keyword_extract'])
    assert.ok(pricing.network && pricing.payTo)
    assert.deepEqual(pricing.escrow, { chain: SOL, program: '3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE', thresholdUsd: 0.15, plan: '/v1/escrow/plan' })
  } finally {
    await h.close()
  }
})

test('a browser can use the gateway: preflight is answered and the price and receipt headers are readable', async () => {
  const h = await startGateway({ fetchImpl: okApi })
  try {
    const preflight = await fetch(`${h.base}/v1/agents/sentiment_score`, { method: 'OPTIONS', headers: { origin: 'https://agenteco.my.id', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,payment-signature' } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /payment-signature/)
    const challenge = await fetch(`${h.base}/v1/agents/sentiment_score`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://agenteco.my.id' }, body: JSON.stringify({ text: 'great' }) })
    assert.equal(challenge.status, 402)
    assert.equal(challenge.headers.get('access-control-allow-origin'), '*', 'the 402 itself is readable by the page')
    assert.match(challenge.headers.get('access-control-expose-headers') ?? '', /payment-required/)
    assert.match(challenge.headers.get('access-control-expose-headers') ?? '', /payment-response/)
    const plan = await getPlan(h.base, 'capability=sentiment_score&budgetUsd=1')
    assert.equal(plan.headers.get('access-control-allow-origin'), '*')
  } finally {
    await h.close()
  }
})

test('the budget parser accepts plain decimals only, and prices read as numbers', () => {
  assert.equal(parseBudget('0.01'), 0.01)
  assert.equal(parseBudget('2'), 2)
  assert.equal(parseBudget(undefined), null)
  assert.equal(parseBudget(['1']), null)
  assert.equal(parseBudget('1,5'), null)
  assert.equal(parseBudget(' 1'), 1)
  assert.equal(priceNumber('$0.005'), 0.005)
})

test('the default threshold is $0.15: $0.14 is paid per call, $0.15 and up goes through escrow', async () => {
  const h = await startGateway({ fetchImpl: okApi })
  try {
    for (const budget of ['0.01', '0.1', '0.14']) {
      const plan = (await (await getPlan(h.base, `capability=sentiment_score&budgetUsd=${budget}`)).json()) as Plan
      assert.equal(plan.recommendedMode, 'x402', `budget ${budget}`)
    }
    for (const budget of ['0.15', '0.16', '0.5']) {
      const plan = (await (await getPlan(h.base, `capability=sentiment_score&budgetUsd=${budget}`)).json()) as Plan
      assert.equal(plan.recommendedMode, 'escrow', `budget ${budget}`)
    }
  } finally {
    await h.close()
  }
})
