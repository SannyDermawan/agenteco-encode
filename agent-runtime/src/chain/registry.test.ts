import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { defaultEvmConfig } from './default.ts'
import {
  PRIMARY_CHAIN_ID,
  UnknownChainError,
  chainConfig,
  chainRpcUrls,
  defaultChainId,
  envSuffix,
  normalizeChainId,
  readChain,
  resetChainRegistry,
  resolveServedChainId,
  servedChainIds,
} from './registry.ts'

const BASE = 'eip155:84532'
const ECO = '0x1111111111111111111111111111111111111111'
const touched = ['CHAINS', 'AGENT_ECO_ADDRESS__eip155_84532', 'RPC_URL__eip155_84532', 'RPC_FALLBACK_URLS__eip155_84532', 'DEPLOYMENT_BLOCK__eip155_84532', 'USDT_ADDRESS__eip155_84532']

afterEach(() => {
  for (const k of touched) delete process.env[k]
  resetChainRegistry()
})

test('chain ids: CAIP-2, network names, aliases and bare EVM ids', () => {
  assert.equal(PRIMARY_CHAIN_ID, 'eip155:97') // NETWORK unset = bsc-testnet
  assert.equal(normalizeChainId('eip155:97'), 'eip155:97')
  assert.equal(normalizeChainId('bsc-testnet'), 'eip155:97')
  assert.equal(normalizeChainId(97), 'eip155:97')
  assert.equal(normalizeChainId(' 84532 '), BASE)
  assert.equal(normalizeChainId('Base-Sepolia'), BASE)
  assert.equal(normalizeChainId('testnet'), 'eip155:968')
  assert.equal(normalizeChainId('mainnet'), 'eip155:677')
  assert.equal(normalizeChainId('eip155:1'), null)
  assert.equal(normalizeChainId('solana:devnet'), null)
  assert.equal(normalizeChainId(''), null)
  assert.equal(envSuffix(BASE), 'eip155_84532')
})

test('without CHAINS the process serves its primary chain only, configured as before', () => {
  assert.deepEqual(servedChainIds(), ['eip155:97'])
  assert.equal(defaultChainId(), 'eip155:97')
  assert.equal(chainConfig('bsc-testnet'), defaultEvmConfig())
  assert.equal(resolveServedChainId(undefined), 'eip155:97')
  assert.equal(resolveServedChainId(''), 'eip155:97')
  assert.equal(resolveServedChainId('97'), 'eip155:97')
  assert.throws(() => resolveServedChainId('base-sepolia'), UnknownChainError)
})

test('another chain needs its own deployment address, by suffixed env', () => {
  assert.throws(() => chainConfig('base-sepolia'), /AGENT_ECO_ADDRESS__eip155_84532 must be set/)
  process.env.AGENT_ECO_ADDRESS__eip155_84532 = ECO
  process.env.DEPLOYMENT_BLOCK__eip155_84532 = '123'
  const config = chainConfig('base-sepolia')
  assert.equal(config.chainId, BASE)
  assert.equal(config.chain.id, 84532)
  assert.equal(config.agentEco, ECO)
  assert.equal(config.usdt, '0x036CbD53842c5426634e7929541eC2318f3dCF7e')
  assert.equal(config.tokenSymbol, 'USDC')
  assert.equal(config.nativeSymbol, 'ETH')
  assert.equal(config.firstEscrowId, BigInt(1))
  assert.deepEqual(config.legacy, [])
  assert.equal(config.deploymentBlock, BigInt(123))
  assert.equal(config.logRange, BigInt(45000))
  assert.equal(config.chain.contracts?.multicall3?.address, '0xcA11bde05977b3631167028862bE2a173976CA11')
  assert.deepEqual(chainRpcUrls(BASE), ['https://base-sepolia-rpc.publicnode.com', 'https://sepolia.base.org'])
  // The primary chain's unsuffixed env never leaks into another chain.
  assert.notEqual(config.agentEco, defaultEvmConfig().agentEco)
})

test('suffixed RPC and token overrides', () => {
  process.env.AGENT_ECO_ADDRESS__eip155_84532 = ECO
  process.env.RPC_URL__eip155_84532 = 'https://rpc.example/base'
  process.env.RPC_FALLBACK_URLS__eip155_84532 = 'none'
  process.env.USDT_ADDRESS__eip155_84532 = '0x2222222222222222222222222222222222222222'
  assert.deepEqual(chainRpcUrls(BASE), ['https://rpc.example/base'])
  assert.equal(chainConfig(BASE).usdt, '0x2222222222222222222222222222222222222222')
  process.env.USDT_ADDRESS__eip155_84532 = 'nope'
  resetChainRegistry()
  assert.throws(() => chainConfig(BASE), /USDT_ADDRESS__eip155_84532 is not a valid EVM address/)
})

test('CHAINS lists the served chains, the first is the default', () => {
  process.env.CHAINS = 'bsc-testnet, eip155:84532, 97'
  process.env.AGENT_ECO_ADDRESS__eip155_84532 = ECO
  assert.deepEqual(servedChainIds(), ['eip155:97', BASE])
  assert.equal(defaultChainId(), 'eip155:97')
  assert.equal(resolveServedChainId('84532'), BASE)
  assert.equal(resolveServedChainId('base-sepolia'), BASE)
  assert.throws(() => resolveServedChainId('bot-testnet'), /not served here/)
  assert.throws(() => resolveServedChainId('nonsense'), UnknownChainError)

  resetChainRegistry()
  process.env.CHAINS = 'base-sepolia,bsc-testnet'
  assert.equal(defaultChainId(), BASE)
})

test('CHAINS fails fast: an unknown chain, or a served chain without its deployment', () => {
  process.env.CHAINS = 'bsc-testnet,eip155:1'
  assert.throws(() => servedChainIds(), /unknown chain: eip155:1/)
  resetChainRegistry()
  process.env.CHAINS = 'bsc-testnet,base-sepolia'
  assert.throws(() => servedChainIds(), /AGENT_ECO_ADDRESS__eip155_84532 must be set/)
})

test('one shared reader per chain', () => {
  process.env.AGENT_ECO_ADDRESS__eip155_84532 = ECO
  assert.equal(readChain('97'), readChain('eip155:97'))
  assert.equal(readChain(BASE).chainId, BASE)
  assert.notEqual(readChain(BASE), readChain('97'))
  assert.equal(readChain(BASE).signer, null)
})
