'use client'
import '@/lib/solana/polyfills'
import { x402Client } from '@x402/core/client'
import { wrapFetchWithPayment } from '@x402/fetch'
import { ExactSvmScheme } from '@x402/svm/exact/client'
import type { TransactionModifyingSigner } from '@runtime/chain/kit.ts'
import { SOLANA } from '@/lib/web3/network'
import { GATEWAY_URL, decodeReceipt, type Receipt } from './gateway'

export interface PaidCall {
  result: Record<string, unknown>
  receipt: Receipt | null
  /** True when the gateway answered a payment it had already settled for the same request. */
  replayed: boolean
}

/** What the gateway says in words when a call does not work, so the page can show it. */
class GatewayError extends Error {}

function describe(status: number, body: { error?: string; detail?: string; charged?: boolean } | null): string {
  if (body?.detail) return body.detail
  if (status === 402) return 'The payment was not accepted. Nothing was charged.'
  if (status === 503) return 'The payment service did not answer. Nothing was charged, try again shortly.'
  return body?.error ? `The gateway answered ${body.error}.` : `The gateway answered HTTP ${status}.`
}

/**
 * Pays for one call of a gateway agent from the visitor's wallet with x402: the gateway answers 402 with the price,
 * the wallet signs one USDC transfer (the facilitator pays the network fee), the gateway runs the agent and settles
 * the payment only after the agent answered. Throws with a readable message when the visitor cancels in the wallet or
 * the call fails; a failed call is never charged.
 */
export async function payPerCall(txSigner: TransactionModifyingSigner, capability: string, brief: unknown): Promise<PaidCall> {
  // The client reads the mint and a blockhash from the cluster: use the app's own RPC, not a shared public default.
  const scheme = new ExactSvmScheme(txSigner as never, SOLANA ? { rpcUrl: SOLANA.rpcUrl } : undefined)
  const paidFetch = wrapFetchWithPayment(fetch, new x402Client().register('solana:*', scheme))
  let res: Response
  try {
    res = await paidFetch(`${GATEWAY_URL}/v1/agents/${encodeURIComponent(capability)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(brief),
    })
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    if (/reject|denied|declin|cancel/i.test(raw)) throw new GatewayError('The wallet request was cancelled. Nothing was charged.')
    throw new GatewayError(raw.split('\n')[0] || 'The payment could not be made.')
  }
  const body = (await res.json().catch(() => null)) as (Record<string, unknown> & { error?: string; detail?: string; charged?: boolean }) | null
  if (!res.ok || !body) throw new GatewayError(describe(res.status, body))
  return { result: body, receipt: decodeReceipt(res.headers.get('payment-response')), replayed: res.headers.get('x-payment-replay') === 'true' }
}
