'use client'
import { useQuery } from '@tanstack/react-query'
import { NeumorphicCard } from './NeumorphicCard'
import { HashCheck } from './HashCheck'
import { getTaskByEscrow } from '@/lib/api/tasks'
import { useEscrowHashes } from '@/lib/chain/hooks'
import { capabilityLabel } from '@/lib/capabilityTemplates'
import { explorerTxUrl } from '@/lib/web3/escrowEvents'
import { LANGUAGES } from '@shared/capabilities/definitions'

const LABELS: Record<string, string> = {
  text: 'Text',
  targetLanguage: 'Target language',
  tone: 'Tone',
  csv: 'CSV',
  question: 'Question',
  coins: 'Coins',
  horizon: 'Horizon',
  txHash: 'Transaction',
}

function Value({ name, value }: { name: string; value: unknown }) {
  if (name === 'targetLanguage' && typeof value === 'string') {
    return <span>{LANGUAGES.find((l) => l.code === value)?.name ?? value}</span>
  }
  if (name === 'txHash' && typeof value === 'string') {
    return (
      <a href={explorerTxUrl(value)} target="_blank" rel="noreferrer" className="break-all font-mono text-[12px] text-[#8FA9FF] hover:underline">
        {value} ↗
      </a>
    )
  }
  if (Array.isArray(value)) return <span>{value.join(', ')}</span>
  const text = String(value)
  return text.includes('\n') || text.length > 120 ? (
    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-[#0B0C11] p-2.5 font-mono text-[11.5px] text-[#F5F5F7]">
      {text}
    </pre>
  ) : (
    <span>{text}</span>
  )
}

/**
 * What the buyer asked for (spec §5, §13): the brief and acceptance criteria
 * behind the escrow's taskHash, re-hashed in the browser against the chain.
 */
export function TaskCard({ escrowId }: { escrowId: bigint }) {
  const { data: task } = useQuery({
    queryKey: ['taskByEscrow', escrowId.toString()],
    queryFn: () => getTaskByEscrow(escrowId.toString()),
    refetchInterval: (query) => (query.state.data ? false : 10_000),
  })
  const hashes = useEscrowHashes(task ? escrowId : undefined, false)
  if (!task) return null

  const brief = (task.brief ?? {}) as Record<string, unknown>
  return (
    <NeumorphicCard className="p-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">TASK</h3>
        <span className="text-[12px] text-[#8B8D96]">{capabilityLabel(task.capability)}</span>
      </div>
      <dl className="space-y-2 text-[13px] text-[#F5F5F7]">
        {Object.entries(brief).map(([name, value]) => (
          <div key={name}>
            <dt className="text-[11.5px] text-[#8B8D96]">{LABELS[name] ?? name}</dt>
            <dd>
              <Value name={name} value={value} />
            </dd>
          </div>
        ))}
        <div>
          <dt className="text-[11.5px] text-[#8B8D96]">Acceptance criteria</dt>
          <dd className={task.criteria ? '' : 'text-[#54565F]'}>{task.criteria || 'None given'}</dd>
        </div>
      </dl>
      <div className="mt-4 border-t border-white/[0.06] pt-3">
        <HashCheck label="taskHash" text={task.preimage} onchainHash={hashes.data?.[0] ?? task.taskHash} />
      </div>
    </NeumorphicCard>
  )
}
