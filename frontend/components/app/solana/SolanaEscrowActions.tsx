'use client'
import { useState } from 'react'
import Link from 'next/link'
import { sameWallet } from '@shared/wallets'
import { textHash } from '@shared/hashes'
import { forgetPendingReason, rememberPendingReason, submitDisputeReason } from '@/lib/api/disputes'
import { useIsArbiter } from '@/lib/chain/hooks'
import { useSolanaAction } from '@/lib/solana/actions'
import type { SolanaEscrow } from '@/lib/solana/hooks'
import { useWallet } from '@/lib/wallet/useWallet'
import { onChainStatusLabel } from '@/lib/web3/status'

type Variant = 'primary' | 'danger' | 'ghost'

function ActionButton({ label, onClick, pending, variant = 'primary' }: { label: string; onClick: () => void; pending: boolean; variant?: Variant }) {
  const styles = {
    primary: 'bg-[#5B5FEF] text-white hover:brightness-110',
    danger: 'bg-[#EF4444]/15 text-[#EF4444] border border-[#EF4444]/30 hover:bg-[#EF4444]/20',
    ghost: 'bg-white/[0.04] text-[#F5F5F7] border border-white/[0.08] hover:bg-white/[0.07]',
  }[variant]
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className={`flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-[13.5px] font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${styles}`}
    >
      {pending && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current" />}
      {label}
    </button>
  )
}

/**
 * What the connected wallet can do with an escrow on Solana, by its status, the same set as the EVM
 * panel: the buyer accepts or disputes a delivery, anyone moves a timed-out escrow on (the program
 * checks the deadline itself), the seller starts and delivers (normally its agent software does), and
 * the arbiter rules on the Disputes page. Each write is one wallet prompt.
 */
