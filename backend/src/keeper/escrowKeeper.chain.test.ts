import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { keccak256, toHex } from 'viem'
import { anvilUnavailable, startTestChain, type TestChain } from '../../../agent-runtime/test-support/anvil.ts'
import { MOCK_USDT_ABI } from '../../../agent-runtime/src/shared/abi.generated.ts'

/**
 * The keeper and the on-chain reputation read against a real local chain: every timeout
 * the keeper may claim, a dry run that changes nothing, and escrows that are not due yet.
 */
const skip = anvilUnavailable() ?? false

const S = { FUNDED: 1, EXECUTING: 2, DELIVERED: 3, DISPUTED: 4, SETTLED: 5, REFUNDED: 6 }

describe('keeper cycle on a local chain', { skip }, () => {
  let chain: TestChain
  let escrow: typeof import('../../../agent-runtime/src/onchain/escrow.ts')
  let keeper: typeof import('./escrowKeeper.ts')
  let reputation: typeof import('../host/reputation.ts')
  let buyer: ReturnType<typeof import('../../../agent-runtime/src/onchain/clients.ts').createOnchainClients>
  let seller: typeof buyer
  let keeperClients: ReturnType<typeof import('../clients.ts').createClients>
  let config: import('../config.ts').KeeperConfig

  const h = (s: string) => keccak256(toHex(s))
  const status = (id: bigint) => escrow.getEscrowStatus(buyer, id)
  const fund = () => escrow.createAndFundEscrow(buyer, chain.addresses.seller, '1', h('task'))

  before(async () => {
    chain = await startTestChain()
    process.env.RPC_URL = chain.rpcUrl
    process.env.RPC_FALLBACK_URLS = 'none'
    process.env.AGENT_ECO_ADDRESS = chain.agentEco
    process.env.USDT_ADDRESS = chain.usdt
    process.env.KEEPER_PRIVATE_KEY = chain.keys.keeper
    escrow = await import('../../../agent-runtime/src/onchain/escrow.ts')
    keeper = await import('./escrowKeeper.ts')
    reputation = await import('../host/reputation.ts')
    const { createOnchainClients } = await import('../../../agent-runtime/src/onchain/clients.ts')
    const { createClients } = await import('../clients.ts')
    const { loadConfig } = await import('../config.ts')
    buyer = createOnchainClients(chain.keys.buyer)
    seller = createOnchainClients(chain.keys.seller)
    config = loadConfig()
    keeperClients = createClients(config)
    const hash = await buyer.walletClient.writeContract({ address: chain.usdt, abi: MOCK_USDT_ABI, functionName: 'faucet' })
    await buyer.publicClient.waitForTransactionReceipt({ hash })
  })

  after(() => chain?.stop())

  test('claims every kind of timeout, only for what is due, and a dry run changes nothing', async () => {
    const funded = await fund() // seller never starts
    const executing = await fund() // seller starts, never delivers
    await escrow.startExecution(seller, executing)
    const delivered = await fund() // buyer never answers
    await escrow.startExecution(seller, delivered)
    await escrow.markDelivered(seller, delivered, h('result'))
    const disputed = await fund() // arbiter never rules
    await escrow.startExecution(seller, disputed)
    await escrow.markDelivered(seller, disputed, h('result'))
    await escrow.raiseDispute(buyer, disputed, h('reason'))

    // Nothing is due yet: a cycle leaves everything alone.
    await keeper.runKeeperCycle(keeperClients, config)
    assert.deepEqual(
      await Promise.all([funded, executing, delivered, disputed].map(status)),
      [S.FUNDED, S.EXECUTING, S.DELIVERED, S.DISPUTED]
    )

    // Past every deadline, a dry run only logs.
    await chain.advance(1000)
    await keeper.runKeeperCycle(keeperClients, { ...config, dryRun: true })
    assert.deepEqual(
      await Promise.all([funded, executing, delivered, disputed].map(status)),
      [S.FUNDED, S.EXECUTING, S.DELIVERED, S.DISPUTED]
    )

    await keeper.runKeeperCycle(keeperClients, config)
    assert.equal(await status(funded), S.REFUNDED) // claimAcceptTimeout
    assert.equal(await status(executing), S.REFUNDED) // claimExecutionTimeout
    assert.equal(await status(delivered), S.SETTLED) // finalizeAfterReviewWindow
    assert.equal(await status(disputed), S.REFUNDED) // claimDisputeTimeout

    // A fresh escrow is not due, so the next cycle skips it.
    const fresh = await fund()
    await keeper.runKeeperCycle(keeperClients, config)
    assert.equal(await status(fresh), S.FUNDED)
  })

  test('on-chain reputation of the seller, summed over deployments', async () => {
    const rep = await reputation.getOnchainReputation(buyer.publicClient as never, chain.addresses.seller)
    assert.deepEqual(rep, {
      completedJobs: 1,
      failedJobs: 1,
      successRatePct: 50,
      ratingCount: 0,
      avgRatingScore: null,
    })
  })
})
