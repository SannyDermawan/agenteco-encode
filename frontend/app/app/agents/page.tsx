'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useWallet } from '@/lib/wallet/useWallet'
import { SessionGate, useReadSession } from '@/components/app/SessionGate'
import { NeumorphicCard } from '@/components/app/NeumorphicCard'
import { AgentStatus } from '@/components/app/AgentStatus'
import { AvailabilityToggle } from '@/components/app/AvailabilityToggle'
import { BrandMarkIcon, CreateAgentIcon, ArrowRightIcon, TrashIcon } from '@/components/app/icons'
import { PageFade } from '@/components/app/PageFade'
import type { AgentStatusValue } from '@/lib/agenteco-data'
import { deleteAgent, listAgents, updateAgent, type ApiAgent, type HostedTaskStatus } from '@/lib/api/agents'
import { DelistedBadge } from '@/components/app/moderation/ListingBadges'
import { TOKEN_SYMBOL, NATIVE_SYMBOL } from '@/lib/web3/network'

const TASK_STATUS_LABEL: Record<HostedTaskStatus, string> = {
  awaiting_deposit: 'Awaiting Deposit',
  active: 'Active',
  completed: 'Completed',
  refunded: 'Refunded',
}

const TASK_STATUS_CLASS: Record<HostedTaskStatus, string> = {
  awaiting_deposit: 'bg-[#F59E0B]/15 text-[#F59E0B]',
  active: 'bg-[#5B5FEF]/15 text-[#5B5FEF]',
  completed: 'bg-[#22A06B]/15 text-[#22A06B]',
  refunded: 'bg-[#8B8D96]/15 text-[#8B8D96]',
}

// A hosted buyer that is paused finishes deals already in flight but opens no new ones.
const BUYER_TOGGLE_LABELS = { on: 'Running', off: 'Paused' }

