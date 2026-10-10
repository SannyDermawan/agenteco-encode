import { defineChain, fallback, http, isAddress, type Address, type Transport } from 'viem'

/**
 * The one place the Node side (backend API, host, keeper, and the standalone
 * buyer/seller agents) learns which network it's on and which AgentEco
 * deployment to talk to. Mirrors frontend/lib/web3/network.ts.
 *
 * Pick the network with NETWORK=bsc-testnet|bot-testnet|bot-mainnet|base-sepolia
 * (default bsc-testnet; "testnet"/"mainnet" still mean the BOT Chain presets).
 * This is the process's primary chain; ./chain/registry.ts serves several
 * chains at once (CHAINS) from the same presets. Chain
 * params come from the presets below; the deployment — contract, token, deploy
 * block — comes from env, with working defaults where this repo has deployed.
 * A network without a default deployment refuses to start until
 * AGENT_ECO_ADDRESS is set, instead of quietly pointing at another chain.
 */

export type NetworkName = 'bsc-testnet' | 'bot-testnet' | 'bot-mainnet' | 'base-sepolia'

export interface NetworkPreset {
  chainId: number
  name: string
  rpcUrl: string
  /** Tried in order when rpcUrl fails or times out (not for eth_getLogs-heavy scans, which need rpcUrl). */
  fallbackRpcUrls?: string[]
  explorerUrl: string
  explorerName: string
  nativeSymbol: string
  testnet: boolean
  /** Settlement token for this network — MockUSDT on BSC Testnet, USDT on BOT Chain, USDC on Base Sepolia. */
  usdtAddress: Address
  /** What logs and API messages call the settlement token. */
  tokenSymbol: string
  /** Least native gas a hosted agent's wallet needs before the host will run it. */
  hostedMinGas: string
  /** System wallets (keeper, arbiter, hosted agents) below this log a warning. */
  lowGasWarn: string
  /** Multicall3, when deployed on this chain — batches contract reads. */
  multicall3?: Address
  /** Largest block span per eth_getLogs call the default RPC accepts (with margin). */
  logRange: bigint
  /** AgentEco deployment defaults, where this repo has one. */
  deployment?: Deployment
}

export interface Deployment {
  agentEcoAddress: Address
  deploymentBlock: bigint
  /** Where this deployment's escrow numbering starts. */
  firstEscrowId: bigint
  /** Earlier deployments, oldest first: escrows numbered below the next one's firstEscrowId still live there. */
  legacy?: { agentEcoAddress: Address; firstEscrowId: bigint }[]
}

