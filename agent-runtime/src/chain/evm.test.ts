import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { createPublicClient, createWalletClient, defineChain, http, keccak256, nonceManager, toHex, type Address, type Chain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvilUnavailable, startTestChain, type TestChain } from '../../test-support/anvil.ts'
import { MOCK_USDT_ABI } from '../shared/abi.generated.ts'
import { EvmAdapter, canRule, type EvmChainConfig } from './evm.ts'
import type { ChainAdapter } from './types.ts'

const h = (s: string) => keccak256(toHex(s))
const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const SETTLED = 5

function config(chain: Chain, overrides: Partial<EvmChainConfig> = {}): EvmChainConfig {
  return {
    chainId: `eip155:${chain.id}`,
    chain,
    agentEco: A(1),
    usdt: A(2),
    tokenSymbol: 'TST',
    nativeSymbol: 'ETH',
    explorerUrl: 'https://scan.example',
    explorerName: 'Example Scan',
    executionWindow: BigInt(300),
    reviewWindow: BigInt(600),
    firstEscrowId: BigInt(1),
    legacy: [],
    deploymentBlock: null,
    logRange: BigInt(10000),
    hostedMinGas: '0.001',
    lowGasWarn: '0.01',
    erc8004: null,
    ...overrides,
  }
}

