import { isAddress, type Address } from 'viem'
import { SOLANA_PRESETS, type SolanaPreset } from '@runtime/chain/solana-presets.ts'

/**
 * Which networks the app serves, which one this browser is on, and which AgentEco
 * deployment it talks to there. Mirrors agent-runtime/src/network.ts and
 * agent-runtime/src/chain/registry.ts (the backend side) — keep in sync.
 *
 * - NEXT_PUBLIC_NETWORK (default bsc-testnet; "testnet"/"mainnet" still mean the BOT
 *   Chain presets) is the primary network: the unsuffixed NEXT_PUBLIC_* deployment
 *   settings below are its, exactly as before.
 * - NEXT_PUBLIC_CHAINS lists the networks the app offers (CAIP-2 ids or names, the
 *   default first); unset = the primary network alone. Every other network takes its
 *   deployment from the same settings suffixed with its CAIP-2 id (colon as underscore),
 *   e.g. NEXT_PUBLIC_AGENT_ECO_ADDRESS__eip155_84532.
 * - The visitor picks one in the top bar (selectNetwork): it is remembered in this
 *   browser and applied on reload, and every export of this module is that network's.
 *   The /app pages render in the browser only (see app/app/layout.tsx), so they never
 *   disagree with a server render; the landing page uses ./landingNetwork.ts instead.
 *
 * Solana is offered the same way (`solana-devnet`, or its CAIP-2 id, in NEXT_PUBLIC_CHAINS) and is the one
 * network of a different family: its settings are NEXT_PUBLIC_AGENT_ECO_PROGRAM__solana_<id> (required),
 * NEXT_PUBLIC_TOKEN_MINT__…, NEXT_PUBLIC_RPC_URL__… and NEXT_PUBLIC_FIRST_ESCROW_ID__…. While a Solana network
 * is selected the EVM exports below (contracts, RPC, wagmi's chain) stay those of the primary EVM network and
 * are simply unused; every export that describes "the selected network" (CHAIN_KEY, TOKEN_SYMBOL, the
 * explorer, FAMILY) is the Solana one.
 *
 * A build that offers a network without a deployment fails loudly instead of silently
 * pointing users at another chain's contracts. NEXT_PUBLIC_* values are inlined at build
 * time, so each must be read with a literal `process.env.NEXT_PUBLIC_…` — and changing one
 * needs a redeploy.
 */

export type EvmNetworkName = 'bsc-testnet' | 'bot-testnet' | 'bot-mainnet' | 'base-sepolia'
export type SolanaNetworkName = 'solana-devnet'
export type NetworkName = EvmNetworkName | SolanaNetworkName

/** Which kind of chain a network is: it decides the wallet, the signing and the way the chain is read. */
export type NetworkFamily = 'evm' | 'solana'

export interface FaucetLink {
  label: string
  url: string
}

interface NetworkPreset {
  chainId: number
  name: string
  /** Short label for the top bar badge. */
  label: string
  rpcUrl: string
  /** Tried when rpcUrl fails — mirrors agent-runtime/src/network.ts. */
  fallbackRpcUrls?: string[]
  explorerUrl: string
  explorerName: string
  nativeSymbol: string
  testnet: boolean
  /** Settlement token — MockUSDT on BSC Testnet, USDT on BOT Chain, USDC on Base Sepolia. */
  usdtAddress: Address
  /** What the UI calls the settlement token. */
  tokenSymbol: string
  /** True when the settlement token is MockUSDT, which has a public faucet(). */
  tokenHasFaucet: boolean
  /** Where users get native gas tokens (and, without a token faucet, test tokens) for this network. */
  gasFaucets: FaucetLink[]
  /** Multicall3, when deployed on this chain — batches contract reads. */
  multicall3?: Address
  /** Largest block span per eth_getLogs call the default RPC accepts (with margin). */
  logRange: bigint
  /** Blocks of log history the default RPC keeps (null = full history). */
  logHistory: bigint | null
  /** Native gas sent to a hosted agent's wallet at activation. */
  agentGasTopup: string
  deployment?: {
    agentEcoAddress: Address
    deployBlock: bigint
    /** Where this deployment's escrow numbering starts. */
    firstEscrowId: bigint
    /** Earlier deployments, oldest first: escrows numbered below the next one's firstEscrowId still live there. */
    legacy?: { agentEcoAddress: Address; firstEscrowId: bigint }[]
  }
}

