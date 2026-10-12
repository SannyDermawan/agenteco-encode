'use client'
import * as evm from '@/lib/web3/hooks'
import * as solana from '@/lib/solana/compat'
import type { ReputationSummary } from '@/lib/web3/reputation'
import { useEscrowTxHashes as useEvmEscrowTxHashes, useEscrowsInvolving as useEvmEscrowsInvolving } from '@/lib/web3/escrowEvents'
import { FAMILY } from '@/lib/web3/network'
import { useSolanaEscrow } from '@/lib/solana/hooks'

/**
 * The on-chain reads the order, dispute and listing components share, for whichever kind of chain the
 * selected network is. Both families answer with the shapes AgentEco.sol's own reads have (tuples of
 * bigints in the contract's order), so a component imports a hook from here and does not care which one
 * it gets. The family is fixed for a page load (switching network reloads the app), so the rules of hooks
 * hold. Components that are EVM-only keep importing @/lib/web3/hooks directly.
 */

interface Read<T> {
  data: T | undefined
  isLoading?: boolean
  isPending?: boolean
  isError?: boolean
  refetch?: () => unknown
}

const pick = <E, S>(forEvm: E, forSolana: S): E | S => (FAMILY === 'solana' ? forSolana : forEvm)

/** [buyer, seller, amount, status]. */
export const useEscrowBasic = pick(evm.useEscrowBasic, solana.useEscrowBasic) as unknown as (escrowId?: bigint) => Read<readonly [string, string, bigint, number]> & { refetch: () => unknown }
/** [createdAt, fundedAt, executingAt, deliveredAt, settledAt]. */
export const useEscrowTimestamps = pick(evm.useEscrowTimestamps, solana.useEscrowTimestamps) as unknown as (escrowId?: bigint) => Read<readonly [bigint, bigint, bigint, bigint, bigint]> & { refetch: () => unknown }
/** [executionWindow, reviewWindow, executionDeadline, reviewDeadline]. */
export const useEscrowWindows = pick(evm.useEscrowWindows, solana.useEscrowWindows) as unknown as (escrowId?: bigint) => Read<readonly [bigint, bigint, bigint, bigint]>
/** [disputedAt, disputeDeadline, acceptDeadline, rated]. */
export const useEscrowDisputeInfo = pick(evm.useEscrowDisputeInfo, solana.useEscrowDisputeInfo) as unknown as (escrowId?: bigint, live?: boolean) => Read<readonly [bigint, bigint, bigint, boolean]> & { refetch: () => unknown }
/** [taskHash, resultHash, disputeReasonHash, disputeResponseHash, resolutionHash]. */
export const useEscrowHashes = pick(evm.useEscrowHashes, solana.useEscrowHashes) as unknown as (escrowId?: bigint, live?: boolean) => Read<readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`]>
export const useIsExecutionTimedOut = pick(evm.useIsExecutionTimedOut, solana.useIsExecutionTimedOut) as unknown as (escrowId?: bigint) => Read<boolean>
export const useIsReviewExpired = pick(evm.useIsReviewExpired, solana.useIsReviewExpired) as unknown as (escrowId?: bigint) => Read<boolean>
/** [rate in basis points, the fee on this escrow in token units]. */
export const useEscrowFee = pick(evm.useEscrowFee, solana.useEscrowFee) as unknown as (escrowId?: bigint) => { data: readonly [bigint, bigint] | undefined; isPending: boolean }
export const usePlatformFee = pick(evm.usePlatformFee, solana.usePlatformFee) as unknown as () => { data: { bps: number; treasury: string } | undefined; isPending: boolean }
export const useReputation = pick(evm.useReputation, solana.useReputation) as unknown as (address?: string) => Read<ReputationSummary> & { refetch: () => unknown }
export const useArbiter = pick(evm.useArbiter, solana.useArbiter) as unknown as (escrowId?: bigint) => { data: string | undefined; isPending: boolean }
export const useIsArbiter = pick(evm.useIsArbiter, solana.useIsArbiter) as unknown as (address?: string, escrowId?: bigint) => boolean
/** Decimals of the settlement token. */
export const useTokenDecimals = pick(evm.useUsdtDecimals, solana.useTokenDecimals) as unknown as () => { data: number | undefined; isPending: boolean }
/** The wallet's balance of the settlement token, in base units. */
export const useTokenBalance = pick(evm.useUsdtBalance, solana.useTokenBalance) as unknown as (address?: string) => { data: bigint | undefined }
/** Buyer: rate the seller 1–100, once, after the escrow is final and something was delivered. */
export const useRateSeller = pick(evm.useRateSeller, solana.useRateSeller) as unknown as () => {
  write: (escrowId: bigint, score: number) => void
  hash: string | undefined
  isPending: boolean
  isConfirming: boolean
  isSuccess: boolean
  error: Error | null
  reset: () => void
}

/** Per-stage transaction links for the timeline: read from event logs on EVM; not collected on Solana (the timeline then shows times only). */
export const useEscrowTxHashes = pick(useEvmEscrowTxHashes, () => ({ data: undefined, refetch: () => undefined })) as unknown as (escrowId?: bigint) => { data: ReturnType<typeof useEvmEscrowTxHashes>['data']; refetch: () => unknown }

/** Whether each timer has run out on the chain's clock, so a permissionless "claim" is open — Solana only (EVM reads these per action). */
export const useEscrowFlags = pick(
  () => ({ data: undefined }),
  (escrowId?: bigint) => useSolanaEscrow(escrowId, (e) => e.flags)
) as unknown as (escrowId?: bigint) => { data: { acceptTimedOut: boolean; executionTimedOut: boolean; reviewExpired: boolean; disputeTimedOut: boolean } | undefined }

interface InvolvedEscrow {
  escrowId: bigint
  buyer: string
  seller: string
  amount: bigint
  status: number
}
type Multi<T> = { status: string; result: T }[]

/** Every escrow one of the addresses is buyer or seller of (the dashboard's direct hires). */
export const useEscrowsInvolving = pick(useEvmEscrowsInvolving, solana.useEscrowsInvolving) as unknown as (addresses: string[]) => { data: InvolvedEscrow[] | undefined }
/** Statuses and timestamps of many escrows at once, shaped like a wagmi multicall's answer. */
export const useEscrowStatuses = pick(evm.useEscrowStatuses, solana.useEscrowStatuses) as unknown as (escrowIds: bigint[]) => { data: Multi<number> | undefined }
export const useEscrowTimestampsMulti = pick(evm.useEscrowTimestampsMulti, solana.useEscrowTimestampsMulti) as unknown as (escrowIds: bigint[]) => { data: Multi<readonly bigint[]> | undefined }
