import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * The gateway's memory of payments. A payment proof is a signed Solana transaction, so the same proof presented twice is
 * the same money: the ledger makes sure a proof pays for one piece of work only, and records what happened to each.
 *
 *  in_progress  the work is running, a second request with the same proof is refused (409)
 *  done         work delivered and the payment settled, the same request replays the stored answer
 *  failed       the agent failed after verification: nothing was settled, so the buyer paid nothing and may retry
 *  unsettled    the work was delivered but the facilitator could not settle: for the merchant to reconcile
 */
export type PaymentStatus = 'in_progress' | 'done' | 'failed' | 'unsettled'

export interface PaymentRecord {
  id: string
  status: PaymentStatus
  /** Hash of the request the payment was for, so a replay for a different request is refused. */
  requestHash: string
  capability: string
  result?: unknown
  settlementTx?: string
  error?: string
  at: string
  updatedAt: string
}

export const paymentId = (headerValue: string): string => createHash('sha256').update(headerValue).digest('hex').slice(0, 32)
export const requestHash = (method: string, path: string, body: unknown): string =>
  createHash('sha256').update(`${method} ${path} ${JSON.stringify(body ?? null)}`).digest('hex').slice(0, 32)

export class Ledger {
  private readonly records = new Map<string, PaymentRecord>()

  constructor(
    private readonly file?: string,
    private readonly now: () => Date = () => new Date()
  ) {
    if (file && existsSync(file)) {
      try {
        for (const r of JSON.parse(readFileSync(file, 'utf8')) as PaymentRecord[]) {
          // A job that was running when the process stopped has an unknown outcome: keep it visible, not retryable.
          this.records.set(r.id, r.status === 'in_progress' ? { ...r, status: 'unsettled', error: 'The gateway restarted while the job was running.' } : r)
        }
      } catch {
        // A corrupt ledger file must not stop the gateway; it starts empty and the old file is left as it is.
      }
    }
  }

  get(id: string): PaymentRecord | undefined {
    return this.records.get(id)
  }

  begin(id: string, hash: string, capability: string): PaymentRecord {
    const at = this.now().toISOString()
    const record: PaymentRecord = { id, status: 'in_progress', requestHash: hash, capability, at, updatedAt: at }
    this.records.set(id, record)
    this.save()
    return record
  }

  update(id: string, patch: Partial<Pick<PaymentRecord, 'status' | 'result' | 'settlementTx' | 'error'>>): PaymentRecord | undefined {
    const current = this.records.get(id)
    if (!current) return undefined
    const next = { ...current, ...patch, updatedAt: this.now().toISOString() }
    this.records.set(id, next)
    this.save()
    return next
  }

  /** A failed attempt is forgotten for retry purposes but stays in the audit log (see list). */
  forget(id: string): void {
    this.records.delete(id)
    this.save()
  }

  list(): PaymentRecord[] {
    return [...this.records.values()]
  }

  private save(): void {
    if (this.file) writeFileSync(this.file, JSON.stringify(this.list(), null, 2))
  }
}
