import type { PublicClient } from 'viem'
import { evmAdapterFor } from '../chain/default.ts'

/**
 * Escrow discovery from contract state, not event logs. Public BSC Testnet
 * RPCs either refuse eth_getLogs (the official data-seed nodes) or prune log
 * history after ~80,000 blocks (~18 hours, PublicNode), so a log scan from the
 * deploy block breaks a day after deployment. AgentEco.sol numbers escrows
 * firstEscrowId..nextEscrowId-1 and exposes each one through getEscrowBasic,
 * which works against any RPC, forever.
 *
 * Legacy deployments (v1 and v2, see ../network.ts) come first, each within
 * its own id range; ids never overlap, so callers treat every contract as one
 * list and agentEcoFor(id) finds the right one. The logic lives in the chain
 * adapter (../chain/evm.ts).
 */

export type { EscrowBasic } from '../chain/evm.ts'

/** Every escrow id that exists: each legacy deployment's, oldest first, then the current one's. */
export function allEscrowIds(publicClient: PublicClient): Promise<bigint[]> {
  return evmAdapterFor({ publicClient }).escrowIds()
}

/** Escrow ids on the current deployment only, the ones that can still change. */
export function currentEscrowIds(publicClient: PublicClient): Promise<bigint[]> {
  return evmAdapterFor({ publicClient }).escrowIds({ currentOnly: true })
}

/** Reads getEscrowBasic for many ids, batched through Multicall3 when the chain has it. */
export function readEscrowBasics(publicClient: PublicClient, ids: bigint[]) {
  return evmAdapterFor({ publicClient }).readEscrowBasics(ids)
}

/** Every escrow, as basic info. */
export function readAllEscrows(publicClient: PublicClient) {
  return evmAdapterFor({ publicClient }).listEscrows()
}

/** Every escrow on the current deployment, as basic info. */
export function readCurrentEscrows(publicClient: PublicClient) {
  return evmAdapterFor({ publicClient }).listEscrows({ currentOnly: true })
}
