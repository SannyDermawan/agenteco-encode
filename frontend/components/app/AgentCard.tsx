'use client'
import Link from 'next/link'
import { NeumorphicCard } from './NeumorphicCard'
import { AgentStatus } from './AgentStatus'
import { BrandMarkIcon, ArrowRightIcon } from './icons'
import type { AgentSummary } from '@/lib/agenteco-data'
import { useReputation } from '@/lib/chain/hooks'
import { displayStars, formatReputationLine, onchainRawTooltip } from '@/lib/web3/reputation'
import { useSellerRating } from '@/lib/useSellerRating'
import { TOKEN_SYMBOL } from '@/lib/web3/network'
import { capabilityLabel } from '@/lib/capabilityTemplates'
import { NewBadge } from './moderation/ListingBadges'

/** For an agent with an on-chain wallet, reputation is read live from AgentEco.sol
 * (the contract is the source of truth) instead of the static 0s the registry mapper sets. */
export function AgentCard({ agent }: { agent: AgentSummary }) {
  const { data } = useReputation(agent.walletAddress)
  const { data: rating } = useSellerRating(agent.walletAddress)
  const reputationLine = data ? formatReputationLine(data, displayStars(rating)) : 'No ratings yet · 0 jobs'

  return (
    <NeumorphicCard className="flex flex-col p-5">
      <div className="flex items-start justify-between">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#151820] text-[#8B5CF6]">
          <BrandMarkIcon className="h-4 w-4" />
        </span>
        <div className="flex items-center gap-2">
          <NewBadge createdAt={agent.createdAt} />
          {agent.hosted !== undefined && (
            <span
              className="rounded-full border border-white/[0.08] bg-[#0B0C11] px-2 py-0.5 text-[10.5px] text-[#8B8D96]"
              title={agent.hosted ? 'Run by AgentEco with its own wallet' : 'Runs on its owner’s own server'}
            >
              {agent.hosted ? 'Hosted' : 'Self-hosted'}
            </span>
          )}
          <AgentStatus status={agent.status} />
        </div>
      </div>

      <h3 className="mt-4 text-[15px] font-semibold tracking-[-0.01em] text-[#F5F5F7]">{agent.name}</h3>
      <div className="text-[12.5px] text-[#8B8D96]">{agent.service}</div>
      <p className="mt-2.5 text-[12.5px] leading-relaxed text-[#8B8D96]">{agent.description}</p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {agent.capabilities.map((c) => (
          <span
            key={c}
            className="rounded-full border border-white/[0.08] bg-[#0B0C11] px-2.5 py-1 text-[10.5px] text-[#8B8D96]"
          >
            {capabilityLabel(c)}
          </span>
        ))}
      </div>

      <div className="mt-4 text-[12.5px]">
        <span className="font-semibold text-[#F5F5F7]">{agent.price.toFixed(2)} {TOKEN_SYMBOL}</span>{' '}
        <span className="text-[#8B8D96]">/ task</span>
      </div>
      <div className="mt-1.5 text-[11.5px] text-[#8B8D96]" title={data ? onchainRawTooltip(data) : undefined}>
        {reputationLine}
      </div>

      <Link
        href={`/app/agents/${agent.id}`}
        className="mt-4 flex items-center justify-center gap-1.5 rounded-xl border border-white/[0.08] bg-[#11141B] py-2.5 text-[13px] font-medium text-[#F5F5F7] transition hover:border-[#5B5FEF]/40 hover:bg-[#5B5FEF]/10"
      >
        View Agent
        <ArrowRightIcon className="h-3.5 w-3.5" />
      </Link>
    </NeumorphicCard>
  )
}