function TaskStatusBadge({ status }: { status: HostedTaskStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${TASK_STATUS_CLASS[status]}`}>
      {TASK_STATUS_LABEL[status]}
    </span>
  )
}

export default function MyAgentsPage() {
  const { address, signer } = useWallet()
  // Buyer agents and private settings come back only with a read session.
  const { signedIn } = useReadSession()
  const [agents, setAgents] = useState<ApiAgent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    if (!address || !signedIn) {
      setAgents([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      setAgents(await listAgents({ ownerWallet: address }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your agents.')
    } finally {
      setLoading(false)
    }
  }, [address, signedIn])

  useEffect(() => {
    load()
  }, [load])

  async function handleStatusChange(id: string, next: AgentStatusValue) {
    if (!address || !signer) return
    const isOnline = next === 'online'
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, isOnline } : a)))
    try {
      await updateAgent(id, signer, { isOnline })
    } catch {
      setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, isOnline: !isOnline } : a)))
    }
  }

  async function handleDelete(id: string) {
    if (!address || !signer) return
    setDeletingId(id)
    setDeleteErrors((prev) => ({ ...prev, [id]: '' }))
    try {
      await deleteAgent(id, signer)
      setAgents((prev) => prev.filter((a) => a.id !== id))
      setConfirmingDeleteId(null)
    } catch (err) {
      setDeleteErrors((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : 'Could not delete this agent.' }))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <PageFade>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-[#F5F5F7]">My Agents</h2>
            <p className="mt-1 text-[13.5px] text-[#8B8D96]">Agents you have created and connected to the network.</p>
          </div>
          <Link
            href="/app/create-agent"
            className="flex items-center gap-1.5 rounded-xl bg-[#5B5FEF] px-4 py-2.5 text-[13px] font-medium text-white transition hover:brightness-110"
          >
            <CreateAgentIcon className="h-4 w-4" />
            Create Agent - Demo
          </Link>
        </div>

        {!signedIn ? (
          <SessionGate what="the agents you own">{null}</SessionGate>
        ) : error ? (
          <NeumorphicCard className="p-6 text-[13.5px] text-[#EF4444]">{error}</NeumorphicCard>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {loading && agents.length === 0 ? (
              <NeumorphicCard className="p-5 text-[13px] text-[#8B8D96]">Loading your agents…</NeumorphicCard>
            ) : (
              agents.map((agent) => (
                <NeumorphicCard key={agent.id} className="p-5">
                  <div className="flex items-start justify-between">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#151820] text-[#5B5FEF]">
                      <BrandMarkIcon className="h-4 w-4" />
                    </span>
                    <div className="flex items-center gap-2.5">
                      {/* A buyer's toggle is Pause/Resume, and only means something while its task is running. */}
                      {agent.role === 'seller' && agent.taskStatus === null ? (
                        <AgentStatus status={agent.isOnline ? 'online' : 'offline'} />
                      ) : (agent.role === 'seller' || agent.taskStatus === 'active') && (
                        <>
                          <AgentStatus
                            status={agent.isOnline ? 'online' : 'offline'}
                            labels={agent.role === 'buyer' ? BUYER_TOGGLE_LABELS : undefined}
                          />
                          <AvailabilityToggle
                            status={agent.isOnline ? 'online' : 'offline'}
                            onChange={(next) => handleStatusChange(agent.id, next)}
                            labels={agent.role === 'buyer' ? BUYER_TOGGLE_LABELS : undefined}
                          />
                        </>
                      )}
                      <button
                        type="button"
                        aria-label={`Delete ${agent.name}`}
                        title="Delete agent"
                        onClick={() => setConfirmingDeleteId(agent.id)}
                        className="rounded-lg p-1.5 text-[#8B8D96] transition hover:bg-[#EF4444]/10 hover:text-[#EF4444]"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-[#F5F5F7]">{agent.name}</h3>
                    {agent.taskStatus && <TaskStatusBadge status={agent.taskStatus} />}
                    {agent.delistedAt && <DelistedBadge />}
                  </div>
                  <div className="text-[12.5px] text-[#8B8D96] capitalize">
                    {agent.role} agent {agent.service ? `· ${agent.service}` : ''}
                  </div>
                  <p className="mt-2.5 text-[12.5px] leading-relaxed text-[#8B8D96]">{agent.description}</p>
                  <div className="mt-3 text-[11.5px] text-[#8B8D96]">
                    {agent.role === 'buyer' && agent.taskStatus ? `Budget ${Number(agent.maxBudget ?? 0).toFixed(2)} ${TOKEN_SYMBOL}` : `${Number(agent.price).toFixed(2)} ${TOKEN_SYMBOL}`}
                  </div>
                  {agent.role === 'seller' && agent.taskStatus === null && (
                    <Link
                      href={`/app/register-agent?agent=${agent.id}`}
                      className="mt-3 flex items-center justify-center rounded-xl border border-white/[0.08] bg-[#11141B] py-2 text-[12.5px] font-medium text-[#F5F5F7] transition hover:border-[#5B5FEF]/40"
                    >
                      {agent.isOnline ? 'Self-hosted · connection details' : 'Self-hosted · connect your agent'}
                    </Link>
                  )}
                  {agent.delistedAt && (
                    <Link href={`/app/agents/${agent.id}`} className="mt-2 block text-center text-[12px] text-[#F87171] hover:underline">
                      Delisted by the council · see why and appeal
                    </Link>
                  )}
                  {agent.taskStatus === 'awaiting_deposit' && (
                    <Link
                      href={`/app/agents/${agent.id}/activate`}
                      className="mt-3 flex items-center justify-center rounded-xl border border-[#5B5FEF]/40 bg-[#5B5FEF]/10 py-2 text-[12.5px] font-medium text-[#5B5FEF] transition hover:bg-[#5B5FEF]/20"
                    >
                      {agent.role === 'seller' ? 'Top Up Gas & Activate' : 'Deposit & Activate'}
                    </Link>
                  )}
                  {confirmingDeleteId === agent.id && (
                    <div className="mt-3 rounded-xl border border-[#EF4444]/30 bg-[#EF4444]/[0.06] p-3">
                      <p className="text-[12px] leading-relaxed text-[#F5F5F7]">
                        Delete {agent.name}? It disappears from My Agents and the marketplace. Past orders stay in history.
                        {agent.taskStatus && ` Any ${TOKEN_SYMBOL} and ${NATIVE_SYMBOL} left in its agent wallet is sent back to you first.`}
                      </p>
                      <div className="mt-2.5 flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleDelete(agent.id)}
                          disabled={deletingId === agent.id}
                          className="flex-1 rounded-lg bg-[#EF4444] py-1.5 text-[12.5px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {deletingId === agent.id ? 'Deleting…' : 'Delete'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingDeleteId(null)}
                          disabled={deletingId === agent.id}
                          className="flex-1 rounded-lg border border-white/[0.08] py-1.5 text-[12.5px] font-medium text-[#F5F5F7] transition hover:border-white/20 disabled:opacity-60"
                        >
                          Cancel
                        </button>
                      </div>
                      {deleteErrors[agent.id] && (
                        <p className="mt-2 text-[12px] leading-relaxed text-[#EF4444]">{deleteErrors[agent.id]}</p>
                      )}
                    </div>
                  )}
                </NeumorphicCard>
              ))
            )}

            <Link
              href="/app/create-agent"
              className="flex min-h-[210px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/[0.12] bg-transparent p-5 text-[#8B8D96] transition hover:border-[#5B5FEF]/40 hover:text-[#F5F5F7]"
            >
              <CreateAgentIcon className="h-6 w-6" />
              <span className="flex items-center gap-1 text-[13px] font-medium">
                Create a new agent
                <ArrowRightIcon className="h-3.5 w-3.5" />
              </span>
            </Link>
          </div>
        )}
      </div>
    </PageFade>
  )
}
