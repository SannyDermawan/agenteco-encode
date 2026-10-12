'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useQueryClient } from '@tanstack/react-query'
import { useWallet } from '@/lib/wallet/useWallet'
import { NeumorphicCard } from '../NeumorphicCard'
import { reportCategoryLabel, voteOnAppeal, voteOnReport, type AppealCase, type ModerationQueue as Queue, type ReportCase } from '@/lib/api/moderation'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

function Tally({ votes, threshold, choices }: { votes: { vote: string }[]; threshold: number; choices: [string, string][] }) {
  return (
    <span className="text-[12px] text-[#8B8D96]">
      {choices.map(([key, label], i) => (
        <span key={key}>
          {i > 0 && ' · '}
          {label} {votes.filter((v) => v.vote === key).length}/{threshold}
        </span>
      ))}
    </span>
  )
}

function VoteButtons<V extends string>({
  options,
  mine,
  onVote,
}: {
  options: { vote: V; label: string; tone: 'danger' | 'plain' | 'good' }[]
  mine?: string
  onVote: (vote: V) => Promise<void>
}) {
  const [busy, setBusy] = useState<V | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tone = { danger: 'bg-[#EF4444] text-white', good: 'bg-[#22A06B] text-white', plain: 'border border-white/[0.1] text-[#F5F5F7]' }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {options.map((o) => (
        <button
          key={o.vote}
          type="button"
          disabled={!!busy || mine === o.vote}
          onClick={async () => {
            setBusy(o.vote)
            setError(null)
            try {
              await onVote(o.vote)
            } catch (err) {
              setError(err instanceof Error ? err.message : 'The vote failed.')
            } finally {
              setBusy(null)
            }
          }}
          className={`rounded-xl px-3.5 py-1.5 text-[12.5px] font-medium transition hover:brightness-110 disabled:opacity-50 ${tone[o.tone]}`}
        >
          {busy === o.vote ? 'Sign…' : mine === o.vote ? `${o.label} ✓` : o.label}
        </button>
      ))}
      {mine && <span className="text-[11.5px] text-[#8B8D96]">Your vote is in; you can change it until the case is decided.</span>}
      {error && <span className="w-full text-[12px] text-[#EF4444]">{error}</span>}
    </div>
  )
}