describe('EvmAdapter without a chain', () => {
  const chain = defineChain({ id: 5, name: 'x', nativeCurrency: { name: 'E', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:1'] } } })
  const readOnly = new EvmAdapter(config(chain), { publicClient: createPublicClient({ chain, transport: http('http://127.0.0.1:1') }) })

  test('identity: family, CAIP-2 chain id, explorer links, address normalisation', () => {
    assert.equal(readOnly.family, 'evm')
    assert.equal(readOnly.chainId, 'eip155:5')
    assert.equal(readOnly.nativeSymbol, 'ETH')
    assert.equal(readOnly.explorer.name, 'Example Scan')
    assert.equal(readOnly.explorer.txUrl('0xabc'), 'https://scan.example/tx/0xabc')
    assert.equal(readOnly.explorer.addressUrl('0xdef'), 'https://scan.example/address/0xdef')
    assert.equal(readOnly.normalizeAddress('0xABCdef'), '0xabcdef')
    assert.equal(readOnly.signer, null)
  })

  test('a read-only adapter refuses to write', async () => {
    await assert.rejects(readOnly.startExecution(BigInt(1)), /read-only/)
    await assert.rejects(readOnly.createAndFundEscrow({ seller: A(9), amount: 1, taskHash: h('t') }), /read-only/)
    await assert.rejects(readOnly.ruleDispute(BigInt(1), true, h('r')), /read-only/)
    await assert.rejects(readOnly.claimTimeout(BigInt(1), 'claimAcceptTimeout'), /read-only/)
  })

  test('escrow ids route to the deployment that numbers them', () => {
    const adapter = new EvmAdapter(
      config(chain, {
        agentEco: A(3),
        firstEscrowId: BigInt(2001),
        legacy: [
          { address: A(1), firstEscrowId: BigInt(1), endEscrowId: BigInt(1001) },
          { address: A(2), firstEscrowId: BigInt(1001), endEscrowId: BigInt(2001) },
        ],
      }),
      { publicClient: readOnly.client }
    )
    assert.equal(adapter.agentEcoFor(BigInt(1)), A(1))
    assert.equal(adapter.agentEcoFor(BigInt(1000)), A(1))
    assert.equal(adapter.agentEcoFor(BigInt(1001)), A(2))
    assert.equal(adapter.agentEcoFor(BigInt(2000)), A(2))
    assert.equal(adapter.agentEcoFor(BigInt(2001)), A(3))
    assert.equal(adapter.agentEcoFor(BigInt(999999)), A(3))
    // The current deployment first, then the legacy ones, newest first.
    assert.deepEqual(adapter.allAgentEcoAddresses, [A(3), A(2), A(1)])
  })

  test('canRule: the arbiter wallet, or a council member', () => {
    assert.equal(canRule({ arbiter: A(1), council: null }, A(1).toUpperCase().replace('0X', '0x')), true)
    assert.equal(canRule({ arbiter: A(1), council: null }, A(2)), false)
    assert.equal(canRule({ arbiter: A(9), council: { members: [A(1), A(2)] } }, A(2)), true)
    // With a council, the council's own address is not a member.
    assert.equal(canRule({ arbiter: A(9), council: { members: [A(1)] } }, A(9)), false)
  })
})

const skip = anvilUnavailable() ?? false

describe('EvmAdapter on a local chain', { skip }, () => {
  let test_: TestChain
  let viemChain: Chain

  before(async () => {
    test_ = await startTestChain({ chainId: 31337, firstEscrowId: 1001 })
    viemChain = defineChain({
      id: 31337,
      name: 'anvil',
      nativeCurrency: { name: 'E', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [test_.rpcUrl] } },
    })
  })

  after(() => test_?.stop())

  const clientsFor = (role: keyof TestChain['keys']) => {
    const account = privateKeyToAccount(test_.keys[role], { nonceManager })
    return {
      publicClient: createPublicClient({ chain: viemChain, transport: http(test_.rpcUrl) }),
      walletClient: createWalletClient({ account, chain: viemChain, transport: http(test_.rpcUrl) }),
      account,
    }
  }

  test('one deal end to end through the chain-neutral interface only', async () => {
    const cfg = config(viemChain, { agentEco: test_.agentEco, usdt: test_.usdt, tokenSymbol: 'mUSDT', firstEscrowId: BigInt(1001) })
    const buyer: ChainAdapter = new EvmAdapter(cfg, clientsFor('buyer'))
    const seller: ChainAdapter = new EvmAdapter(cfg, clientsFor('seller'))
    assert.equal(buyer.signer, test_.addresses.buyer)

    assert.deepEqual(await buyer.token(), { address: test_.usdt, symbol: 'mUSDT', decimals: 18 })

    const c = clientsFor('buyer')
    await c.publicClient.waitForTransactionReceipt({ hash: await c.walletClient.writeContract({ address: test_.usdt, abi: MOCK_USDT_ABI, functionName: 'faucet' }) })

    const id = await buyer.createAndFundEscrow({ seller: test_.addresses.seller, amount: '2', taskHash: h('task') })
    assert.equal(id, BigInt(1001))
    await seller.startExecution(id)
    await seller.markDelivered(id, h('result'))
    await buyer.acceptAndSettle(id)
    assert.equal(await buyer.getEscrowStatus(id), SETTLED)
    await buyer.rateSeller(id, 90)

    const [basic] = await buyer.readEscrowBasics([id])
    assert.equal(basic.amount, BigInt('2000000000000000000'))
    assert.equal(basic.buyer.toLowerCase(), test_.addresses.buyer.toLowerCase())
    const rep = await buyer.getReputation(test_.addresses.seller)
    assert.deepEqual(rep, { completedJobs: 1, failedJobs: 0, successRatePct: 100, ratingCount: 1, avgRatingScore: 90 })
    assert.equal((await buyer.getArbiterSetup(id)).arbiter, test_.addresses.arbiter)
  })

  test('two deployments on one chain: ids, status reads and reputation span both', async () => {
    // The first AgentEco on this chain (numbering from 1) is the legacy one; the harness's is current (from 1001).
    const legacyAddress = await test_.deployAgentEco(1)
    const cfg = config(viemChain, {
      agentEco: test_.agentEco,
      usdt: test_.usdt,
      firstEscrowId: BigInt(1001),
      legacy: [{ address: legacyAddress, firstEscrowId: BigInt(1), endEscrowId: BigInt(1001) }],
    })
    const buyer = new EvmAdapter(cfg, clientsFor('buyer'))
    const seller = new EvmAdapter(cfg, clientsFor('seller'))

    // Open an escrow on the legacy contract through an adapter pointed at it, settle it there.
    const legacyOnly = (role: keyof TestChain['keys']) => new EvmAdapter(config(viemChain, { agentEco: legacyAddress, usdt: test_.usdt }), clientsFor(role))
    const lb = legacyOnly('buyer')
    const ls = legacyOnly('seller')
    const legacyId = await lb.createAndFundEscrow({ seller: test_.addresses.seller, amount: 1, taskHash: h('legacy task') })
    assert.equal(legacyId, BigInt(1))
    await ls.startExecution(legacyId)
    await ls.markDelivered(legacyId, h('legacy result'))
    await lb.acceptAndSettle(legacyId)

    // The two-deployment adapter reads id 1 from the legacy contract and 1001 from the current one.
    assert.equal(await buyer.getEscrowStatus(BigInt(1)), SETTLED)
    assert.equal(await buyer.getEscrowStatus(BigInt(1001)), SETTLED)
    assert.deepEqual(await buyer.escrowIds(), [BigInt(1), BigInt(1001)])
    assert.deepEqual(await buyer.escrowIds({ currentOnly: true }), [BigInt(1001)])
    const all = await buyer.listEscrows()
    assert.deepEqual(
      all.map((e) => e.id),
      [BigInt(1), BigInt(1001)]
    )

    // Reputation is summed over both deployments: one settled job on each.
    const rep = await seller.getReputation(test_.addresses.seller)
    assert.equal(rep.completedJobs, 2)
    assert.equal(rep.failedJobs, 0)

    // Writes route by id too: the legacy escrow is rated on the legacy contract.
    await buyer.rateSeller(BigInt(1), 50)
    assert.equal((await buyer.getEscrowDisputeInfo(BigInt(1))).rated, true)
    assert.equal((await buyer.getEscrowDisputeInfo(BigInt(1001))).rated, true)
  })
})
