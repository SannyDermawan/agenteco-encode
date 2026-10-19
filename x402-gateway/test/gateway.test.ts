import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { Ledger } from '../src/ledger.ts'
import { proofIdFromHeader, SOLANA_DEVNET } from '../src/gateway.ts'
import type { AgentService } from '../src/agents.ts'
import { MERCHANT, payFor, post, startGateway } from './helpers.ts'

const PATH = '/v1/agents/sentiment_score'
const BRIEF = { text: 'great and fast' }

function counting(run?: () => Promise<Record<string, unknown>>): AgentService & { runs: number } {
  const agent = {
    runs: 0,
    capability: 'sentiment_score',
    description: 'test agent',
    priceUsd: '$0.005',
    input: z.object({ text: z.string().min(1) }),
    async run() {
      agent.runs += 1
      return run ? run() : { score: 1 }
    },
  }
  return agent
}

test('an unpaid request gets 402 with the price, asset, network and recipient', async () => {
  const h = await startGateway()
  try {
    const res = await post(h.base, PATH, BRIEF)
    assert.equal(res.status, 402)
    const required = JSON.parse(Buffer.from(res.headers.get('payment-required')!, 'base64').toString('utf8')) as { accepts: Record<string, unknown>[] }
    const accept = required.accepts[0]!
    assert.equal(accept.scheme, 'exact')
    assert.equal(accept.network, SOLANA_DEVNET)
    assert.equal(accept.amount, '5000', '$0.005 of a 6-decimal token')
    assert.equal(accept.asset, '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 'devnet USDC')
    assert.equal(accept.payTo, MERCHANT)
  } finally {
    await h.close()
  }
})

test('a paid request runs the agent once and settles once', async () => {
  const agent = counting()
  const h = await startGateway({}, [agent])
  try {
    const headers = await payFor(h.base, PATH, BRIEF)
    const res = await post(h.base, PATH, BRIEF, headers)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { score: 1 })
    assert.equal(agent.runs, 1)
    assert.equal(h.facilitator.calls.verify, 1)
    assert.equal(h.facilitator.calls.settle, 1)
    assert.ok(res.headers.get('payment-response'), 'the settlement receipt travels back to the client')
    const record = h.gateway.ledger.list()[0]!
    assert.equal(record.status, 'done')
    assert.match(record.settlementTx ?? '', /^FakeSettlement/)
  } finally {
    await h.close()
  }
})

test('a bad request is refused before any payment is asked for', async () => {
  const agent = counting()
  const h = await startGateway({}, [agent])
  try {
    const bad = await post(h.base, PATH, { nope: true })
    assert.equal(bad.status, 400)
    assert.equal(((await bad.json()) as { error: string }).error, 'invalid_brief')
    assert.equal((await post(h.base, '/v1/agents/unknown', BRIEF)).status, 404)
    assert.equal(h.facilitator.calls.verify, 0)
    assert.equal(agent.runs, 0)
  } finally {
    await h.close()
  }
})

test('an invalid or underpaid payment is refused and the agent never runs', async () => {
  const agent = counting()
  const h = await startGateway({}, [agent])
  try {
    h.facilitator.verifyResult = () => ({ isValid: false, invalidReason: 'invalid_exact_svm_payload_transaction_amount_mismatch' })
    const headers = await payFor(h.base, PATH, BRIEF)
    const res = await post(h.base, PATH, BRIEF, headers)
    assert.equal(res.status, 402)
    assert.equal(agent.runs, 0)
    assert.equal(h.facilitator.calls.settle, 0)
    assert.equal(h.gateway.ledger.list().length, 0)
  } finally {
    await h.close()
  }
})

test('a payment proof pays for one job only: same request replays, another request is refused', async () => {
  const agent = counting()
  const h = await startGateway({}, [agent])
  try {
    const headers = await payFor(h.base, PATH, BRIEF)
    assert.equal((await post(h.base, PATH, BRIEF, headers)).status, 200)
    const replay = await post(h.base, PATH, BRIEF, headers)
    assert.equal(replay.status, 200)
    assert.equal(replay.headers.get('x-payment-replay'), 'true')
    assert.equal(agent.runs, 1, 'the replay did not run the agent again')
    assert.equal(h.facilitator.calls.settle, 1, 'and did not settle again')
    const other = await post(h.base, PATH, { text: 'a different request' }, headers)
    assert.equal(other.status, 409)
    assert.equal(((await other.json()) as { error: string }).error, 'payment_already_used')
  } finally {
    await h.close()
  }
})

