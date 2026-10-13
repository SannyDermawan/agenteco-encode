/** Mirrors AgentEco.sol's OrderStatus enum exactly. Do not renumber. */
export const ORDER_STATUS = {
  CREATED: 0,
  FUNDED: 1,
  EXECUTING: 2,
  DELIVERED: 3,
  DISPUTED: 4,
  SETTLED: 5,
  REFUNDED: 6,
} as const

export type KeeperAction =
  | 'claimAcceptTimeout'
  | 'claimExecutionTimeout'
  | 'finalizeAfterReviewWindow'
  | 'claimDisputeTimeout'
  | null

/** The eligibility flags AgentEco.sol itself exposes (isAcceptTimedOut, …). */
export interface TimeoutFlags {
  acceptTimedOut: boolean
  executionTimedOut: boolean
  reviewExpired: boolean
  disputeTimedOut: boolean
}

/** Which flag matters for each status that can time out, the keeper reads only that one. */
export const FLAG_FOR_STATUS: Partial<Record<number, keyof TimeoutFlags>> = {
  [ORDER_STATUS.FUNDED]: 'acceptTimedOut',
  [ORDER_STATUS.EXECUTING]: 'executionTimedOut',
  [ORDER_STATUS.DELIVERED]: 'reviewExpired',
  [ORDER_STATUS.DISPUTED]: 'disputeTimedOut',
}

/**
 * Pure decision function, no I/O. Given an escrow's on-chain status and the
 * contract's own eligibility flags, decides which permissionless call, if any,
 * moves it on. Every non-final status has one, so no escrow can stay stuck:
 *   FUNDED    → claimAcceptTimeout        (seller never started)
 *   EXECUTING → claimExecutionTimeout     (seller never delivered)
 *   DELIVERED → finalizeAfterReviewWindow (buyer never answered)
 *   DISPUTED  → claimDisputeTimeout       (arbiter never ruled)
 */
export function decideKeeperAction(status: number, flags: Partial<TimeoutFlags>): KeeperAction {
  if (status === ORDER_STATUS.FUNDED && flags.acceptTimedOut) return 'claimAcceptTimeout'
  if (status === ORDER_STATUS.EXECUTING && flags.executionTimedOut) return 'claimExecutionTimeout'
  if (status === ORDER_STATUS.DELIVERED && flags.reviewExpired) return 'finalizeAfterReviewWindow'
  if (status === ORDER_STATUS.DISPUTED && flags.disputeTimedOut) return 'claimDisputeTimeout'
  return null
}
