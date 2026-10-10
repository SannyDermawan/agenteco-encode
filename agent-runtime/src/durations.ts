import type { PublicClient } from 'viem'
import { AGENT_ECO_ABI } from './shared/abi.generated.ts'
import { AGENT_ECO_ADDRESS } from './network.ts'

/**
 * Every off-chain timer, from env (spec §12.2). Defaults are the demo values
 * this deployment runs with; production values are in the comments and in
 * .env.example. The contract-side timers (accept timeout, dispute timeout,
 * min window) are constructor arguments — see script/Deploy.s.sol.
 */

function seconds(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive whole number of seconds, got: ${raw}`)
  return n
}

/** How long the seller has to deliver after startExecution. Production: 86400. */
export const EXECUTION_WINDOW_SECONDS = BigInt(seconds('EXECUTION_WINDOW_SECONDS', 300))
/** How long the buyer has to accept or dispute after delivery. Production: 172800. */
export const REVIEW_WINDOW_SECONDS = BigInt(seconds('REVIEW_WINDOW_SECONDS', 600))
/** How long a seller has to answer a dispute before the AI arbiter runs without it. Production: 43200. */
export const SELLER_RESPONSE_WINDOW_SECONDS = seconds('SELLER_RESPONSE_WINDOW_SECONDS', 120)
/** How long the human arbiter can override the AI recommendation before it executes. Production: 21600. */
export const ARBITER_OVERRIDE_WINDOW_SECONDS = seconds('ARBITER_OVERRIDE_WINDOW_SECONDS', 180)
/**
 * How long the side whose turn it is may stay silent in a negotiation before it expires,
 * so a buyer is never left waiting on a seller that went away (and vice versa). Production: 3600.
 */
export const NEGOTIATION_TURN_SECONDS = seconds('NEGOTIATION_TURN_SECONDS', 300)
/** A self-hosted agent (the SDK) tells AgentEco it is still running this often. */
export const HEARTBEAT_SECONDS = 30
/** A self-hosted seller with no heartbeat for this long is shown offline. */
export const SELF_HOSTED_STALE_SECONDS = seconds('SELF_HOSTED_STALE_SECONDS', 120)

/**
 * Refuses to run with timers the deployed contract would reject, or that
 * leave the AI arbiter no room before the on-chain dispute deadline:
 * - execution / review windows within [minWindow, MAX_WINDOW]
 * - seller response + arbiter override ≤ half of disputeTimeout
 */
export async function assertDurationsFitContract(publicClient: PublicClient): Promise<void> {
  const read = <T>(functionName: 'minWindow' | 'MAX_WINDOW' | 'disputeTimeout') =>
    publicClient.readContract({ address: AGENT_ECO_ADDRESS, abi: AGENT_ECO_ABI, functionName }) as Promise<T>
  const [minWindow, maxWindow, disputeTimeout] = await Promise.all([
    read<bigint>('minWindow'),
    read<bigint>('MAX_WINDOW'),
    read<bigint>('disputeTimeout'),
  ])
  assertDurationsFit({ minWindow, maxWindow, disputeTimeout })
}

/** The same check against limits already read (e.g. a chain adapter's timerLimits()), for any chain. */
export function assertDurationsFit({ minWindow, maxWindow, disputeTimeout }: { minWindow: bigint; maxWindow: bigint; disputeTimeout: bigint }): void {
  for (const [name, value] of [
    ['EXECUTION_WINDOW_SECONDS', EXECUTION_WINDOW_SECONDS],
    ['REVIEW_WINDOW_SECONDS', REVIEW_WINDOW_SECONDS],
  ] as const) {
    if (value < minWindow || value > maxWindow) {
      throw new Error(`${name}=${value} is outside the contract's allowed range [${minWindow}, ${maxWindow}] seconds.`)
    }
  }

  const disputeBudget = SELLER_RESPONSE_WINDOW_SECONDS + ARBITER_OVERRIDE_WINDOW_SECONDS
  if (BigInt(disputeBudget) * BigInt(2) > disputeTimeout) {
    throw new Error(
      `SELLER_RESPONSE_WINDOW_SECONDS + ARBITER_OVERRIDE_WINDOW_SECONDS (${disputeBudget}s) must be at most half of ` +
        `the contract's disputeTimeout (${disputeTimeout}s), so the AI arbiter can act before the deadline.`
    )
  }
}
