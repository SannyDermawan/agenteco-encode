// A buyer agent that pays for an AgentEco agent call by itself with x402 on Solana devnet.
//
//   GATEWAY_URL=http://localhost:8402 SVM_PRIVATE_KEY=<base58 devnet secret key> npm run pay-demo
//
// The wallet needs devnet USDC (the mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU). The key comes from the environment and is
// never printed. The facilitator pays the network fee; the buyer only pays the price shown in the 402.
import { createKeyPairSignerFromBytes } from '@solana/kit'
import { base58 } from '@scure/base'
import { x402Client } from '@x402/core/client'
import { wrapFetchWithPayment } from '@x402/fetch'
import { ExactSvmScheme } from '@x402/svm/exact/client'
import { toClientSvmSigner } from '@x402/svm'

const key = process.env.SVM_PRIVATE_KEY
if (!key) throw new Error('Set SVM_PRIVATE_KEY in .env (a base58 devnet secret key for a wallet that holds devnet USDC).')
const gateway = process.env.GATEWAY_URL ?? 'http://localhost:8402'

const signer = toClientSvmSigner(await createKeyPairSignerFromBytes(base58.decode(key)))
const client = new x402Client().register('solana:*', new ExactSvmScheme(signer))
const paidFetch = wrapFetchWithPayment(fetch, client)

console.log(`buyer ${signer.address} -> ${gateway}`)
const pricing = (await (await fetch(`${gateway}/v1/pricing`)).json()) as { agents: { capability: string; price: string }[] }
console.log('price list:', pricing.agents.map((a) => `${a.capability} ${a.price}`).join(', '))

const res = await paidFetch(`${gateway}/v1/agents/sentiment_score`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'The agent was fast, helpful and easy to use. I recommend it.' }),
})
console.log('status:', res.status)
console.log('result:', await res.json())
const receipt = res.headers.get('payment-response')
if (receipt) console.log('settlement receipt:', JSON.parse(Buffer.from(receipt, 'base64').toString('utf8')))
