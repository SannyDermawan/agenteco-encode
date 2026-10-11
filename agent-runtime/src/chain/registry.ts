import { createPublicClient, createWalletClient, defineChain, fallback, http, isAddress, nonceManager, type Address, type Hex, type PublicClient, type Transport } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { EXECUTION_WINDOW_SECONDS, REVIEW_WINDOW_SECONDS } from '../durations.ts'
import { NETWORK_ALIASES, NETWORK_PRESETS, RPC_TIMEOUT_MS, RPC_URLS, appChain, appTransport, type NetworkName } from '../network.ts'
import { defaultEvmConfig } from './default.ts'
import { EvmAdapter, type EvmChainConfig } from './evm.ts'
import { erc8004FromSettings } from '../shared/erc8004.ts'
import type { ChainId } from './types.ts'

/**
 * Every chain a process can talk to, and the ones it serves.
 *
 * - The primary chain is NETWORK (default bsc-testnet), configured exactly as before by the
 *   unsuffixed env (RPC_URL, AGENT_ECO_ADDRESS, …) — see ../network.ts and ./default.ts.
 * - Any other chain with a preset is configured by the same names with its CAIP-2 id as a
 *   suffix, the colon written as an underscore: RPC_URL__eip155_84532, AGENT_ECO_ADDRESS__eip155_84532,
 *   USDT_ADDRESS__…, RPC_FALLBACK_URLS__…, DEPLOYMENT_BLOCK__…, LOG_RANGE_BLOCKS__…,
 *   HOSTED_MIN_GAS__…, LOW_GAS_WARN__…, ERC8004_IDENTITY_REGISTRY__…, ERC8004_REPUTATION_REGISTRY__….
 * - CHAINS (comma-separated CAIP-2 ids or network names) lists the chains the backend serves
 *   — its keeper, host and API. Unset, it serves the primary chain only, as before.
 *
 * Entries are built on first use, so tests can set the env first (resetChainRegistry()).
 */

export class UnknownChainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnknownChainError'
  }
}

/** The primary chain's id. */
export const PRIMARY_CHAIN_ID: ChainId = `eip155:${appChain.id}`

/** `eip155:84532` → `eip155_84532`, the suffix of that chain's env overrides. */
export function envSuffix(chainId: ChainId): string {
  return chainId.replace(/[^A-Za-z0-9]/g, '_')
}

const presetChainId = (name: NetworkName): ChainId => `eip155:${NETWORK_PRESETS[name].chainId}`

/**
 * A CAIP-2 id for a CAIP-2 id, a network name or alias ("base-sepolia", "testnet") or a
 * bare EVM chain id (97, "97"); null when it names no known chain.
 */
export function normalizeChainId(input: string | number): ChainId | null {
  const raw = String(input).trim().toLowerCase()
  if (!raw) return null
  const caip = /^\d+$/.test(raw) ? `eip155:${raw}` : raw
  if (caip === PRIMARY_CHAIN_ID) return PRIMARY_CHAIN_ID
  const name = (NETWORK_ALIASES[raw] ?? raw) as NetworkName
  if (name in NETWORK_PRESETS) return presetChainId(name)
  const byId = (Object.keys(NETWORK_PRESETS) as NetworkName[]).find((n) => presetChainId(n) === caip)
  return byId ? presetChainId(byId) : null
}

interface ChainEntry {
  config: EvmChainConfig
  transport: Transport
  rpcUrls: string[]
}

function suffixedEnv(chainId: ChainId) {
  const suffix = envSuffix(chainId)
  return (name: string): string | undefined => process.env[`${name}__${suffix}`]?.trim() || undefined
}

function transportFor(urls: string[]): Transport {
  const transports = urls.map((url) => http(url, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }))
  return transports.length === 1 ? transports[0] : fallback(transports)
}

