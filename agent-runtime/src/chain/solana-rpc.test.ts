import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, test } from 'node:test'
import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError, type RpcTransport } from '@solana/kit'
import { SolanaRpcBackend, retryingOnRateLimit } from './solana-rpc.ts'

const tooMany = () => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { message: 'Too Many Requests', headers: new Headers(), statusCode: 429 })
const fake = (impl: () => Promise<unknown>) => impl as unknown as RpcTransport

describe('SolanaRpcBackend against a public node that answers HTTP 429', () => {
  test('a request refused with 429 is retried and succeeds', async () => {
    let calls = 0
    const transport = retryingOnRateLimit(fake(async () => (++calls < 3 ? Promise.reject(tooMany()) : 'ok')), 1)
    assert.equal(await transport({} as never), 'ok')
    assert.equal(calls, 3)
  })

  test('any other failure is thrown at once, and a node that never relents is given up on', async () => {
    let calls = 0
    const broken = retryingOnRateLimit(fake(async () => (calls++, Promise.reject(new Error('boom')))), 1)
    await assert.rejects(() => broken({} as never), /boom/)
    assert.equal(calls, 1)

    calls = 0
    const never = retryingOnRateLimit(fake(async () => (calls++, Promise.reject(tooMany()))), 1)
    await assert.rejects(() => never({} as never), /429/)
    assert.equal(calls, 9) // the first try and eight retries
  })

  test('over real HTTP: the backend reads through a 429 on a node that answers on the second try', async () => {
    let requests = 0
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        if (++requests === 1) {
          res.writeHead(429, { 'content-type': 'text/plain' }).end('Too Many Requests')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'GenesisHash11111111111111111111111111111111' }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const backend = new SolanaRpcBackend(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      assert.equal(await backend.getGenesisHash(), 'GenesisHash11111111111111111111111111111111')
      assert.equal(requests, 2)
    } finally {
      server.close()
    }
  })
})
