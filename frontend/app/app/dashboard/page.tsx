'use client'
import { StatCard } from '@/components/app/StatCard'
import { OrderTable } from '@/components/app/OrderTable'
import { NeumorphicCard } from '@/components/app/NeumorphicCard'
import { ActivityTimeline } from '@/components/app/ActivityTimeline'
import { PageFade } from '@/components/app/PageFade'
import { GetTestTokensCard } from '@/components/app/GetTestTokensCard'
import { useOverview } from '@/lib/useOverview'
import { SessionGate } from '@/components/app/SessionGate'
import { useReputation } from '@/lib/web3/hooks'
import { TOKEN_SYMBOL } from '@/lib/web3/network'

export default function DashboardPage() {
  const { signedIn, agents, orderRows, loading, error, settledCount, activeOrders, totalVolumeSettled, activityEntries } =
    useOverview()

  const sellerAgent = agents.find((a) => a.role === 'seller' && a.walletAddress)
  const reputation = useReputation(sellerAgent?.walletAddress as `0x${string}` | undefined)

  const recentOrders = orderRows.slice(0, 5)

  return (
    <PageFade>
      <div className="space-y-8">
        <div>
          <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-[#F5F5F7]">Dashboard</h2>
          <p className="mt-1 text-[13.5px] text-[#8B8D96]">Monitor your agents, transactions, and economic activity.</p>
        </div>

        <GetTestTokensCard />

        {!signedIn ? (
          <SessionGate what="your dashboard">{null}</SessionGate>
        ) : error ? (
          <NeumorphicCard className="p-6 text-[13.5px] text-[#EF4444]">{error}</NeumorphicCard>
        ) : loading ? (
          <NeumorphicCard className="p-6 text-[13.5px] text-[#8B8D96]">Loading…</NeumorphicCard>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard label="My Agents" value={String(agents.length)} />
              <StatCard label="Active Orders" value={String(activeOrders)} />
              <StatCard label="Completed Jobs" value={String(settledCount)} />
              <StatCard label="Total Volume Settled" value={`${totalVolumeSettled.toFixed(2)} ${TOKEN_SYMBOL}`} accent="#5B5FEF" />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <h3 className="mb-3 text-[15px] font-semibold text-[#F5F5F7]">Recent Orders</h3>
                {recentOrders.length === 0 ? (
                  <NeumorphicCard className="p-6 text-center text-[13px] text-[#8B8D96]">No orders yet.</NeumorphicCard>
                ) : (
                  <OrderTable orders={recentOrders} />
                )}
              </div>

              <div>
                <h3 className="mb-3 text-[15px] font-semibold text-[#F5F5F7]">Agent Performance</h3>
                {!sellerAgent ? (
                  <NeumorphicCard className="p-5 text-[12.5px] text-[#8B8D96]">
                    You don&apos;t own a seller agent with an on-chain wallet yet.
                  </NeumorphicCard>
                ) : (
                  <NeumorphicCard className="grid grid-cols-2 gap-4 p-5">
                    <div>
                      <div className="text-[19px] font-semibold text-[#F5F5F7]">
                        {reputation.data ? (reputation.data.successPct === null ? '-' : `${reputation.data.successPct.toFixed(1)}%`) : '…'}
                      </div>
                      <div className="mt-0.5 text-[11.5px] text-[#8B8D96]">Success Rate</div>
                    </div>
                    <div>
                      <div className="text-[19px] font-semibold text-[#F5F5F7]">
                        {reputation.data ? reputation.data.completedJobs : '…'}
                      </div>
                      <div className="mt-0.5 text-[11.5px] text-[#8B8D96]">Completed Jobs</div>
                    </div>
                    <div className="col-span-2 truncate text-[11px] text-[#54565F]" title={sellerAgent.name}>
                      {sellerAgent.name}
                    </div>
                  </NeumorphicCard>
                )}
              </div>
            </div>

            <div>
              <h3 className="mb-3 text-[15px] font-semibold text-[#F5F5F7]">Recent Activity</h3>
              <NeumorphicCard className="p-5">
                {activityEntries.length === 0 ? (
                  <p className="text-[13px] text-[#8B8D96]">Nothing yet, activity shows up once a negotiation starts.</p>
                ) : (
                  <ActivityTimeline entries={activityEntries.slice(0, 8)} />
                )}
              </NeumorphicCard>
            </div>
          </>
        )}
      </div>
    </PageFade>
  )
}
