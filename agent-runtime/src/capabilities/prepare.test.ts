import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PublicClient } from 'viem'
import * as prepare from './prepare.ts'
import { AI_UNAVAILABLE, mentionsAiUnavailable, prepareJob } from './prepare.ts'

const ctx = { publicClient: {} as PublicClient, agentEcoAddress: '0x0000000000000000000000000000000000000000' }

test('prepareJob rejects a brief that fails the capability schema, without throwing', async () => {
  const out = await prepareJob('translation', { text: '', targetLanguage: 'id' }, ctx)
  assert.equal(out.ok, false)
  assert.match((out as { reason: string }).reason, /Invalid brief/)
})

test('prepareJob reports an unparseable CSV as an invalid brief', async () => {
  const out = await prepareJob('data_analysis', { csv: 'only-a-header' }, ctx)
  assert.equal(out.ok, false)
})

test('every platform capability needs a model: there is no code-only result to deliver', async () => {
  // The old fallback is gone, so no capability can be delivered from the code-computed data alone.
  assert.equal('codeOnlyResult' in prepare, false)
  for (const [capability, brief] of [
    ['translation', { text: 'Hello', targetLanguage: 'id' }],
    ['data_analysis', { csv: 'day,sales\n2026-01-01,10\n2026-01-02,14\n2026-01-03,12' }],
  ] as const) {
    const out = await prepareJob(capability, brief, ctx)
    assert.ok(out.ok, capability)
  }
})

test('a result whose model-written prose says "AI unavailable" is recognised, and only there', () => {
  assert.equal(mentionsAiUnavailable('data_analysis', { stats: {}, insights: [], summary: `${AI_UNAVAILABLE}, these are the computed statistics only.` }), true)
  assert.equal(mentionsAiUnavailable('data_analysis', { insights: ['ai UNAVAILABLE'], summary: 'ok' }), true)
  assert.equal(mentionsAiUnavailable('crypto_market_brief', { data: {}, brief: `${AI_UNAVAILABLE}, this is the market data only.` }), true)
  assert.equal(mentionsAiUnavailable('tx_explainer', { facts: {}, explanation: `${AI_UNAVAILABLE}, these are the decoded facts only.` }), true)
  assert.equal(mentionsAiUnavailable('translation', { translatedText: 'x', targetLanguage: 'id', notes: 'AI unavailable' }), true)

  // A translation of a text that happens to contain the phrase is the buyer's own words, not a fallback.
  assert.equal(mentionsAiUnavailable('translation', { translatedText: 'The sign said: AI unavailable', targetLanguage: 'en' }), false)
  assert.equal(mentionsAiUnavailable('data_analysis', { stats: { columns: ['AI unavailable'] }, insights: ['Sales grew.'], summary: 'Sales grew 40%.' }), false)
  assert.equal(mentionsAiUnavailable('data_analysis', null), false)
})
