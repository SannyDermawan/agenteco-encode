import { isHex, type Address, type Hex } from 'viem'
import { servedChainIdsOf } from '../../agent-runtime/src/chain/multi.ts'
import { AGENT_ECO_ADDRESS, DEPLOYMENT_BLOCK, RPC_URL } from './network.ts'

export type KeeperConfig = {
  rpcUrl: string
  agentEcoAddress: Address
  /** The EVM keeper wallet; null when only Solana chains are served (their keeper is a keypair file, SOLANA_KEEPER_KEYPAIR). */
  keeperPrivateKey: Hex | null
  keeperIntervalMs: number
  dryRun: boolean
  deploymentBlock: bigint | null
}

function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value.trim()
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number, got: ${raw}`)
  }
  return parsed
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (!raw || raw.trim() === '') return fallback
  return raw.trim().toLowerCase() === 'true'
}


/**
 * Loads and validates all keeper configuration from process.env. Throws
 * a descriptive error on the first problem found, the caller (index.ts)
 * is expected to let this crash the process at startup rather than run
 * with partial/invalid config.
 */
export function loadConfig(): KeeperConfig {
  // An EVM keeper key is needed exactly when an EVM chain is served.
  const keeperPrivateKeyRaw = servedChainIdsOf('evm').length > 0 ? required('KEEPER_PRIVATE_KEY') : (process.env.KEEPER_PRIVATE_KEY?.trim() ?? '')
  const normalizedKey = keeperPrivateKeyRaw === '' || keeperPrivateKeyRaw.startsWith('0x') ? keeperPrivateKeyRaw : `0x${keeperPrivateKeyRaw}`
  if (normalizedKey !== '' && (!isHex(normalizedKey) || normalizedKey.length !== 66)) {
    throw new Error('KEEPER_PRIVATE_KEY must be a 32-byte hex private key (0x followed by 64 hex characters).')
  }

  return {
    // Network + deployment come from ./network.ts (NETWORK + env), shared with the API and host.
    rpcUrl: RPC_URL,
    agentEcoAddress: AGENT_ECO_ADDRESS,
    keeperPrivateKey: normalizedKey === '' ? null : (normalizedKey as Hex),
    // KEEPER_POLL_INTERVAL_MS (spec name); KEEPER_INTERVAL_MS still honored for existing deployments.
    keeperIntervalMs: optionalNumber(
      process.env.KEEPER_POLL_INTERVAL_MS?.trim() ? 'KEEPER_POLL_INTERVAL_MS' : 'KEEPER_INTERVAL_MS',
      15_000
    ),
    dryRun: optionalBoolean('DRY_RUN', false),
    deploymentBlock: DEPLOYMENT_BLOCK,
  }
}
