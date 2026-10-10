import type { Address, PublicClient } from 'viem'
import { evmAdapterFor } from '../../../agent-runtime/src/chain/default.ts'
import type { OnchainReputation } from '../../../agent-runtime/src/chain/types.ts'

export type { OnchainReputation }

/**
 * Raw on-chain reputation, as AgentEco.sol reports it — summed over the
 * current deployment and every legacy one, so a seller keeps its history.
 */
export function getOnchainReputation(publicClient: PublicClient, address: Address): Promise<OnchainReputation> {
  return evmAdapterFor({ publicClient }).getReputation(address)
}
