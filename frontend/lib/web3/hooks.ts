'use client'
import { useCallback } from 'react'
import { useReadContract, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { decodeEventLog, type TransactionReceipt } from 'viem'
import {
  AGENT_ECO_ABI,
  AGENT_ECO_ADDRESS,
  ARBITER_COUNCIL_ABI,
  ERC20_ABI,
  ALL_AGENT_ECO_ADDRESSES,
  USDT_ADDRESS,
  agentEcoFor,
  hasPlatformFee,
} from './abi'
import { summarizeReputation } from './reputation'

const contract = { address: AGENT_ECO_ADDRESS, abi: AGENT_ECO_ABI } as const
/** The contract an escrow lives on: the current deployment, or the legacy one its id falls in (see ./network.ts). */
const contractFor = (escrowId: bigint | undefined) =>
  ({ address: escrowId === undefined ? AGENT_ECO_ADDRESS : agentEcoFor(escrowId), abi: AGENT_ECO_ABI }) as const

// Hosted agents move escrows forward on their own, so an open order page has
// to poll to show it live, until the escrow can't change any more.
const LIVE_POLL_MS = 5000
// AgentEco.sol OrderStatus: SETTLED / REFUNDED, terminal.
const TERMINAL_STATUSES = new Set([5, 6])

// =================================================================
// READS
// =================================================================

export function useEscrowBasic(escrowId?: bigint) {
  return useReadContract({
    ...contractFor(escrowId),
    functionName: 'getEscrowBasic',
    args: escrowId !== undefined ? [escrowId] : undefined,
    query: {
      enabled: escrowId !== undefined,
      refetchInterval: (query) => {
        const status = query.state.data?.[3]
        return status !== undefined && TERMINAL_STATUSES.has(Number(status)) ? false : LIVE_POLL_MS
      },
    },
  })
}

export function useEscrowTimestamps(escrowId?: bigint) {
  return useReadContract({
    ...contractFor(escrowId),
    functionName: 'getEscrowTimestamps',
    args: escrowId !== undefined ? [escrowId] : undefined,
    query: {
      enabled: escrowId !== undefined,
      // [createdAt, fundedAt, executingAt, deliveredAt, settledAt], done once settled.
      refetchInterval: (query) => (query.state.data && query.state.data[4] > BigInt(0) ? false : LIVE_POLL_MS),
    },
  })
}

/**
 * The arbiter, read from AgentEco.sol itself rather than hardcoded, so a new
 * deployment or an arbiter handover is picked up automatically. With an
 * escrowId, the arbiter of the deployment holding it (each has its own council).
 */
export function useArbiter(escrowId?: bigint) {
  return useReadContract({
    ...contractFor(escrowId),
    functionName: 'arbiter',
    query: { staleTime: 60_000 },
  })
}

export interface ArbiterCouncilInfo {
  address: `0x${string}`
  members: readonly `0x${string}`[]
  rulingThreshold: number
}

/**
 * The arbiter council, when AgentEco's arbiter is an ArbiterCouncil contract
 * (from v2) rather than a wallet: its members and how many votes a ruling needs.
 * Null for a wallet arbiter (the council reads fail on an address with no code).
 * With an escrowId, the council of the deployment holding it.
 */
export function useArbiterCouncil(escrowId?: bigint): ArbiterCouncilInfo | null | undefined {
  const { data: arbiter } = useArbiter(escrowId)
  const { data, isPending } = useReadContracts({
    allowFailure: true,
    contracts: arbiter
      ? [
          { address: arbiter, abi: ARBITER_COUNCIL_ABI, functionName: 'getMembers' },
          { address: arbiter, abi: ARBITER_COUNCIL_ABI, functionName: 'rulingThreshold' },
        ]
      : [],
    query: { enabled: !!arbiter, staleTime: 60_000 },
  })
  if (!arbiter || isPending) return undefined
  const [members, threshold] = data ?? []
  if (members?.status !== 'success' || threshold?.status !== 'success') return null
  return { address: arbiter, members: members.result as readonly `0x${string}`[], rulingThreshold: Number(threshold.result) }
}

/**
 * True when `address` can rule disputes: the arbiter wallet, or a member of the
 * arbiter council, of the deployment holding `escrowId`, or the current one.
 */
export function useIsArbiter(address?: string, escrowId?: bigint) {
  const { data: arbiter } = useArbiter(escrowId)
  const council = useArbiterCouncil(escrowId)
  if (!address || !arbiter) return false
  const a = address.toLowerCase()
  if (council) return council.members.some((m) => m.toLowerCase() === a)
  return a === arbiter.toLowerCase()
}

export function useEscrowWindows(escrowId?: bigint) {
  return useReadContract({
    ...contractFor(escrowId),
    functionName: 'getEscrowWindows',
    args: escrowId !== undefined ? [escrowId] : undefined,
    query: { enabled: escrowId !== undefined },
  })
}

export function useResultHash(escrowId?: bigint) {
  return useReadContract({
    ...contractFor(escrowId),
    functionName: 'getResultHash',
    args: escrowId !== undefined ? [escrowId] : undefined,
    query: { enabled: escrowId !== undefined },
  })
}

export function useEscrowStatus(escrowId?: bigint) {
  return useReadContract({
    ...contractFor(escrowId),
    functionName: 'getEscrowStatus',
    args: escrowId !== undefined ? [escrowId] : undefined,
    query: { enabled: escrowId !== undefined },
  })
}

export function useIsExecutionTimedOut(escrowId?: bigint) {
  return useReadContract({
    ...contractFor(escrowId),
    functionName: 'isExecutionTimedOut',
    args: escrowId !== undefined ? [escrowId] : undefined,
    query: { enabled: escrowId !== undefined },
  })
}

export function useIsReviewExpired(escrowId?: bigint) {
  return useReadContract({
    ...contractFor(escrowId),
    functionName: 'isReviewExpired',
    args: escrowId !== undefined ? [escrowId] : undefined,
    query: { enabled: escrowId !== undefined },
  })
}

/** Batched (multicall) read, for a dashboard aggregating many orders at once. */
export function useEscrowStatuses(escrowIds: bigint[]) {
  return useReadContracts({
    contracts: escrowIds.map((id) => ({ ...contractFor(id), functionName: 'getEscrowStatus' as const, args: [id] as const })),
    query: { enabled: escrowIds.length > 0 },
  })
}

export function useEscrowTimestampsMulti(escrowIds: bigint[]) {
  return useReadContracts({
    contracts: escrowIds.map((id) => ({ ...contractFor(id), functionName: 'getEscrowTimestamps' as const, args: [id] as const })),
    query: { enabled: escrowIds.length > 0 },
  })
}

/** [disputedAt, disputeDeadline, acceptDeadline, rated], polled until the escrow is final and rated. */
export function useEscrowDisputeInfo(escrowId?: bigint, live = true) {
  return useReadContract({
    ...contractFor(escrowId),
    functionName: 'getEscrowDisputeInfo',
    args: escrowId !== undefined ? [escrowId] : undefined,
    query: { enabled: escrowId !== undefined, refetchInterval: live ? LIVE_POLL_MS : false },
  })
}

/** [taskHash, resultHash, disputeReasonHash, disputeResponseHash, resolutionHash]. */
export function useEscrowHashes(escrowId?: bigint, live = true) {
  return useReadContract({
    ...contractFor(escrowId),
    functionName: 'getEscrowHashes',
    args: escrowId !== undefined ? [escrowId] : undefined,
    query: { enabled: escrowId !== undefined, refetchInterval: live ? LIVE_POLL_MS : false },
  })
}

const REPUTATION_CONTRACTS = ALL_AGENT_ECO_ADDRESSES

/**
 * On-chain reputation for `address`, as a named summary (see ./reputation.ts),
 * summed over every AgentEco deployment (v3, v2, v1), so a seller keeps its history.
 */
export function useReputation(address?: `0x${string}`) {
  return useReadContracts({
    allowFailure: false,
    contracts: address
      ? REPUTATION_CONTRACTS.map((a) => ({ address: a, abi: AGENT_ECO_ABI, functionName: 'getReputation' as const, args: [address] as const }))
      : [],
    query: {
      enabled: !!address,
      select: (rows) => {
        const sum: [bigint, bigint, bigint, bigint, bigint] = [BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0)]
        for (const row of rows) for (let i = 0; i < 5; i++) sum[i] += (row as readonly bigint[])[i]
        return summarizeReputation(sum)
      },
    },
  })
}

