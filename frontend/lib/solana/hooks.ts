'use client'
import './polyfills'
import { useQuery } from '@tanstack/react-query'
import type { EscrowBasic, EscrowDisputeInfo, EscrowHashes, EscrowTimestamps, EscrowWindows, OnchainReputation, TokenInfo } from '@runtime/chain/types.ts'
import { SOLANA } from '@/lib/web3/network'
import { solanaReader } from './chain'

/** Reads of the escrow program for the Solana pages: polled while an escrow can still change. */

const LIVE_POLL_MS = 5000
const TERMINAL = new Set([5, 6]) // SETTLED, REFUNDED — the EVM contract's numbering, which the adapter keeps

const chainKey = SOLANA?.chainKey ?? 'solana'

/** The settlement token's mint info (decimals). */
export function useSolanaToken() {
  return useQuery<TokenInfo>({ queryKey: [chainKey, 'token'], queryFn: () => solanaReader().token(), staleTime: Infinity })
}

/** SOL and settlement-token balances of a wallet, in base units. */
export function useSolanaBalances(address: string | undefined) {
  return useQuery({
    queryKey: [chainKey, 'balances', address],
    enabled: !!address,
    refetchInterval: 10_000,
    queryFn: async () => {
      const reader = solanaReader()
      const [sol, token] = await Promise.all([reader.nativeBalance(address!), reader.tokenBalance(address!)])
      return { sol, token }
    },
  })
}

/** The platform fee (basis points) new escrows pay when they settle to the seller. */
export function useSolanaPlatformFee() {
  return useQuery({ queryKey: [chainKey, 'platformFee'], queryFn: () => solanaReader().platformFeeBps(), staleTime: 60_000 })
}

export interface SolanaEscrow {
  basic: EscrowBasic
  timestamps: EscrowTimestamps
  windows: EscrowWindows
  dispute: EscrowDisputeInfo
  hashes: EscrowHashes
  feeBps: number
  /** Whether the seller's `execution` / the review window / accept / dispute timers have run out on the chain's own clock. */
  flags: { acceptTimedOut: boolean; executionTimedOut: boolean; reviewExpired: boolean; disputeTimedOut: boolean }
}

/** Everything the order page shows about one escrow, read together so the page never mixes two moments. */
export function useSolanaEscrow(escrowId: bigint | undefined) {
  return useQuery<SolanaEscrow>({
    queryKey: [chainKey, 'escrow', escrowId?.toString()],
    enabled: escrowId !== undefined,
    refetchInterval: (query) => (query.state.data && TERMINAL.has(query.state.data.basic.status) ? false : LIVE_POLL_MS),
    retry: 1,
    queryFn: async () => {
      const reader = solanaReader()
      const id = escrowId!
      const [basic, timestamps, windows, dispute, hashes, feeBps, acceptTimedOut, executionTimedOut, reviewExpired, disputeTimedOut] = await Promise.all([
        reader.getEscrowBasic(id),
        reader.getEscrowTimestamps(id),
        reader.getEscrowWindows(id),
        reader.getEscrowDisputeInfo(id),
        reader.getEscrowHashes(id),
        reader.escrowFeeBps(id),
        reader.readTimeoutFlag(id, 'acceptTimedOut'),
        reader.readTimeoutFlag(id, 'executionTimedOut'),
        reader.readTimeoutFlag(id, 'reviewExpired'),
        reader.readTimeoutFlag(id, 'disputeTimedOut'),
      ])
      return { basic, timestamps, windows, dispute, hashes, feeBps, flags: { acceptTimedOut, executionTimedOut, reviewExpired, disputeTimedOut } }
    },
  })
}

/** A seller's on-chain record. */
export function useSolanaReputation(seller: string | undefined) {
  return useQuery<OnchainReputation>({
    queryKey: [chainKey, 'reputation', seller],
    enabled: !!seller,
    refetchInterval: 15_000,
    queryFn: () => solanaReader().getReputation(seller!),
  })
}

/** The arbiter wallet of the program (a wallet, or the multisig vault standing in for a council). */
export function useSolanaArbiter() {
  return useQuery({ queryKey: [chainKey, 'arbiter'], queryFn: () => solanaReader().getArbiterSetup(), staleTime: 60_000 })
}
