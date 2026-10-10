import { evmAdapterFor } from '../../../agent-runtime/src/chain/default.ts'
import type { EvmAdapter } from '../../../agent-runtime/src/chain/evm.ts'
import type { Clients } from '../clients.ts'
import type { KeeperConfig } from '../config.ts'
import { log, logError } from '../log.ts'
import { decideKeeperAction, FLAG_FOR_STATUS, type KeeperAction } from './decide.ts'

const ACTION_REASON: Record<NonNullable<KeeperAction>, string> = {
  claimAcceptTimeout: 'seller never started the funded job',
  claimExecutionTimeout: 'seller missed the execution deadline',
  finalizeAfterReviewWindow: 'buyer let the review window expire',
  claimDisputeTimeout: 'arbiter missed the dispute deadline',
}

async function submitKeeperTx(
  chain: EvmAdapter,
  config: KeeperConfig,
  escrowId: bigint,
  functionName: NonNullable<KeeperAction>
): Promise<void> {
  if (config.dryRun) {
    log(`[DRY RUN] Would submit ${functionName}(#${escrowId}) — no transaction sent.`)
    return
  }

  try {
    // claimTimeout simulates first (catches a stale/ineligible escrow, e.g. someone
    // else's keeper already claimed it, before we spend gas), then sends, then awaits
    // the receipt — not just the hash — which is what guarantees this escrow can't be
    // double-submitted: processEscrow() is only called sequentially within a cycle, and
    // cycles never overlap (see index.ts), so nothing else touches this escrowId until
    // this resolves.
    const claim = await chain.claimTimeout(escrowId, functionName, {
      onSubmitting: () => log(`Submitting ${functionName}(#${escrowId})`),
      onSent: (hash) => log(`Transaction: ${hash}`),
    })
    log(
      `${functionName}(#${escrowId}) ${claim.success ? 'succeeded' : 'reverted'} — ` +
        `block ${claim.blockNumber}, tx ${claim.hash}`
    )
  } catch (error) {
    logError(`${functionName}(#${escrowId}) failed`, error)
  }
}

async function processEscrow(chain: EvmAdapter, config: KeeperConfig, escrowId: bigint, status: number): Promise<void> {
  try {
    // Only the flag that matters for this status is read (one RPC call, not four).
    const flag = FLAG_FOR_STATUS[status]
    if (!flag) return
    const flagValue = await chain.readTimeoutFlag(escrowId, flag)

    const action = decideKeeperAction(status, { [flag]: flagValue })
    if (!action) return

    log(`Escrow #${escrowId}: ${ACTION_REASON[action]} — calling ${action}`)
    await submitKeeperTx(chain, config, escrowId, action)
  } catch (error) {
    logError(`Failed checking escrow #${escrowId}`, error)
  }
}


/**
 * One full keeper pass on one chain: read every escrow's status straight from
 * the contract (batched — no event logs, so it works on RPCs that prune history),
 * then act on each one that can time out. Escrows are processed sequentially so
 * a slow or stuck transaction can't cause overlapping submissions. `chain` signs
 * with the keeper's wallet.
 */
export async function runKeeperCycleOn(chain: EvmAdapter, config: KeeperConfig, label = ''): Promise<void> {
  const escrows = await chain.listEscrows()
  const live = escrows.filter((e) => FLAG_FOR_STATUS[e.status] !== undefined)
  if (live.length) log(`${label}${escrows.length} escrows, ${live.length} live — checking timeouts`)

  for (const escrow of live) {
    await processEscrow(chain, config, escrow.id, escrow.status)
  }
}

/** One keeper pass on the primary chain, with the keeper's clients. */
export function runKeeperCycle(clients: Clients, config: KeeperConfig): Promise<void> {
  return runKeeperCycleOn(evmAdapterFor(clients), config)
}
