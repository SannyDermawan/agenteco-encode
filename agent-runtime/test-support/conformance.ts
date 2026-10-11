/**
 * One scenario, run against every ChainAdapter: the whole escrow state machine through the
 * chain-neutral interface only (settle, both dispute rulings, every timeout), with exact
 * balance accounting and access-control checks. If an adapter drifts from the EVM contract's
 * behaviour, it fails here.
 */
import assert from 'node:assert/strict'
import { keccak256, toHex } from 'viem'
import type { ChainAdapter, Hash32 } from '../src/chain/types.ts'

const hash = (text: string) => keccak256(toHex(text)) as Hash32

const FUNDED = 1
const EXECUTING = 2
const DELIVERED = 3
const DISPUTED = 4
const SETTLED = 5
const REFUNDED = 6

export interface ConformanceRig {
  buyer: ChainAdapter
  seller: ChainAdapter
  /** Signs disputes with the deployment's arbiter wallet. */
  arbiter: ChainAdapter
  /** Any funded wallet: the permissionless timeout claims. */
  keeper: ChainAdapter
  /** Where platform fees are paid. */
  treasuryAddress: string
  feeBps: number
  decimals: number
  /** Escrow windows the adapters were configured with, and the deployment's accept timeout (seconds). */
  executionWindow: number
  reviewWindow: number
  acceptTimeout: number
  /** The buyer's signature of `message`, as the chain's wallets produce it. */
  signAsBuyer(message: string): Promise<string>
  /** Give the buyer settlement tokens (base units). */
  fundBuyer(amount: bigint): Promise<void>
  /** Move the chain's clock forward. */
  advance(seconds: number): Promise<void>
}

