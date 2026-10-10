import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { encodeFunctionData, keccak256, toHex } from 'viem'
import { anvilUnavailable, startTestChain, type TestChain } from '../../test-support/anvil.ts'
import { AGENT_ECO_ABI, ARBITER_COUNCIL_ABI, MOCK_USDT_ABI } from '../shared/abi.generated.ts'

/**
 * The whole escrow lifecycle against a real local chain: create, fund, execute, deliver,
 * settle, rate, dispute and rule (wallet arbiter and ArbiterCouncil), through the public
 * helpers of ./escrow.ts, ./arbiter.ts and ./escrowIndex.ts. It pins the behaviour of the
 * on-chain layer, whatever code sits underneath.
 */
const skip = anvilUnavailable() ?? false

// Status values of AgentEco.OrderStatus.
const S = { CREATED: 0, FUNDED: 1, EXECUTING: 2, DELIVERED: 3, DISPUTED: 4, SETTLED: 5, REFUNDED: 6 }

describe('escrow lifecycle on a local chain', { skip }, () => {
  let chain: TestChain
  // Loaded after the env is set: ../network.ts reads the deployment from it at import time.
  let escrow: typeof import('./escrow.ts')
  let arbiterMod: typeof import('./arbiter.ts')
  let index: typeof import('./escrowIndex.ts')
  let clientsMod: typeof import('./clients.ts')
  let clients: Record<'buyer' | 'seller' | 'arbiter' | 'other', ReturnType<typeof import('./clients.ts').createOnchainClients>>

  const h = (s: string) => keccak256(toHex(s))
  const taskHash = h('task')

  before(async () => {
    chain = await startTestChain()
    process.env.RPC_URL = chain.rpcUrl
    process.env.RPC_FALLBACK_URLS = 'none'
    process.env.AGENT_ECO_ADDRESS = chain.agentEco
    process.env.USDT_ADDRESS = chain.usdt
    escrow = await import('./escrow.ts')
    arbiterMod = await import('./arbiter.ts')
    index = await import('./escrowIndex.ts')
    clientsMod = await import('./clients.ts')
    clients = {
      buyer: clientsMod.createOnchainClients(chain.keys.buyer),
      seller: clientsMod.createOnchainClients(chain.keys.seller),
      arbiter: clientsMod.createOnchainClients(chain.keys.arbiter),
      other: clientsMod.createOnchainClients(chain.keys.other),
    }
    // The buyer funds itself from the token's faucet (100 mUSDT).
    const hash = await clients.buyer.walletClient.writeContract({ address: chain.usdt, abi: MOCK_USDT_ABI, functionName: 'faucet' })
    await clients.buyer.publicClient.waitForTransactionReceipt({ hash })
  })

  after(() => chain?.stop())

  const fund = (price: string) => escrow.createAndFundEscrow(clients.buyer, chain.addresses.seller, price, taskHash)
  const deliver = async (id: bigint, result = 'result') => {
    await escrow.startExecution(clients.seller, id)
    await escrow.markDelivered(clients.seller, id, h(result))
  }

  test('create, fund, execute, deliver, settle, rate', async () => {
    const id = await fund('1.5')
    assert.equal(id, BigInt(1))
    assert.equal(await escrow.getEscrowStatus(clients.buyer, id), S.FUNDED)
    assert.equal((await escrow.getEscrowHashes(clients.buyer, id)).taskHash, taskHash)

    await escrow.startExecution(clients.seller, id)
    assert.equal(await escrow.getEscrowStatus(clients.buyer, id), S.EXECUTING)
    const windows = await escrow.getEscrowWindows(clients.buyer, id)
    assert.equal(windows.executionWindow, BigInt(300))
    assert.equal(windows.reviewWindow, BigInt(600))
    assert.ok(windows.executionDeadline > BigInt(0))

    await escrow.markDelivered(clients.seller, id, h('result'))
    assert.equal(await escrow.getEscrowStatus(clients.buyer, id), S.DELIVERED)
    assert.equal((await escrow.getEscrowHashes(clients.buyer, id)).resultHash, h('result'))
    const ts = await escrow.getEscrowTimestamps(clients.buyer, id)
    assert.ok(ts.createdAt > BigInt(0) && ts.fundedAt > BigInt(0) && ts.executingAt > BigInt(0) && ts.deliveredAt > BigInt(0))
    assert.equal(ts.settledAt, BigInt(0))

    await escrow.acceptAndSettle(clients.buyer, id)
    assert.equal(await escrow.getEscrowStatus(clients.buyer, id), S.SETTLED)

    assert.equal((await escrow.getEscrowDisputeInfo(clients.buyer, id)).rated, false)
    const rateTx = await escrow.rateSeller(clients.buyer, id, 80)
    assert.match(rateTx, /^0x[0-9a-f]{64}$/)
    assert.equal((await escrow.getEscrowDisputeInfo(clients.buyer, id)).rated, true)

    // The seller got the price minus the 2.5% fee.
    const balance = await clients.seller.publicClient.readContract({ address: chain.usdt, abi: MOCK_USDT_ABI, functionName: 'balanceOf', args: [chain.addresses.seller] })
    assert.equal(balance, BigInt('1462500000000000000'))
  })

  test('dispute: seller response, wallet arbiter rules for the buyer', async () => {
    const id = await fund('1')
    await deliver(id, 'bad result')
    const reasonTx = await escrow.raiseDispute(clients.buyer, id, h('reason'))
    assert.match(reasonTx, /^0x[0-9a-f]{64}$/)
    assert.equal(await escrow.getEscrowStatus(clients.buyer, id), S.DISPUTED)
    await escrow.submitDisputeResponse(clients.seller, id, h('response'))
    const hashes = await escrow.getEscrowHashes(clients.buyer, id)
    assert.equal(hashes.disputeReasonHash, h('reason'))
    assert.equal(hashes.disputeResponseHash, h('response'))
    const info = await escrow.getEscrowDisputeInfo(clients.buyer, id)
    assert.ok(info.disputedAt > BigInt(0) && info.disputeDeadline > info.disputedAt)

    const setup = await arbiterMod.readArbiterSetup(clients.buyer.publicClient)
    assert.equal(setup.arbiter, chain.addresses.arbiter)
    assert.equal(setup.council, null)
    assert.equal(arbiterMod.canRule(setup, chain.addresses.arbiter), true)
    assert.equal(arbiterMod.canRule(setup, chain.addresses.other), false)

    await assert.rejects(arbiterMod.ruleDispute(clients.other, id, false, h('rationale')), /neither the arbiter nor a member/)
    const outcome = await arbiterMod.ruleDispute(clients.arbiter, id, false, h('rationale'))
    assert.equal(outcome.kind, 'executed')
    assert.equal(await escrow.getEscrowStatus(clients.buyer, id), S.REFUNDED)
    assert.equal((await escrow.getEscrowHashes(clients.buyer, id)).resolutionHash, h('rationale'))
  })

  test('direct resolveDispute for the seller, and an unrelated wallet cannot', async () => {
    const id = await fund('1')
    await deliver(id)
    await escrow.raiseDispute(clients.buyer, id, h('reason2'))
    await assert.rejects(escrow.resolveDispute(clients.other, id, true, h('r2')))
    await escrow.resolveDispute(clients.arbiter, id, true, h('r2'))
    assert.equal(await escrow.getEscrowStatus(clients.buyer, id), S.SETTLED)
  })

  test('a failed write throws', async () => {
    const id = await fund('0.5')
    // Not disputed, so a response cannot be submitted.
    await assert.rejects(escrow.submitDisputeResponse(clients.seller, id, h('x')))
  })

  test('escrow index lists every escrow with basics', async () => {
    const ids = await index.allEscrowIds(clients.buyer.publicClient)
    assert.deepEqual(ids, [BigInt(1), BigInt(2), BigInt(3), BigInt(4)])
    assert.deepEqual(await index.currentEscrowIds(clients.buyer.publicClient), ids)
    const all = await index.readAllEscrows(clients.buyer.publicClient)
    assert.equal(all.length, 4)
    assert.equal(all[0].id, BigInt(1))
    assert.equal(all[0].buyer, chain.addresses.buyer)
    assert.equal(all[0].seller, chain.addresses.seller)
    assert.equal(all[0].amount, BigInt('1500000000000000000'))
    assert.deepEqual(
      all.map((e) => e.status),
      [S.SETTLED, S.REFUNDED, S.SETTLED, S.FUNDED]
    )
    const some = await index.readEscrowBasics(clients.buyer.publicClient, [BigInt(2), BigInt(4)])
    assert.deepEqual(
      some.map((e) => e.id),
      [BigInt(2), BigInt(4)]
    )
    assert.equal((await index.readCurrentEscrows(clients.buyer.publicClient)).length, 4)
  })

  test('ArbiterCouncil: votes accumulate and the last one executes the ruling', async () => {
    const council = await chain.deployCouncil([chain.addresses.arbiter, chain.addresses.other], 2, 1)
    // Hand the arbiter role to the council: the old arbiter names it, the council accepts via an admin vote.
    const a = clients.arbiter
    await a.publicClient.waitForTransactionReceipt({
      hash: await a.walletClient.writeContract({ address: chain.agentEco, abi: AGENT_ECO_ABI, functionName: 'transferArbiter', args: [council] }),
    })
    const accept = encodeFunctionData({ abi: AGENT_ECO_ABI, functionName: 'acceptArbiter' })
    await a.publicClient.waitForTransactionReceipt({
      hash: await a.walletClient.writeContract({ address: council, abi: ARBITER_COUNCIL_ABI, functionName: 'proposeAdmin', args: [chain.agentEco, accept] }),
    })

    const setup = await arbiterMod.readArbiterSetup(clients.buyer.publicClient)
    assert.equal(setup.arbiter.toLowerCase(), council.toLowerCase())
    assert.equal(setup.council?.rulingThreshold, 2)
    assert.equal(setup.council?.adminThreshold, 1)
    assert.deepEqual(
      setup.council?.members.map((m) => m.toLowerCase()).sort(),
      [chain.addresses.arbiter, chain.addresses.other].map((m) => m.toLowerCase()).sort()
    )
    assert.equal(arbiterMod.canRule(setup, chain.addresses.other), true)
    assert.equal(arbiterMod.canRule(setup, chain.addresses.buyer), false)

    const id = await fund('1')
    await deliver(id)
    await escrow.raiseDispute(clients.buyer, id, h('reason3'))

    await assert.rejects(arbiterMod.ruleDispute(clients.buyer, id, true, h('r3')), /neither the arbiter nor a member/)
    const first = await arbiterMod.ruleDispute(clients.arbiter, id, true, h('r3'))
    assert.equal(first.kind, 'voted')
    if (first.kind === 'voted') assert.deepEqual([first.votes, first.needed], [1, 2])
    const again = await arbiterMod.ruleDispute(clients.arbiter, id, true, h('r3'))
    assert.deepEqual(again, { kind: 'already-voted', votes: 1, needed: 2 })
    const last = await arbiterMod.ruleDispute(clients.other, id, true, h('r3'))
    assert.equal(last.kind, 'executed')
    assert.equal(await escrow.getEscrowStatus(clients.buyer, id), S.SETTLED)
  })
})
