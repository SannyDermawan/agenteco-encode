'use client'
import { useQuery } from '@tanstack/react-query'
import { NeumorphicCard } from './NeumorphicCard'
import { CapabilityResultView } from './CapabilityResultView'
import { HashCheck } from './HashCheck'
import { getEscrowResult } from '@/lib/api/escrowResults'
import { useEscrowHashes } from '@/lib/chain/hooks'
import { capabilityLabel } from '@/lib/capabilityTemplates'

const DELIVERED_OR_LATER = 3 // AgentEco.sol OrderStatus.DELIVERED
const RETRY_MS = 4000

/** Shown once an escrow reaches DELIVERED or later, shared by the on-chain
 * order page and the off-chain order page's live status section. */
export function EscrowResultCard({ escrowId, status }: { escrowId: bigint; status: number }) {
  // The seller commits the result hash on-chain first and publishes the
  // plaintext a few seconds later, so a page that sees DELIVERED early gets a
  // 404, keep polling until the result lands, then stop.
  const { data: result } = useQuery({
    queryKey: ['escrowResult', escrowId.toString()],
    queryFn: () => getEscrowResult(escrowId.toString()),
    enabled: status >= DELIVERED_OR_LATER,
    refetchInterval: (query) => (query.state.data ? false : RETRY_MS),
  })
  const hashes = useEscrowHashes(status >= DELIVERED_OR_LATER ? escrowId : undefined, false)

  if (status < DELIVERED_OR_LATER) return null

  return (
    <NeumorphicCard className="p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">RESULT</h3>
        {result && <span className="text-[12px] text-[#8B8D96]">{capabilityLabel(result.capability)}</span>}
      </div>
      {result ? (
        <>
          <CapabilityResultView capability={result.capability} result={result.result} />
          <div className="mt-4 space-y-1.5 border-t border-white/[0.06] pt-3">
            <HashCheck label="resultHash" text={result.resultJson} onchainHash={hashes.data?.[1] ?? result.resultHash} />
            <details className="text-[11.5px] text-[#8B8D96]">
              <summary className="cursor-pointer hover:text-[#F5F5F7]">Raw result JSON</summary>
              <pre className="mt-2 overflow-x-auto rounded-xl border border-white/[0.06] bg-[#0B0C11] p-3 text-[11.5px] leading-relaxed text-[#F5F5F7]">
                {result.resultJson ?? JSON.stringify(result.result, null, 2)}
              </pre>
            </details>
          </div>
        </>
      ) : (
        <p className="text-[13px] text-[#8B8D96]">
          No result recorded off-chain yet, only its hash was committed on-chain.
        </p>
      )}
    </NeumorphicCard>
  )
}
