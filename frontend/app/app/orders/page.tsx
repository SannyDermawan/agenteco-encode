'use client'
import { useMemo, useState } from 'react'
import { OrderTable } from '@/components/app/OrderTable'
import { NeumorphicCard } from '@/components/app/NeumorphicCard'
import { PageFade } from '@/components/app/PageFade'
import { useOverview } from '@/lib/useOverview'
import { SessionGate } from '@/components/app/SessionGate'

const FILTERS = ['All', 'Active', 'Completed'] as const
type Filter = (typeof FILTERS)[number]

// AgentEco.sol: 5 SETTLED, 6 REFUNDED, nothing left to do on either.
const isCompleted = (escrowStatus?: number) => escrowStatus === 5 || escrowStatus === 6

export default function OrdersPage() {
  const { signedIn, orderRows, loading, error } = useOverview()
  const [filter, setFilter] = useState<Filter>('All')

  const filtered = useMemo(() => {
    if (filter === 'All') return orderRows
    return orderRows.filter((o) => (filter === 'Completed' ? isCompleted(o.escrowStatus) : !isCompleted(o.escrowStatus)))
  }, [orderRows, filter])

  return (
    <PageFade>
      <div className="space-y-6">
        <div>
          <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-[#F5F5F7]">Orders</h2>
          <p className="mt-1 text-[13.5px] text-[#8B8D96]">
            Track every service request and transaction, negotiated by your agents or hired directly.
          </p>
        </div>

        {!signedIn ? (
          <SessionGate what="your orders">{null}</SessionGate>
        ) : error ? (
          <NeumorphicCard className="p-6 text-[13.5px] text-[#EF4444]">{error}</NeumorphicCard>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={`rounded-full border px-3.5 py-1.5 text-[12px] font-medium transition ${
                    filter === f
                      ? 'border-[#5B5FEF]/50 bg-[#5B5FEF]/15 text-[#F5F5F7]'
                      : 'border-white/[0.08] bg-[#0D0F14] text-[#8B8D96] hover:text-[#F5F5F7]'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>

            {loading ? (
              <NeumorphicCard className="p-6 text-[13.5px] text-[#8B8D96]">Loading orders…</NeumorphicCard>
            ) : filtered.length === 0 ? (
              <NeumorphicCard className="p-10 text-center text-[13.5px] text-[#8B8D96]">
                {filter === 'All'
                  ? 'No orders yet. Orders appear once a negotiation is accepted or you hire an agent directly.'
                  : `No ${filter.toLowerCase()} orders.`}
              </NeumorphicCard>
            ) : (
              <OrderTable orders={filtered} />
            )}
          </>
        )}
      </div>
    </PageFade>
  )
}
