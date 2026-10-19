import { test } from 'node:test'
import { startGateway, post, payFor } from './helpers.ts'

test('explore: what the gateway answers', async () => {
  const h = await startGateway()
  try {
    const r0 = await post(h.base, '/v1/agents/sentiment_score', { text: 'great and fast' })
    console.log('no payment:', r0.status, [...r0.headers.keys()].join(','), (await r0.text()).slice(0, 200))
    const enc = r0.headers.get('payment-required')
    if (enc) console.log('requirements:', Buffer.from(enc, 'base64').toString('utf8').slice(0, 600))
    const headers = await payFor(h.base, '/v1/agents/sentiment_score', { text: 'great and fast' })
    const r1 = await post(h.base, '/v1/agents/sentiment_score', { text: 'great and fast' }, headers)
    console.log('paid:', r1.status, (await r1.text()).slice(0, 200), 'settle calls', h.facilitator.calls)
    console.log('logs:', h.logs)
  } finally {
    await h.close()
  }
})