function buildEntry(chainId: ChainId): ChainEntry {
  if (chainId === PRIMARY_CHAIN_ID) return { config: defaultEvmConfig(), transport: appTransport(), rpcUrls: RPC_URLS }

  const name = (Object.keys(NETWORK_PRESETS) as NetworkName[]).find((n) => presetChainId(n) === chainId)
  if (!name) throw new UnknownChainError(`No preset for chain ${chainId}.`)
  const preset = NETWORK_PRESETS[name]
  const env = suffixedEnv(chainId)
  const suffix = envSuffix(chainId)

  const address = (key: string, fallbackValue: Address | undefined): Address => {
    const value = env(key) ?? fallbackValue
    if (!value) throw new Error(`${key}__${suffix} must be set: there is no default AgentEco deployment on ${preset.name}.`)
    if (!isAddress(value)) throw new Error(`${key}__${suffix} is not a valid EVM address: ${value}`)
    return value
  }
  const block = (key: string, fallbackValue: bigint | undefined): bigint | null => {
    const value = env(key)
    if (!value) return fallbackValue ?? null
    if (!/^\d+$/.test(value)) throw new Error(`${key}__${suffix} must be an integer block number, got: ${value}`)
    return BigInt(value)
  }

  const ownDeployment = env('AGENT_ECO_ADDRESS') !== undefined
  const deployment = preset.deployment
  const firstEscrowId = ownDeployment ? BigInt(1) : (deployment?.firstEscrowId ?? BigInt(1))
  const legacyList = ownDeployment ? [] : (deployment?.legacy ?? [])
  const legacy = legacyList.map((d, i) => ({
    address: d.agentEcoAddress,
    firstEscrowId: d.firstEscrowId,
    endEscrowId: legacyList[i + 1]?.firstEscrowId ?? firstEscrowId,
  }))

  const fallbacks = env('RPC_FALLBACK_URLS')
  const rpcUrls = [
    env('RPC_URL') ?? preset.rpcUrl,
    ...(fallbacks?.toLowerCase() === 'none' ? [] : (fallbacks?.split(',').map((u) => u.trim()).filter(Boolean) ?? preset.fallbackRpcUrls ?? [])),
  ].filter((url, i, all) => all.indexOf(url) === i)

  const chain = defineChain({
    id: preset.chainId,
    name: preset.name,
    nativeCurrency: { name: preset.nativeSymbol, symbol: preset.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: rpcUrls } },
    blockExplorers: { default: { name: preset.explorerName, url: preset.explorerUrl } },
    contracts: preset.multicall3 ? { multicall3: { address: preset.multicall3 } } : undefined,
    testnet: preset.testnet,
  })

  return {
    config: {
      chainId,
      chain,
      agentEco: address('AGENT_ECO_ADDRESS', deployment?.agentEcoAddress),
      usdt: address('USDT_ADDRESS', preset.usdtAddress),
      tokenSymbol: preset.tokenSymbol,
      nativeSymbol: preset.nativeSymbol,
      explorerUrl: preset.explorerUrl,
      explorerName: preset.explorerName,
      executionWindow: EXECUTION_WINDOW_SECONDS,
      reviewWindow: REVIEW_WINDOW_SECONDS,
      firstEscrowId,
      legacy,
      deploymentBlock: block('DEPLOYMENT_BLOCK', deployment?.deploymentBlock),
      logRange: block('LOG_RANGE_BLOCKS', preset.logRange) ?? preset.logRange,
      hostedMinGas: env('HOSTED_MIN_GAS') ?? preset.hostedMinGas,
      lowGasWarn: env('LOW_GAS_WARN') ?? preset.lowGasWarn,
      erc8004: erc8004FromSettings(env, `__${suffix}`) ?? preset.erc8004 ?? null,
    },
    transport: transportFor(rpcUrls),
    rpcUrls,
  }
}

let entries = new Map<ChainId, ChainEntry>()
let readers = new Map<ChainId, EvmAdapter>()
let served: ChainId[] | undefined

/** Forget every built entry, so the next call re-reads the env (tests). */
export function resetChainRegistry(): void {
  entries = new Map()
  readers = new Map()
  served = undefined
}

