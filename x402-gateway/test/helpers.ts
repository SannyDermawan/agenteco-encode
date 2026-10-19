import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createGateway, SOLANA_DEVNET, type GatewayConfig } from '../src/gateway.ts'
import type { AgentService } from '../src/agents.ts'

export const MERCHANT = '3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE'
export const FEE_PAYER = '11111111111111111111111111111111'
export const PAYER = 'So11111111111111111111111111111111111111112'

export interface FakeFacilitator {
  url: string
  calls: { verify: number; settle: number; supported: number }
  /** What /verify answers next. */
  verifyResult: () => { isValid: boolean; invalidReason?: string; payer?: string }
  settleResult: () => { success: boolean; errorReason?: string; transaction?: string }
  /** Delay (ms) added to verify and settle, to provoke a timeout. */
  delayMs: number
  /** Make every route answer 500. */
  down: boolean
  close(): Promise<void>
}

/** A stand-in for an x402 facilitator that speaks the documented HTTP interface (/supported, /verify, /settle). */
export async function startFakeFacilitator(): Promise<FakeFacilitator> {
  const state: FakeFacilitator = {
    url: '',
    calls: { verify: 0, settle: 0, supported: 0 },
    verifyResult: () => ({ isValid: true, payer: PAYER }),
    settleResult: () => ({ success: true, transaction: 'FakeSettlementSignature111111111111111111111111111111111111111111111111111' }),
    delayMs: 0,
    down: false,
    close: async () => {},
  }
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (state.down) return send(500, { error: 'down' })
      const path = new URL(req.url ?? '/', 'http://x').pathname
      if (path === '/supported') {
        state.calls.supported += 1
        return send(200, { kinds: [{ x402Version: 2, scheme: 'exact', network: SOLANA_DEVNET, extra: { feePayer: FEE_PAYER } }], extensions: [], signers: { 'solana:*': [FEE_PAYER] } })
      }
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs))
      if (path === '/verify') {
        state.calls.verify += 1
        return send(200, state.verifyResult())
      }
      if (path === '/settle') {
        state.calls.settle += 1
        const result = state.settleResult()
        return send(200, { ...result, network: SOLANA_DEVNET, payer: PAYER })
      }
      send(404, { error: 'not found' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  state.close = () => new Promise((r) => server.close(() => r()))
  return state
}

export interface Harness {
  base: string
  facilitator: FakeFacilitator
  gateway: ReturnType<typeof createGateway>
  logs: string[]
  close(): Promise<void>
}

export async function startGateway(overrides: Partial<GatewayConfig> = {}, agents?: AgentService[]): Promise<Harness> {
  const facilitator = await startFakeFacilitator()
  const logs: string[] = []
  const gateway = createGateway({ payTo: MERCHANT, facilitatorUrl: facilitator.url, facilitatorTimeoutMs: 1500, agents, log: (m) => logs.push(m), ...overrides })
  await gateway.ready
  const server = await new Promise<Server>((resolve) => {
    const s = gateway.app.listen(0, '127.0.0.1', () => resolve(s))
  })
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    facilitator,
    gateway,
    logs,
    close: async () => {
      await new Promise((r) => server.close(r))
      await facilitator.close()
    },
  }
}

export const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

/** Reads the 402 the way an x402 client does and builds a payment header for it (the transaction is a placeholder the fake facilitator accepts). */
export async function payFor(base: string, path: string, body: unknown, nonce = 'tx-1'): Promise<Record<string, string>> {
  const challenge = await post(base, path, body)
  if (challenge.status !== 402) throw new Error(`expected 402, got ${challenge.status}`)
  const encoded = challenge.headers.get('payment-required')
  if (!encoded) throw new Error('402 without a PAYMENT-REQUIRED header')
  const required = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as { accepts: Record<string, unknown>[]; resource?: unknown }
  const payload = { x402Version: 2, resource: required.resource, accepted: required.accepts[0], payload: { transaction: Buffer.from(nonce).toString('base64') } }
  return { 'payment-signature': Buffer.from(JSON.stringify(payload)).toString('base64') }
}
