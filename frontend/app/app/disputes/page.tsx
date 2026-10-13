'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { formatUnits } from 'viem'
import { useAccount } from 'wagmi'
import { NeumorphicCard } from '@/components/app/NeumorphicCard'
import { PageFade } from '@/components/app/PageFade'
import { SessionGate, useReadSession } from '@/components/app/SessionGate'
import { ArrowRightIcon } from '@/components/app/icons'
import { listDisputeReasons, type ApiDispute } from '@/lib/api/disputes'
import { ArbiterDecision } from '@/components/app/ArbiterDecision'
import { Remaining, useNow } from '@/components/app/DeadlineCountdown'
import { explorerTxUrl, useDisputes, type DisputeSummary } from '@/lib/web3/escrowEvents'
import { useArbiter, useArbiterCouncil, useIsArbiter, useUsdtDecimals } from '@/lib/web3/hooks'
import { TOKEN_SYMBOL } from '@/lib/web3/network'
import { getModerationQueue } from '@/lib/api/moderation'
import { ModerationQueue } from '@/components/app/moderation/ModerationQueue'
import { FAMILY } from '@/lib/web3/network'
import { UnsupportedOnSolana } from '@/components/app/solana/UnsupportedOnSolana'

const DISPUTED = 4 // AgentEco.sol OrderStatus

function truncateAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function waitingFor(since: number, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function DisputeRow({ d, record, decimals }: { d: DisputeSummary; record?: ApiDispute; decimals?: number }) {
  const open = d.status === DISPUTED
  const now = useNow()
  const overrideDeadline = record?.overrideDeadline ? Math.floor(new Date(record.overrideDeadline).getTime() / 1000) : null
  const amount = decimals !== undefined ? formatUnits(d.amount, decimals) : '…'
  return (
    <NeumorphicCard className="p-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[15px] font-semibold text-[#F5F5F7]">Escrow #{d.escrowId.toString()}</span>
        <span className="text-[13px] text-[#8B8D96]">{amount} {TOKEN_SYMBOL}</span>
        {open ? (
          <span className="rounded-full border border-[#EF4444]/35 bg-[#EF4444]/10 px-2 py-0.5 text-[11px] font-medium text-[#F87171]">
            Waiting {waitingFor(d.raisedAt)}
          </span>
        ) : (
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-[#8B8D96]">
            {d.resolution
              ? d.resolution.byTimeout
                ? 'Refunded, arbiter deadline passed'
                : d.resolution.releasedToSeller
                  ? 'Released to seller'
                  : 'Refunded to buyer'
              : 'Closed'}
          </span>
        )}
        <Link
          href={`/app/orders/onchain/${d.escrowId}`}
          className={`ml-auto flex items-center gap-1 rounded-xl px-3.5 py-2 text-[13px] font-medium transition ${
            open ? 'bg-[#5B5FEF] text-white hover:brightness-110' : 'border border-white/[0.08] text-[#F5F5F7] hover:border-white/20'
          }`}
        >
          {open ? 'Order details' : 'View'}
          <ArrowRightIcon className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-3">
        <div className="text-[#8B8D96]">
          Buyer <span className="font-mono text-[#4F7CFF]">{truncateAddress(d.buyer)}</span>
        </div>
        <div className="text-[#8B8D96]">
          Seller <span className="font-mono text-[#8B5CF6]">{truncateAddress(d.seller)}</span>
        </div>
        <div className="text-[#8B8D96]">
          Raised {new Date(d.raisedAt).toLocaleString()}{' '}
          {d.raisedTx && (
            <a href={explorerTxUrl(d.raisedTx)} target="_blank" rel="noreferrer" className="text-[#5B5FEF] hover:underline">
              ↗
            </a>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] font-medium tracking-[0.08em] text-[#8B8D96]">BUYER&apos;S REASON</div>
          <p className="whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-[#0B0C11] p-3 text-[13px] leading-relaxed text-[#F5F5F7]">
            {record?.reason || <span className="text-[#8B8D96]">No reason text, only its hash is on-chain.</span>}
          </p>
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium tracking-[0.08em] text-[#8B8D96]">
            SELLER&apos;S RESPONSE{record?.responseSource === 'ai' ? ' · AI' : ''}
          </div>
          <p className="whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-[#0B0C11] p-3 text-[13px] leading-relaxed text-[#F5F5F7]">
            {record?.sellerResponse || <span className="text-[#8B8D96]">No response.</span>}
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-[#5B5FEF]/25 bg-[#5B5FEF]/[0.05] p-3">
        <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[11px] font-medium tracking-[0.08em] text-[#8FA9FF]">
          AI RECOMMENDATION
          {record?.recModel && <span className="font-normal normal-case tracking-normal text-[#54565F]">{record.recProvider}/{record.recModel}</span>}
        </div>
        {record?.recVerdict ? (
          <>
            <div className="text-[13px] text-[#F5F5F7]">
              {record.recVerdict === 'seller' ? 'Release to seller' : 'Refund buyer'} ·{' '}
              <span className="text-[#8B8D96]">{record.recConfidence}% confident</span>
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-[#8B8D96]">{record.recRationale}</p>
          </>
        ) : record?.recUnavailable ? (
          <p className="text-[12.5px] text-[#8B8D96]">AI recommendation unavailable, decide manually.</p>
        ) : (
          <p className="text-[12.5px] text-[#8B8D96]">Pending, runs after the seller responds or its window closes.</p>
        )}
      </div>

      {open ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-[#8B8D96]">
            {overrideDeadline && record?.recVerdict && (
              <span>
                Your override window: <Remaining deadline={overrideDeadline} now={now} />
                {', then the AI ruling executes if it is confident enough'}
              </span>
            )}
            <span>
              Dispute deadline: <Remaining deadline={Math.floor(d.deadline / 1000)} now={now} />, then the buyer is refunded
            </span>
          </div>
          <ArbiterDecision escrowId={d.escrowId} dispute={record} />
        </div>
      ) : (
        record?.resolution && (
          <div className="mt-3 text-[12px] text-[#8B8D96]">
            Decided by{' '}
            {record.resolution === 'ai-auto' ? 'the AI arbiter (automatic)' : record.resolution === 'arbiter-manual' ? 'the arbiter' : 'timeout'}
            {record.resolutionTx && (
              <>
                {' '}
                ·{' '}
                <a href={explorerTxUrl(record.resolutionTx)} target="_blank" rel="noreferrer" className="text-[#5B5FEF] hover:underline">
                  tx ↗
                </a>
              </>
            )}
          </div>
        )
      )}
    </NeumorphicCard>
  )
}

/** The arbiter's inbox: every dispute on the contract, open ones (longest waiting) first. */
function DisputesPageEvm() {
  const { address, isConnected } = useAccount()
  const { signedIn } = useReadSession()
  const { data: arbiter } = useArbiter()
  const council = useArbiterCouncil()
  const isArbiter = useIsArbiter(address)
  const { data: disputes, isPending } = useDisputes(isArbiter)
  const { data: decimals } = useUsdtDecimals()
  // The dispute texts are private: the API lists them only to the signed-in arbiter.
  const { data: reasons } = useQuery({
    queryKey: ['disputeReasons', address],
    queryFn: listDisputeReasons,
    enabled: isArbiter && signedIn,
    refetchInterval: 5_000,
  })
  const recordByEscrow = new Map((reasons ?? []).map((r) => [r.escrowId, r]))
  // Listing reports and appeals, decided by the same council.
  const [tab, setTab] = useState<'disputes' | 'moderation'>('disputes')
  const { data: queue, error: queueError } = useQuery({
    queryKey: ['moderation', address],
    queryFn: getModerationQueue,
    enabled: isArbiter && signedIn,
    refetchInterval: 10_000,
  })
  const openCases = (queue?.reports.filter((r) => r.status === 'open').length ?? 0) + (queue?.appeals.filter((a) => a.status === 'open').length ?? 0)

  const open = disputes?.filter((d) => d.status === DISPUTED) ?? []
  const closed = disputes?.filter((d) => d.status !== DISPUTED) ?? []

  return (
    <PageFade>
      <div className="space-y-6">
        <div>
          <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-[#F5F5F7]">Disputes</h2>
          <p className="mt-1 text-[13.5px] text-[#8B8D96]">
            {tab === 'disputes'
              ? 'Escrows a buyer has disputed. The AI arbiter recommends a ruling once the seller has answered; approve it, reverse it with your own reasons, or let a confident recommendation execute when your override window ends.'
              : 'Listings reported by users, and appeals from owners of delisted agents. The council decides both.'}
          </p>
        </div>

        {!isConnected ? (
          <NeumorphicCard className="p-6 text-[13.5px] text-[#8B8D96]">
            Connect an arbiter wallet (a member of the arbiter council) from the top bar to review disputes.
          </NeumorphicCard>
        ) : !isArbiter ? (
          <NeumorphicCard className="p-6 text-[13.5px] leading-relaxed text-[#8B8D96]">
            {council ? 'Only members of the AgentEco arbiter council can resolve disputes' : 'Only the AgentEco arbiter can resolve disputes'}
            {arbiter && (
              <>
                {' '}
               , {council ? 'council' : 'currently'} <span className="font-mono text-[#F5F5F7]">{truncateAddress(arbiter)}</span>
                {council && <>, {council.members.length} members</>}
              </>
            )}
            .
          </NeumorphicCard>
        ) : !signedIn ? (
          <SessionGate what="the disputes">{null}</SessionGate>
        ) : (
          <>
            <div className="flex gap-2" role="tablist">
              {(
                [
                  ['disputes', `Escrow disputes · ${open.length}`],
                  ['moderation', `Reports & appeals · ${openCases}`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  onClick={() => setTab(key)}
                  className={`rounded-full border px-3.5 py-1.5 text-[12.5px] transition ${
                    tab === key ? 'border-[#5B5FEF]/50 bg-[#5B5FEF]/10 text-[#F5F5F7]' : 'border-white/[0.08] text-[#8B8D96] hover:text-[#F5F5F7]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab === 'moderation' ? (
              queueError ? (
                <NeumorphicCard className="p-6 text-[13.5px] text-[#EF4444]">{(queueError as Error).message}</NeumorphicCard>
              ) : !queue ? (
                <NeumorphicCard className="p-6 text-[13.5px] text-[#8B8D96]">Loading the moderation queue…</NeumorphicCard>
              ) : (
                <ModerationQueue queue={queue} me={address!.toLowerCase()} />
              )
            ) : isPending ? (
              <NeumorphicCard className="p-6 text-[13.5px] text-[#8B8D96]">Reading disputes from the chain…</NeumorphicCard>
            ) : (
              <>
                <section className="space-y-3">
                  <h3 className="text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">OPEN · {open.length}</h3>
                  {open.length === 0 ? (
                    <NeumorphicCard className="p-6 text-center text-[13.5px] text-[#8B8D96]">
                      No open disputes, nothing is waiting on you.
                    </NeumorphicCard>
                  ) : (
                    open.map((d) => (
                      <DisputeRow key={d.escrowId.toString()} d={d} record={recordByEscrow.get(d.escrowId.toString())} decimals={decimals} />
                    ))
                  )}
                </section>

                {closed.length > 0 && (
                  <section className="space-y-3">
                    <h3 className="text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">RESOLVED · {closed.length}</h3>
                    {closed.map((d) => (
                      <DisputeRow key={d.escrowId.toString()} d={d} record={recordByEscrow.get(d.escrowId.toString())} decimals={decimals} />
                    ))}
                  </section>
                )}
              </>
            )}
          </>
        )}
      </div>
    </PageFade>
  )
}

export default function DisputesPage() {
  return FAMILY === 'solana' ? <UnsupportedOnSolana title="Disputes console" why="On Solana the arbiter is the escrow program's arbiter signer: on devnet that is the AI arbiter's key, which rules a confident recommendation by itself after the override window. The council console exists for EVM networks only. A dispute is raised, answered and shown on its order page." instead={{ href: '/app/orders', label: 'See your orders' }} /> : <DisputesPageEvm />
}
