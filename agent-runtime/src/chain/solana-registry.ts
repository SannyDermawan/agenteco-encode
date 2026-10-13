import { address, createKeyPairSignerFromBytes, getBase58Encoder, type TransactionSigner } from '@solana/kit'
import { readFileSync } from 'node:fs'
import { EXECUTION_WINDOW_SECONDS, REVIEW_WINDOW_SECONDS } from '../durations.ts'
import { SolanaAdapter, isSolanaChainId, type SolanaBackend, type SolanaChainConfig } from './solana.ts'
import { SOLANA_PRESETS } from './solana-presets.ts'
import { SolanaRpcBackend } from './solana-rpc.ts'
import type { ChainId } from './types.ts'

export { SOLANA_PRESETS }

/**
 * The Solana chains a process can talk to. Like the EVM registry (./registry.ts) a chain with a
 * preset is configured by setting names with its CAIP-2 id as a suffix, the colon as an underscore:
 *
 *   RPC_URL__solana_<genesis prefix>            default: the preset's public RPC
 *   AGENT_ECO_PROGRAM__solana_<…>               required: the deployed escrow program (no default deployment)
 *   TOKEN_MINT__solana_<…>                      default: the preset's settlement mint (devnet USDC)
 *   FIRST_ESCROW_ID__solana_<…>                 default 1
 *
 * Entries are built on first use (resetSolanaRegistry() in tests). Tests and embedders can register a
 * chain with its own backend (registerSolanaChain), e.g. the in-process litesvm one.
 */

/** `solana-devnet`, `solana:EtWT…`, anything that names a Solana chain, known or not. */
export function isSolanaChainRef(input: string | number): boolean {
  return /^solana([:-]|$)/i.test(String(input).trim())
}

/** The CAIP-2 id of the Solana chain `input` names (a preset's id, name or alias, or a registered chain's id), or null. */
export function normalizeSolanaChainId(input: string | number): ChainId | null {
  const raw = String(input).trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  for (const [name, preset] of Object.entries(SOLANA_PRESETS)) {
    if (lower === name || preset.aliases.includes(lower) || raw === preset.chainId) return preset.chainId
  }
  return isSolanaChainId(raw) && registered.has(raw) ? raw : null
}

export interface SolanaEntry {
  config: SolanaChainConfig
  rpcUrl: string
  testnet: boolean
  name: string
  backend: SolanaBackend
}

const registered = new Map<ChainId, SolanaEntry>()
let entries = new Map<ChainId, SolanaEntry>()
let readers = new Map<ChainId, SolanaAdapter>()

export function resetSolanaRegistry(): void {
  entries = new Map()
  readers = new Map()
  registered.clear()
}

/** Serves a Solana chain with an explicit config and backend (tests; an embedder with its own RPC client). */
export function registerSolanaChain(entry: SolanaEntry): void {
  registered.set(entry.config.chainId, entry)
  readers.delete(entry.config.chainId)
}

const envSuffix = (chainId: ChainId) => chainId.replace(/[^A-Za-z0-9]/g, '_')

function buildEntry(chainId: ChainId): SolanaEntry {
  const preset = Object.values(SOLANA_PRESETS).find((p) => p.chainId === chainId)
  if (!preset) throw new Error(`No preset for Solana chain ${chainId}.`)
  const suffix = envSuffix(chainId)
  const env = (name: string): string | undefined => process.env[`${name}__${suffix}`]?.trim() || undefined
  const pubkey = (key: string, fallbackValue?: string) => {
    const value = env(key) ?? fallbackValue
    if (!value) throw new Error(`${key}__${suffix} must be set: there is no default AgentEco deployment on ${preset.name}.`)
    try {
      return address(value)
    } catch {
      throw new Error(`${key}__${suffix} is not a valid Solana address: ${value}`)
    }
  }
  const first = env('FIRST_ESCROW_ID') ?? '1'
  if (!/^\d+$/.test(first) || BigInt(first) < 1n) throw new Error(`FIRST_ESCROW_ID__${suffix} must be a positive integer, got: ${first}`)
  const rpcUrl = env('RPC_URL') ?? preset.rpcUrl
  return {
    config: {
      chainId,
      programId: pubkey('AGENT_ECO_PROGRAM'),
      mint: pubkey('TOKEN_MINT', preset.defaultMint),
      tokenSymbol: preset.tokenSymbol,
      nativeSymbol: preset.nativeSymbol,
      explorerUrl: preset.explorerUrl,
      explorerName: preset.explorerName,
      explorerQuery: preset.explorerQuery,
      executionWindow: BigInt(EXECUTION_WINDOW_SECONDS),
      reviewWindow: BigInt(REVIEW_WINDOW_SECONDS),
      firstEscrowId: BigInt(first),
    },
    rpcUrl,
    testnet: preset.testnet,
    name: preset.name,
    backend: new SolanaRpcBackend(rpcUrl),
  }
}

/** A served Solana chain's entry (built from the environment on first use). Throws for a chain nobody configured. */
export function solanaEntry(chainId: ChainId): SolanaEntry {
  const own = registered.get(chainId)
  if (own) return own
  let e = entries.get(chainId)
  if (!e) entries.set(chainId, (e = buildEntry(chainId)))
  return e
}

/** A shared read-only adapter for a Solana chain. */
export function readSolana(chainId: ChainId): SolanaAdapter {
  let reader = readers.get(chainId)
  if (!reader) {
    const e = solanaEntry(chainId)
    reader = new SolanaAdapter(e.config, e.backend, null)
    readers.set(chainId, reader)
  }
  return reader
}

/** An adapter that signs with `signer` on a Solana chain. */
export function signerSolana(chainId: ChainId, signer: TransactionSigner): SolanaAdapter {
  const e = solanaEntry(chainId)
  return new SolanaAdapter(e.config, e.backend, signer)
}

/** A signer from a Solana CLI keypair file (a JSON array of 64 secret-key bytes). The file is read, never logged. */
export async function solanaSignerFromFile(path: string): Promise<TransactionSigner> {
  const bytes = JSON.parse(readFileSync(path, 'utf8')) as number[]
  return createKeyPairSignerFromBytes(new Uint8Array(bytes))
}

/**
 * A signer from a secret key given as text: a JSON array of 64 bytes (a Solana CLI keypair) or base58 (what
 * wallets export). For a host that keeps its key in an environment variable, where a file is no use. Never logged.
 */
export async function solanaSignerFromSecret(secret: string): Promise<TransactionSigner> {
  const text = secret.trim()
  const bytes = text.startsWith('[') ? Uint8Array.from(JSON.parse(text) as number[]) : new Uint8Array(getBase58Encoder().encode(text))
  return createKeyPairSignerFromBytes(bytes)
}
