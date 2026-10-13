'use client'
import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { sameWallet } from '@shared/wallets'
import { useWallet } from '@/lib/wallet/useWallet'
import { NeumorphicCard } from './NeumorphicCard'
import { HashCheck } from './HashCheck'
import { Remaining, useNow } from './DeadlineCountdown'
import { forgetPendingReason, getDisputeReason, readPendingReason, submitDisputeReason, type ApiDispute } from '@/lib/api/disputes'
import { useEscrowHashes, useIsArbiter } from '@/lib/chain/hooks'
import { explorerTxUrl } from '@/lib/web3/escrowEvents'

// AgentEco.sol OrderStatus (the Solana adapter reports the same numbers)
const DISPUTED = 4
const SETTLED = 5
const REFUNDED = 6

// The AI arbiter runs in the backend host, which serves EVM chains only; on Solana the
// council rules directly and the ruling is not reported back to the API.
// The AI arbiter host serves every network, Solana included (its key is the program's arbiter on devnet).
const HAS_AI_ARBITER = true

const DECIDED_BY: Record<NonNullable<ApiDispute['resolution']>, string> = {
  'ai-auto': 'AI arbiter (automatic)',
  'arbiter-manual': 'Human arbiter',
  timeout: 'Dispute timeout',
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <div
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold ${
          done ? 'bg-[#5B5FEF] text-white' : 'border border-white/15 text-[#8B8D96]'
        }`}
      >
        {n}
      </div>
      <div className="min-w-0 flex-1 pb-5">
        <div className="mb-1.5 text-[12.5px] font-medium text-[#F5F5F7]">{title}</div>
        {children}
      </div>
    </div>
  )
}

function Quote({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words rounded-xl border border-white/[0.06] bg-[#0B0C11] p-3 text-[12.5px] leading-relaxed text-[#F5F5F7]">
      {text}
    </p>
  )
}

const muted = 'text-[12.5px] text-[#8B8D96]'

/** The arbiter's rationale text inside the stored preimage (fixed-key JSON). */
function rulingRationale(d: ApiDispute): string | null {
  if (!d.rationalePreimage) return null
  try {
    return (JSON.parse(d.rationalePreimage) as { rationale?: string }).rationale ?? null
  } catch {
    return null
  }
}

/**
 * The whole dispute, step by step (spec §11): the buyer's reason, the
 * seller's response, the AI arbiter's recommendation and the ruling, each
 * text re-hashed against the chain, with the ruling's transaction. Visible to
 * anyone, so it can be followed without being the arbiter.
 */
export function DisputeTimelineCard({ escrowId, status, buyer }: { escrowId: bigint; status: number; buyer: string }) {
  const { address, signer } = useWallet()
  const queryClient = useQueryClient()
  const isArbiter = useIsArbiter(address, escrowId)
  const isBuyer = !!address && sameWallet(address, buyer)
  const now = useNow()
  const open = status === DISPUTED

  const { data: d, isPending } = useQuery({
    queryKey: ['disputeReason', escrowId.toString()],
    queryFn: () => getDisputeReason(escrowId.toString()),
    refetchInterval: open ? 5000 : (query) => (query.state.data && !query.state.data.resolution ? 5000 : false),
  })
  const hashes = useEscrowHashes(open || d ? escrowId : undefined, open)

  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Prefill with the exact text the dispute transaction hashed, if this browser sent it.
  useEffect(() => {
    const pending = readPendingReason(escrowId.toString())
    if (pending) setDraft(pending)
  }, [escrowId])

  if (!open && !d) return null

  async function handleSave() {
    if (!address || !signer) return
    setSaving(true)
    setError(null)
    try {
      await submitDisputeReason(signer, escrowId.toString(), draft.trim())
      forgetPendingReason(escrowId.toString())
      await queryClient.invalidateQueries({ queryKey: ['disputeReason', escrowId.toString()] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your reason.')
    } finally {
      setSaving(false)
    }
  }

  const [, , reasonHash, responseHash, resolutionHash] = hashes.data ?? []
  const responded = !!responseHash && !/^0x0+$/.test(responseHash)
  const overrideDeadline = d?.overrideDeadline ? Math.floor(new Date(d.overrideDeadline).getTime() / 1000) : null
  const ruling = d ? rulingRationale(d) : null
  // Final on-chain without a ruling record in the API (Solana): show the outcome the chain has.
  const settledOnChain = !HAS_AI_ARBITER && !d?.resolution && (status === SETTLED || status === REFUNDED)

  return (
    <NeumorphicCard className="p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">DISPUTE</h3>
        {open && (
          <span className="rounded-full border border-[#EF4444]/35 bg-[#EF4444]/10 px-2 py-0.5 text-[10.5px] font-medium text-[#F87171]">
            {isArbiter ? 'Awaiting your decision' : 'Awaiting ruling'}
          </span>
        )}
      </div>

      <Step n={1} title="Buyer's reason" done={!!d?.reason}>
        {d?.reason ? (
          <Quote text={d.reason} />
        ) : isPending ? (
          <p className={muted}>Loading…</p>
        ) : isBuyer && open ? (
          <div className="space-y-2">
            <p className={muted}>
              Only the hash of your reason is on-chain. Add the exact text you disputed with so the arbiter can read it.
            </p>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              maxLength={1000}
              className="w-full resize-none rounded-lg border border-white/[0.08] bg-[#0B0C11] px-3 py-2 text-[13px] text-[#F5F5F7] focus:outline-none"
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || draft.trim().length < 10}
              className="w-full rounded-xl bg-[#5B5FEF] py-2.5 text-[13px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save reason'}
            </button>
            {error && <p className="text-[12px] text-[#EF4444]">{error}</p>}
          </div>
        ) : (
          <p className={muted}>The reason text hasn&apos;t reached the API, only its hash is on-chain.</p>
        )}
        <div className="mt-1.5">
          <HashCheck label="reasonHash" text={d?.reason || null} onchainHash={reasonHash ?? d?.reasonHash} />
        </div>
      </Step>

      <Step n={2} title="Seller's response" done={!!d?.sellerResponse}>
        {d?.sellerResponse ? (
          <>
            <Quote text={d.sellerResponse} />
            <div className="mt-1 text-[11px] text-[#54565F]">
              {d.responseSource === 'ai' ? 'Written by the seller agent’s AI' : d.responseSource === 'manual' ? 'Written by the seller' : 'Sent by the seller’s agent'}
            </div>
            <div className="mt-1">
              <HashCheck label="responseHash" text={d.sellerResponse} onchainHash={responseHash ?? d.responseHash ?? undefined} />
            </div>
          </>
        ) : responded ? (
          <p className={muted}>Answered on-chain, waiting for the text…</p>
        ) : d?.recommendedAt || !open ? (
          <p className={muted}>No response.</p>
        ) : (
          <p className={muted}>Waiting for the seller to respond…</p>
        )}
      </Step>

      <Step n={3} title={HAS_AI_ARBITER ? 'AI arbiter recommendation' : 'AI arbiter (not on this network)'} done={!!d?.recVerdict}>
        {d?.recVerdict ? (
          <div className="space-y-1.5">
            <div className="text-[13px] text-[#F5F5F7]">
              Release to the <span className="font-semibold">{d.recVerdict}</span> ·{' '}
              <span className="text-[#8B8D96]">{d.recConfidence}% confident</span>
            </div>
            {d.recRationale && <Quote text={d.recRationale} />}
            <div className="text-[11px] text-[#54565F]">
              {d.recProvider}/{d.recModel}
              {overrideDeadline && !d.resolution && (
                <>
                  {' '}· arbiter override window: <Remaining deadline={overrideDeadline} now={now} />
                </>
              )}
            </div>
          </div>
        ) : !HAS_AI_ARBITER ? (
          <p className={muted}>There is no AI arbiter on this network: the arbiter rules directly, or the dispute timeout refunds the buyer.</p>
        ) : d?.recUnavailable ? (
          <p className={muted}>AI recommendation unavailable, the arbiter decides manually, or the timeout refunds the buyer.</p>
        ) : (
          <p className={muted}>Runs once the seller responds or its response window closes.</p>
        )}
      </Step>

      <Step n={4} title="Ruling" done={!!d?.resolution || settledOnChain}>
        {d?.resolution ? (
          <div className="space-y-1.5">
            <div className="text-[13px] text-[#F5F5F7]">
              {d.releasedToSeller ? 'Paid to the seller' : 'Refunded to the buyer'} ·{' '}
              <span className="text-[#8B8D96]">{DECIDED_BY[d.resolution]}</span>
            </div>
            {ruling && <Quote text={ruling} />}
            {d.resolution !== 'timeout' && (
              <HashCheck label="rationaleHash" text={d.rationalePreimage} onchainHash={resolutionHash ?? d.rationaleHash ?? undefined} />
            )}
            {d.resolutionTx && (
              <a href={explorerTxUrl(d.resolutionTx)} target="_blank" rel="noreferrer" className="text-[11.5px] text-[#8FA9FF] hover:underline">
                Ruling transaction ↗
              </a>
            )}
          </div>
        ) : settledOnChain ? (
          <div className="space-y-1.5">
            <div className="text-[13px] text-[#F5F5F7]">
              {status === SETTLED ? 'Paid to the seller' : 'Refunded to the buyer'} ·{' '}
              <span className="text-[#8B8D96]">final on-chain</span>
            </div>
            <p className={muted}>
              {status === SETTLED
                ? 'The arbiter ruled for the seller.'
                : 'The arbiter ruled for the buyer, or the dispute timeout refunded them.'}{' '}
              The ruling text is not reported to the API on this network.
            </p>
          </div>
        ) : (
          <p className={muted}>Not decided yet.</p>
        )}
      </Step>
    </NeumorphicCard>
  )
}
