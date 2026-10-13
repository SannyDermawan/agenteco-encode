import { EXECUTION_WINDOW_SECONDS, REVIEW_WINDOW_SECONDS } from '../durations.ts'
import {
  AGENT_ECO_ADDRESS,
  DEPLOYMENT_BLOCK,
  EXPLORER_URL,
  FIRST_ESCROW_ID,
  HOSTED_MIN_GAS,
  LEGACY_DEPLOYMENTS,
  LOG_RANGE,
  LOW_GAS_WARN,
  NATIVE_SYMBOL,
  PRESET_ERC8004,
  TOKEN_SYMBOL,
  USDT_ADDRESS,
  appChain,
} from '../network.ts'
import { EvmAdapter, type EvmChainConfig, type EvmClients } from './evm.ts'
import { erc8004FromSettings } from '../shared/erc8004.ts'

/**
 * The process's primary chain (NETWORK + unsuffixed env, see ../network.ts) as an
 * EvmChainConfig, the one place where the env-driven constants meet the config-driven
 * adapter. ./registry.ts adds the other chains of CHAINS.
 */
let cached: EvmChainConfig | undefined
export function defaultEvmConfig(): EvmChainConfig {
  cached ??= {
    chainId: `eip155:${appChain.id}`,
    chain: appChain,
    agentEco: AGENT_ECO_ADDRESS,
    usdt: USDT_ADDRESS,
    tokenSymbol: TOKEN_SYMBOL,
    nativeSymbol: NATIVE_SYMBOL,
    explorerUrl: EXPLORER_URL,
    explorerName: appChain.blockExplorers.default.name,
    executionWindow: EXECUTION_WINDOW_SECONDS,
    reviewWindow: REVIEW_WINDOW_SECONDS,
    firstEscrowId: FIRST_ESCROW_ID,
    legacy: LEGACY_DEPLOYMENTS.map((d) => ({ address: d.address, firstEscrowId: d.firstEscrowId, endEscrowId: d.endEscrowId })),
    deploymentBlock: DEPLOYMENT_BLOCK,
    logRange: LOG_RANGE,
    hostedMinGas: HOSTED_MIN_GAS,
    lowGasWarn: LOW_GAS_WARN,
    erc8004: erc8004FromSettings((name) => process.env[name]?.trim() || undefined) ?? PRESET_ERC8004,
  }
  return cached
}

/** An adapter for the primary chain, talking through `clients`. */
export function evmAdapterFor(clients: EvmClients): EvmAdapter {
  return new EvmAdapter(defaultEvmConfig(), clients)
}