function entry(chainId: ChainId): ChainEntry {
  let e = entries.get(chainId)
  if (!e) entries.set(chainId, (e = buildEntry(chainId)))
  return e
}

/** The EVM chains this process serves (CHAINS), the default one first; Solana ones are listed by ./multi.ts. Each must be fully configured. */
export function servedChainIds(): ChainId[] {
  if (!served) {
    const raw = process.env.CHAINS?.trim()
    const list = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [PRIMARY_CHAIN_ID]
    const ids: ChainId[] = []
    let hasSolana = false
    for (const item of list) {
      // Solana chains are served by ./multi.ts; this registry is the EVM half and leaves them out.
      if (/^solana([:-]|$)/i.test(item)) {
        hasSolana = true
        continue
      }
      const id = normalizeChainId(item)
      if (!id) throw new Error(`CHAINS lists an unknown chain: ${item}`)
      if (!ids.includes(id)) ids.push(id)
    }
    if (ids.length === 0 && !hasSolana) throw new Error('CHAINS is empty')
    for (const id of ids) entry(id) // fail at startup, not on the first request
    served = ids
  }
  return served
}

/** The chain an API request means when it names none: the first served chain. */
export function defaultChainId(): ChainId {
  return servedChainIds()[0]
}

/**
 * The served chain `input` names (CAIP-2 id, network name or EVM chain id), or the default
 * one when `input` is empty. Throws UnknownChainError for a chain this process does not serve.
 */
export function resolveServedChainId(input?: string | number | null): ChainId {
  if (input === undefined || input === null || String(input).trim() === '') return defaultChainId()
  const id = normalizeChainId(input)
  if (!id || !servedChainIds().includes(id)) {
    throw new UnknownChainError(`Chain ${input} is not served here. Served: ${servedChainIds().join(', ')}.`)
  }
  return id
}

/** Any known chain's config — served or not (the SDK may run on a chain its process never listed). */
export function chainConfig(chainId: ChainId | string = PRIMARY_CHAIN_ID): EvmChainConfig {
  const id = normalizeChainId(chainId)
  if (!id) throw new UnknownChainError(`Unknown chain: ${chainId}`)
  return entry(id).config
}

/** A shared read-only adapter for a chain. */
export function readChain(chainId: ChainId | string = defaultChainId()): EvmAdapter {
  const id = normalizeChainId(chainId)
  if (!id) throw new UnknownChainError(`Unknown chain: ${chainId}`)
  let reader = readers.get(id)
  if (!reader) {
    const e = entry(id)
    reader = new EvmAdapter(e.config, { publicClient: createPublicClient({ chain: e.config.chain, transport: e.transport }) as PublicClient })
    readers.set(id, reader)
  }
  return reader
}

/**
 * A wallet's clients on a chain. The nonce manager keeps its own count: load-balanced public
 * RPCs can report a stale pending nonce right after a transaction.
 */
export function signerClients(chainId: ChainId | string, privateKey: Hex) {
  const e = entry(normalizeChainId(chainId) ?? chainId)
  const account = privateKeyToAccount(privateKey, { nonceManager })
  const publicClient = createPublicClient({ chain: e.config.chain, transport: e.transport })
  const walletClient = createWalletClient({ account, chain: e.config.chain, transport: e.transport })
  return { account, publicClient, walletClient }
}

/** An adapter that signs with `privateKey` on a chain. */
export function signerChain(chainId: ChainId | string, privateKey: Hex): EvmAdapter {
  const id = normalizeChainId(chainId)
  if (!id) throw new UnknownChainError(`Unknown chain: ${chainId}`)
  const clients = signerClients(id, privateKey)
  return new EvmAdapter(entry(id).config, clients as never)
}

/** The RPC URLs a chain is reached through, primary first. */
export function chainRpcUrls(chainId: ChainId | string): string[] {
  return entry(normalizeChainId(chainId) ?? chainId).rpcUrls
}
