'use client'
import './polyfills'
import { useQuery } from '@tanstack/react-query'
import { normalizeWallet } from '@shared/wallets'
import { summarizeReputation } from '@/lib/web3/reputation'
import { SOLANA } from '@/lib/web3/network'
import { solanaReader } from './chain'
import { useSolanaAction } from './actions'
import { useSolanaBalances, useSolanaEscrow, useSolanaPlatformFee, useSolanaReputationCounters, useSolanaToken, useSolanaArbiter } from './hooks'

/**
 * The Solana side of lib/chain/hooks.ts: the escrow reads the shared order components use, answering with
 * the same shapes the EVM contract's reads have (tuples of bigints, in the same order), so those
 * components run unchanged on either family. Escrow ids on Solana are u64, the amounts SPL base units.
 */

const hex32 = (h: string) => h as `0x${string}`

export function useEscrowBasic(escrowId?: bigint) {
  return useSolanaEscrow(escrowId, (e) => [e.basic.buyer, e.basic.seller, e.basic.amount, e.basic.status] as const)
}

export function useEscrowTimestamps(escrowId?: bigint) {
  return useSolanaEscrow(escrowId, (e) => [e.timestamps.createdAt, e.timestamps.fundedAt, e.timestamps.executingAt, e.timestamps.deliveredAt, e.timestamps.settledAt] as const)
}

/** [executionWindow, reviewWindow, executionDeadline, reviewDeadline]. */
export function useEscrowWindows(escrowId?: bigint) {
  return useSolanaEscrow(escrowId, (e) => [e.windows.executionWindow, e.windows.reviewWindow, e.windows.executionDeadline, e.windows.reviewDeadline] as const)
}

/** [disputedAt, disputeDeadline, acceptDeadline, rated]. */
export function useEscrowDisputeInfo(escrowId?: bigint, _live = true) {
  void _live
  return useSolanaEscrow(escrowId, (e) => [e.dispute.disputedAt, e.dispute.disputeDeadline, e.dispute.acceptDeadline, e.dispute.rated] as const)
}

/** [taskHash, resultHash, disputeReasonHash, disputeResponseHash, resolutionHash]. */
export function useEscrowHashes(escrowId?: bigint, _live = true) {
  void _live
  return useSolanaEscrow(escrowId, (e) => [hex32(e.hashes.taskHash), hex32(e.hashes.resultHash), hex32(e.hashes.disputeReasonHash), hex32(e.hashes.disputeResponseHash), hex32(e.hashes.resolutionHash)] as const)
}

export function useIsExecutionTimedOut(escrowId?: bigint) {
  return useSolanaEscrow(escrowId, (e) => e.flags.executionTimedOut)
}

export function useIsReviewExpired(escrowId?: bigint) {
  return useSolanaEscrow(escrowId, (e) => e.flags.reviewExpired)
}

/** [rate in basis points, the fee on this escrow's amount in token units]. */
export function useEscrowFee(escrowId?: bigint) {
  const { data, isPending } = useSolanaEscrow(escrowId, (e) => [BigInt(e.feeBps), (e.basic.amount * BigInt(e.feeBps)) / BigInt(10_000)] as const)
  return { data, isPending }
}

export function usePlatformFee() {
  const { data, isPending } = useSolanaPlatformFee()
  return { data: data === undefined ? undefined : { bps: data, treasury: '' }, isPending }
}

export function useReputation(address?: string) {
  const query = useSolanaReputationCounters(address)
  return { ...query, data: query.data ? summarizeReputation(query.data) : undefined }
}

export function useArbiter(_escrowId?: bigint) {
  void _escrowId
  const { data, isPending } = useSolanaArbiter()
  return { data: data?.arbiter, isPending }
}

/** A Solana arbiter is one signer (a wallet, or a multisig's vault): there is no council contract to read. */
export function useArbiterCouncil(_escrowId?: bigint): null | undefined {
  void _escrowId
  const { isPending } = useSolanaArbiter()
  return isPending ? undefined : null
}

export function useIsArbiter(address?: string, _escrowId?: bigint) {
  void _escrowId
  const { data } = useSolanaArbiter()
  return !!address && !!data && address === data.arbiter
}

export function useTokenDecimals() {
  const { data, isPending } = useSolanaToken()
  return { data: data?.decimals, isPending }
}

export function useTokenBalance(address?: string) {
  const { data } = useSolanaBalances(address)
  return { data: data?.token }
}

/** Buyer: rateSeller(escrowId, score 1–100). */
export function useRateSeller() {
  const action = useSolanaAction((adapter, escrowId: bigint, score: number) => adapter.rateSeller(escrowId, score))
  return { ...action, write: (escrowId: bigint, score: number) => void action.run(escrowId, score) }
}

/** Every escrow one of `addresses` is the buyer or seller of, found by reading the program's escrows. */
export function useEscrowsInvolving(addresses: string[]) {
  const mine = [...new Set(addresses.map(normalizeWallet))].sort()
  return useQuery({
    queryKey: [SOLANA?.chainKey, 'escrowsInvolving', mine],
    enabled: mine.length > 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      const set = new Set(mine)
      return (await solanaReader().listEscrows())
        .filter((e) => set.has(normalizeWallet(e.buyer)) || set.has(normalizeWallet(e.seller)))
        .map((e) => ({ escrowId: e.id, buyer: e.buyer, seller: e.seller, amount: e.amount, status: e.status }))
    },
  })
}

type Multi<T> = { status: 'success'; result: T }[]

/** Statuses of many escrows, in the shape a wagmi multicall answers with. */
export function useEscrowStatuses(escrowIds: bigint[]) {
  return useQuery({
    queryKey: [SOLANA?.chainKey, 'statuses', escrowIds.map(String)],
    enabled: escrowIds.length > 0,
    refetchInterval: 15_000,
    queryFn: async (): Promise<Multi<number>> => (await solanaReader().readEscrowBasics(escrowIds)).map((e) => ({ status: 'success', result: e.status })),
  })
}

/** Timestamps of many escrows: [createdAt, fundedAt, executingAt, deliveredAt, settledAt] each. */
export function useEscrowTimestampsMulti(escrowIds: bigint[]) {
  return useQuery({
    queryKey: [SOLANA?.chainKey, 'timestampsMulti', escrowIds.map(String)],
    enabled: escrowIds.length > 0,
    refetchInterval: 15_000,
    queryFn: async (): Promise<Multi<readonly bigint[]>> =>
      Promise.all(
        escrowIds.map(async (id) => {
          const t = await solanaReader().getEscrowTimestamps(id)
          return { status: 'success' as const, result: [t.createdAt, t.fundedAt, t.executingAt, t.deliveredAt, t.settledAt] as readonly bigint[] }
        })
      ),
  })
}
