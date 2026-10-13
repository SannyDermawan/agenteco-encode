'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { keccak256, stringToHex, zeroHash } from 'viem'
import { useAccount, useSignMessage, useWriteContract } from 'wagmi'
import { readContract, waitForTransactionReceipt } from 'wagmi/actions'
import { wagmiConfig } from '@/lib/web3/config'
import { AGENT_ECO_ABI, ERC20_ABI, USDT_ADDRESS, agentEcoFor } from '@/lib/web3/abi'
import { forgetPendingReason, rememberPendingReason, submitDisputeReason } from '@/lib/api/disputes'
import { textHash } from '@shared/hashes'
import {
  useAcceptAndSettle,
  useClaimExecutionTimeout,
  useFinalizeAfterReviewWindow,
  useIsArbiter,
  useIsExecutionTimedOut,
  useIsReviewExpired,
  useMarkDelivered,
  useRefundEscrow,
  useStartExecution,
  useUsdtDecimals,
} from '@/lib/web3/hooks'
import { assertUsdtBalance } from '@/lib/web3/usdtBalance'
import { onChainStatusLabel } from '@/lib/web3/status'

type Props = {
  escrowId: bigint
  buyer: `0x${string}`
  seller: `0x${string}`
  amount: bigint
  status: number
  onChanged: () => void
}

function isSameAddress(a?: string, b?: string) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

