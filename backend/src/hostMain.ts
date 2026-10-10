import { log, logError, setLogTag } from './log.ts'
import { runHostCycleOnce } from './host/buyerTaskHost.ts'
import { runSellerHostCycleOnce } from './host/sellerTaskHost.ts'
import { initArbiter, runArbiterCycleOnce } from './host/arbiter.ts'
import { indexRecentRatings } from './ratings.ts'
import { installAiCallLog } from './ai/aiCallLog.ts'
import { assertServedChainsMatchRpc, readChain, servedChainIds } from './chains.ts'
import { EXECUTION_WINDOW_SECONDS, REVIEW_WINDOW_SECONDS, assertDurationsFit } from '../../agent-runtime/src/durations.ts'

setLogTag('HOST')
// Every AI attempt the host makes is counted (GET /ai-calls/stats).
installAiCallLog()

const INTERVAL_MS = Number(process.env.HOST_INTERVAL_MS ?? 5000)
const RATING_SCAN_MS = 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Multi-tenant runtime for hosted buyer tasks ("make an agent buy for me"),
 * hosted seller agents and the AI arbiter —
 * the platform-run counterpart to the standalone buyer-agent/seller-agent
 * processes, which self-custody their own keys instead. Requires the API
 * server (src/server.ts) to already be running on the same host, since it
 * talks to the registry over HTTP like any other agent.
 */
async function main(): Promise<void> {
  log('Host runtime started', 'HOST')
  for (const id of servedChainIds()) {
    const { config } = readChain(id)
    log(`Chain: ${config.chain.name} (${id}) — contract ${config.agentEco}, ${config.tokenSymbol} ${config.usdt}`, 'HOST')
  }
  log(`Polling interval: ${INTERVAL_MS}ms`, 'HOST')

  // The host signs real transactions — never let it run against the wrong
  // chain, or with escrow windows a chain's contract would reject.
  await assertServedChainsMatchRpc()
  for (const id of servedChainIds()) assertDurationsFit(await readChain(id).timerLimits())
  log(`Escrow windows: execution ${EXECUTION_WINDOW_SECONDS}s, review ${REVIEW_WINDOW_SECONDS}s`, 'HOST')
  await initArbiter()

  let running = true
  const shutdown = (signal: string) => {
    log(`Received ${signal}, finishing current cycle then shutting down…`, 'HOST')
    running = false
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  /**
   * One independent loop per role. Sellers must answer a funded escrow within
   * the 120 s accept timeout, so they can't wait behind a buyer that is busy
   * sending three funding transactions on a slow RPC — and the arbiter's
   * deadlines are no different. Each role signs with its own wallets, so the
   * loops never share a nonce. A loop never overlaps itself.
   */
  async function loop(label: string, every: number, cycle: () => Promise<void>): Promise<void> {
    while (running) {
      try {
        await cycle()
      } catch (error) {
        logError(`${label} cycle failed`, error, 'HOST')
      }
      if (running) await sleep(every)
    }
  }

  await Promise.all([
    loop('Buyer host', INTERVAL_MS, runHostCycleOnce),
    loop('Seller host', INTERVAL_MS, runSellerHostCycleOnce),
    loop('Arbiter', INTERVAL_MS, runArbiterCycleOnce),
    // Ratings made outside our own flows, about once a minute, on every served chain.
    loop('Rating index', RATING_SCAN_MS, async () => {
      for (const id of servedChainIds()) {
        try {
          await indexRecentRatings(id)
        } catch (error) {
          logError(`Rating index ${id} failed`, error, 'HOST')
        }
      }
    }),
  ])

  log('Stopped.', 'HOST')
}

main().catch((error) => {
  logError('Fatal startup error', error, 'HOST')
  process.exit(1)
})
