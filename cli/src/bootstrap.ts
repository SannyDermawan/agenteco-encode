import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Runs before anything from the SDK is loaded (the SDK reads its chain settings from the
 * environment when it first loads): asks the API which chains it serves and where their contracts
 * are, and sets the environment the SDK expects. The chain the command is about becomes the
 * primary one (unsuffixed settings), every other served chain gets suffixed settings.
 *
 * Skipped when the settings are already in the environment (tests, or a person who set them), and
 * harmless when the API cannot be reached: the built-in presets then apply (BSC Testnet works as is).
 */
interface ServedChain {
  chainId: string
  evmChainId: number
  agentEco: string
  token: { address: string }
  erc8004?: { identity: string; reputation: string } | null
}

const PRESET_NAME: Record<number, string> = { 97: 'bsc-testnet', 968: 'bot-testnet', 677: 'bot-mainnet', 84532: 'base-sepolia' }

/**
 * A preset that already ships this deployment keeps it: setting the address would switch the SDK
 * to "this one contract only" and drop the older contracts it also reads (BSC Testnet's v1 and v2).
 */
const PRESET_DEPLOYMENT: Record<string, string> = { 'eip155:97': '0xdc08dd97e959ab6ed2ab76702f25757fe1ff46be' }

export function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i < 0) return undefined
  const a = argv[i]
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[i + 1]
}

function readHomeConfig(env: NodeJS.ProcessEnv): { api?: string; defaultChain?: string } {
  try {
    const home = env.AGENTECO_HOME?.trim() || join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.agenteco')
    return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

export async function bootstrapChains(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.AGENT_ECO_ADDRESS?.trim()) return // already configured
  const config = readHomeConfig(env)
  const api = (env.AGENTECO_API_URL?.trim() || config.api || '').replace(/\/+$/, '')
  if (!api) return

  let chains: ServedChain[]
  try {
    const res = await fetch(`${api}/chains`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return
    chains = (await res.json()) as ServedChain[]
  } catch {
    return
  }
  if (!Array.isArray(chains) || chains.length === 0) return

  const wanted = (flagValue(argv, 'chain') ?? config.defaultChain ?? '').toLowerCase()
  const primary =
    chains.find((c) => c.chainId === wanted || String(c.evmChainId) === wanted || PRESET_NAME[c.evmChainId] === wanted) ??
    chains.find((c) => c.chainId === `eip155:${97}`) ??
    chains[0]

  for (const c of chains) {
    const suffix = c.chainId === primary.chainId ? '' : `__${c.chainId.replace(/[^A-Za-z0-9]/g, '_')}`
    if (PRESET_DEPLOYMENT[c.chainId] !== c.agentEco.toLowerCase()) env[`AGENT_ECO_ADDRESS${suffix}`] ??= c.agentEco
    env[`USDT_ADDRESS${suffix}`] ??= c.token.address
    if (c.erc8004) {
      env[`ERC8004_IDENTITY_REGISTRY${suffix}`] ??= c.erc8004.identity
      env[`ERC8004_REPUTATION_REGISTRY${suffix}`] ??= c.erc8004.reputation
    }
  }
  const name = PRESET_NAME[primary.evmChainId]
  if (name) env.NETWORK ??= name
}