export interface PlatformFee {
  /** Basis points: 250 = 2.5%. */
  bps: number
  treasury: `0x${string}`
}

/**
 * The platform fee new escrows are created with (AgentEco v3): a share of the
 * price paid to the treasury when an escrow settles to the seller. Refunds are free.
 */
export function usePlatformFee() {
  return useReadContracts({
    allowFailure: false,
    contracts: [
      { ...contract, functionName: 'feeBps' },
      { ...contract, functionName: 'treasury' },
    ],
    query: {
      staleTime: 60_000,
      select: ([bps, treasury]): PlatformFee => ({ bps: Number(bps), treasury }),
    },
  })
}

/**
 * The fee one escrow pays, fixed when it was created: [rate in bps, fee in token
 * units]. Escrows on v1 and v2 have no fee, so this is [0, 0] for them without a read.
 */
export function useEscrowFee(escrowId?: bigint) {
  const charged = escrowId !== undefined && hasPlatformFee(escrowId)
  const read = useReadContract({
    ...contract,
    functionName: 'getEscrowFee',
    args: charged ? [escrowId] : undefined,
    query: { enabled: charged, staleTime: Infinity },
  })
  if (escrowId !== undefined && !charged) return { data: [BigInt(0), BigInt(0)] as const, isPending: false }
  return { data: read.data, isPending: read.isPending }
}

