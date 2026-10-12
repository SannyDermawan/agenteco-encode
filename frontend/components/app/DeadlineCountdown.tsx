'use client'
import { useEffect, useState } from 'react'
import { NeumorphicCard } from './NeumorphicCard'
import { formatDuration } from '@/lib/web3/constants'
import { useEscrowDisputeInfo, useEscrowWindows } from '@/lib/chain/hooks'

// AgentEco.sol OrderStatus
const FUNDED = 1
const EXECUTING = 2
const DELIVERED = 3
const DISPUTED = 4

/** Seconds since epoch, ticking once a second. */
export function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

/** "4m 12s left" or "passed" — the one line every deadline uses. */
export function Remaining({ deadline, now }: { deadline: number; now: number }) {
  const left = deadline - now
  return left > 0 ? (
    <span className={left < 60 ? 'text-[#F59E0B]' : 'text-[#F5F5F7]'}>{formatDuration(left)} left</span>
  ) : (
    <span className="text-[#8B8D96]">passed</span>
  )
}

/**
 * The deadline the escrow is currently running against (spec §12.2), live.
 * What happens when it passes is spelled out, since the keeper acts on it.
 */
export function DeadlineCountdown({ escrowId, status }: { escrowId: bigint; status: number }) {
  const now = useNow()
  const windows = useEscrowWindows(escrowId)
  const dispute = useEscrowDisputeInfo(escrowId, status <= DISPUTED)

  let line: { label: string; deadline: number; then: string } | null = null
  if (status === FUNDED && dispute.data) {
    line = { label: 'Seller must start by', deadline: Number(dispute.data[2]), then: 'the buyer is refunded (accept timeout).' }
  } else if (status === EXECUTING && windows.data) {
    line = { label: 'Seller must deliver by', deadline: Number(windows.data[2]), then: 'the buyer is refunded (execution timeout).' }
  } else if (status === DELIVERED && windows.data) {
    line = { label: 'Buyer must accept or dispute by', deadline: Number(windows.data[3]), then: 'the seller is paid automatically.' }
  } else if (status === DISPUTED && dispute.data) {
    line = { label: 'Arbiter must rule by', deadline: Number(dispute.data[1]), then: 'the buyer is refunded (dispute timeout).' }
  }
  if (!line || line.deadline === 0) return null

  return (
    <NeumorphicCard className="flex flex-wrap items-center justify-between gap-2 px-6 py-4 text-[13px]">
      <span className="text-[#8B8D96]">{line.label}</span>
      <span className="font-medium tabular-nums">
        <Remaining deadline={line.deadline} now={now} />
      </span>
      <span className="w-full text-[11.5px] text-[#54565F]">If it passes, {line.then}</span>
    </NeumorphicCard>
  )
}
