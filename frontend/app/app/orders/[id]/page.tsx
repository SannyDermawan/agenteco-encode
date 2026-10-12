'use client'
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { formatUnits } from 'viem'
import { NeumorphicCard } from '@/components/app/NeumorphicCard'
import { OrderStatusBadge } from '@/components/app/OrderStatus'
import { OnChainStatusBadge } from '@/components/app/OnChainStatusBadge'
import { OrderTimeline } from '@/components/app/OrderTimeline'
import { OnChainTimeline } from '@/components/app/OnChainTimeline'
import { EscrowActionPanel } from '@/components/app/EscrowActionPanel'
import { EscrowReviewCards } from '@/components/app/EscrowReviewCards'
import { DeadlineCountdown } from '@/components/app/DeadlineCountdown'
import { NegotiationDealCard, NegotiationTimeline } from '@/components/app/NegotiationTimeline'
import { FundOrderCard } from '@/components/app/FundOrderCard'
import { PageFade } from '@/components/app/PageFade'
import { agentEcoFor } from '@/lib/web3/abi'
import { EscrowFeeBreakdown } from '@/components/app/PlatformFee'
import { explorerAddressUrl, TOKEN_SYMBOL } from '@/lib/web3/network'
import { getOrder, toNegotiationEntries, toOrderRow } from '@/lib/api/orders'
import { PrivateOrderError } from '@/lib/api/session'
import { PrivateOrderNotice, SessionGate } from '@/components/app/SessionGate'
import { useAccount } from 'wagmi'
import { useEscrowBasic, useEscrowTimestamps, useReputation, useUsdtDecimals } from '@/lib/web3/hooks'
import { useEscrowTxHashes } from '@/lib/web3/escrowEvents'
import { FAMILY } from '@/lib/web3/network'
import { UnsupportedOnSolana } from '@/components/app/solana/UnsupportedOnSolana'

/**
 * The escrow's on-chain state (once escrowId is set) is the live, real
 * status — the DB `status` column only ever tracks "agreed" vs "funded"
 * (see schema comment on the Order model). This reads the chain directly
 * and surfaces the full escrow experience (timeline, actions, result)
 * inline instead of linking out to the separate /orders/onchain page.
 */
function LiveEscrowMain({ escrowId }: { escrowId: bigint }) {
  const basic = useEscrowBasic(escrowId)
  const timestamps = useEscrowTimestamps(escrowId)
  const txHashes = useEscrowTxHashes(escrowId)
  const status = basic.data?.[3]
  // Shares its query cache key (seller address) with LiveEscrowSidebar's own
  // useReputation call below, so refetching here also refreshes the sidebar.
  const reputation = useReputation(basic.data?.[1])

  function refetchAll() {
    basic.refetch()
    timestamps.refetch()
    txHashes.refetch()
    reputation.refetch()
  }

  // Settlement bumps the seller's on-chain reputation — refresh it whenever
  // the (polled) escrow status moves.
  const refetchReputation = reputation.refetch
  useEffect(() => {
    if (status !== undefined) refetchReputation()
  }, [status, refetchReputation])

  return (
    <>
      <NeumorphicCard className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">TRANSACTION TIMELINE</h3>
          {status !== undefined && <OnChainStatusBadge status={status} />}
        </div>
        {timestamps.data && status !== undefined ? (
          <OnChainTimeline
            status={status}
            timestamps={{
              createdAt: timestamps.data[0],
              fundedAt: timestamps.data[1],
              executingAt: timestamps.data[2],
              deliveredAt: timestamps.data[3],
              settledAt: timestamps.data[4],
            }}
            txHashes={txHashes.data}
          />
        ) : (
          <p className="text-[13px] text-[#8B8D96]">Loading live status…</p>
        )}
      </NeumorphicCard>

      {status !== undefined && <DeadlineCountdown escrowId={escrowId} status={status} />}

      {basic.data && status !== undefined && (
        <NeumorphicCard className="p-6">
          <h3 className="mb-3 text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">ACTIONS</h3>
          <EscrowActionPanel
            escrowId={escrowId}
            buyer={basic.data[0]}
            seller={basic.data[1]}
            amount={basic.data[2]}
            status={status}
            onChanged={refetchAll}
          />
        </NeumorphicCard>
      )}

      {basic.data && status !== undefined && (
        <EscrowReviewCards escrowId={escrowId} status={status} buyer={basic.data[0]} deliveredAt={timestamps.data?.[3]} />
      )}
    </>
  )
}

