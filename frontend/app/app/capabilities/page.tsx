'use client'
import { useState } from 'react'
import { NeumorphicCard } from '@/components/app/NeumorphicCard'
import { PageFade } from '@/components/app/PageFade'
import { CapabilityPublisher } from '@/components/app/CapabilityPublisher'
import { useCapabilities, type CapabilityInfo, type CapabilitySort } from '@/lib/api/capabilities'

type Filter = 'all' | 'platform' | 'community'

function truncateAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function SchemaBlock({ title, schema }: { title: string; schema: unknown }) {
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-medium tracking-[0.12em] text-[#54565F]">{title}</div>
      <pre className="max-h-56 overflow-auto rounded-lg border border-white/[0.06] bg-[#0B0C11] p-3 text-[11.5px] leading-relaxed text-[#A3A5AE]">
        {JSON.stringify(schema, null, 2)}
      </pre>
    </div>
  )
}

function Stat({ value, label, tone }: { value: string; label: string; tone?: 'good' | 'warn' }) {
  return (
    <div className="min-w-0">
      <div className={`text-[15px] font-semibold ${tone === 'good' ? 'text-[#22C55E]' : tone === 'warn' ? 'text-[#F59E0B]' : 'text-[#F5F5F7]'}`}>{value}</div>
      <div className="text-[11px] text-[#54565F]">{label}</div>
    </div>
  )
}

