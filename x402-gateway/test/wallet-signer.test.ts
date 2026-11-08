import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSigner, type TransactionModifyingSigner } from '@solana/kit'
import { x402Client } from '@x402/core/client'
import { wrapFetchWithPayment } from '@x402/fetch'
import { ExactSvmScheme } from '@x402/svm/exact/client'
import { startGateway } from './helpers.ts'

/**
 * The website pays per call from the visitor's wallet. A wallet (Phantom, Solflare) is not a keypair: the x402 client
 * gets a kit TransactionModifyingSigner whose `modifyAndSignTransactions` hands the transaction to the wallet. This test
 * pays through the official x402 client with exactly that kind of signer (backed by a throwaway key instead of a wallet),
 * against the real gateway, with a fake RPC (mint and blockhash) and the fake facilitator.
 */

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

async function startFakeRpc(blockhash: string): Promise<{ url: string; close(): Promise<void> }> {
  // An SPL mint account, 82 bytes: no mint authority, supply 0, 6 decimals, initialised, no freeze authority.
  const mint = Buffer.alloc(82)
  mint.writeUInt8(6, 44)
  mint.writeUInt8(1, 45)
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const call = JSON.parse(body) as { id: number; method: string }
      const result =
        call.method === 'getAccountInfo'
          ? { context: { slot: 1 }, value: { data: [mint.toString('base64'), 'base64'], executable: false, lamports: 1461600, owner: TOKEN_PROGRAM, rentEpoch: 0, space: 82 } }
          : call.method === 'getLatestBlockhash'
            ? { context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 1000 } }
            : null
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(() => r())) }
}

test('a wallet-style signer pays per call through the x402 client, and the gateway delivers and settles', async () => {
  const keypair = await generateKeyPairSigner()
  const rpc = await startFakeRpc((await generateKeyPairSigner()).address)
  const seen: { address: string; signedBy: string[] }[] = []
  // What the website's transactionSigner is: it receives the unsigned transaction, the wallet signs it and may change it.
  const walletLike: TransactionModifyingSigner = {
    address: keypair.address,
    async modifyAndSignTransactions(transactions) {
      const signed = await Promise.all(
        transactions.map(async (tx) => {
          const [signatures] = await keypair.signTransactions([tx])
          const out = Object.freeze({ ...tx, signatures: Object.freeze({ ...tx.signatures, ...signatures }) })
          seen.push({ address: keypair.address, signedBy: Object.entries(out.signatures).filter(([, s]) => s !== null).map(([a]) => a) })
          return out
        })
      )
      return signed as never
    },
  }

  const h = await startGateway()
  try {
    const client = new x402Client().register('solana:*', new ExactSvmScheme(walletLike as never, { rpcUrl: rpc.url }))
    const paidFetch = wrapFetchWithPayment(fetch, client)
    const res = await paidFetch(`${h.base}/v1/agents/sentiment_score`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'great and fast' }),
    })
    assert.equal(res.status, 200)
    const out = (await res.json()) as { score: number; label: string }
    assert.equal(out.label, 'positive')
    assert.equal(seen.length, 1, 'the wallet was asked to sign exactly one transaction')
    assert.deepEqual(seen[0]!.signedBy, [keypair.address], 'signed by the visitor only: the fee payer signs later, at settlement')
    const receipt = JSON.parse(Buffer.from(res.headers.get('payment-response')!, 'base64').toString('utf8')) as { success: boolean; transaction: string }
    assert.equal(receipt.success, true)
    assert.match(receipt.transaction, /^FakeSettlement/)
    assert.equal(h.facilitator.calls.verify, 1)
    assert.equal(h.facilitator.calls.settle, 1)
    assert.equal(h.gateway.ledger.list()[0]?.status, 'done')
  } finally {
    await h.close()
    await rpc.close()
  }
})

test('a visitor who rejects the wallet prompt pays nothing and the agent never runs', async () => {
  const keypair = await generateKeyPairSigner()
  const rpc = await startFakeRpc((await generateKeyPairSigner()).address)
  const rejecting: TransactionModifyingSigner = {
    address: keypair.address,
    async modifyAndSignTransactions() {
      throw new Error('User rejected the request.')
    },
  }
  const h = await startGateway()
  try {
    const paidFetch = wrapFetchWithPayment(fetch, new x402Client().register('solana:*', new ExactSvmScheme(rejecting as never, { rpcUrl: rpc.url })))
    await assert.rejects(() => paidFetch(`${h.base}/v1/agents/sentiment_score`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'great' }) }), /rejected/i)
    assert.equal(h.facilitator.calls.verify, 0)
    assert.equal(h.facilitator.calls.settle, 0)
    assert.equal(h.gateway.ledger.list().length, 0)
  } finally {
    await h.close()
    await rpc.close()
  }
})