export function useUsdtBalance(address?: `0x${string}`) {
  return useReadContract({
    address: USDT_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  })
}

export function useUsdtDecimals() {
  return useReadContract({
    address: USDT_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'decimals',
  })
}

export function useUsdtAllowance(owner?: `0x${string}`) {
  return useReadContract({
    address: USDT_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: owner ? [owner, AGENT_ECO_ADDRESS] : undefined,
    query: { enabled: !!owner },
  })
}

// =================================================================
// WRITES, shared shape: { write, hash, isPending, isConfirming, isSuccess, error, reset }
// =================================================================

// Actions that take only the escrow id. Dispute actions also carry a hash,
// see useHashedEscrowAction below.
type SimpleEscrowAction =
  | 'startExecution'
  | 'fundEscrow'
  | 'acceptAndSettle'
  | 'refundEscrow'
  | 'claimAcceptTimeout'
  | 'claimExecutionTimeout'
  | 'finalizeAfterReviewWindow'
  | 'claimDisputeTimeout'

type HashedEscrowAction = 'raiseDispute' | 'submitDisputeResponse' | 'resolveDisputeForSeller' | 'resolveDisputeForBuyer'

function useEscrowAction(functionName: SimpleEscrowAction) {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  const write = useCallback(
    (escrowId: bigint) => {
      writeContract({ ...contractFor(escrowId), functionName, args: [escrowId] })
    },
    [writeContract, functionName]
  )

  return { write, hash, isPending, isConfirming, isSuccess, error, reset }
}

/** Dispute actions: (escrowId, keccak256 of the off-chain text or rationale object). */
function useHashedEscrowAction(functionName: HashedEscrowAction) {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  const write = useCallback(
    (escrowId: bigint, textOrRationaleHash: `0x${string}`) => {
      writeContract({ ...contractFor(escrowId), functionName, args: [escrowId, textOrRationaleHash] })
    },
    [writeContract, functionName]
  )

  return { write, hash, isPending, isConfirming, isSuccess, error, reset }
}

