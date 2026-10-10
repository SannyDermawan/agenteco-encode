import type { Address, Hex } from 'viem'
import { evmAdapterFor } from '../chain/default.ts'
import type { OnchainClients } from './clients.ts'

/**
 * Escrow calls against the configured chain, taking a wallet's clients. The logic lives in
 * the chain adapter (../chain/evm.ts); these keep the signatures the SDK and hosts use.
 */

/**
 * Buyer side: create the escrow for the negotiated price, committing the task's
 * hash (see ../shared/hashes.ts), then fund it.
 */
export function createAndFundEscrow(
  clients: OnchainClients,
  sellerAddress: Address,
  priceUsdt: number | string,
  taskHash: Hex
): Promise<bigint> {
  return evmAdapterFor(clients).createAndFundEscrow({ seller: sellerAddress, amount: priceUsdt, taskHash })
}

/** Seller side: move a funded escrow into EXECUTING. */
export function startExecution(clients: OnchainClients, escrowId: bigint): Promise<void> {
  return evmAdapterFor(clients).startExecution(escrowId)
}

/** Seller side: deliver the task result (a hash of it — the payload itself lives off-chain/in logs). */
export function markDelivered(clients: OnchainClients, escrowId: bigint, resultHash: `0x${string}`): Promise<void> {
  return evmAdapterFor(clients).markDelivered(escrowId, resultHash)
}

/** Buyer side: accept the delivered result and release payment in one call. */
export function acceptAndSettle(clients: OnchainClients, escrowId: bigint): Promise<void> {
  return evmAdapterFor(clients).acceptAndSettle(escrowId)
}

export function getEscrowStatus(clients: Pick<OnchainClients, 'publicClient'>, escrowId: bigint): Promise<number> {
  return evmAdapterFor(clients).getEscrowStatus(escrowId)
}

/** Buyer side: dispute a delivered result. `reasonHash` = textHash(reason); the text goes to the API after. */
export function raiseDispute(clients: OnchainClients, escrowId: bigint, reasonHash: `0x${string}`) {
  return evmAdapterFor(clients).raiseDispute(escrowId, reasonHash)
}

/** Seller side: answer a dispute once, before its deadline. */
export function submitDisputeResponse(clients: OnchainClients, escrowId: bigint, responseHash: `0x${string}`) {
  return evmAdapterFor(clients).submitDisputeResponse(escrowId, responseHash)
}

/** Buyer side: rate the seller 1–100, once, after the escrow is final and something was delivered. */
export function rateSeller(clients: OnchainClients, escrowId: bigint, score: number) {
  return evmAdapterFor(clients).rateSeller(escrowId, score)
}

/**
 * Arbiter side: rule a dispute, committing the rationale's hash — only when the
 * arbiter is this wallet. ruleDispute (./arbiter.ts) also handles an ArbiterCouncil.
 */
export function resolveDispute(clients: OnchainClients, escrowId: bigint, toSeller: boolean, rationaleHash: `0x${string}`) {
  return evmAdapterFor(clients).resolveDispute(escrowId, toSeller, rationaleHash)
}

/** getEscrowDisputeInfo: dispute timing, the accept deadline and whether the buyer has rated. */
export function getEscrowDisputeInfo(clients: Pick<OnchainClients, 'publicClient'>, escrowId: bigint) {
  return evmAdapterFor(clients).getEscrowDisputeInfo(escrowId)
}

/** getEscrowHashes: every hash committed for an escrow (0x00… until that stage happened). */
export function getEscrowHashes(clients: Pick<OnchainClients, 'publicClient'>, escrowId: bigint) {
  return evmAdapterFor(clients).getEscrowHashes(escrowId)
}

/** getEscrowTimestamps: createdAt … settledAt (0 until reached). */
export function getEscrowTimestamps(clients: Pick<OnchainClients, 'publicClient'>, escrowId: bigint) {
  return evmAdapterFor(clients).getEscrowTimestamps(escrowId)
}

/** getEscrowWindows: the negotiated windows, and their deadlines (0 until execution / delivery started). */
export function getEscrowWindows(clients: Pick<OnchainClients, 'publicClient'>, escrowId: bigint) {
  return evmAdapterFor(clients).getEscrowWindows(escrowId)
}
