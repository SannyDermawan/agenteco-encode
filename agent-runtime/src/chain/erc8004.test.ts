import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { createPublicClient, createWalletClient, defineChain, http, nonceManager, type Chain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvilUnavailable, startTestChain, type TestChain } from '../../test-support/anvil.ts'
import { REGISTRATION_TYPE, buildRegistrationFile, dealFeedback, erc8004FromSettings } from '../shared/erc8004.ts'
import { EvmAdapter, type EvmChainConfig } from './evm.ts'

describe('ERC-8004 helpers', () => {
  test('the registration file follows the EIP-8004 shape', () => {
    const file = buildRegistrationFile({
      name: 'Translator',
      description: 'Translates text',
      capabilities: ['translation'],
      agentUrl: 'https://api.example/agents/abc',
      endpoint: 'https://agent.example',
      active: true,
      registration: { agentId: '7', evmChainId: 84532, identityRegistry: '0x00000000000000000000000000000000000000AA' },
    })
    assert.equal(file.type, REGISTRATION_TYPE)
    assert.deepEqual(file.services, [
      { name: 'AgentEco', endpoint: 'https://api.example/agents/abc', version: '1' },
      { name: 'web', endpoint: 'https://agent.example' },
    ])
    assert.deepEqual(file.registrations, [{ agentId: 7, agentRegistry: 'eip155:84532:0x00000000000000000000000000000000000000AA' }])
    assert.equal(file.x402Support, false)
    assert.equal(file.active, true)
    assert.deepEqual(file.supportedTrust, ['reputation'])
    assert.deepEqual(buildRegistrationFile({ name: 'n', description: 'd', capabilities: [], agentUrl: 'u', active: false }).registrations, [])
  })

  test('deal feedback: 1–100, no decimals, tagged with the capability and the escrow', () => {
    assert.deepEqual(dealFeedback({ score: 80, capability: 'translation', chainId: 'eip155:97', escrowId: BigInt(12) }), {
      value: BigInt(80),
      valueDecimals: 0,
      tag1: 'translation',
      tag2: 'agenteco:eip155:97:12',
    })
    assert.throws(() => dealFeedback({ score: 0, capability: 'x', chainId: 'c', escrowId: '1' }), /1–100/)
    assert.throws(() => dealFeedback({ score: 101, capability: 'x', chainId: 'c', escrowId: '1' }), /1–100/)
  })

  test('registries are configured both or neither', () => {
    const from = (env: Record<string, string>) => erc8004FromSettings((n) => env[n])
    assert.equal(from({}), null)
    const a = '0x1111111111111111111111111111111111111111'
    const b = '0x2222222222222222222222222222222222222222'
    assert.deepEqual(from({ ERC8004_IDENTITY_REGISTRY: a, ERC8004_REPUTATION_REGISTRY: b }), { identity: a, reputation: b })
    assert.throws(() => from({ ERC8004_IDENTITY_REGISTRY: a }), /must both be set/)
    assert.throws(() => from({ ERC8004_IDENTITY_REGISTRY: a, ERC8004_REPUTATION_REGISTRY: 'nope' }), /must both be set/)
  })
})

const skip = anvilUnavailable() ?? false

describe('ERC-8004 on a local chain', { skip }, () => {
  let t: TestChain
  let chain: Chain
  let config: EvmChainConfig

  before(async () => {
    t = await startTestChain({ chainId: 31337, erc8004: true })
    chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'E', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [t.rpcUrl] } } })
    config = {
      chainId: 'eip155:31337',
      chain,
      agentEco: t.agentEco,
      usdt: t.usdt,
      tokenSymbol: 'mUSDT',
      nativeSymbol: 'ETH',
      explorerUrl: 'https://scan.example',
      explorerName: 'Scan',
      executionWindow: BigInt(300),
      reviewWindow: BigInt(600),
      firstEscrowId: BigInt(1),
      legacy: [],
      deploymentBlock: null,
      logRange: BigInt(10000),
      hostedMinGas: '0.001',
      lowGasWarn: '0.01',
      erc8004: t.erc8004,
    }
  })

  after(() => t?.stop())

  const as = (role: keyof TestChain['keys'], cfg = config) => {
    const account = privateKeyToAccount(t.keys[role], { nonceManager })
    return new EvmAdapter(cfg, {
      publicClient: createPublicClient({ chain, transport: http(t.rpcUrl) }),
      walletClient: createWalletClient({ account, chain, transport: http(t.rpcUrl) }),
      account,
    })
  }

  test('an agent registers, a buyer gives deal feedback, the owner cannot review itself', async () => {
    const seller = as('seller')
    const buyer = as('buyer')
    const uri = 'https://api.example/agents/abc/registration.json'

    const { agentId, txHash } = await seller.erc8004Register(uri)
    assert.equal(agentId, BigInt(1))
    assert.equal((await seller.erc8004Owner(agentId)).toLowerCase(), t.addresses.seller.toLowerCase())
    assert.equal(await seller.erc8004AgentURI(agentId), uri)
    assert.deepEqual(await buyer.erc8004Registration(txHash), { agentId, agentURI: uri, owner: t.addresses.seller })

    assert.equal(await buyer.erc8004LastFeedback(agentId, t.addresses.buyer), null)
    await buyer.erc8004GiveFeedback(agentId, dealFeedback({ score: 90, capability: 'translation', chainId: config.chainId, escrowId: BigInt(5) }))
    assert.deepEqual(await buyer.erc8004LastFeedback(agentId, t.addresses.buyer), {
      index: BigInt(1),
      value: BigInt(90),
      valueDecimals: 0,
      tag1: 'translation',
      tag2: 'agenteco:eip155:31337:5',
      isRevoked: false,
    })

    await assert.rejects(seller.erc8004GiveFeedback(agentId, dealFeedback({ score: 100, capability: 'translation', chainId: config.chainId, escrowId: BigInt(6) })))
  })

  test('a chain without registries says so', async () => {
    const plain = as('buyer', { ...config, erc8004: null })
    await assert.rejects(plain.erc8004Register('x'), /ERC-8004 is not configured on eip155:31337/)
  })
})
