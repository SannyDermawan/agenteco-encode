import type { Address, Hex, PublicClient } from 'viem'
import { evmAdapterFor } from '../chain/default.ts'
import { canRule as canRuleSetup } from '../chain/evm.ts'
import type { ArbiterSetup } from '../chain/evm.ts'
import { AGENT_ECO_ADDRESS } from '../network.ts'
import type { OnchainClients } from './clients.ts'

/**
 * Who may rule disputes. AgentEco's arbiter is either a wallet, or (from v2)
 * an ArbiterCouncil contract — a small multisig whose members are the AI
 * arbiter's key and human operators. With a council, a member rules by
 * voting; the vote that reaches its ruling threshold executes the ruling.
 * The logic lives in the chain adapter (../chain/evm.ts).
 */

export type { ArbiterSetup } from '../chain/evm.ts'
export type { RulingOutcome } from '../chain/types.ts'

export function readArbiterSetup(publicClient: PublicClient, agentEco: Address = AGENT_ECO_ADDRESS): Promise<ArbiterSetup> {
  return evmAdapterFor({ publicClient }).arbiterSetupAt(agentEco)
}

/** Whether `address` can rule: it is the arbiter wallet, or a member of the arbiter council. */
export const canRule: (setup: ArbiterSetup, address: string) => boolean = canRuleSetup

/**
 * Rule a dispute as the arbiter: directly when the arbiter is this wallet,
 * or by a council vote when it is an ArbiterCouncil this wallet belongs to.
 */
export function ruleDispute(clients: OnchainClients, escrowId: bigint, toSeller: boolean, rationaleHash: Hex) {
  return evmAdapterFor(clients).ruleDispute(escrowId, toSeller, rationaleHash)
}
