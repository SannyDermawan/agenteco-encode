import { join } from 'node:path'
import { normalizeAnyChainId } from '../../agent-runtime/src/chain/multi.ts'
import { SOLANA_PRESETS } from '../../agent-runtime/src/chain/solana-registry.ts'
import { NETWORK_PRESETS } from '../../agent-runtime/src/network.ts'
import { DEFAULT_API_URL } from '../../agent-runtime/src/sdk/common.ts'
import { readJson, writeJsonAtomic } from './home.ts'

export interface Caps {
  maxPerJob: number
  maxPerDay: number
}

/** `~/.agenteco/config.json`. Written by the person (or `agenteco caps set`), read by the CLI and the MCP server. */
export interface Config {
  /** AgentEco API. Default: AGENTECO_API_URL, else the public API. */
  api?: string
  /** Chain `init` uses when none is named. Default: bsc-testnet. */
  defaultChain?: string
  /** Spend caps per kind of network, and per chain to override. */
  caps?: { testnet?: Partial<Caps>; mainnet?: Partial<Caps>; chains?: Record<string, Partial<Caps>> }
  /** If set, only these chains can be used (CAIP-2 ids or names). */
  chains?: string[]
}

/** On a testnet 1 token per job and 5 per day; on a mainnet nothing, until the person raises it. */
export const DEFAULT_CAPS = { testnet: { maxPerJob: 1, maxPerDay: 5 }, mainnet: { maxPerJob: 0, maxPerDay: 0 } } as const

export const DEFAULT_CHAIN = 'bsc-testnet'

const configPath = (home: string) => join(home, 'config.json')

export function loadConfig(home: string): Config {
  return readJson<Config>(configPath(home)) ?? {}
}

export function saveConfig(home: string, config: Config): void {
  writeJsonAtomic(configPath(home), config)
}

export function apiUrl(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  return (env.AGENTECO_API_URL?.trim() || config.api || DEFAULT_API_URL).replace(/\/+$/, '')
}

/** A CAIP-2 id for whatever the person typed (`base-sepolia`, `84532`, `eip155:84532`, `solana-devnet`); throws when unknown. */
export function resolveChain(input: string): string {
  const id = normalizeAnyChainId(input)
  if (!id) throw new Error(`Unknown chain "${input}". Known: bsc-testnet, base-sepolia, bot-testnet, bot-mainnet, solana-devnet.`)
  return id
}

/** Whether a chain is a testnet, by its preset. An unknown chain counts as a mainnet (the strict side). */
export function isTestnet(chainId: string): boolean {
  const solana = Object.values(SOLANA_PRESETS).find((p) => p.chainId === chainId)
  if (solana) return solana.testnet
  const preset = Object.values(NETWORK_PRESETS).find((p) => `eip155:${p.chainId}` === chainId)
  return preset?.testnet === true
}

/** The settlement token's symbol on a chain, from its preset (needs no deployment, so caps can be explained before one is configured). */
export function tokenSymbolFor(chainId: string): string {
  const solana = Object.values(SOLANA_PRESETS).find((p) => p.chainId === chainId)
  if (solana) return solana.tokenSymbol
  return Object.values(NETWORK_PRESETS).find((p) => `eip155:${p.chainId}` === chainId)?.tokenSymbol ?? 'tokens'
}

/** The caps that apply on a chain: the per-chain override, else the testnet/mainnet defaults. */
export function capsFor(config: Config, chainId: string): Caps {
  const kind = isTestnet(chainId) ? 'testnet' : 'mainnet'
  const base = DEFAULT_CAPS[kind]
  const own = { ...config.caps?.[kind], ...config.caps?.chains?.[chainId] }
  return {
    maxPerJob: own.maxPerJob ?? base.maxPerJob,
    maxPerDay: own.maxPerDay ?? base.maxPerDay,
  }
}

/** Throws when the config's allow-list excludes this chain. */
export function assertChainAllowed(config: Config, chainId: string): void {
  if (!config.chains?.length) return
  const allowed = config.chains.map((c) => normalizeAnyChainId(c)).filter(Boolean)
  if (!allowed.includes(chainId)) throw new Error(`${chainId} is not in the "chains" allow-list of your config.json (${config.chains.join(', ')}).`)
}