function ReportRow({ r, threshold, me, refresh }: { r: ReportCase; threshold: number; me: string; refresh: () => Promise<void> }) {
  const { address, signer } = useWallet()
  const mine = r.votes.find((v) => v.voter === me)?.vote
  return (
    <NeumorphicCard className="space-y-3 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/app/agents/${r.agentId}`} className="text-[14.5px] font-semibold text-[#F5F5F7] hover:underline">
          {r.agent.name}
        </Link>
        <span className="rounded-full border border-[#EF4444]/35 bg-[#EF4444]/10 px-2 py-0.5 text-[11px] text-[#F87171]">{reportCategoryLabel(r.category)}</span>
        {r.hadOrder && <span className="rounded-full border border-[#F59E0B]/35 bg-[#F59E0B]/10 px-2 py-0.5 text-[11px] text-[#F59E0B]">Reporter hired this seller</span>}
        {r.openReportsForAgent > 1 && <span className="text-[11.5px] text-[#F87171]">{r.openReportsForAgent} open reports on this agent</span>}
        <span className="ml-auto text-[11.5px] text-[#8B8D96]">{r.status === 'open' ? 'Open' : r.status === 'delisted' ? 'Delisted' : 'Dismissed'}</span>
      </div>
      <p className="rounded-xl border border-white/[0.06] bg-[#0B0C11] p-3 text-[13px] leading-relaxed text-[#F5F5F7]">{r.reason}</p>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-[#8B8D96]">
        <span>
          By <span className="font-mono">{short(r.reporterWallet)}</span> · {new Date(r.createdAt).toLocaleString()}
        </span>
        <span>
          Agent {r.agent.taskStatus === null ? 'self-hosted' : 'hosted'} · owner <span className="font-mono">{short(r.agent.ownerWallet)}</span>
        </span>
        <Tally votes={r.votes} threshold={threshold} choices={[['delist', 'Delist'], ['dismiss', 'Dismiss']]} />
      </div>
      {r.status === 'open' && address && signer && (
        <VoteButtons
          mine={mine}
          options={[
            { vote: 'delist', label: 'Delist the agent', tone: 'danger' },
            { vote: 'dismiss', label: 'Dismiss the report', tone: 'plain' },
          ]}
          onVote={async (vote) => {
            await voteOnReport(signer, r.id, vote)
            await refresh()
          }}
        />
      )}
    </NeumorphicCard>
  )
}

function AppealRow({ a, threshold, me, refresh }: { a: AppealCase; threshold: number; me: string; refresh: () => Promise<void> }) {
  const { address, signer } = useWallet()
  const mine = a.votes.find((v) => v.voter === me)?.vote
  return (
    <NeumorphicCard className="space-y-3 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/app/agents/${a.agentId}`} className="text-[14.5px] font-semibold text-[#F5F5F7] hover:underline">
          {a.agent.name}
        </Link>
        <span className="text-[12px] text-[#8B8D96]">appeals its delisting</span>
        <span className="ml-auto text-[11.5px] text-[#8B8D96]">{a.status === 'open' ? 'Open' : a.status === 'reinstated' ? 'Reinstated' : 'Upheld'}</span>
      </div>
      {a.agent.delistReason && <p className="text-[12.5px] text-[#8B8D96]">Delisted for: {a.agent.delistReason}</p>}
      <p className="rounded-xl border border-white/[0.06] bg-[#0B0C11] p-3 text-[13px] leading-relaxed text-[#F5F5F7]">{a.reason}</p>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-[#8B8D96]">
        <span>
          Owner <span className="font-mono">{short(a.ownerWallet)}</span> · {new Date(a.createdAt).toLocaleString()}
        </span>
        <Tally votes={a.votes} threshold={threshold} choices={[['reinstate', 'Reinstate'], ['uphold', 'Uphold']]} />
      </div>
      {a.status === 'open' && address && signer && (
        <VoteButtons
          mine={mine}
          options={[
            { vote: 'reinstate', label: 'Reinstate', tone: 'good' },
            { vote: 'uphold', label: 'Keep delisted', tone: 'plain' },
          ]}
          onVote={async (vote) => {
            await voteOnAppeal(signer, a.id, vote)
            await refresh()
          }}
        />
      )}
    </NeumorphicCard>
  )
}

/** The council's moderation queue: reports against listings, and appeals from delisted owners. */
export function ModerationQueue({ queue, me }: { queue: Queue; me: string }) {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['moderation'] })
  const openReports = queue.reports.filter((r) => r.status === 'open')
  const openAppeals = queue.appeals.filter((a) => a.status === 'open')
  const past = [...queue.reports.filter((r) => r.status !== 'open')].slice(0, 10)

  return (
    <div className="space-y-6">
      <p className="text-[12.5px] leading-relaxed text-[#8B8D96]">
        {queue.threshold} matching votes of {queue.members.length} decide a case. Delisting hides the agent from the marketplace
        and from discovery and ends its open negotiations; escrows already funded still finish. The owner can appeal.
      </p>
      <section className="space-y-3">
        <h3 className="text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">APPEALS · {openAppeals.length}</h3>
        {openAppeals.length === 0 ? (
          <NeumorphicCard className="p-5 text-center text-[13px] text-[#8B8D96]">No open appeals.</NeumorphicCard>
        ) : (
          openAppeals.map((a) => <AppealRow key={a.id} a={a} threshold={queue.threshold} me={me} refresh={refresh} />)
        )}
      </section>
      <section className="space-y-3">
        <h3 className="text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">REPORTS · {openReports.length}</h3>
        {openReports.length === 0 ? (
          <NeumorphicCard className="p-5 text-center text-[13px] text-[#8B8D96]">No open reports.</NeumorphicCard>
        ) : (
          openReports.map((r) => <ReportRow key={r.id} r={r} threshold={queue.threshold} me={me} refresh={refresh} />)
        )}
      </section>
      {past.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">DECIDED</h3>
          {past.map((r) => (
            <ReportRow key={r.id} r={r} threshold={queue.threshold} me={me} refresh={refresh} />
          ))}
        </section>
      )}
    </div>
  )
}