// Each preset verified against its RPC's eth_chainId; faucet URLs checked live.
const PRESETS: Record<EvmNetworkName, NetworkPreset> = {
  'bsc-testnet': {
    chainId: 97,
    name: 'BSC Testnet',
    label: 'BSC Testnet',
    // PublicNode, not the official data-seed nodes: those reject eth_getLogs,
    // which every escrow/dispute scan here needs. 50,000 blocks per call.
    rpcUrl: 'https://bsc-testnet-rpc.publicnode.com',
    fallbackRpcUrls: ['https://bsc-testnet-dataseed.bnbchain.org', 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'],
    explorerUrl: 'https://testnet.bscscan.com',
    explorerName: 'BscScan Testnet',
    nativeSymbol: 'tBNB',
    testnet: true,
    usdtAddress: '0xae0BbCf2Ec6cbE83C39927e9A087c9486E51Cea7',
    tokenSymbol: 'mUSDT',
    tokenHasFaucet: true,
    gasFaucets: [
      { label: 'QuickNode BNB testnet faucet', url: 'https://faucet.quicknode.com/binance-smart-chain/bnb-testnet' },
      { label: 'BNB Chain Telegram bot (@bnbchain_official_bot)', url: 'https://t.me/bnbchain_official_bot' },
    ],
    // BSC Testnet gas is ~0.1–3 gwei; one job costs well under 0.001 tBNB.
    agentGasTopup: '0.005',
    logHistory: BigInt(75000),
    logRange: BigInt(45000),
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    // AgentEco v3 (the 2.5% platform fee, with its own ArbiterCouncil), numbering escrows
    // from 2001. v1 (#1–#1000) and v2 (#1001–#2000) are still read for their escrows.
    deployment: {
      agentEcoAddress: '0xdC08Dd97e959Ab6ED2AB76702F25757Fe1fF46BE',
      deployBlock: BigInt(135056464),
      firstEscrowId: BigInt(2001),
      // Earlier deployments, oldest first: an escrow id below the next one's firstEscrowId lives there.
      legacy: [
        { agentEcoAddress: '0x8bdff809013c28aA8a85038660D9d6E8d2c0294b', firstEscrowId: BigInt(1) },
        { agentEcoAddress: '0xBbbD2902B736E7d7cbc031A597D51FFE5809c4F1', firstEscrowId: BigInt(1001) },
      ],
    },
  },
  'bot-testnet': {
    chainId: 968,
    name: 'BOT Chain Testnet',
    label: 'BOT Testnet',
    rpcUrl: 'https://rpc.bohr.life',
    explorerUrl: 'https://scan.bohr.life',
    explorerName: 'BOT Chain Explorer',
    nativeSymbol: 'BOT',
    testnet: true,
    usdtAddress: '0x75edC9335175Fc0552D51D48439F229c10420fe3',
    tokenSymbol: 'USDT',
    tokenHasFaucet: false,
    gasFaucets: [],
    // BOT Chain gas is ~20 gwei.
    agentGasTopup: '0.08',
    logHistory: null,
    logRange: BigInt(500000),
  },
  'bot-mainnet': {
    chainId: 677,
    name: 'BOT Chain Mainnet',
    label: 'BOT Mainnet',
    rpcUrl: 'https://rpc.botchain.ai',
    explorerUrl: 'https://scan.botchain.ai',
    explorerName: 'BOT Chain Explorer',
    nativeSymbol: 'BOT',
    testnet: false,
    usdtAddress: '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C',
    tokenSymbol: 'USDT',
    tokenHasFaucet: false,
    gasFaucets: [],
    // BOT Chain gas is ~20 gwei.
    agentGasTopup: '0.08',
    logHistory: null,
    logRange: BigInt(500000),
  },
  'base-sepolia': {
    chainId: 84532,
    name: 'Base Sepolia',
    label: 'Base Sepolia',
    // PublicNode serves eth_getLogs over 50,000 blocks; the official sepolia.base.org caps it
    // at 200, but reads and transactions work there, so it is the fallback.
    rpcUrl: 'https://base-sepolia-rpc.publicnode.com',
    fallbackRpcUrls: ['https://sepolia.base.org'],
    explorerUrl: 'https://sepolia.basescan.org',
    explorerName: 'BaseScan Sepolia',
    nativeSymbol: 'ETH',
    testnet: true,
    // Circle's test USDC (6 decimals).
    usdtAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    tokenSymbol: 'USDC',
    tokenHasFaucet: false,
    gasFaucets: [
      { label: 'Coinbase Developer Platform faucet (Base Sepolia ETH)', url: 'https://portal.cdp.coinbase.com/products/faucet' },
      { label: 'Circle faucet (test USDC on Base Sepolia)', url: 'https://faucet.circle.com' },
    ],
    // Base Sepolia gas is a fraction of a gwei.
    agentGasTopup: '0.002',
    logHistory: null,
    logRange: BigInt(45000),
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    // No AgentEco deployment yet: NEXT_PUBLIC_AGENT_ECO_ADDRESS__eip155_84532 and _DEPLOY_BLOCK__ must be set.
  },
}

// Names from before the BSC Testnet deployment.
const ALIASES: Record<string, EvmNetworkName> = { testnet: 'bot-testnet', mainnet: 'bot-mainnet' }

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/** An EVM network name for a name, an alias, a CAIP-2 id or an EVM chain id; null when it is not an EVM network. */
function toEvmNetworkName(raw: string): EvmNetworkName | null {
  const value = raw.trim().toLowerCase()
  const name = ALIASES[value] ?? value
  if (name in PRESETS) return name as EvmNetworkName
  const id = value.startsWith('eip155:') ? value.slice('eip155:'.length) : value
  return (Object.keys(PRESETS) as EvmNetworkName[]).find((n) => String(PRESETS[n].chainId) === id) ?? null
}

/** A Solana network name for a preset's name, alias or CAIP-2 id (case-sensitive base58 in the id); null when unknown. */
function toSolanaNetworkName(raw: string): SolanaNetworkName | null {
  const value = raw.trim()
  const lower = value.toLowerCase()
  for (const [name, preset] of Object.entries(SOLANA_PRESETS)) {
    if (lower === name || preset.aliases.includes(lower) || value === preset.chainId) return name as SolanaNetworkName
  }
  return null
}

/** A network name for a name, an alias, a CAIP-2 id or an EVM chain id; null when unknown. */
function toNetworkName(raw: string): NetworkName | null {
  return toEvmNetworkName(raw) ?? toSolanaNetworkName(raw)
}

function readNetwork(raw: string | undefined): EvmNetworkName {
  const value = clean(raw) ?? 'bsc-testnet'
  const name = toEvmNetworkName(value)
  if (!name) throw new Error(`NEXT_PUBLIC_NETWORK must be one of ${Object.keys(PRESETS).join(', ')}, got: ${value}`)
  return name
}

/** The primary network (always an EVM one): the unsuffixed NEXT_PUBLIC_* deployment settings are its. */
export const PRIMARY_NETWORK: EvmNetworkName = readNetwork(process.env.NEXT_PUBLIC_NETWORK)

interface DeploymentEnv {
  rpcUrl?: string
  rpcFallbacks?: string
  agentEco?: string
  usdt?: string
  deployBlock?: string
  agentGasTopup?: string
}

const PRIMARY_ENV: DeploymentEnv = {
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,
  rpcFallbacks: process.env.NEXT_PUBLIC_RPC_FALLBACK_URLS,
  agentEco: process.env.NEXT_PUBLIC_AGENT_ECO_ADDRESS,
  usdt: process.env.NEXT_PUBLIC_USDT_ADDRESS,
  deployBlock: process.env.NEXT_PUBLIC_DEPLOY_BLOCK,
  agentGasTopup: process.env.NEXT_PUBLIC_AGENT_GAS_TOPUP,
}

// Every other network's settings, suffixed with its CAIP-2 id — read literally (build-time inlining).
const SUFFIXED_ENV: Record<EvmNetworkName, DeploymentEnv> = {
  'bsc-testnet': {
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL__eip155_97,
    rpcFallbacks: process.env.NEXT_PUBLIC_RPC_FALLBACK_URLS__eip155_97,
    agentEco: process.env.NEXT_PUBLIC_AGENT_ECO_ADDRESS__eip155_97,
    usdt: process.env.NEXT_PUBLIC_USDT_ADDRESS__eip155_97,
    deployBlock: process.env.NEXT_PUBLIC_DEPLOY_BLOCK__eip155_97,
    agentGasTopup: process.env.NEXT_PUBLIC_AGENT_GAS_TOPUP__eip155_97,
  },
  'bot-testnet': {
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL__eip155_968,
    rpcFallbacks: process.env.NEXT_PUBLIC_RPC_FALLBACK_URLS__eip155_968,
    agentEco: process.env.NEXT_PUBLIC_AGENT_ECO_ADDRESS__eip155_968,
    usdt: process.env.NEXT_PUBLIC_USDT_ADDRESS__eip155_968,
    deployBlock: process.env.NEXT_PUBLIC_DEPLOY_BLOCK__eip155_968,
    agentGasTopup: process.env.NEXT_PUBLIC_AGENT_GAS_TOPUP__eip155_968,
  },
  'bot-mainnet': {
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL__eip155_677,
    rpcFallbacks: process.env.NEXT_PUBLIC_RPC_FALLBACK_URLS__eip155_677,
    agentEco: process.env.NEXT_PUBLIC_AGENT_ECO_ADDRESS__eip155_677,
    usdt: process.env.NEXT_PUBLIC_USDT_ADDRESS__eip155_677,
    deployBlock: process.env.NEXT_PUBLIC_DEPLOY_BLOCK__eip155_677,
    agentGasTopup: process.env.NEXT_PUBLIC_AGENT_GAS_TOPUP__eip155_677,
  },
  'base-sepolia': {
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL__eip155_84532,
    rpcFallbacks: process.env.NEXT_PUBLIC_RPC_FALLBACK_URLS__eip155_84532,
    agentEco: process.env.NEXT_PUBLIC_AGENT_ECO_ADDRESS__eip155_84532,
    usdt: process.env.NEXT_PUBLIC_USDT_ADDRESS__eip155_84532,
    deployBlock: process.env.NEXT_PUBLIC_DEPLOY_BLOCK__eip155_84532,
    agentGasTopup: process.env.NEXT_PUBLIC_AGENT_GAS_TOPUP__eip155_84532,
  },
}

function readNumber(name: string, raw: string | undefined, fallback: number): number {
  const value = clean(raw)
  if (!value) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got: ${value}`)
  return n
}

/** Everything the app needs to know about one network and its AgentEco deployment. */
export interface NetworkConfig {
  family: 'evm'
  name: EvmNetworkName
  /** CAIP-2 id, as the API names chains (`?chain=`). */
  chainKey: string
  chainId: number
  chainName: string
  label: string
  isTestnet: boolean
  rpcUrl: string
  rpcUrls: string[]
  explorerUrl: string
  explorerName: string
  logRange: bigint
  logHistory: bigint | null
  multicall3?: Address
  nativeSymbol: string
  tokenSymbol: string
  tokenHasFaucet: boolean
  gasFaucets: FaucetLink[]
  agentGasTopup: string
  agentEcoAddress: Address
  usdtAddress: Address
  deployBlock: bigint
  firstEscrowId: bigint
  legacyDeployments: { address: Address; firstEscrowId: bigint; endEscrowId: bigint }[]
  /** The AgentEco contract (the Solana program, on Solana) and the link to an address on this network's explorer. */
  contractAddress: string
  explorerAddressUrl(address: string): string
}

export function networkConfig(name: EvmNetworkName): NetworkConfig {
  const preset = PRESETS[name]
  const env = name === PRIMARY_NETWORK ? PRIMARY_ENV : SUFFIXED_ENV[name]
  const chainKey = `eip155:${preset.chainId}`
  const suffix = name === PRIMARY_NETWORK ? '' : `__${chainKey.replace(':', '_')}`

  const address = (setting: string, raw: string | undefined, fallback: Address | undefined): Address => {
    const value = clean(raw) ?? fallback
    if (!value) throw new Error(`NEXT_PUBLIC_${setting}${suffix} must be set to offer ${preset.name} — there is no default deployment for it.`)
    if (!isAddress(value)) throw new Error(`NEXT_PUBLIC_${setting}${suffix} is not a valid EVM address: ${value}`)
    return value
  }
  const deployBlock = (() => {
    const value = clean(env.deployBlock)
    if (!value) {
      if (preset.deployment?.deployBlock === undefined) throw new Error(`NEXT_PUBLIC_DEPLOY_BLOCK${suffix} must be set to offer ${preset.name}.`)
      return preset.deployment.deployBlock
    }
    if (!/^\d+$/.test(value)) throw new Error(`NEXT_PUBLIC_DEPLOY_BLOCK${suffix} must be an integer block number, got: ${value}`)
    return BigInt(value)
  })()

  const rpcUrl = clean(env.rpcUrl) ?? preset.rpcUrl
  const fallbacks = clean(env.rpcFallbacks)
  const rpcUrls = [
    rpcUrl,
    ...(fallbacks?.toLowerCase() === 'none' ? [] : (fallbacks?.split(',').map((u) => u.trim()).filter(Boolean) ?? preset.fallbackRpcUrls ?? [])),
  ].filter((url, i, all) => all.indexOf(url) === i)

  /*
   * Earlier AgentEco deployments, whose escrows are still read there. Only used with the
   * preset's own deployment: setting the address points everything at that one contract.
   */
  const ownDeployment = !!clean(env.agentEco)
  const legacyList = ownDeployment ? [] : (preset.deployment?.legacy ?? [])
  const firstEscrowId = ownDeployment ? BigInt(1) : (preset.deployment?.firstEscrowId ?? BigInt(1))

  return {
    family: 'evm',
    name,
    chainKey,
    chainId: preset.chainId,
    chainName: preset.name,
    label: preset.label,
    isTestnet: preset.testnet,
    rpcUrl,
    rpcUrls,
    explorerUrl: preset.explorerUrl,
    explorerName: preset.explorerName,
    logRange: preset.logRange,
    logHistory: preset.logHistory,
    multicall3: preset.multicall3,
    nativeSymbol: preset.nativeSymbol,
    tokenSymbol: preset.tokenSymbol,
    tokenHasFaucet: preset.tokenHasFaucet,
    gasFaucets: preset.gasFaucets,
    agentGasTopup: clean(env.agentGasTopup) ?? preset.agentGasTopup,
    agentEcoAddress: address('AGENT_ECO_ADDRESS', env.agentEco, preset.deployment?.agentEcoAddress),
    usdtAddress: address('USDT_ADDRESS', env.usdt, preset.usdtAddress),
    deployBlock,
    firstEscrowId,
    legacyDeployments: legacyList.map((d, i) => ({
      address: d.agentEcoAddress,
      firstEscrowId: d.firstEscrowId,
      endEscrowId: legacyList[i + 1]?.firstEscrowId ?? firstEscrowId,
    })),
    contractAddress: address('AGENT_ECO_ADDRESS', env.agentEco, preset.deployment?.agentEcoAddress),
    explorerAddressUrl: (a) => `${preset.explorerUrl}/address/${a}`,
  }
}

/** A Solana network and its AgentEco escrow program. */
export interface SolanaNetworkConfig {
  family: 'solana'
  name: SolanaNetworkName
  /** CAIP-2 id, as the API names chains (`?chain=`). */
  chainKey: string
  /** The chain identifier wallets use (wallet-standard), e.g. `solana:devnet`. */
  walletChain: string
  chainName: string
  label: string
  isTestnet: boolean
  rpcUrl: string
  rpcUrls: string[]
  explorerUrl: string
  explorerName: string
  /** Appended to explorer links (`?cluster=devnet`). */
  explorerQuery: string
  nativeSymbol: string
  tokenSymbol: string
  tokenHasFaucet: false
  gasFaucets: FaucetLink[]
  /** The escrow program (the "contract"). */
  programId: string
  /** The settlement token's mint. */
  mint: string
  firstEscrowId: bigint
  contractAddress: string
  explorerAddressUrl(address: string): string
}

export type AnyNetworkConfig = NetworkConfig | SolanaNetworkConfig

// Read literally — Next inlines NEXT_PUBLIC_* at build time. The suffix is the CAIP-2 id, the colon as an underscore.
const SOLANA_ENV: Record<SolanaNetworkName, DeploymentEnv & { program?: string; mint?: string; firstEscrowId?: string }> = {
  'solana-devnet': {
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL__solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1,
    rpcFallbacks: process.env.NEXT_PUBLIC_RPC_FALLBACK_URLS__solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1,
    program: process.env.NEXT_PUBLIC_AGENT_ECO_PROGRAM__solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1,
    mint: process.env.NEXT_PUBLIC_TOKEN_MINT__solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1,
    firstEscrowId: process.env.NEXT_PUBLIC_FIRST_ESCROW_ID__solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1,
  },
}

const WALLET_CHAIN: Record<SolanaNetworkName, string> = { 'solana-devnet': 'solana:devnet' }
const SOLANA_FAUCETS: Record<SolanaNetworkName, FaucetLink[]> = {
  'solana-devnet': [
    { label: 'Solana faucet (devnet SOL)', url: 'https://faucet.solana.com' },
    { label: 'Circle faucet (devnet USDC — choose Solana Devnet)', url: 'https://faucet.circle.com' },
  ],
}
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export function solanaNetworkConfig(name: SolanaNetworkName): SolanaNetworkConfig {
  const preset: SolanaPreset = SOLANA_PRESETS[name]
  const env = SOLANA_ENV[name]
  const suffix = `__${preset.chainId.replace(':', '_')}`
  const base58 = (setting: string, raw: string | undefined, fallback?: string): string => {
    const value = clean(raw) ?? fallback
    if (!value) throw new Error(`NEXT_PUBLIC_${setting}${suffix} must be set to offer ${preset.name} — there is no default deployment for it.`)
    if (!SOLANA_ADDRESS.test(value)) throw new Error(`NEXT_PUBLIC_${setting}${suffix} is not a valid Solana address: ${value}`)
    return value
  }
  const first = clean(env.firstEscrowId) ?? '1'
  if (!/^\d+$/.test(first) || BigInt(first) < BigInt(1)) throw new Error(`NEXT_PUBLIC_FIRST_ESCROW_ID${suffix} must be a positive integer, got: ${first}`)
  const rpcUrl = clean(env.rpcUrl) ?? preset.rpcUrl
  const fallbacks = clean(env.rpcFallbacks)
  const rpcUrls = [rpcUrl, ...(fallbacks?.toLowerCase() === 'none' ? [] : (fallbacks?.split(',').map((u) => u.trim()).filter(Boolean) ?? []))].filter((u, i, all) => all.indexOf(u) === i)
  const programId = base58('AGENT_ECO_PROGRAM', env.program)
  return {
    family: 'solana',
    name,
    chainKey: preset.chainId,
    walletChain: WALLET_CHAIN[name],
    chainName: preset.name,
    label: preset.name,
    isTestnet: preset.testnet,
    rpcUrl,
    rpcUrls,
    explorerUrl: preset.explorerUrl,
    explorerName: preset.explorerName,
    explorerQuery: preset.explorerQuery,
    nativeSymbol: preset.nativeSymbol,
    tokenSymbol: preset.tokenSymbol,
    tokenHasFaucet: false,
    gasFaucets: SOLANA_FAUCETS[name],
    programId,
    mint: base58('TOKEN_MINT', env.mint, preset.defaultMint),
    firstEscrowId: BigInt(first),
    contractAddress: programId,
    explorerAddressUrl: (a) => `${preset.explorerUrl}/address/${a}${preset.explorerQuery}`,
  }
}

/** The networks this build offers, the default first (NEXT_PUBLIC_CHAINS; unset = the primary alone). */
export const AVAILABLE_NETWORKS: AnyNetworkConfig[] = (() => {
  const raw = clean(process.env.NEXT_PUBLIC_CHAINS)
  const names: NetworkName[] = []
  for (const item of raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [PRIMARY_NETWORK]) {
    const name = toNetworkName(item)
    if (!name) throw new Error(`NEXT_PUBLIC_CHAINS lists an unknown network: ${item}`)
    if (!names.includes(name)) names.push(name)
  }
  // Every offered network must be fully configured: the build fails here otherwise.
  return names.map((name): AnyNetworkConfig => (name in SOLANA_PRESETS ? solanaNetworkConfig(name as SolanaNetworkName) : networkConfig(name as EvmNetworkName)))
})()

/** The network a visitor starts on. */
export const DEFAULT_NETWORK: NetworkName = AVAILABLE_NETWORKS[0].name

const STORAGE_KEY = 'agenteco.network'

/** The network this browser picked (remembered across visits), or the default one. */
function selectedNetwork(): NetworkName {
  if (typeof window === 'undefined') return DEFAULT_NETWORK
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved && AVAILABLE_NETWORKS.some((n) => n.name === saved)) return saved as NetworkName
  } catch {
    // Storage blocked: the default network.
  }
  return DEFAULT_NETWORK
}

/** Switch this browser to another offered network: the app reloads on it. */
export function selectNetwork(name: NetworkName): void {
  if (!AVAILABLE_NETWORKS.some((n) => n.name === name)) return
  try {
    window.localStorage.setItem(STORAGE_KEY, name)
  } catch {
    // Storage blocked: nothing to remember the choice in.
    return
  }
  window.location.reload()
}

export const NETWORK: NetworkName = selectedNetwork()
/** The selected network, of whichever family. */
const selected = AVAILABLE_NETWORKS.find((n) => n.name === NETWORK)!
/** Which kind of chain the selected network is. */
export const FAMILY: NetworkFamily = selected.family
/** Whether this build offers a Solana network at all (the Solana wallet provider is only mounted then). */
export const SOLANA_OFFERED: boolean = AVAILABLE_NETWORKS.some((n) => n.family === 'solana')
/** The Solana network when one is selected, else null. */
export const SOLANA: SolanaNetworkConfig | null = selected.family === 'solana' ? selected : null
/**
 * The EVM network the EVM exports below describe: the selected one, or — while a Solana network is
 * selected — the first EVM network offered (else the primary one). Nothing EVM runs on Solana, so
 * this only keeps those modules loading.
 */
const active: NetworkConfig =
  selected.family === 'evm' ? selected : ((AVAILABLE_NETWORKS.find((n) => n.family === 'evm') as NetworkConfig | undefined) ?? networkConfig(PRIMARY_NETWORK))
/** The EVM network behind the EVM exports (wagmi's chain is built from it). */
export const EVM_NETWORK = active

// --- The selected network, of either family ---

/** The selected network's CAIP-2 id — every API call names it (lib/api/base.ts). */
export const CHAIN_KEY = selected.chainKey
export const CHAIN_NAME = selected.chainName
export const NETWORK_LABEL = selected.label
export const IS_TESTNET = selected.isTestnet
export const EXPLORER_URL = selected.explorerUrl
export const EXPLORER_NAME = selected.explorerName
export const NATIVE_SYMBOL = selected.nativeSymbol
export const TOKEN_SYMBOL = selected.tokenSymbol
export const TOKEN_HAS_FAUCET = selected.tokenHasFaucet
export const GAS_FAUCETS = selected.gasFaucets
/** The escrow contract (EVM) or program (Solana) of the selected network. */
export const CONTRACT_ADDRESS = selected.contractAddress

export function explorerAddressUrl(address: string): string {
  return selected.explorerAddressUrl(address)
}

// --- The EVM network (see `active`) ---

export const CHAIN_ID = active.chainId
export const RPC_URL = active.rpcUrl
/** RPC_URL, then fallbacks (NEXT_PUBLIC_RPC_FALLBACK_URLS, comma-separated, or "none"). */
export const RPC_URLS: string[] = active.rpcUrls
/** Block span per eth_getLogs call for this network's RPC. */
export const LOG_RANGE = active.logRange
export const MULTICALL3 = active.multicall3
/**
 * How far back the default RPC still serves logs (PublicNode on BSC Testnet
 * prunes after ~80,000 blocks). Log scans — only used for explorer links —
 * never reach further back; escrow discovery reads contract state instead.
 */
export const LOG_HISTORY_BLOCKS = active.logHistory

/** Native gas sent to a hosted agent's wallet at activation (NEXT_PUBLIC_AGENT_GAS_TOPUP overrides). */
export const AGENT_GAS_TOPUP = active.agentGasTopup

/** Below this native balance the app asks for gas before anything else (default 0.002). */
export const MIN_NATIVE_BALANCE = readNumber('NEXT_PUBLIC_MIN_TBNB', process.env.NEXT_PUBLIC_MIN_TBNB, 0.002)

export const AGENT_ECO_ADDRESS = active.agentEcoAddress
export const USDT_ADDRESS = active.usdtAddress
/** Block AgentEco.sol was deployed at — every event-log scan starts here. */
export const DEPLOY_BLOCK = active.deployBlock

/** First escrow id of AGENT_ECO_ADDRESS (the current deployment); lower ids belong to a legacy one. */
export const FIRST_ESCROW_ID: bigint = active.firstEscrowId
/** Earlier AgentEco deployments, oldest first, each with its escrow ids [firstEscrowId, endEscrowId). */
export const LEGACY_DEPLOYMENTS: { address: Address; firstEscrowId: bigint; endEscrowId: bigint }[] = active.legacyDeployments
/** The most recent earlier deployment (older code paths read one legacy contract). */
export const LEGACY_AGENT_ECO_ADDRESS: Address | null = LEGACY_DEPLOYMENTS[LEGACY_DEPLOYMENTS.length - 1]?.address ?? null
/** Every AgentEco deployment this app reads, the current one first. A seller's reputation is summed over all of them. */
export const ALL_AGENT_ECO_ADDRESSES: Address[] = [AGENT_ECO_ADDRESS, ...LEGACY_DEPLOYMENTS.map((d) => d.address).reverse()]

/** The AgentEco contract that holds this escrow: the current one, or the legacy one its id falls in. */
export function agentEcoFor(escrowId: bigint): Address {
  if (escrowId >= FIRST_ESCROW_ID) return AGENT_ECO_ADDRESS
  return LEGACY_DEPLOYMENTS.find((d) => escrowId >= d.firstEscrowId && escrowId < d.endEscrowId)?.address ?? AGENT_ECO_ADDRESS
}

/** Whether this escrow pays the platform fee: only the current deployment (v3) has one. */
export function hasPlatformFee(escrowId: bigint): boolean {
  return agentEcoFor(escrowId) === AGENT_ECO_ADDRESS
}