export async function runConformance(rig: ConformanceRig): Promise<void> {
  const { buyer, seller, arbiter, keeper } = rig
  const buyerAddress = buyer.signer!
  const sellerAddress = seller.signer!
  const same = (a: string, b: string) => buyer.normalizeAddress(a) === buyer.normalizeAddress(b)
  const balance = (address: string) => buyer.tokenBalance(address)

  // --- Identity ------------------------------------------------------------------------------
  assert.equal(buyer.isValidAddress(buyerAddress), true)
  assert.equal(buyer.isValidAddress('not an address'), false)
  assert.equal(buyer.isValidAddress(''), false)

  const message = 'AgentEco conformance sign-in'
  const signature = await rig.signAsBuyer(message)
  assert.equal(await buyer.verifySignature({ address: buyerAddress, message, signature }), true)
  assert.equal(await buyer.verifySignature({ address: buyerAddress, message: `${message}!`, signature }), false, 'another message')
  assert.equal(await buyer.verifySignature({ address: sellerAddress, message, signature }), false, "another wallet's signature")
  assert.equal(await buyer.verifySignature({ address: buyerAddress, message, signature: 'garbage' }), false, 'garbage')

  const token = await buyer.token()
  assert.equal(token.decimals, rig.decimals)
  const unit = BigInt(10) ** BigInt(token.decimals)
  const price = BigInt(2) * unit
  const fee = (price * BigInt(rig.feeBps)) / BigInt(10_000)
  assert.ok(fee > BigInt(0), 'the scenario needs a fee to prove it is charged only on settlement')
  await rig.fundBuyer(BigInt(100) * unit)

  // Expected balances, moved by every step below.
  const expected = { buyer: await balance(buyerAddress), seller: await balance(sellerAddress), treasury: await balance(rig.treasuryAddress) }
  const checkBalances = async (when: string) => {
    assert.equal(await balance(buyerAddress), expected.buyer, `buyer balance ${when}`)
    assert.equal(await balance(sellerAddress), expected.seller, `seller balance ${when}`)
    assert.equal(await balance(rig.treasuryAddress), expected.treasury, `treasury balance ${when}`)
  }
  const created: bigint[] = []
  const open = async (task: string) => {
    const id = await buyer.createAndFundEscrow({ seller: sellerAddress, amount: '2', taskHash: hash(task) })
    created.push(id)
    expected.buyer -= price
    assert.equal(await buyer.getEscrowStatus(id), FUNDED)
    await checkBalances(`after funding ${task}`)
    return id
  }
  const deliver = async (id: bigint, task: string) => {
    await seller.startExecution(id)
    assert.equal(await buyer.getEscrowStatus(id), EXECUTING)
    await seller.markDelivered(id, hash(`result of ${task}`))
    assert.equal(await buyer.getEscrowStatus(id), DELIVERED)
  }
  const paidToSeller = () => {
    expected.seller += price - fee
    expected.treasury += fee
  }
  const refunded = () => {
    expected.buyer += price
  }

  // --- 1. Settlement: the fee is taken from the price, the rest goes to the seller ---------------
  const id1 = await open('task 1')
  const basic = await buyer.getEscrowBasic(id1)
  assert.equal(basic.id, id1)
  assert.ok(same(basic.buyer, buyerAddress))
  assert.ok(same(basic.seller, sellerAddress))
  assert.equal(basic.amount, price)
  assert.equal((await buyer.getEscrowHashes(id1)).taskHash, hash('task 1'))
  const windows = await buyer.getEscrowWindows(id1)
  assert.equal(windows.executionWindow, BigInt(rig.executionWindow))
  assert.equal(windows.reviewWindow, BigInt(rig.reviewWindow))
  assert.equal(windows.executionDeadline, BigInt(0), 'no deadline before execution starts')

  await assert.rejects(buyer.startExecution(id1), 'only the seller starts execution')
  await seller.startExecution(id1)
  assert.equal(await buyer.getEscrowStatus(id1), EXECUTING)
  let stamps = await buyer.getEscrowTimestamps(id1)
  assert.ok(stamps.executingAt > BigInt(0) && stamps.fundedAt > BigInt(0) && stamps.createdAt > BigInt(0))
  assert.equal((await buyer.getEscrowWindows(id1)).executionDeadline - stamps.executingAt, BigInt(rig.executionWindow))
  assert.equal(stamps.deliveredAt, BigInt(0))

  await assert.rejects(buyer.acceptAndSettle(id1), 'nothing delivered yet')
  await seller.markDelivered(id1, hash('result of task 1'))
  assert.equal(await buyer.getEscrowStatus(id1), DELIVERED)
  assert.equal(await buyer.getResultHash(id1), hash('result of task 1'))
  stamps = await buyer.getEscrowTimestamps(id1)
  assert.equal((await buyer.getEscrowWindows(id1)).reviewDeadline - stamps.deliveredAt, BigInt(rig.reviewWindow))

  await assert.rejects(seller.acceptAndSettle(id1), 'only the buyer pays')
  await buyer.acceptAndSettle(id1)
  paidToSeller()
  assert.equal(await buyer.getEscrowStatus(id1), SETTLED)
  assert.ok((await buyer.getEscrowTimestamps(id1)).settledAt > BigInt(0))
  await checkBalances('after settlement')

  await assert.rejects(buyer.rateSeller(id1, 0), 'score 0')
  await assert.rejects(buyer.rateSeller(id1, 101), 'score 101')
  await assert.rejects(seller.rateSeller(id1, 100), 'only the buyer rates')
  await buyer.rateSeller(id1, 90)
  assert.equal((await buyer.getEscrowDisputeInfo(id1)).rated, true)
  await assert.rejects(buyer.rateSeller(id1, 90), 'one rating per escrow')
  assert.deepEqual(await buyer.getReputation(sellerAddress), { completedJobs: 1, failedJobs: 0, successRatePct: 100, ratingCount: 1, avgRatingScore: 90 })

  // --- 2. A dispute the arbiter rules for the buyer: full refund, no fee, a failed job ------------
  const id2 = await open('task 2')
  await deliver(id2, 'task 2')
  await assert.rejects(buyer.raiseDispute(id2, `0x${'00'.repeat(32)}` as Hash32), 'a dispute needs a reason')
  await assert.rejects(seller.raiseDispute(id2, hash('reason 2')), 'only the buyer disputes')
  await buyer.raiseDispute(id2, hash('reason 2'))
  assert.equal(await buyer.getEscrowStatus(id2), DISPUTED)
  const limits = await buyer.timerLimits()
  assert.equal(limits.minWindow, BigInt(120))
  assert.equal(limits.disputeTimeout, BigInt(900))
  assert.ok(limits.maxWindow > limits.minWindow)
  const info2 = await buyer.getEscrowDisputeInfo(id2)
  assert.ok(info2.disputedAt > BigInt(0))
  assert.equal(info2.disputeDeadline - info2.disputedAt, limits.disputeTimeout)

  await seller.submitDisputeResponse(id2, hash('response 2'))
  await assert.rejects(seller.submitDisputeResponse(id2, hash('response 2, again')), 'one response only')
  await assert.rejects(buyer.resolveDispute(id2, true, hash('rationale')), 'the buyer is not the arbiter')
  await assert.rejects(seller.ruleDispute(id2, true, hash('rationale')), 'the seller is not the arbiter')
  const setup = await arbiter.getArbiterSetup(id2)
  assert.ok(same(setup.arbiter, arbiter.signer!))
  assert.equal(setup.council, null)
  const ruling = await arbiter.ruleDispute(id2, false, hash('rationale 2'))
  assert.equal(ruling.kind, 'executed')
  refunded()
  assert.equal(await buyer.getEscrowStatus(id2), REFUNDED)
  assert.deepEqual(await buyer.getEscrowHashes(id2), {
    taskHash: hash('task 2'),
    resultHash: hash('result of task 2'),
    disputeReasonHash: hash('reason 2'),
    disputeResponseHash: hash('response 2'),
    resolutionHash: hash('rationale 2'),
  })
  await checkBalances('after a ruling for the buyer')
  // Work was delivered, so the buyer may still rate it.
  await buyer.rateSeller(id2, 20)
  assert.deepEqual(await buyer.getReputation(sellerAddress), { completedJobs: 1, failedJobs: 1, successRatePct: 50, ratingCount: 2, avgRatingScore: 55 })

  // --- 3. A dispute ruled for the seller: paid like a settlement --------------------------------
  const id3 = await open('task 3')
  await deliver(id3, 'task 3')
  await buyer.raiseDispute(id3, hash('reason 3'))
  assert.equal((await arbiter.ruleDispute(id3, true, hash('rationale 3'))).kind, 'executed')
  paidToSeller()
  assert.equal(await buyer.getEscrowStatus(id3), SETTLED)
  await checkBalances('after a ruling for the seller')
  assert.equal((await buyer.getReputation(sellerAddress)).completedJobs, 2)

  // --- 4. Accept timeout: the seller never started; refund, no mark against the seller ----------
  const id4 = await open('task 4')
  assert.equal(await keeper.readTimeoutFlag(id4, 'acceptTimedOut'), false)
  await assert.rejects(keeper.claimTimeout(id4, 'claimAcceptTimeout'), 'too early')
  await rig.advance(rig.acceptTimeout + 1)
  assert.equal(await keeper.readTimeoutFlag(id4, 'acceptTimedOut'), true)
  await assert.rejects(seller.startExecution(id4), 'too late to start')
  const events: string[] = []
  const claim = await keeper.claimTimeout(id4, 'claimAcceptTimeout', { onSubmitting: () => events.push('submitting'), onSent: () => events.push('sent') })
  assert.equal(claim.success, true)
  assert.deepEqual(events, ['submitting', 'sent'])
  refunded()
  assert.equal(await buyer.getEscrowStatus(id4), REFUNDED)
  await checkBalances('after the accept timeout')
  await assert.rejects(buyer.rateSeller(id4, 50), 'nothing was delivered')
  assert.equal((await buyer.getReputation(sellerAddress)).failedJobs, 1)

  // --- 5. Execution timeout: started but never delivered; refund and a failed job ----------------
  const id5 = await open('task 5')
  await seller.startExecution(id5)
  assert.equal(await keeper.readTimeoutFlag(id5, 'executionTimedOut'), false)
  await rig.advance(rig.executionWindow + 1)
  assert.equal(await keeper.readTimeoutFlag(id5, 'executionTimedOut'), true)
  await keeper.claimTimeout(id5, 'claimExecutionTimeout')
  refunded()
  assert.equal(await buyer.getEscrowStatus(id5), REFUNDED)
  await checkBalances('after the execution timeout')
  assert.equal((await buyer.getReputation(sellerAddress)).failedJobs, 2)

  // --- 6. Review window over: anyone can finalize and the seller is paid ---------------------------
  const id6 = await open('task 6')
  await deliver(id6, 'task 6')
  assert.equal(await keeper.readTimeoutFlag(id6, 'reviewExpired'), false)
  await assert.rejects(keeper.claimTimeout(id6, 'finalizeAfterReviewWindow'), 'too early')
  await rig.advance(rig.reviewWindow + 1)
  assert.equal(await keeper.readTimeoutFlag(id6, 'reviewExpired'), true)
  await assert.rejects(buyer.raiseDispute(id6, hash('too late')), 'review window is over')
  await keeper.claimTimeout(id6, 'finalizeAfterReviewWindow')
  paidToSeller()
  assert.equal(await buyer.getEscrowStatus(id6), SETTLED)
  await checkBalances('after the review window')
  assert.equal((await buyer.getReputation(sellerAddress)).completedJobs, 3)

  // --- 7. Dispute timeout: the arbiter never ruled; refund, nobody at fault ----------------------
  const id7 = await open('task 7')
  await deliver(id7, 'task 7')
  await buyer.raiseDispute(id7, hash('reason 7'))
  assert.equal(await keeper.readTimeoutFlag(id7, 'disputeTimedOut'), false)
  await assert.rejects(keeper.claimTimeout(id7, 'claimDisputeTimeout'), 'too early')
  await rig.advance(Number(limits.disputeTimeout) + 1)
  assert.equal(await keeper.readTimeoutFlag(id7, 'disputeTimedOut'), true)
  await assert.rejects(arbiter.ruleDispute(id7, true, hash('too late')), 'the ruling window is over')
  await keeper.claimTimeout(id7, 'claimDisputeTimeout')
  refunded()
  assert.equal(await buyer.getEscrowStatus(id7), REFUNDED)
  await checkBalances('after the dispute timeout')
  assert.deepEqual(await buyer.getReputation(sellerAddress), { completedJobs: 3, failedJobs: 2, successRatePct: (3 / 5) * 100, ratingCount: 2, avgRatingScore: 55 })

  // --- Listing ------------------------------------------------------------------------------------
  assert.deepEqual(await buyer.escrowIds(), created)
  assert.deepEqual(
    (await buyer.listEscrows()).map((e) => [e.id, e.status]),
    [
      [id1, SETTLED],
      [id2, REFUNDED],
      [id3, SETTLED],
      [id4, REFUNDED],
      [id5, REFUNDED],
      [id6, SETTLED],
      [id7, REFUNDED],
    ]
  )
  assert.equal(expected.treasury - (await balance(rig.treasuryAddress)), BigInt(0))
}
