'use client'
import { useQuery } from '@tanstack/react-query'
import { NeumorphicCard } from './NeumorphicCard'
import { getVerification } from '@/lib/api/judging'

const DELIVERED = 3
const SETTLED = 5 // SETTLED and REFUNDED are final

/**
 * A hosted buyer's AI verification of the delivered result (spec §10.1):
 * score, the code's decision and the model's reasons. Human buyers judge
 * for themselves, so there is none for direct hires.
 */
export function VerificationCard({ escrowId, status }: { escrowId: bigint; status: number }) {
  const { data: v } = useQuery({
    queryKey: ['verification', escrowId.toString()],
    queryFn: () => getVerification(escrowId.toString()),
    enabled: status >= DELIVERED,
    // It appears a few seconds after delivery; stop once it's there or the escrow moved on.
    refetchInterval: (query) => (query.state.data || status >= SETTLED ? false : 5000),
  })
  if (!v) return null

  const accepted = v.verdict === 'accept'
  const unscored = v.score === null
  return (
    <NeumorphicCard className="p-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">AI VERIFICATION</h3>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${
            accepted ? 'border-[#22C55E]/35 bg-[#22C55E]/10 text-[#22C55E]' : 'border-[#EF4444]/35 bg-[#EF4444]/10 text-[#F87171]'
          }`}
        >
          {accepted ? 'Accepted: settle' : 'Disputed'}
        </span>
      </div>
      {!unscored && (
        <div className="mb-3">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[26px] font-semibold text-[#F5F5F7]">{v.score}</span>
            <span className="text-[13px] text-[#8B8D96]">/ 100</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className={`h-full rounded-full ${accepted ? 'bg-[#22C55E]' : 'bg-[#EF4444]'}`}
              style={{ width: `${Math.max(2, v.score ?? 0)}%` }}
            />
          </div>
        </div>
      )}
      <p className="text-[13px] leading-relaxed text-[#F5F5F7]">{v.rationale}</p>
      <div className="mt-2 text-[11px] text-[#54565F]">
        {v.provider === 'none'
          ? 'No AI model answered, accepted without a score, and the seller is not rated.'
          : v.provider === 'rule'
            ? 'Decided by rule: the result was never published.'
            : `Verified by ${v.provider}/${v.model} · the score, not the model, decides: at or above the threshold the buyer settles.`}
      </div>
    </NeumorphicCard>
  )
}
