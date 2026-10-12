'use client'
import { useEffect, useMemo, useState } from 'react'
import { formatUnits } from 'viem'
import { normalizeWallet, sameWallet } from '@shared/wallets'
import { useWallet } from './wallet/useWallet'
import { useReadSession } from '@/components/app/SessionGate'
import { listAgents, type ApiAgent } from './api/agents'
import { listOrders, buildActivityEntries, toOrderRow, type ApiOrder } from './api/orders'
import { useEscrowStatuses, useEscrowTimestampsMulti, useEscrowsInvolving, useTokenDecimals } from './chain/hooks'
import type { ActivityEntry, Order } from './agenteco-data'

const ON_CHAIN_SETTLED = 5
const ON_CHAIN_REFUNDED = 6

function shortId(id: string) {
  return id.slice(0, 8)
}

function truncateAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** An order row plus the fields needed to sort and total it. */
type OrderRowWithMeta = Order & { sortAt: number; escrowId?: bigint }

/**
 * Everything the Dashboard, Orders, and Activity pages show for the connected
 * wallet: negotiated orders from the registry, plus direct "Request Service"
 * hires that only exist on-chain (no Order row) — both with live escrow status.
 */
export function useOverview() {
  const { address, isConnected } = useWallet()
  // Orders are private: nothing is fetched until the wallet has signed in (SessionGate).
  const { signedIn } = useReadSession()
  const [agents, setAgents] = useState<ApiAgent[]>([])
  const [allAgents, setAllAgents] = useState<ApiAgent[]>([])
  const [orders, setOrders] = useState<ApiOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { data: decimals } = useTokenDecimals()

  useEffect(() => {
    if (!address || !signedIn) {
      setAgents([])
      setOrders([])
      return
    }
    setLoading(true)
    setError(null)
    Promise.all([listAgents({ ownerWallet: address }), listOrders({ ownerWallet: address }), listAgents()])
      .then(([mine, o, everyone]) => {
        setAgents(mine)
        setOrders(o)
        setAllAgents(everyone)
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load dashboard data.'))
      .finally(() => setLoading(false))
  }, [address, signedIn])

  // Direct hires: escrows where the connected wallet is the buyer, or the
  // connected wallet / one of its agents' wallets is the seller.
  const myAddresses = useMemo(
    () => (address ? [address, ...agents.map((a) => a.walletAddress).filter((w): w is string => !!w)] : []),
    [address, agents]
  )
  const escrowsQuery = useEscrowsInvolving(myAddresses)
  const directHires = useMemo(() => {
    const negotiatedIds = new Set(orders.map((o) => o.escrowId).filter(Boolean))
    return (escrowsQuery.data ?? []).filter((e) => !negotiatedIds.has(e.escrowId.toString()))
  }, [escrowsQuery.data, orders])

  const fundedOrders = useMemo(() => orders.filter((o): o is ApiOrder & { escrowId: string } => !!o.escrowId), [orders])
  // One batched read for every escrow on the page: negotiated first, then direct hires.
  const escrowIds = useMemo(
    () => [...fundedOrders.map((o) => BigInt(o.escrowId)), ...directHires.map((e) => e.escrowId)],
    [fundedOrders, directHires]
  )
  const statusesQuery = useEscrowStatuses(escrowIds)
  const timestampsQuery = useEscrowTimestampsMulti(escrowIds)

  const statusOf = useMemo(() => {
    const map = new Map<string, number>()
    escrowIds.forEach((id, i) => {
      const r = statusesQuery.data?.[i]
      if (r?.status === 'success') map.set(id.toString(), Number(r.result))
    })
    return map
  }, [escrowIds, statusesQuery.data])

  const timestampsOf = useMemo(() => {
    const map = new Map<string, readonly bigint[]>()
    escrowIds.forEach((id, i) => {
      const r = timestampsQuery.data?.[i]
      if (r?.status === 'success') map.set(id.toString(), r.result)
    })
    return map
  }, [escrowIds, timestampsQuery.data])

  const orderRows = useMemo((): OrderRowWithMeta[] => {
    const agentByWallet = new Map(
      allAgents.filter((a) => a.walletAddress).map((a) => [normalizeWallet(a.walletAddress!), a] as const)
    )
    const nameFor = (wallet: string) =>
      address && sameWallet(wallet, address) ? 'You' : (agentByWallet.get(normalizeWallet(wallet))?.name ?? truncateAddress(wallet))

    const negotiated = orders.map((o): OrderRowWithMeta => ({
      ...toOrderRow(o),
      escrowStatus: o.escrowId ? statusOf.get(o.escrowId) : undefined,
      escrowId: o.escrowId ? BigInt(o.escrowId) : undefined,
      sortAt: new Date(o.createdAt).getTime(),
    }))

    const direct = directHires.map((e): OrderRowWithMeta => {
      const createdAt = timestampsOf.get(e.escrowId.toString())?.[0]
      const sortAt = createdAt ? Number(createdAt) * 1000 : 0
      const seller = agentByWallet.get(normalizeWallet(e.seller))
      return {
        id: `Escrow #${e.escrowId}`,
        buyer: nameFor(e.buyer),
        seller: nameFor(e.seller),
        service: seller?.service ?? 'Direct hire',
        amount: decimals !== undefined ? Number(formatUnits(e.amount, decimals)) : 0,
        status: 'Escrow Funded',
        escrowStatus: statusOf.get(e.escrowId.toString()),
        createdAt: sortAt ? new Date(sortAt).toLocaleDateString() : '…',
        href: `/app/orders/onchain/${e.escrowId}`,
        escrowId: e.escrowId,
        sortAt,
      }
    })

    return [...negotiated, ...direct].sort((a, b) => b.sortAt - a.sortAt)
  }, [orders, directHires, allAgents, address, statusOf, timestampsOf, decimals])

  const settledRows = orderRows.filter((r) => r.escrowStatus === ON_CHAIN_SETTLED)
  const settledCount = settledRows.length
  const totalVolumeSettled = settledRows.reduce((sum, r) => sum + r.amount, 0)
  // Anything not settled or refunded is still in flight — including agreed-but-unfunded deals.
  const activeOrders = orderRows.filter((r) => r.escrowStatus !== ON_CHAIN_SETTLED && r.escrowStatus !== ON_CHAIN_REFUNDED).length

  const activityEntries = useMemo(() => {
    const entries = buildActivityEntries(orders)

    for (const row of orderRows) {
      if (row.escrowId === undefined) continue
      const ts = timestampsOf.get(row.escrowId.toString())
      if (!ts) continue
      const [createdAt, fundedAt, executingAt, deliveredAt, settledAt] = ts
      const label = row.href ? `direct hire ${row.id} (${row.buyer} → ${row.seller})` : `order ${shortId(row.id)}`

      const milestones: [bigint, ActivityEntry['kind'], string][] = [
        ...(row.href ? [[createdAt, 'discovery', `Escrow created for ${label}`] as [bigint, ActivityEntry['kind'], string]] : []),
        [fundedAt, 'escrow', `Escrow funded for ${label}`],
        [executingAt, 'execution', `Execution started for ${label}`],
        [deliveredAt, 'execution', `Result delivered for ${label}`],
        [settledAt, 'settlement', `Payment settled for ${label}`],
      ]
      for (const [at, kind, message] of milestones) {
        if (at > BigInt(0)) {
          const ms = Number(at) * 1000
          entries.push({ at: ms, time: new Date(ms).toLocaleString(), message, kind })
        }
      }
    }

    return entries.sort((a, b) => b.at - a.at).map(({ at: _at, ...entry }) => entry)
  }, [orders, orderRows, timestampsOf])

  return {
    isConnected,
    signedIn,
    agents,
    orders,
    orderRows,
    loading,
    error,
    settledCount,
    activeOrders,
    totalVolumeSettled,
    activityEntries,
  }
}
