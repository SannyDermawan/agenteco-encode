'use client'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { sameWallet } from '@shared/wallets'
import { useWallet } from '@/lib/wallet/useWallet'
import { NeumorphicCard } from '../NeumorphicCard'
import { FIELD_CLASS } from '../FormField'
import { useReadSession } from '../SessionGate'
import { appealDelisting, getAgentModeration } from '@/lib/api/moderation'

const APPEAL_STATUS = { open: 'With the council', reinstated: 'Reinstated', upheld: 'Upheld (still delisted)' } as const

/**
 * Shown on a delisted agent's page. Everyone sees that the arbiter council
 * delisted it; its owner also sees why, can appeal, and follows the appeal.
 */
export function DelistedPanel({ agentId, ownerWallet, reason }: { agentId: string; ownerWallet: string; reason: string | null }) {
  const { address, signedIn } = useReadSession()
  const { signer } = useWallet()
  const queryClient = useQueryClient()
  const isOwner = !!address && sameWallet(address, ownerWallet)
  const { data } = useQuery({ queryKey: ['agent-moderation', agentId], queryFn: () => getAgentModeration(agentId), enabled: isOwner && signedIn })
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const openAppeal = data?.appeals.find((a) => a.status === 'open')

  async function appeal() {
    if (!address || !signer) return
    setBusy(true)
    setError(null)
    try {
      await appealDelisting(signer, { agentId, reason: text.trim() })
      setText('')
      await queryClient.invalidateQueries({ queryKey: ['agent-moderation', agentId] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The appeal failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <NeumorphicCard className="border-[#EF4444]/30 p-6">
      <h3 className="text-[12px] font-medium tracking-[0.1em] text-[#F87171]">DELISTED</h3>
      <p className="mt-2 text-[13.5px] leading-relaxed text-[#F5F5F7]">
        The arbiter council removed this agent from the marketplace after a report. It takes no new work; deals already in escrow
        still finish.
      </p>
      {isOwner && (
        <div className="mt-4 space-y-3 text-[13px]">
          {reason && (
            <p className="rounded-xl border border-white/[0.06] bg-[#0B0C11] p-3 text-[#C9CBD3]">
              <span className="text-[#8B8D96]">Reason: </span>
              {reason}
            </p>
          )}
          {data?.appeals.map((a) => (
            <div key={a.id} className="rounded-xl border border-white/[0.06] bg-[#0B0C11]/60 p-3 text-[12.5px]">
              <div className="font-medium text-[#F5F5F7]">Appeal · {APPEAL_STATUS[a.status]}</div>
              <p className="mt-1 text-[#8B8D96]">{a.reason}</p>
            </div>
          ))}
          {!signedIn ? (
            <p className="text-[12.5px] text-[#8B8D96]">Sign in with your wallet to see the decision and appeal it.</p>
          ) : openAppeal ? null : (
            <>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="Why should the council reinstate it? What did you fix?"
                className={`${FIELD_CLASS} resize-none`}
              />
              <button
                type="button"
                disabled={busy || text.trim().length < 10}
                onClick={appeal}
                className="rounded-xl bg-[#5B5FEF] px-4 py-2 text-[12.5px] font-medium text-white transition hover:brightness-110 disabled:opacity-50"
              >
                {busy ? 'Sign in your wallet…' : 'Appeal to the council'}
              </button>
            </>
          )}
          {error && <p className="text-[12px] text-[#EF4444]">{error}</p>}
        </div>
      )}
    </NeumorphicCard>
  )
}
