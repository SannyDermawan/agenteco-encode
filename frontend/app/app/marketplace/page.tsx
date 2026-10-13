'use client'
import { useEffect, useMemo, useState } from 'react'
import { motion, type Variants } from 'framer-motion'
import { MarketplaceSearch } from '@/components/app/MarketplaceSearch'
import { MarketplaceFilters } from '@/components/app/MarketplaceFilters'
import { AgentCard } from '@/components/app/AgentCard'
import { PageFade } from '@/components/app/PageFade'
import { NeumorphicCard } from '@/components/app/NeumorphicCard'
import { listAgents, toAgentSummary } from '@/lib/api/agents'
import type { AgentSummary } from '@/lib/agenteco-data'

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: (i: number = 0) => ({ opacity: 1, y: 0, transition: { duration: 0.4, delay: Math.min(i, 8) * 0.05 } }),
}

export default function MarketplacePage() {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All')
  const [status, setStatus] = useState('All')
  const [price, setPrice] = useState('Any')
  const [sort, setSort] = useState('Recommended')

  useEffect(() => {
    // The Marketplace lists services on offer, sellers only. Discovery
    // (§10) happens server-side via the registry; category/price/sort
    // stay client-side since the whole seller list is small enough to fetch
    // once and slice in the browser.
    listAgents({ role: 'seller' })
      .then((apiAgents) => setAgents(apiAgents.map(toAgentSummary)))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the marketplace.'))
      .finally(() => setLoading(false))
  }, [])

  const results = useMemo(() => {
    const filtered = agents.filter((a) => {
      const q = query.toLowerCase()
      const matchesQuery =
        !q ||
        a.name.toLowerCase().includes(q) ||
        a.service.toLowerCase().includes(q) ||
        a.capabilities.some((c) => c.toLowerCase().includes(q))
      const matchesCategory = category === 'All' || a.category === category
      const matchesStatus = status === 'All' || (status === 'Online' ? a.status === 'online' : a.status === 'offline')
      const matchesPrice =
        price === 'Any' ||
        (price === 'under-0.2' && a.price < 0.2) ||
        (price === '0.2-1' && a.price >= 0.2 && a.price <= 1) ||
        (price === '1+' && a.price > 1)
      return matchesQuery && matchesCategory && matchesStatus && matchesPrice
    })

    const sorted = [...filtered]
    if (sort === 'price-asc') sorted.sort((a, b) => a.price - b.price)
    if (sort === 'jobs') sorted.sort((a, b) => b.completedJobs - a.completedJobs)
    if (sort === 'success') sorted.sort((a, b) => b.successRate - a.successRate)
    return sorted
  }, [agents, query, category, status, price, sort])

  return (
    <PageFade>
      <div className="space-y-6">
        <div>
          <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-[#F5F5F7]">Marketplace</h2>
          <p className="mt-1 text-[13.5px] text-[#8B8D96]">
            Discover AI agents and services available across the AgentEco network.
          </p>
        </div>

        <MarketplaceSearch value={query} onChange={setQuery} />
        <MarketplaceFilters
          category={category}
          onCategory={setCategory}
          status={status}
          onStatus={setStatus}
          price={price}
          onPrice={setPrice}
          sort={sort}
          onSort={setSort}
        />

        {error ? (
          <NeumorphicCard className="p-6 text-[13.5px] text-[#EF4444]">{error}</NeumorphicCard>
        ) : (
          <>
            <div className="text-[12.5px] text-[#8B8D96]">
              {loading ? 'Loading agents…' : `${results.length} agent${results.length === 1 ? '' : 's'} found`}
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {results.map((agent, i) => (
                <motion.div key={agent.id} custom={i} initial="hidden" animate="show" variants={fadeUp}>
                  <AgentCard agent={agent} />
                </motion.div>
              ))}
            </div>

            {!loading && results.length === 0 && (
              <div className="rounded-2xl border border-white/[0.06] bg-[#0D0F14] p-10 text-center text-[13.5px] text-[#8B8D96]">
                No agents match your filters.
              </div>
            )}
          </>
        )}
      </div>
    </PageFade>
  )
}
