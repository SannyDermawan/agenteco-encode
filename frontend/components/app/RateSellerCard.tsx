'use client'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { sameWallet } from '@shared/wallets'
import { useWallet } from '@/lib/wallet/useWallet'
import { NeumorphicCard } from './NeumorphicCard'
import { getEscrowRating, reportRating } from '@/lib/api/judging'
import { useEscrowDisputeInfo, useRateSeller } from '@/lib/chain/hooks'
import { explorerTxUrl } from '@/lib/web3/escrowEvents'

// AgentEco.sol OrderStatus: final states
const SETTLED = 5
const REFUNDED = 6

function Stars({ value, onPick, size = 'text-[22px]' }: { value: number; onPick?: (stars: number) => void; size?: string }) {
  const [hover, setHover] = useState(0)
  const shown = hover || value
  return (
    <div className="flex gap-1" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={!onPick}
          onClick={() => onPick?.(n)}
          onMouseEnter={() => onPick && setHover(n)}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          className={`${size} leading-none transition ${n <= shown ? 'text-[#FBBF24]' : 'text-white/15'} ${onPick ? 'hover:scale-110' : 'cursor-default'}`}
        >
          ★
        </button>
      ))}
    </div>
  )
}

/**
 * Rating after a finished job (spec §10.2): the buyer rates 1–5 stars once
 * the escrow is final and something was delivered; the contract stores
 * stars × 20 and allows it only once. Hosted buyers rate with their AI
 * verification score instead — shown here too.
 */
export function RateSellerCard({
  escrowId,
  status,
  buyer,
  deliveredAt,
}: {
  escrowId: bigint
  status: number
  buyer: string
  deliveredAt: bigint
}) {
  const { address } = useWallet()
  const queryClient = useQueryClient()
  const final = status === SETTLED || status === REFUNDED
  const eligible = final && deliveredAt > BigInt(0)
  const info = useEscrowDisputeInfo(eligible ? escrowId : undefined, false)
  const rated = info.data?.[3] ?? false
  const { data: rating } = useQuery({
    queryKey: ['escrowRating', escrowId.toString()],
    queryFn: () => getEscrowRating(escrowId.toString()),
    enabled: eligible,
    refetchInterval: (query) => (query.state.data ? false : 10_000),
  })

  const [stars, setStars] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const rate = useRateSeller()

  // Once mined: tell the API (it reads the score from the receipt), refresh.
  useEffect(() => {
    if (!rate.isSuccess || !rate.hash) return
    reportRating(rate.hash)
      .catch(() => {}) // the backend's SellerRated scan catches it anyway
      .finally(() => {
        info.refetch()
        queryClient.invalidateQueries({ queryKey: ['escrowRating', escrowId.toString()] })
        queryClient.invalidateQueries({ queryKey: ['ratingSummaries'] })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rate.isSuccess, rate.hash])

  if (!eligible) return null
  const isBuyer = !!address && sameWallet(address, buyer)
  if (!rated && !isBuyer && !rating) return null

  const busy = rate.isPending || rate.isConfirming
  return (
    <NeumorphicCard className="p-6">
      <h3 className="mb-3 text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">SELLER RATING</h3>
      {rating ? (
        <div className="space-y-1.5">
          <Stars value={Math.round(rating.score / 20)} />
          <div className="text-[12.5px] text-[#8B8D96]">
            {rating.score}/100 · {rating.source === 'ai' ? 'AI-rated from the verification score' : 'Rated by the buyer'}
            {rating.sameOwner && ' · same owner, not counted in the public average'}
          </div>
          {rating.txHash && (
            <a href={explorerTxUrl(rating.txHash)} target="_blank" rel="noreferrer" className="text-[11.5px] text-[#8FA9FF] hover:underline">
              rateSeller transaction ↗
            </a>
          )}
        </div>
      ) : rated ? (
        <p className="text-[13px] text-[#8B8D96]">Rated on-chain — loading the score…</p>
      ) : (
        <div className="space-y-3">
          <p className="text-[13px] text-[#8B8D96]">How did this seller do? One rating per job, stored on-chain.</p>
          <Stars value={stars} onPick={busy ? undefined : setStars} size="text-[28px]" />
          <button
            type="button"
            disabled={stars === 0 || busy}
            onClick={() => {
              setError(null)
              rate.write(escrowId, stars * 20)
            }}
            className="w-full rounded-xl bg-[#5B5FEF] py-2.5 text-[13px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Submitting rating…' : stars ? `Rate ${stars} star${stars > 1 ? 's' : ''}` : 'Pick 1–5 stars'}
          </button>
          {(error || rate.error) && (
            <p className="text-[12px] text-[#EF4444]">{error ?? rate.error?.message.split('\n')[0]}</p>
          )}
        </div>
      )}
    </NeumorphicCard>
  )
}