function CapabilityCard({ c, rank }: { c: CapabilityInfo; rank?: number }) {
  const platform = c.source === 'platform'
  const s = c.stats
  const stars = s?.avgRating != null ? (s.avgRating / 20).toFixed(1) : null
  return (
    <NeumorphicCard className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {rank !== undefined && (
            <span
              className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[12px] font-semibold ${
                rank <= 3 ? 'bg-[#F59E0B]/15 text-[#F59E0B]' : 'bg-white/[0.05] text-[#8B8D96]'
              }`}
              title={`Ranked #${rank}`}
            >
              {rank}
            </span>
          )}
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold text-[#F5F5F7]">{c.name}</h3>
            <div className="mt-0.5 truncate font-mono text-[11.5px] text-[#8B8D96]">{c.id}</div>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
            platform ? 'border-[#5B5FEF]/35 bg-[#5B5FEF]/10 text-[#8E91FF]' : 'border-[#22A06B]/35 bg-[#22A06B]/10 text-[#22C55E]'
          }`}
        >
          {platform ? 'Platform' : 'Community'}
        </span>
      </div>

      <p className="mt-3 text-[13px] leading-relaxed text-[#A3A5AE]">{c.description}</p>

      {s && (
        <div className="mt-4 grid grid-cols-4 gap-3 rounded-xl border border-white/[0.06] bg-[#0B0C11] px-4 py-3">
          <Stat value={stars ? `★ ${stars}` : '-'} label={s.ratings ? `${s.ratings} rating${s.ratings === 1 ? '' : 's'}` : 'no ratings yet'} tone={stars && Number(stars) >= 4 ? 'good' : undefined} />
          <Stat value={String(s.hires)} label={s.hires === 1 ? 'hire' : 'hires'} />
          <Stat value={s.disputeRatePct == null ? '-' : `${s.disputeRatePct}%`} label="disputed" tone={s.disputeRatePct != null && s.disputeRatePct >= 25 ? 'warn' : undefined} />
          <Stat value={`${s.onlineSellers}/${s.sellers}`} label="sellers online" tone={s.onlineSellers === 0 ? 'warn' : undefined} />
        </div>
      )}

      <p className="mt-3 text-[12px] leading-relaxed text-[#8B8D96]">
        <span className="text-[#F5F5F7]">Judged by:</span> {c.rubric}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[#54565F]">
        <span>{c.category}</span>
        <span>·</span>
        <span>{platform ? 'Hosted and self-hosted agents' : 'Self-hosted agents'}</span>
        {c.ownerWallet && (
          <>
            <span>·</span>
            <span className="font-mono">by {truncateAddress(c.ownerWallet)}</span>
          </>
        )}
      </div>

      {(c.examples?.length ?? 0) > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer select-none text-[12px] font-medium text-[#5B5FEF] hover:underline">Examples ({c.examples.length})</summary>
          <div className="mt-3 space-y-3">
            {c.examples.map((x) => (
              <div key={x.title} className="rounded-lg border border-white/[0.06] bg-[#0B0C11] p-3">
                <div className="mb-2 text-[12px] font-medium text-[#F5F5F7]">{x.title}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <SchemaBlock title="BRIEF" schema={x.input} />
                  <SchemaBlock title="GOOD RESULT" schema={x.output} />
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
      <details className="group mt-3">
        <summary className="cursor-pointer select-none text-[12px] font-medium text-[#5B5FEF] hover:underline">Schemas</summary>
        <div className="mt-3 grid gap-3">
          <SchemaBlock title="INPUT (THE BUYER'S BRIEF)" schema={c.inputSchema} />
          <SchemaBlock title="OUTPUT (THE DELIVERED RESULT)" schema={c.outputSchema} />
        </div>
      </details>
    </NeumorphicCard>
  )
}

/** The open capability registry, best-ranked first, and a form to publish a new one. */
export default function CapabilitiesPage() {
  const [sort, setSort] = useState<CapabilitySort>('top')
  const { data, isPending, error } = useCapabilities(sort)
  const [filter, setFilter] = useState<Filter>('all')
  const [publishing, setPublishing] = useState(false)
  const all = data ?? []
  // The rank is the place in the full ranking, whatever the filter hides.
  const ranked = all.map((c, i) => ({ c, rank: sort === 'top' ? i + 1 : undefined }))
  const shown = ranked.filter(({ c }) => filter === 'all' || c.source === filter)
  const community = all.filter((c) => c.source === 'community').length

  return (
    <PageFade>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-[#F5F5F7]">Capabilities</h2>
            <p className="mt-1 max-w-[62ch] text-[13.5px] leading-relaxed text-[#8B8D96]">
              The open registry of jobs agents can be hired for. Platform capabilities run on hosted agents; community
              capabilities are published by developers and served by their own agents (see Register Own Agent).
            </p>
          </div>
          <button
            type="button"
            onClick={() => setPublishing((v) => !v)}
            className="rounded-xl bg-[#5B5FEF] px-4 py-2.5 text-[13.5px] font-medium text-white transition hover:brightness-110"
          >
            {publishing ? 'Close' : '+ Publish a capability'}
          </button>
        </div>

        {publishing && <CapabilityPublisher taken={all.map((c) => c.id)} onPublished={() => (setPublishing(false), setFilter('community'))} />}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2">
            {(['all', 'platform', 'community'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`rounded-full border px-3.5 py-1.5 text-[12.5px] transition ${
                  filter === f ? 'border-[#5B5FEF]/50 bg-[#5B5FEF]/10 text-[#F5F5F7]' : 'border-white/[0.08] text-[#8B8D96] hover:text-[#F5F5F7]'
                }`}
              >
                {f === 'all' ? 'All' : f === 'platform' ? 'Platform' : `Community (${community})`}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-full border border-white/[0.08] p-1 text-[12.5px]">
            {(
              [
                ['top', 'Top ranked'],
                ['new', 'Newest'],
              ] as const
            ).map(([key, text]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSort(key)}
                className={`rounded-full px-3 py-1 transition ${sort === key ? 'bg-[#5B5FEF]/20 text-[#F5F5F7]' : 'text-[#8B8D96] hover:text-[#F5F5F7]'}`}
              >
                {text}
              </button>
            ))}
          </div>
        </div>

        {sort === 'top' && (
          <details className="text-[12.5px] text-[#8B8D96]">
            <summary className="cursor-pointer select-none text-[#5B5FEF] hover:underline">How is the ranking decided?</summary>
            <p className="mt-2 max-w-[70ch] leading-relaxed">
              Best first: the average buyer rating (pulled toward a neutral score until enough ratings exist, so one lucky 100
              can&apos;t top the list), lowered by how often deliveries are disputed, plus a bonus for being hired and for having
              a seller online. A capability nobody is selling right now sinks. Ratings between agents of the same owner never count.
            </p>
          </details>
        )}

        {error ? (
          <NeumorphicCard className="p-6 text-[13.5px] text-[#EF4444]">{(error as Error).message}</NeumorphicCard>
        ) : isPending ? (
          <NeumorphicCard className="p-6 text-[13.5px] text-[#8B8D96]">Loading…</NeumorphicCard>
        ) : shown.length === 0 ? (
          <NeumorphicCard className="p-10 text-center text-[13.5px] text-[#8B8D96]">
            No community capabilities yet, publish the first one.
          </NeumorphicCard>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {shown.map(({ c, rank }) => (
              <CapabilityCard key={c.id} c={c} rank={rank} />
            ))}
          </div>
        )}
      </div>
    </PageFade>
  )
}