export function useStartExecution() {
  return useEscrowAction('startExecution')
}

export function useFundEscrow() {
  return useEscrowAction('fundEscrow')
}

export function useAcceptAndSettle() {
  return useEscrowAction('acceptAndSettle')
}

export function useRaiseDispute() {
  return useHashedEscrowAction('raiseDispute')
}

export function useSubmitDisputeResponse() {
  return useHashedEscrowAction('submitDisputeResponse')
}

export function useClaimAcceptTimeout() {
  return useEscrowAction('claimAcceptTimeout')
}

export function useClaimDisputeTimeout() {
  return useEscrowAction('claimDisputeTimeout')
}

export function useRefundEscrow() {
  return useEscrowAction('refundEscrow')
}

export function useClaimExecutionTimeout() {
  return useEscrowAction('claimExecutionTimeout')
}

export function useFinalizeAfterReviewWindow() {
  return useEscrowAction('finalizeAfterReviewWindow')
}

export function useResolveDisputeForSeller() {
  return useHashedEscrowAction('resolveDisputeForSeller')
}

export function useResolveDisputeForBuyer() {
  return useHashedEscrowAction('resolveDisputeForBuyer')
}

/** Buyer: rateSeller(escrowId, score 1–100), once, after the escrow is final and something was delivered. */
export function useRateSeller() {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  const write = useCallback(
    (escrowId: bigint, score: number) => {
      writeContract({ ...contractFor(escrowId), functionName: 'rateSeller', args: [escrowId, score] })
    },
    [writeContract]
  )

  return { write, hash, isPending, isConfirming, isSuccess, error, reset }
}

export function useMarkDelivered() {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  const write = useCallback(
    (escrowId: bigint, resultHash: `0x${string}`) => {
      writeContract({ ...contractFor(escrowId), functionName: 'markDelivered', args: [escrowId, resultHash] })
    },
    [writeContract]
  )

  return { write, hash, isPending, isConfirming, isSuccess, error, reset }
}

export function useApproveUsdt() {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  const write = useCallback(
    (amount: bigint) => {
      writeContract({ address: USDT_ADDRESS, abi: ERC20_ABI, functionName: 'approve', args: [AGENT_ECO_ADDRESS, amount] })
    },
    [writeContract]
  )

  return { write, hash, isPending, isConfirming, isSuccess, error, reset }
}

/**
 * createEscrow doesn't hand back its return value directly (that's only
 * possible for a plain eth_call, not a state-changing tx), the new
 * escrowId has to be read out of the EscrowCreated event once the
 * transaction is mined, via the receipt this hook already waits for.
 */
export function useCreateEscrow() {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract()
  const { data: receipt, isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  const write = useCallback(
    (seller: `0x${string}`, amount: bigint, executionWindow: bigint, reviewWindow: bigint, taskHash: `0x${string}`) => {
      writeContract({
        ...contract,
        functionName: 'createEscrow',
        args: [seller, amount, executionWindow, reviewWindow, taskHash],
      })
    },
    [writeContract]
  )

  const escrowId = receipt ? parseCreatedEscrowId(receipt) : null

  return { write, hash, isPending, isConfirming, isSuccess, escrowId, error, reset }
}

export function parseCreatedEscrowId(receipt: TransactionReceipt): bigint | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== AGENT_ECO_ADDRESS.toLowerCase()) continue
    try {
      const decoded = decodeEventLog({ abi: AGENT_ECO_ABI, data: log.data, topics: log.topics })
      if (decoded.eventName === 'EscrowCreated') {
        return (decoded.args as { escrowId: bigint }).escrowId
      }
    } catch {
      continue
    }
  }
  return null
}
