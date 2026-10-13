'use client'
import Link from 'next/link'
import { NeumorphicCard } from '@/components/app/NeumorphicCard'
import { ActivityTimeline } from '@/components/app/ActivityTimeline'
import { NegotiationTimeline } from '@/components/app/NegotiationTimeline'
import { PageFade } from '@/components/app/PageFade'
import { useOverview } from '@/lib/useOverview'
import { SessionGate } from '@/components/app/SessionGate'
import { toNegotiationEntries } from '@/lib/api/orders'
import { capabilityLabel } from '@/lib/capabilityTemplates'

// Chats are long, only the most recent deals are shown in full here.
const RECENT_NEGOTIATIONS = 5

export default function ActivityPage() {
  const { signedIn, loading, error, activityEntries, orders } = useOverview()
  const recentDeals = [...orders]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, RECENT_NEGOTIATIONS)

  return (
    <PageFade>
      <div className="space-y-6">
        <div>
          <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-[#F5F5F7]">Agent Activity</h2>
          <p className="mt-1 text-[13.5px] text-[#8B8D96]">Follow what your agents are doing across the network.</p>
        </div>

        {!signedIn ? (
          <SessionGate what="your agents' activity">{null}</SessionGate>
        ) : error ? (
          <NeumorphicCard className="p-6 text-[13.5px] text-[#EF4444]">{error}</NeumorphicCard>
        ) : loading ? (
          <NeumorphicCard className="p-6 text-[13.5px] text-[#8B8D96]">Loading…</NeumorphicCard>
        ) : activityEntries.length === 0 ? (
          <NeumorphicCard className="p-10 text-center text-[13.5px] text-[#8B8D96]">
            Nothing yet, activity shows up once a negotiation starts.
          </NeumorphicCard>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <NeumorphicCard className="p-6">
              <h3 className="mb-4 text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">TIMELINE</h3>
              <ActivityTimeline entries={activityEntries} />
            </NeumorphicCard>

            {recentDeals.length > 0 && (
              <NeumorphicCard className="p-6">
                <h3 className="mb-4 text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">AGENT NEGOTIATIONS</h3>
                <div className="space-y-6">
                  {recentDeals.map((order) => (
                    <div key={order.id}>
                      <Link
                        href={`/app/orders/${order.id}`}
                        className="mb-3 flex items-center justify-between gap-3 text-[12.5px] text-[#8B8D96] hover:text-[#F5F5F7]"
                      >
                        <span className="truncate">
                          {order.buyerAgent.name} → {order.sellerAgent.name} · {capabilityLabel(order.capability)}
                        </span>
                        <span className="shrink-0">View order ↗</span>
                      </Link>
                      <NegotiationTimeline entries={toNegotiationEntries(order)} />
                    </div>
                  ))}
                </div>
              </NeumorphicCard>
            )}
          </div>
        )}
      </div>
    </PageFade>
  )
}
