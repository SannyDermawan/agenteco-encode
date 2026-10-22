import { createHash } from 'node:crypto'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { paymentMiddleware, x402ResourceServer } from '@x402/express'
import { HTTPFacilitatorClient } from '@x402/core/server'
import { ExactSvmScheme } from '@x402/svm/exact/server'
import { DEFAULT_AGENTS, type AgentService } from './agents.ts'
import { Ledger, requestHash } from './ledger.ts'

export const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
export const PUBLIC_FACILITATOR = 'https://x402.org/facilitator'

export interface GatewayConfig {
  /** Solana address (public) that receives the payments. */
  payTo: string
  network?: string
  facilitatorUrl?: string
  facilitatorTimeoutMs?: number
  agents?: AgentService[]
  ledger?: Ledger
  log?: (message: string) => void
}

export interface Gateway {
  app: Express
  ledger: Ledger
  /** Resolves when the resource server has loaded the facilitator's supported payment kinds. */
  ready: Promise<void>
}

const PAYMENT_HEADERS = ['payment-signature', 'x-payment']

function paymentHeader(req: Request): string | undefined {
  for (const name of PAYMENT_HEADERS) {
    const value = req.header(name)
    if (value) return value
  }
  return undefined
}

/** The same payment must map to the same id however it is encoded: hash the signed transaction inside the proof. */
export function proofIdFromPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)
}

export function proofIdFromHeader(header: string): string {
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { payload?: unknown }
    if (decoded.payload !== undefined) return proofIdFromPayload(decoded.payload)
  } catch {
    // not base64 JSON: fall through, the facilitator will reject it as an invalid payment
  }
  return createHash('sha256').update(header).digest('hex').slice(0, 32)
}

/**
 * Builds the gateway: every agent is a paid endpoint `POST /v1/agents/<capability>`. A request without a payment gets
 * HTTP 402 with the price and the Solana payment instructions; with a valid payment the agent runs; the payment settles
 * only after the agent answered successfully.
 *
 * What is handled (and tested):
 *  - a bad request is rejected with 400 BEFORE any payment is asked for,
 *  - an underpaid, expired or malformed payment is refused by verification with 402 and the facilitator's reason,
 *  - a payment proof can pay for one job only: replaying it for the same request returns the stored answer without a
 *    second settlement, replaying it for a different request is 409,
 *  - the agent failing after a valid payment, or delivering a result of the wrong shape, is a 502 and nothing is settled,
 *    so the buyer is not charged,
 *  - the facilitator being slow or down is a 503 with Retry-After and no work is done,
 *  - a settlement that fails after the work was done is recorded as `unsettled` for the merchant to reconcile.
 */