export function SolanaEscrowActions({
  escrowId,
  buyer,
  seller,
  status,
  flags,
  onChanged,
}: {
  escrowId: bigint
  buyer: string
  seller: string
  status: number
  flags: SolanaEscrow['flags']
  onChanged: () => void
}) {
  const { address, signer } = useWallet()
  const isBuyer = !!address && sameWallet(address, buyer)
  const isSeller = !!address && sameWallet(address, seller)
  const isArbiter = useIsArbiter(address, escrowId)

  const settle = useSolanaAction((a) => a.acceptAndSettle(escrowId))
  const start = useSolanaAction((a) => a.startExecution(escrowId))
  const deliver = useSolanaAction((a, hash: `0x${string}`) => a.markDelivered(escrowId, hash))
  const claimAccept = useSolanaAction((a) => a.claimTimeout(escrowId, 'claimAcceptTimeout'))
  const claimExecution = useSolanaAction((a) => a.claimTimeout(escrowId, 'claimExecutionTimeout'))
  const finalize = useSolanaAction((a) => a.claimTimeout(escrowId, 'finalizeAfterReviewWindow'))
  const claimDispute = useSolanaAction((a) => a.claimTimeout(escrowId, 'claimDisputeTimeout'))
  const raise = useSolanaAction((a, hash: `0x${string}`) => a.raiseDispute(escrowId, hash))

  const [resultText, setResultText] = useState('')
  const [disputeFormOpen, setDisputeFormOpen] = useState(false)
  const [disputeReason, setDisputeReason] = useState('')
  const [disputeError, setDisputeError] = useState<string | null>(null)
  const [disputePending, setDisputePending] = useState(false)

  // Runs a write and refreshes the page when it went through (the action hook reports failures in `error`).
  const then = (run: () => Promise<unknown>) => async () => {
    await run()
    onChanged()
  }

  async function handleRaiseDispute() {
    if (!signer) return
    const reason = disputeReason.trim()
    if (reason.length < 10) {
      setDisputeError('Please describe the problem in at least 10 characters.')
      return
    }
    setDisputePending(true)
    setDisputeError(null)
    rememberPendingReason(escrowId.toString(), reason)
    const tx = await raise.run(textHash(reason))
    if (!tx) {
      // Nothing happened on-chain; the action hook shows why (below).
      setDisputePending(false)
      return
    }
    // On-chain the dispute now exists; the reason is best-effort, if saving it fails, the dispute
    // timeline offers the buyer a retry.
    try {
      await submitDisputeReason(signer, escrowId.toString(), reason)
      forgetPendingReason(escrowId.toString())
    } catch {
      // Surfaced by DisputeTimelineCard's "add your reason" prompt.
    }
    setDisputePending(false)
    setDisputeFormOpen(false)
    onChanged()
  }

  const label = onChainStatusLabel(status)
  const buttons: React.ReactNode[] = []

  if (label === 'FUNDED' && flags.acceptTimedOut) {
    buttons.push(<ActionButton key="refund" label="Refund (seller did not start)" onClick={then(claimAccept.run)} pending={claimAccept.isPending} variant="ghost" />)
  }
  if (label === 'FUNDED' && isSeller) {
    buttons.push(<ActionButton key="start" label="Start Execution" onClick={then(start.run)} pending={start.isPending} />)
  }
  if (label === 'EXECUTING' && flags.executionTimedOut) {
    buttons.push(<ActionButton key="timeout" label="Claim Execution Timeout (refund)" onClick={then(claimExecution.run)} pending={claimExecution.isPending} variant="ghost" />)
  }
  if (label === 'DELIVERED' && isBuyer) {
    buttons.push(
      <ActionButton key="accept" label="Accept & Settle" onClick={then(settle.run)} pending={settle.isPending} />,
      <ActionButton key="dispute" label="Raise Dispute" onClick={() => setDisputeFormOpen(true)} pending={false} variant="danger" />
    )
  }
  if (label === 'DELIVERED' && flags.reviewExpired) {
    buttons.push(<ActionButton key="finalize" label="Finalize (release to seller)" onClick={then(finalize.run)} pending={finalize.isPending} variant="ghost" />)
  }
  if (label === 'DISPUTED' && flags.disputeTimedOut) {
    buttons.push(<ActionButton key="disputeTimeout" label="Claim Dispute Timeout (refund)" onClick={then(claimDispute.run)} pending={claimDispute.isPending} variant="ghost" />)
  }
  if (label === 'DISPUTED' && isArbiter) {
    buttons.push(
      <Link key="arbiter" href="/app/disputes" className="flex items-center justify-center rounded-xl bg-[#5B5FEF] py-2.5 text-[13.5px] font-medium text-white transition hover:brightness-110">
        Review in Disputes →
      </Link>
    )
  }

  const showDeliverForm = label === 'EXECUTING' && isSeller && !flags.executionTimedOut
  const showDisputeForm = disputeFormOpen && label === 'DELIVERED' && isBuyer
  const errors = [disputeError, raise.error, settle.error, start.error, deliver.error, claimAccept.error, claimExecution.error, finalize.error, claimDispute.error].map((e) => (typeof e === 'string' ? e : e?.message)).filter(Boolean)

  if (buttons.length === 0 && !showDeliverForm) return <p className="text-[13px] text-[#8B8D96]">Nothing to do on this escrow right now.</p>

  return (
    <div className="space-y-3">
      {showDeliverForm && (
        <div className="space-y-2">
          <input
            type="text"
            value={resultText}
            onChange={(e) => setResultText(e.target.value)}
            placeholder="Result summary, hashed on-chain, the full result stays off-chain"
            className="w-full rounded-xl border border-white/[0.08] bg-[#0B0C11] px-3 py-2.5 text-[13px] text-[#F5F5F7] placeholder:text-[#8B8D96] focus:outline-none"
          />
          <ActionButton label="Mark Delivered" pending={deliver.isPending} onClick={then(() => deliver.run(textHash(resultText.trim())))} />
          {!resultText.trim() && <p className="text-[11.5px] text-[#8B8D96]">The program refuses an empty result hash, so a summary is needed.</p>}
        </div>
      )}

      {showDisputeForm ? (
        <div className="space-y-2 rounded-xl border border-[#EF4444]/25 bg-[#EF4444]/[0.05] p-3.5">
          <label className="block text-[12.5px] font-medium text-[#F5F5F7]" htmlFor="dispute-reason">
            What&apos;s wrong with the delivered result?
          </label>
          <textarea
            id="dispute-reason"
            value={disputeReason}
            onChange={(e) => setDisputeReason(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="e.g. The result is empty / doesn't match what was agreed…"
            className="w-full resize-none rounded-lg border border-white/[0.08] bg-[#0B0C11] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#54565F] focus:outline-none"
          />
          <p className="text-[11.5px] leading-relaxed text-[#8B8D96]">
            The arbiter reviews your reason and the delivered result, then releases the escrow to the seller or refunds you. Two wallet prompts: the
            dispute transaction, then a free signature to save your reason.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <ActionButton label="Submit Dispute" onClick={handleRaiseDispute} pending={disputePending} variant="danger" />
            <ActionButton
              label="Cancel"
              onClick={() => {
                setDisputeFormOpen(false)
                setDisputeError(null)
              }}
              pending={false}
              variant="ghost"
            />
          </div>
        </div>
      ) : (
        buttons.length > 0 && <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{buttons}</div>
      )}

      {errors.length > 0 && <p className="text-[12px] leading-relaxed text-[#EF4444]">{errors[0]}</p>}
    </div>
  )
}