function ActionButton({
  label,
  onClick,
  pending,
  variant = 'primary',
}: {
  label: string
  onClick: () => void
  pending: boolean
  variant?: 'primary' | 'danger' | 'ghost'
}) {
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

/** Wires a { write, isPending, isConfirming, isSuccess } hook to onChanged + local error state. */
function useActionRunner(
  action: { write: (id: bigint) => void; isPending: boolean; isConfirming: boolean; isSuccess: boolean; error: Error | null },
  escrowId: bigint,
  onChanged: () => void
) {
  useEffect(() => {
    if (action.isSuccess) onChanged()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action.isSuccess])

  return {
    run: () => action.write(escrowId),
    pending: action.isPending || action.isConfirming,
    error: action.error,
  }
}

export function EscrowActionPanel({ escrowId, buyer, seller, amount, status, onChanged }: Props) {
  const { address } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const { data: decimals } = useUsdtDecimals()
  const { signMessageAsync } = useSignMessage()

  const isBuyer = isSameAddress(address, buyer)
  const isSeller = isSameAddress(address, seller)
  // Read from the contract, not hardcoded, follows an arbiter handover, council members and new deployments.
  const isArbiter = useIsArbiter(address, escrowId)

  const { data: timedOut } = useIsExecutionTimedOut(escrowId)
  const { data: reviewExpired } = useIsReviewExpired(escrowId)

  const start = useActionRunner(useStartExecution(), escrowId, onChanged)
  const accept = useActionRunner(useAcceptAndSettle(), escrowId, onChanged)
  const refund = useActionRunner(useRefundEscrow(), escrowId, onChanged)
  const claimTimeout = useActionRunner(useClaimExecutionTimeout(), escrowId, onChanged)
  const finalize = useActionRunner(useFinalizeAfterReviewWindow(), escrowId, onChanged)

  const markDeliveredAction = useMarkDelivered()
  const [resultText, setResultText] = useState('')
  useEffect(() => {
    if (markDeliveredAction.isSuccess) onChanged()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markDeliveredAction.isSuccess])

  // Raising a dispute asks the buyer why first, the arbiter's only context.
  const [disputeFormOpen, setDisputeFormOpen] = useState(false)
  const [disputeReason, setDisputeReason] = useState('')
  const [disputePending, setDisputePending] = useState(false)
  const [disputeError, setDisputeError] = useState<string | null>(null)

  async function handleRaiseDispute() {
    if (!address) return
    const reason = disputeReason.trim()
    if (reason.length < 10) {
      setDisputeError('Please describe the problem in at least 10 characters.')
      return
    }
    setDisputePending(true)
    setDisputeError(null)
    rememberPendingReason(escrowId.toString(), reason)
    try {
      const hash = await writeContractAsync({
        address: agentEcoFor(escrowId),
        abi: AGENT_ECO_ABI,
        functionName: 'raiseDispute',
        args: [escrowId, textHash(reason)],
      })
      await waitForTransactionReceipt(wagmiConfig, { hash })
    } catch (err) {
      setDisputeError(err instanceof Error ? err.message : 'Raising the dispute failed. Please try again.')
      setDisputePending(false)
      return
    }
    // On-chain the dispute now exists; the reason is best-effort, if saving it
    // fails, the dispute timeline offers the buyer a retry.
    try {
      await submitDisputeReason({ address, signMessageAsync }, escrowId.toString(), reason)
      forgetPendingReason(escrowId.toString())
    } catch {
      // Surfaced by DisputeTimelineCard's "add your reason" prompt.
    }
    setDisputePending(false)
    setDisputeFormOpen(false)
    onChanged()
  }

  const [fundingPending, setFundingPending] = useState(false)
  const [fundingError, setFundingError] = useState<string | null>(null)

  async function handleFundEscrow() {
    if (!address || decimals === undefined) return
    setFundingPending(true)
    setFundingError(null)
    try {
      await assertUsdtBalance(address, amount, decimals)
      const allowance = await readContract(wagmiConfig, {
        address: USDT_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [address, agentEcoFor(escrowId)],
      })
      if (allowance < amount) {
        const approveHash = await writeContractAsync({
          address: USDT_ADDRESS,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [agentEcoFor(escrowId), amount],
        })
        await waitForTransactionReceipt(wagmiConfig, { hash: approveHash })
      }
      const fundHash = await writeContractAsync({
        address: agentEcoFor(escrowId),
        abi: AGENT_ECO_ABI,
        functionName: 'fundEscrow',
        args: [escrowId],
      })
      await waitForTransactionReceipt(wagmiConfig, { hash: fundHash })
      onChanged()
    } catch (err) {
      setFundingError(err instanceof Error ? err.message : 'Funding failed. Please try again.')
    } finally {
      setFundingPending(false)
    }
  }

  const label = onChainStatusLabel(status)
  const buttons: React.ReactNode[] = []

  if (label === 'CREATED' && isBuyer) {
    buttons.push(
      <ActionButton key="fund" label="Fund Escrow" onClick={handleFundEscrow} pending={fundingPending} />
    )
  }

  if (label === 'FUNDED' && isBuyer) {
    buttons.push(<ActionButton key="refund" label="Refund" onClick={refund.run} pending={refund.pending} variant="ghost" />)
  }

  if (label === 'FUNDED' && isSeller) {
    buttons.push(<ActionButton key="start" label="Start Execution" onClick={start.run} pending={start.pending} />)
  }

  if (label === 'EXECUTING' && timedOut) {
    buttons.push(
      <ActionButton
        key="timeout"
        label="Claim Execution Timeout"
        onClick={claimTimeout.run}
        pending={claimTimeout.pending}
        variant="ghost"
      />
    )
  }

  if (label === 'DELIVERED' && isBuyer) {
    buttons.push(
      <ActionButton key="accept" label="Accept & Settle" onClick={accept.run} pending={accept.pending} />,
      <ActionButton
        key="dispute"
        label="Raise Dispute"
        onClick={() => setDisputeFormOpen(true)}
        pending={false}
        variant="danger"
      />
    )
  }

  if (label === 'DELIVERED' && reviewExpired) {
    buttons.push(
      <ActionButton
        key="finalize"
        label="Finalize (release to seller)"
        onClick={finalize.run}
        pending={finalize.pending}
        variant="ghost"
      />
    )
  }

  // Arbiter decisions happen on the Disputes page, next to the AI recommendation
  // and with a written rationale whose hash goes on-chain.
  if (label === 'DISPUTED' && isArbiter) {
    buttons.push(
      <Link
        key="arbiter"
        href="/app/disputes"
        className="flex items-center justify-center rounded-xl bg-[#5B5FEF] py-2.5 text-[13.5px] font-medium text-white transition hover:brightness-110"
      >
        Review in Disputes →
      </Link>
    )
  }

  const errors = [
    fundingError,
    start.error?.message,
    accept.error?.message,
    disputeError,
    refund.error?.message,
    claimTimeout.error?.message,
    finalize.error?.message,
    markDeliveredAction.error?.message,
  ].filter(Boolean)

  const showDeliverForm = label === 'EXECUTING' && isSeller && !timedOut

  const showDisputeForm = disputeFormOpen && label === 'DELIVERED' && isBuyer

  if (buttons.length === 0 && !showDeliverForm) return null

  return (
    <div className="space-y-3">
      {showDeliverForm && (
        <div className="space-y-2">
          <input
            type="text"
            value={resultText}
            onChange={(e) => setResultText(e.target.value)}
            placeholder="Result summary (optional), hashed on-chain, full result stays off-chain"
            className="w-full rounded-xl border border-white/[0.08] bg-[#0B0C11] px-3 py-2.5 text-[13px] text-[#F5F5F7] placeholder:text-[#8B8D96] focus:outline-none"
          />
          <ActionButton
            label="Mark Delivered"
            pending={markDeliveredAction.isPending || markDeliveredAction.isConfirming}
            onClick={() =>
              markDeliveredAction.write(escrowId, resultText.trim() ? keccak256(stringToHex(resultText.trim())) : zeroHash)
            }
          />
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
            The arbiter reviews your reason and the delivered result, then releases the escrow to the seller or refunds
            you. Two MetaMask prompts: the dispute transaction, then a free signature to save your reason.
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
