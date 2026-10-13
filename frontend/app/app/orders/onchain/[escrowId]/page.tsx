'use client'
import { use, useEffect } from 'react'
import { formatUnits } from 'viem'
import { NeumorphicCard } from '@/components/app/NeumorphicCard'
import { OnChainStatusBadge } from '@/components/app/OnChainStatusBadge'
import { OnChainTimeline } from '@/components/app/OnChainTimeline'
import { EscrowActionPanel } from '@/components/app/EscrowActionPanel'
import { EscrowReviewCards } from '@/components/app/EscrowReviewCards'
import { DeadlineCountdown } from '@/components/app/DeadlineCountdown'
import { PageFade } from '@/components/app/PageFade'
import { SessionGate } from '@/components/app/SessionGate'
import { EscrowAccessGate } from '@/components/app/EscrowAccessGate'
import { SolanaEscrowActions } from '@/components/app/solana/SolanaEscrowActions'
import { agentEcoFor } from '@/lib/web3/abi'
import { EscrowFeeBreakdown } from '@/components/app/PlatformFee'
import { CONTRACT_ADDRESS, FAMILY, explorerAddressUrl, TOKEN_SYMBOL } from '@/lib/web3/network'
import { useEscrowBasic, useEscrowFlags, useEscrowTimestamps, useEscrowTxHashes, useReputation, useTokenDecimals } from '@/lib/chain/hooks'

function truncateAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

// Private to the escrow's buyer, seller and the arbiter.
export default function OnChainOrderPage({ params }: { params: Promise<{ escrowId: string }> }) {
  const { escrowId } = use(params)
  return (
    <SessionGate what="this order">
      <EscrowAccessGate escrowId={escrowId}>
        <OnChainOrder escrowIdParam={escrowId} />
      </EscrowAccessGate>
    </SessionGate>
  )
}

function OnChainOrder({ escrowIdParam }: { escrowIdParam: string }) {
  let escrowId: bigint | null
  try {
    escrowId = BigInt(escrowIdParam)
  } catch {
    escrowId = null
  }

  const basic = useEscrowBasic(escrowId ?? undefined)
  const timestamps = useEscrowTimestamps(escrowId ?? undefined)
  const txHashes = useEscrowTxHashes(escrowId ?? undefined)
  const { data: decimals } = useTokenDecimals()
  const flags = useEscrowFlags(escrowId ?? undefined).data
  const seller = basic.data?.[1]
  const reputation = useReputation(seller)

  function refetchAll() {
    basic.refetch()
    timestamps.refetch()
    txHashes.refetch()
    reputation.refetch()
  }

  // Settlement bumps the seller's on-chain reputation, refresh it whenever
  // the (polled) escrow status moves.
  const liveStatus = basic.data?.[3]
  const refetchReputation = reputation.refetch
  useEffect(() => {
    if (liveStatus !== undefined) refetchReputation()
  }, [liveStatus, refetchReputation])

  if (escrowId === null) {
    return (
      <PageFade>
        <NeumorphicCard className="p-6 text-[13.5px] text-[#8B8D96]">Invalid escrow id.</NeumorphicCard>
      </PageFade>
    )
  }

  if (basic.isLoading) {
    return (
      <PageFade>
        <NeumorphicCard className="p-6 text-[13.5px] text-[#8B8D96]">Loading escrow #{escrowId.toString()}…</NeumorphicCard>
      </PageFade>
    )
  }

  if (basic.isError || !basic.data) {
    return (
      <PageFade>
        <NeumorphicCard className="p-6 text-[13.5px] text-[#8B8D96]">
          Escrow #{escrowId.toString()} was not found on-chain.
        </NeumorphicCard>
      </PageFade>
    )
  }

  const [buyer, sellerAddr, amount, status] = basic.data
  const amountFormatted = decimals !== undefined ? formatUnits(amount, decimals) : '…'
  const rep = reputation.data

  return (
    <PageFade>
      <div className="space-y-6">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-[#F5F5F7]">
              On-Chain Order #{escrowId.toString()}
            </h2>
            <OnChainStatusBadge status={status} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[13.5px] text-[#8B8D96]">
            <span>{amountFormatted} {TOKEN_SYMBOL}</span>
            <a
              href={explorerAddressUrl(FAMILY === 'solana' ? CONTRACT_ADDRESS : agentEcoFor(escrowId))}
              target="_blank"
              rel="noreferrer"
              className="text-[#5B5FEF] hover:underline"
            >
              View {FAMILY === 'solana' ? 'program' : 'contract'} on explorer ↗
            </a>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <NeumorphicCard className="p-6">
              <h3 className="mb-4 text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">TRANSACTION TIMELINE</h3>
              {timestamps.data ? (
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
                <p className="text-[13px] text-[#8B8D96]">Loading…</p>
              )}
            </NeumorphicCard>

            <DeadlineCountdown escrowId={escrowId} status={status} />

            <NeumorphicCard className="p-6">
              <h3 className="mb-3 text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">ACTIONS</h3>
              {FAMILY === 'solana' ? (
                flags ? (
                  <SolanaEscrowActions escrowId={escrowId} buyer={buyer} seller={sellerAddr} status={status} flags={flags} onChanged={refetchAll} />
                ) : (
                  <p className="text-[13px] text-[#8B8D96]">Loading…</p>
                )
              ) : (
                <EscrowActionPanel
                  escrowId={escrowId}
                  buyer={buyer as `0x${string}`}
                  seller={sellerAddr as `0x${string}`}
                  amount={amount}
                  status={status}
                  onChanged={refetchAll}
                />
              )}
            </NeumorphicCard>

            <EscrowReviewCards escrowId={escrowId} status={status} buyer={buyer} deliveredAt={timestamps.data?.[3]} />
          </div>

          <div className="space-y-4">
            <NeumorphicCard className="p-6">
              <h3 className="mb-3 text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">PARTICIPANTS</h3>
              <div className="space-y-3 text-[13.5px]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[#8B8D96]">Buyer</span>
                  <span className="truncate font-mono text-[12px] font-medium text-[#4F7CFF]" title={buyer}>
                    {truncateAddress(buyer)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[#8B8D96]">Seller</span>
                  <span className="truncate font-mono text-[12px] font-medium text-[#8B5CF6]" title={sellerAddr}>
                    {truncateAddress(sellerAddr)}
                  </span>
                </div>
              </div>
            </NeumorphicCard>

            <NeumorphicCard className="p-6">
              <div className="flex items-center justify-between text-[11px] font-medium tracking-[0.14em] text-[#8B8D96]">
                <span>ESCROW</span>
                <i className="h-1.5 w-1.5 rounded-full bg-[#5B5FEF]" />
              </div>
              <div className="mt-2 text-[24px] font-semibold tracking-[-0.02em] text-[#F5F5F7]">
                {amountFormatted} <span className="text-[13px] font-medium text-[#8B8D96]">{TOKEN_SYMBOL}</span>
              </div>
              <EscrowFeeBreakdown escrowId={escrowId} amount={amount} decimals={decimals} />
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
                    <div className="text-[18px] font-semibold text-[#F5F5F7]">{rep.successPct === null ? '-' : `${rep.successPct.toFixed(1)}%`}</div>
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
          </div>
        </div>
      </div>
    </PageFade>
  )
}