test('two requests with the same proof at the same time: one runs, the other gets 409', async () => {
  const agent = counting(() => new Promise((r) => setTimeout(() => r({ score: 1 }), 200)))
  const h = await startGateway({}, [agent])
  try {
    const headers = await payFor(h.base, PATH, BRIEF)
    const [a, b] = await Promise.all([post(h.base, PATH, BRIEF, headers), post(h.base, PATH, BRIEF, headers)])
    assert.deepEqual([a.status, b.status].sort(), [200, 409])
    assert.equal(agent.runs, 1)
    assert.equal(h.facilitator.calls.settle, 1)
  } finally {
    await h.close()
  }
})

test('the agent failing after a valid payment charges nothing and the same proof can retry', async () => {
  let fail = true
  const agent = counting(async () => {
    if (fail) throw new Error('model down')
    return { score: 1 }
  })
  const h = await startGateway({}, [agent])
  try {
    const headers = await payFor(h.base, PATH, BRIEF)
    const failed = await post(h.base, PATH, BRIEF, headers)
    assert.equal(failed.status, 502)
    const body = (await failed.json()) as { error: string; charged: boolean }
    assert.deepEqual([body.error, body.charged], ['agent_failed', false])
    assert.equal(h.facilitator.calls.settle, 0, 'nothing was settled')
    fail = false
    const retry = await post(h.base, PATH, BRIEF, headers)
    assert.equal(retry.status, 200)
    assert.equal(h.facilitator.calls.settle, 1)
  } finally {
    await h.close()
  }
})

test('a facilitator that is down or too slow gives 503 with Retry-After and no work', async () => {
  const agent = counting()
  const h = await startGateway({ facilitatorTimeoutMs: 300 }, [agent])
  try {
    const headers = await payFor(h.base, PATH, BRIEF)
    h.facilitator.delayMs = 1200
    const slow = await post(h.base, PATH, BRIEF, headers)
    assert.equal(slow.status, 503)
    assert.ok(slow.headers.get('retry-after'))
    assert.equal(((await slow.json()) as { error: string }).error, 'facilitator_unavailable')
    h.facilitator.delayMs = 0
    h.facilitator.down = true
    const down = await post(h.base, PATH, BRIEF, headers)
    assert.ok([402, 503].includes(down.status), `status ${down.status}`)
    assert.equal(agent.runs, 0)
  } finally {
    await h.close()
  }
})

test('a settlement that fails after the work is recorded as unsettled and blocks reuse', async () => {
  const agent = counting()
  const h = await startGateway({}, [agent])
  try {
    h.facilitator.settleResult = () => ({ success: false, errorReason: 'transaction_failed' })
    const headers = await payFor(h.base, PATH, BRIEF)
    const res = await post(h.base, PATH, BRIEF, headers)
    assert.notEqual(res.status, 200, 'the result is not handed over for an unsettled payment')
    const record = h.gateway.ledger.list()[0]!
    assert.equal(record.status, 'unsettled')
    const again = await post(h.base, PATH, BRIEF, headers)
    assert.equal(again.status, 409)
    assert.equal(((await again.json()) as { error: string }).error, 'payment_unsettled')
  } finally {
    await h.close()
  }
})

test('the ledger survives a restart and treats an interrupted job as unsettled', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.json')
  const first = new Ledger(file)
  first.begin('a', 'h', 'sentiment_score')
  first.begin('b', 'h', 'sentiment_score')
  first.update('b', { status: 'done', settlementTx: 'sig' })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 2)
  const second = new Ledger(file)
  assert.equal(second.get('a')?.status, 'unsettled')
  assert.equal(second.get('b')?.status, 'done')
})

test('proof ids do not depend on how the proof is encoded', () => {
  const payload = { transaction: 'abc' }
  const one = Buffer.from(JSON.stringify({ x402Version: 2, payload })).toString('base64')
  const two = Buffer.from(JSON.stringify({ payload, x402Version: 2, extra: 1 })).toString('base64')
  assert.equal(proofIdFromHeader(one), proofIdFromHeader(two))
})

test('pricing and health are public', async () => {
  const h = await startGateway()
  try {
    const pricing = (await (await fetch(`${h.base}/v1/pricing`)).json()) as { agents: { capability: string; price: string }[] }
    assert.deepEqual(pricing.agents.map((a) => a.capability), ['sentiment_score', 'keyword_extract'])
    assert.equal(((await (await fetch(`${h.base}/health`)).json()) as { ok: boolean }).ok, true)
  } finally {
    await h.close()
  }
})