export function createGateway(config: GatewayConfig): Gateway {
  const agents = config.agents ?? DEFAULT_AGENTS
  const network = (config.network ?? SOLANA_DEVNET) as `${string}:${string}`
  const ledger = config.ledger ?? new Ledger()
  const log = config.log ?? (() => {})
  const byCapability = new Map(agents.map((a) => [a.capability, a]))

  const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl ?? PUBLIC_FACILITATOR, timeoutMs: config.facilitatorTimeoutMs ?? 15_000 })
  const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactSvmScheme())

  // Hooks that keep the ledger honest about money.
  resourceServer.onVerifyFailure(async (context) => {
    log(`verify failed: ${JSON.stringify((context as { error?: unknown }).error ?? 'invalid payment')}`)
  })
  resourceServer.onAfterSettle(async (context) => {
    const id = proofIdFromPayload(context.paymentPayload.payload)
    const tx = (context.result as { transaction?: string }).transaction
    ledger.update(id, { status: 'done', settlementTx: tx })
    log(`settled ${id} tx ${tx ?? 'unknown'}`)
  })
  resourceServer.onSettleFailure(async (context) => {
    const id = proofIdFromPayload(context.paymentPayload.payload)
    ledger.update(id, { status: 'unsettled', error: String((context as { error?: unknown }).error ?? 'settlement failed') })
    log(`SETTLEMENT FAILED for ${id}: needs reconciliation`)
  })

  const routes = Object.fromEntries(
    agents.map((a) => [
      `POST /v1/agents/${a.capability}`,
      {
        accepts: { scheme: 'exact', network, payTo: config.payTo, price: a.priceUsd },
        description: a.description,
        mimeType: 'application/json',
      },
    ])
  )

  const app = express()
  app.use(express.json({ limit: '8kb' }))

  app.get('/health', (_req, res) => {
    const all = ledger.list()
    res.json({ ok: true, network, agents: agents.map((a) => a.capability), payments: { done: all.filter((r) => r.status === 'done').length, unsettled: all.filter((r) => r.status === 'unsettled').length } })
  })

  app.get('/v1/pricing', (_req, res) => {
    res.json({ network, payTo: config.payTo, agents: agents.map((a) => ({ capability: a.capability, description: a.description, price: a.priceUsd, endpoint: `/v1/agents/${a.capability}` })) })
  })

  // Everything before the payment middleware runs for free, so it must never do the paid work.
  app.post('/v1/agents/:capability', (req: Request, res: Response, next: NextFunction) => {
    const agent = byCapability.get(String(req.params.capability))
    if (!agent) return void res.status(404).json({ error: 'unknown_capability', known: [...byCapability.keys()] })
    const parsed = agent.input.safeParse(req.body)
    if (!parsed.success) return void res.status(400).json({ error: 'invalid_brief', detail: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) })

    const header = paymentHeader(req)
    if (header) {
      const id = proofIdFromHeader(header)
      const record = ledger.get(id)
      if (record) {
        const same = record.requestHash === requestHash(req.method, req.path, req.body)
        if (record.status === 'done' && same) return void res.set('x-payment-replay', 'true').status(200).json(record.result)
        if (record.status === 'done') return void res.status(409).json({ error: 'payment_already_used', detail: 'This payment proof already paid for a different request. Sign a new payment.' })
        if (record.status === 'in_progress') return void res.status(409).json({ error: 'payment_in_flight', detail: 'This payment is being processed. Wait for the first request to finish.' })
        if (record.status === 'unsettled') return void res.status(409).json({ error: 'payment_unsettled', detail: 'The work was done but the payment has not settled. Contact the merchant with this proof id.', proofId: id })
      }
      // Reserve the proof now, before verification, so two requests carrying the same proof at the same time cannot both run.
      ledger.begin(id, requestHash(req.method, req.path, req.body), agent.capability)
      res.on('finish', () => {
        // An error before settlement (invalid payment, facilitator trouble, agent failure) means nothing was charged:
        // free the proof so the buyer can retry. An `unsettled` record is kept on purpose.
        if (res.statusCode >= 400 && ledger.get(id)?.status === 'in_progress') ledger.forget(id)
      })
    }
    next()
  })

  // The payment library answers a facilitator timeout with a bare 502. Say what it is: retry later, nothing charged.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const json = res.json.bind(res)
    res.json = (body?: unknown) => {
      const message = (body as { error?: unknown } | undefined)?.error
      if (res.statusCode === 502 && typeof message === 'string' && /facilitator/i.test(message)) {
        res.status(503).set('retry-after', '5')
        return json({ error: 'facilitator_unavailable', detail: 'The payment facilitator did not answer. Nothing was charged, try again shortly.' })
      }
      return json(body)
    }
    next()
  })

  app.use(paymentMiddleware(routes, resourceServer, undefined, undefined, false))

  app.post('/v1/agents/:capability', async (req: Request, res: Response) => {
    const agent = byCapability.get(String(req.params.capability))!
    const header = paymentHeader(req)
    const id = header ? proofIdFromHeader(header) : undefined
    try {
      const result = await agent.run(req.body)
      // A delivery of the wrong shape is a failed job: nothing is settled and the proof can retry. This checks the shape
      // only, not the quality (that is what AgentEco's escrow, verification and arbiter are for).
      const shape = agent.output?.safeParse(result)
      if (shape && !shape.success) {
        log(`agent ${agent.capability} returned an invalid result: ${shape.error.issues[0]?.message ?? 'wrong shape'}`)
        return void res.status(502).json({ error: 'invalid_result', charged: false, detail: 'The agent returned a result that does not match what it promised. No payment was taken, you can retry.' })
      }
      if (id) ledger.update(id, { result })
      res.json(result)
    } catch (error) {
      // A failed job is an error status, so the payment middleware does not settle: the buyer is not charged.
      log(`agent ${agent.capability} failed: ${(error as Error).message}`)
      res.status(502).json({ error: 'agent_failed', charged: false, detail: 'The agent could not finish. No payment was taken, you can retry.' })
    }
  })

  // Facilitator timeouts and network errors reach here when the payment library throws.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const name = (error as { name?: string }).name ?? ''
    log(`gateway error: ${name} ${(error as Error).message}`)
    if (/Timeout|ECONN|fetch failed|ENOTFOUND/i.test(`${name} ${(error as Error).message}`)) {
      return void res.set('retry-after', '5').status(503).json({ error: 'facilitator_unavailable', detail: 'The payment facilitator did not answer. Nothing was charged, try again shortly.' })
    }
    res.status(500).json({ error: 'internal_error' })
  })

  const ready = resourceServer.initialize().then(
    () => undefined,
    (error: unknown) => {
      log(`could not load facilitator capabilities yet: ${(error as Error).message}`)
    }
  )

  return { app, ledger, ready }
}
