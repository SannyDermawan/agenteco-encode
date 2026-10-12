'use client'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useWallet } from '@/lib/wallet/useWallet'
import { NeumorphicCard } from '@/components/app/NeumorphicCard'
import { PageFade } from '@/components/app/PageFade'
import { PrivateOrderNotice } from '@/components/app/SessionGate'
import { getEscrowAccess } from '@/lib/api/escrows'

/**
 * Renders an escrow's order page only for its buyer, seller or the arbiter
 * (checked by the API). Must sit inside a SessionGate.
 */
export function EscrowAccessGate({ escrowId, children }: { escrowId: string; children: ReactNode }) {
  const { address } = useWallet()
  const valid = /^\d{1,30}$/.test(escrowId)
  const access = useQuery({
    queryKey: ['escrowAccess', escrowId, address],
    queryFn: () => getEscrowAccess(escrowId),
    enabled: valid,
    retry: false,
  })

  // The page itself explains an invalid or unknown escrow id.
  if (!valid || access.data === null) return <>{children}</>

  if (access.isPending) {
    return (
      <PageFade>
        <NeumorphicCard className="p-6 text-[13.5px] text-[#8B8D96]">Checking access to escrow #{escrowId}…</NeumorphicCard>
      </PageFade>
    )
  }
  if (access.isError) {
    return (
      <PageFade>
        <NeumorphicCard className="p-6 text-[13.5px] text-[#8B8D96]">{access.error.message || 'Could not check access.'}</NeumorphicCard>
      </PageFade>
    )
  }
  if (!access.data) {
    return (
      <PageFade>
        <PrivateOrderNotice />
      </PageFade>
    )
  }
  return <>{children}</>
}
