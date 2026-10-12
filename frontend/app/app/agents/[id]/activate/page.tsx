'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { PageFade } from '@/components/app/PageFade'
import { NeumorphicCard } from '@/components/app/NeumorphicCard'
import { ActivateAgentCard } from '@/components/app/ActivateAgentCard'
import { getAgent, type ApiAgent } from '@/lib/api/agents'
import { SessionGate } from '@/components/app/SessionGate'
import { FAMILY } from '@/lib/web3/network'
import { UnsupportedOnSolana } from '@/components/app/solana/UnsupportedOnSolana'

// A hosted agent (and its deposit address) is visible to its owner only.
function ActivateAgentPageEvm() {
  return (
    <SessionGate what="this agent">
      <ActivateAgentContent />
    </SessionGate>
  )
}

function ActivateAgentContent() {
  const params = useParams<{ id: string }>()
  const [agent, setAgent] = useState<ApiAgent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getAgent(params.id)
      .then((a) => {
        if (!cancelled) setAgent(a)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load this agent.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [params.id])

  if (loading) {
    return (
      <PageFade>
        <NeumorphicCard className="mx-auto max-w-[480px] p-8 text-center text-[13.5px] text-[#8B8D96]">
          Loading agent…
        </NeumorphicCard>
      </PageFade>
    )
  }

  if (error || !agent || agent.taskStatus === null) {
    return (
      <PageFade>
        <NeumorphicCard className="mx-auto max-w-[480px] p-8 text-center text-[13.5px] text-[#8B8D96]">
          {error ?? "This agent isn't hosted by AgentEco, so there's nothing to activate."}
        </NeumorphicCard>
      </PageFade>
    )
  }

  return (
    <PageFade>
      <ActivateAgentCard agent={agent} />
    </PageFade>
  )
}

export default function ActivateAgentPage() {
  return FAMILY === 'solana' ? <UnsupportedOnSolana title="Activate a hosted agent" why="Hosted agents hold their key with AgentEco and run on the EVM networks only." instead={{ href: '/app/marketplace', label: 'Browse the marketplace' }} /> : <ActivateAgentPageEvm />
}
