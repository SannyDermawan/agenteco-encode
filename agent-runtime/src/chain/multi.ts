/**
 * Every chain family a process serves, behind one set of calls. The EVM half is ./registry.ts, the
 * Solana half ./solana-registry.ts; CHAINS lists chains of either family (default: NETWORK alone).
 * What is shared is the ChainAdapter interface; whatever needs a family's own features (viem clients,
 * ERC-8004, a signing key) asks for that family explicitly.
 */
import { EvmAdapter } from './evm.ts'
import {
  PRIMARY_CHAIN_ID,
  UnknownChainError,
  chainConfig as evmChainConfig,
  normalizeChainId as normalizeEvmChainId,
  readChain as readEvmChain,
} from './registry.ts'
import { normalizeSolanaChainId, readSolana, solanaEntry } from './solana-registry.ts'
import type { SolanaAdapter } from './solana.ts'
import type { ChainAdapter, ChainId } from './types.ts'

export { UnknownChainError }

export type ChainFamily = 'evm' | 'solana'

export const chainFamily = (chainId: ChainId): ChainFamily => (chainId.startsWith('solana:') ? 'solana' : 'evm')

/** The CAIP-2 id `input` names on any family (id, network name or alias, bare EVM chain id), or null. */
export function normalizeAnyChainId(input: string | number): ChainId | null {
  return normalizeEvmChainId(input) ?? normalizeSolanaChainId(input)
}

/** The chains this process serves (CHAINS, default NETWORK alone), the default first. Every one must be fully configured. */
export function servedChainIds(): ChainId[] {
  const raw = process.env.CHAINS?.trim()
  const list = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [PRIMARY_CHAIN_ID]
  const ids: ChainId[] = []
  for (const item of list) {
    const id = normalizeAnyChainId(item)
    if (!id) throw new Error(`CHAINS lists an unknown chain: ${item}`)
    if (!ids.includes(id)) ids.push(id)
  }
  if (ids.length === 0) throw new Error('CHAINS is empty')
  // Fail at startup, not on the first request.
  for (const id of ids) {
    if (chainFamily(id) === 'evm') evmChainConfig(id)
    else solanaEntry(id)
  }
  return ids
}

export const servedChainIdsOf = (family: ChainFamily): ChainId[] => servedChainIds().filter((id) => chainFamily(id) === family)

export function defaultChainId(): ChainId {
  return servedChainIds()[0]
}

/** The served chain `input` names, or the default one when `input` is empty. Throws UnknownChainError for one this process does not serve. */
export function resolveServedChainId(input?: string | number | null): ChainId {
  if (input === undefined || input === null || String(input).trim() === '') return defaultChainId()
  const id = normalizeAnyChainId(input)
  const served = servedChainIds()
  if (!id || !served.includes(id)) throw new UnknownChainError(`Chain ${input} is not served here. Served: ${served.join(', ')}.`)
  return id
}

/** A shared read-only adapter, for any family. */
export function readAdapter(chainId: ChainId | string = defaultChainId()): ChainAdapter {
  const id = normalizeAnyChainId(chainId)
  if (!id) throw new UnknownChainError(`Unknown chain: ${chainId}`)
  return chainFamily(id) === 'solana' ? readSolana(id) : readEvmChain(id)
}

/** The EVM adapter for an EVM chain; a clear error for any other family (what hosted agents, ERC-8004 and the like need). */
export function readEvm(chainId: ChainId | string): EvmAdapter {
  const id = normalizeAnyChainId(chainId)
  if (!id) throw new UnknownChainError(`Unknown chain: ${chainId}`)
  if (chainFamily(id) !== 'evm') throw new UnsupportedOnChainError(id, 'is not an EVM chain')
  return readEvmChain(id)
}

export function readSolanaAdapter(chainId: ChainId | string): SolanaAdapter {
  const id = normalizeAnyChainId(chainId)
  if (!id || chainFamily(id) !== 'solana') throw new UnknownChainError(`Not a Solana chain: ${chainId}`)
  return readSolana(id)
}

/** A feature this chain family does not have (yet): hosted agents on Solana, ERC-8004 off EVM. Routes answer it with a 400. */
export class UnsupportedOnChainError extends Error {
  constructor(readonly chainId: ChainId, why: string) {
    super(`${chainId} ${why}`)
    this.name = 'UnsupportedOnChainError'
  }
}