/** Escrow amount + live seller reputation — the sidebar half of the live escrow view. */
function LiveEscrowSidebar({ escrowId }: { escrowId: bigint }) {
  const basic = useEscrowBasic(escrowId)
  const { data: decimals } = useUsdtDecimals()
  const seller = basic.data?.[1]
  const reputation = useReputation(seller)
  const rep = reputation.data
  const amountFormatted = basic.data && decimals !== undefined ? formatUnits(basic.data[2], decimals) : '…'

  return (
    <>
      <NeumorphicCard className="p-6">
        <div className="flex items-center justify-between text-[11px] font-medium tracking-[0.14em] text-[#8B8D96]">
          <span>ESCROW</span>
          <i className="h-1.5 w-1.5 rounded-full bg-[#22A06B]" />
        </div>
        <div className="mt-2 text-[24px] font-semibold tracking-[-0.02em] text-[#F5F5F7]">
          {amountFormatted} <span className="text-[13px] font-medium text-[#8B8D96]">{TOKEN_SYMBOL}</span>
        </div>
        {basic.data && <EscrowFeeBreakdown escrowId={escrowId} amount={basic.data[2]} decimals={decimals} />}
        <a
          href={explorerAddressUrl(agentEcoFor(escrowId))}
          target="_blank"
          rel="noreferrer"
          className="mt-3 flex items-center justify-center gap-1.5 rounded-xl border border-white/[0.08] bg-[#11141B] py-2.5 text-[13px] font-medium text-[#F5F5F7] transition hover:border-[#5B5FEF]/40 hover:bg-[#5B5FEF]/10"
        >
          View contract on explorer ↗
        </a>
      </NeumorphicCard>

      {rep && (
        <NeumorphicCard className="p-6">
          <h3 className="mb-3 text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">SELLER REPUTATION</h3>
          <div className="grid grid-cols-2 gap-4 text-[13px]">
            <div>
              <div className="text-[18px] font-semibold text-[#F5F5F7]">{rep.completedJobs}</div>
              <div className="mt-0.5 text-[11px] text-[#8B8D96]">Completed</div>
            </div>
            <div>
              <div className="text-[18px] font-semibold text-[#F5F5F7]">{rep.failedJobs}</div>
              <div className="mt-0.5 text-[11px] text-[#8B8D96]">Failed</div>
            </div>
            <div>
              <div className="text-[18px] font-semibold text-[#F5F5F7]">{rep.successPct === null ? '—' : `${rep.successPct.toFixed(1)}%`}</div>
              <div className="mt-0.5 text-[11px] text-[#8B8D96]">Success Rate</div>
            </div>
            <div>
              <div className="text-[18px] font-semibold text-[#F5F5F7]">
                {decimals !== undefined ? formatUnits(rep.volume, decimals) : '…'}
              </div>
              <div className="mt-0.5 text-[11px] text-[#8B8D96]">Volume ({TOKEN_SYMBOL})</div>
            </div>
          </div>
        </NeumorphicCard>
      )}
    </>
  )
}

const ORDER_POLL_MS = 4000

// Private to the order's buyer, seller and the arbiter.
function OrderDetailPageEvm() {
  return (
    <SessionGate what="this order">
      <OrderDetail />
    </SessionGate>
  )
}

function OrderDetail() {
  const params = useParams<{ id: string }>()
  const { address } = useAccount()

  // A hosted buyer funds the deal on its own, so poll until the order has an
  // escrow — from then on LiveEscrowMain polls the chain for the rest.
  const orderQuery = useQuery({
    queryKey: ['order', params.id, address],
    queryFn: () => getOrder(params.id),
    refetchInterval: (query) => (query.state.data?.escrowId || query.state.error ? false : ORDER_POLL_MS),
    retry: (count, err) => !(err instanceof PrivateOrderError) && count < 3,
  })
  const apiOrder = orderQuery.data ?? null
  const error = orderQuery.error ? orderQuery.error.message || 'Could not load this order.' : null

  if (orderQuery.error instanceof PrivateOrderError) {
    return (
      <PageFade>
        <PrivateOrderNotice />
      </PageFade>
    )
  }

  if (orderQuery.isPending) {
    return (
      <PageFade>
        <NeumorphicCard className="p-6 text-[13.5px] text-[#8B8D96]">Loading order…</NeumorphicCard>
      </PageFade>
    )
  }

  if (error || !apiOrder) {
    return (
      <PageFade>
        <NeumorphicCard className="p-6 text-[13.5px] text-[#8B8D96]">{error ?? 'Order not found.'}</NeumorphicCard>
      </PageFade>
    )
  }

  const row = toOrderRow(apiOrder)
  const entries = toNegotiationEntries(apiOrder)
  const escrowId = apiOrder.escrowId ? BigInt(apiOrder.escrowId) : null

  return (
    <PageFade>
      <div className="space-y-6">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-[#F5F5F7]">Order {apiOrder.id.slice(0, 8)}</h2>
            {!escrowId && <OrderStatusBadge status={row.status} />}
          </div>
          <div className="mt-1 text-[13.5px] text-[#8B8D96]">
            {row.service} · {row.amount.toFixed(2)} {TOKEN_SYMBOL}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            {escrowId ? (
              <LiveEscrowMain escrowId={escrowId} />
            ) : (
              <NeumorphicCard className="p-6">
                <h3 className="mb-4 text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">TRANSACTION TIMELINE</h3>
                <OrderTimeline status={row.status} />
              </NeumorphicCard>
            )}

            <NeumorphicCard className="p-6">
              <h3 className="mb-4 text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">NEGOTIATION</h3>
              <NegotiationTimeline entries={entries} />
              {apiOrder.negotiation.status === 'accepted' && (
                <NegotiationDealCard price={Number(apiOrder.negotiation.agreedPrice ?? apiOrder.price)} escrowId={escrowId} />
              )}
            </NeumorphicCard>
          </div>

          <div className="space-y-4">
            <NeumorphicCard className="p-6">
              <h3 className="mb-3 text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">PARTICIPANTS</h3>
              <div className="space-y-3 text-[13.5px]">
                <div className="flex items-center justify-between">
                  <span className="text-[#8B8D96]">Buyer</span>
                  <span className="font-medium text-[#4F7CFF]">{row.buyer}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#8B8D96]">Seller</span>
                  <span className="font-medium text-[#8B5CF6]">{row.seller}</span>
                </div>
              </div>
            </NeumorphicCard>

            {escrowId ? <LiveEscrowSidebar escrowId={escrowId} /> : <FundOrderCard order={apiOrder} />}
          </div>
        </div>
      </div>
    </PageFade>
  )
}

export default function OrderDetailPage() {
  return FAMILY === 'solana' ? <UnsupportedOnSolana title="Negotiated order" why="Orders come from negotiations between hosted agents, which run on the EVM networks only. A direct hire on Solana opens its on-chain order page right after you fund it." instead={{ href: '/app/orders', label: 'See your orders' }} /> : <OrderDetailPageEvm />
}