// Each preset verified against its RPC's eth_chainId.
export const NETWORK_PRESETS: Record<NetworkName, NetworkPreset> = {
  'bsc-testnet': {
    chainId: 97,
    name: 'BSC Testnet',
    // PublicNode, not the official data-seed nodes: those reject eth_getLogs
    // ("limit exceeded" even for 1,000 blocks), and escrow discovery needs it.
    // PublicNode allows 50,000 blocks per call. Override with RPC_URL.
    rpcUrl: 'https://bsc-testnet-rpc.publicnode.com',
    // Official nodes as a fallback: they refuse large eth_getLogs, but reads,
    // transactions and receipts keep working while PublicNode is down.
    fallbackRpcUrls: ['https://bsc-testnet-dataseed.bnbchain.org', 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'],
    explorerUrl: 'https://testnet.bscscan.com',
    explorerName: 'BscScan Testnet',
    nativeSymbol: 'tBNB',
    testnet: true,
    // MockUSDT (mUSDT, 18 decimals) — AgentEco's own test token, see contracts/MockUSDT.sol.
    usdtAddress: '0xae0BbCf2Ec6cbE83C39927e9A087c9486E51Cea7',
    tokenSymbol: 'mUSDT',
    hostedMinGas: '0.003',
    lowGasWarn: '0.01',
    logRange: BigInt(45000),
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    // AgentEco v3 (the 2.5% platform fee, with its own ArbiterCouncil), numbering escrows
    // from 2001. v1 (#1–#1000) and v2 (#1001–#2000) are still read for their escrows.
    deployment: {
      agentEcoAddress: '0xdC08Dd97e959Ab6ED2AB76702F25757Fe1fF46BE',
      deploymentBlock: BigInt(135056464),
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
    rpcUrl: 'https://rpc.bohr.life',
    explorerUrl: 'https://scan.bohr.life',
    explorerName: 'BOT Chain Explorer',
    nativeSymbol: 'BOT',
    testnet: true,
    usdtAddress: '0x75edC9335175Fc0552D51D48439F229c10420fe3',
    tokenSymbol: 'USDT',
    hostedMinGas: '0.05',
    lowGasWarn: '0.05',
    logRange: BigInt(5000),
  },
  'bot-mainnet': {
    chainId: 677,
    name: 'BOT Chain Mainnet',
    rpcUrl: 'https://rpc.botchain.ai',
    explorerUrl: 'https://scan.botchain.ai',
    explorerName: 'BOT Chain Explorer',
    nativeSymbol: 'BOT',
    testnet: false,
    usdtAddress: '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C',
    tokenSymbol: 'USDT',
    hostedMinGas: '0.05',
    lowGasWarn: '0.05',
    logRange: BigInt(5000),
  },
  'base-sepolia': {
    chainId: 84532,
    name: 'Base Sepolia',
    // PublicNode serves eth_getLogs over 50,000 blocks; the official sepolia.base.org caps
    // it at 200 blocks, but reads and transactions work there, so it is the fallback.
    rpcUrl: 'https://base-sepolia-rpc.publicnode.com',
    fallbackRpcUrls: ['https://sepolia.base.org'],
    explorerUrl: 'https://sepolia.basescan.org',
    explorerName: 'BaseScan Sepolia',
    nativeSymbol: 'ETH',
    testnet: true,
    // Circle's test USDC (6 decimals).
    usdtAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    tokenSymbol: 'USDC',
    hostedMinGas: '0.0005',
    lowGasWarn: '0.002',
    logRange: BigInt(45000),
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    // No AgentEco deployment yet: AGENT_ECO_ADDRESS (or AGENT_ECO_ADDRESS__eip155_84532) must be set.
  },
}

// Names from before the BSC Testnet deployment.
export const NETWORK_ALIASES: Record<string, NetworkName> = { testnet: 'bot-testnet', mainnet: 'bot-mainnet' }

function env(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function readNetwork(): NetworkName {
  const raw = (env('NETWORK') ?? 'bsc-testnet').toLowerCase()
  const name = NETWORK_ALIASES[raw] ?? raw
  if (!(name in NETWORK_PRESETS)) {
    throw new Error(`NETWORK must be one of ${Object.keys(NETWORK_PRESETS).join(', ')}, got: ${raw}`)
  }
  return name as NetworkName
}

function readAddress(name: string, fallback: Address | undefined): Address {
  const value = env(name) ?? fallback
  if (!value) throw new Error(`${name} must be set when NETWORK=${NETWORK} — there is no default deployment for it.`)
  if (!isAddress(value)) throw new Error(`${name} is not a valid EVM address: ${value}`)
  return value
}

function readBlock(name: string, fallback: bigint | undefined): bigint | null {
  const value = env(name)
  if (!value) return fallback ?? null
  try {
    return BigInt(value)
  } catch {
    throw new Error(`${name} must be an integer block number, got: ${value}`)
  }
}

export const NETWORK: NetworkName = readNetwork()
const preset = NETWORK_PRESETS[NETWORK]

/** Overridable (e.g. a private RPC provider); defaults to the network's public RPC. */
export const RPC_URL = env('RPC_URL') ?? preset.rpcUrl
/**
 * RPC_URL first, then fallbacks (RPC_FALLBACK_URLS, comma-separated, overrides
 * the preset; set it to "none" for no fallback). A public RPC going quiet for
 * a few minutes is enough to miss a 120 s accept deadline, so every process
 * fails over instead of waiting.
 */
export const RPC_URLS: string[] = [
  RPC_URL,
  ...(env('RPC_FALLBACK_URLS')?.toLowerCase() === 'none'
    ? []
    : (env('RPC_FALLBACK_URLS')?.split(',').map((u) => u.trim()).filter(Boolean) ?? preset.fallbackRpcUrls ?? [])),
].filter((url, i, all) => all.indexOf(url) === i)

/** Per-request timeout before failing over to the next RPC. */
export const RPC_TIMEOUT_MS = 10_000

/** viem transport over RPC_URLS: the primary, then each fallback on error or timeout. */
export function appTransport(): Transport {
  const transports = RPC_URLS.map((url) => http(url, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }))
  return transports.length === 1 ? transports[0] : fallback(transports)
}
export const EXPLORER_URL = preset.explorerUrl
export const NATIVE_SYMBOL = preset.nativeSymbol
export const TOKEN_SYMBOL = preset.tokenSymbol
/** Minimum native balance for a hosted agent wallet (HOSTED_MIN_GAS overrides). */
export const HOSTED_MIN_GAS = env('HOSTED_MIN_GAS') ?? preset.hostedMinGas
/** Warn when a system wallet's native balance drops below this (LOW_GAS_WARN_TBNB overrides). */
export const LOW_GAS_WARN = env('LOW_GAS_WARN_TBNB') ?? preset.lowGasWarn
/** Block span per eth_getLogs call (LOG_RANGE_BLOCKS overrides, e.g. for a paid RPC). */
export const LOG_RANGE = readBlock('LOG_RANGE_BLOCKS', preset.logRange) ?? preset.logRange
export const AGENT_ECO_ADDRESS = readAddress('AGENT_ECO_ADDRESS', preset.deployment?.agentEcoAddress)
export const USDT_ADDRESS = readAddress('USDT_ADDRESS', preset.usdtAddress)
/** Block AgentEco.sol was deployed at — log scans start here. Null = unknown (scan from "now"). */
export const DEPLOYMENT_BLOCK = readBlock('DEPLOYMENT_BLOCK', preset.deployment?.deploymentBlock)

/*
 * Earlier AgentEco deployments, whose escrows are still read there. Only used with the
 * preset's own deployment: setting AGENT_ECO_ADDRESS points everything at that one contract.
 */
const legacyList: { agentEcoAddress: Address; firstEscrowId: bigint }[] = env('AGENT_ECO_ADDRESS') ? [] : (preset.deployment?.legacy ?? [])
/** First escrow id of AGENT_ECO_ADDRESS (the current deployment); lower ids belong to a legacy one. */
export const FIRST_ESCROW_ID: bigint = env('AGENT_ECO_ADDRESS') ? BigInt(1) : (preset.deployment?.firstEscrowId ?? BigInt(1))
/** Earlier AgentEco deployments, oldest first, each with its escrow ids [firstEscrowId, endEscrowId). */
export const LEGACY_DEPLOYMENTS: { address: Address; firstEscrowId: bigint; endEscrowId: bigint }[] = legacyList.map((d, i) => ({
  address: d.agentEcoAddress,
  firstEscrowId: d.firstEscrowId,
  endEscrowId: legacyList[i + 1]?.firstEscrowId ?? FIRST_ESCROW_ID,
}))
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

/** Whether a log or receipt came from one of this app's AgentEco contracts. */
export function isAgentEcoAddress(address: string): boolean {
  const a = address.toLowerCase()
  return ALL_AGENT_ECO_ADDRESSES.some((x) => x.toLowerCase() === a)
}

export const appChain = defineChain({
  id: preset.chainId,
  name: preset.name,
  nativeCurrency: { name: preset.nativeSymbol, symbol: preset.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: RPC_URLS } },
  blockExplorers: { default: { name: preset.explorerName, url: preset.explorerUrl } },
  contracts: preset.multicall3 ? { multicall3: { address: preset.multicall3 } } : undefined,
  testnet: preset.testnet,
})

/** Explorer link for a transaction on the active network. */
export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`
}

/**
 * Fails fast when RPC_URL points at a different chain than NETWORK — e.g. a
 * mainnet process accidentally given a testnet RPC.
 */
export async function assertRpcMatchesNetwork(getChainId: () => Promise<number>): Promise<void> {
  const actual = await getChainId()
  if (actual !== appChain.id) {
    throw new Error(`RPC_URL reports chain id ${actual}, but NETWORK=${NETWORK} expects ${appChain.id} (${appChain.name}).`)
  }
}
