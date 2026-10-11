import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { servedChainIds as servedEvmChainIds, resetChainRegistry } from './registry.ts'
import { chainFamily, defaultChainId, normalizeAnyChainId, readAdapter, readEvm, resolveServedChainId, servedChainIds, UnknownChainError, UnsupportedOnChainError } from './multi.ts'
import { normalizeSolanaChainId, readSolana, resetSolanaRegistry, solanaEntry } from './solana-registry.ts'
import { SOLANA_DEVNET_CHAIN_ID } from './solana.ts'

const SUFFIX = SOLANA_DEVNET_CHAIN_ID.replace(/[^A-Za-z0-9]/g, '_')
const PROGRAM = 'GB9VQpdEQYTnw7NLcgAWLrUoeh2ZDtMjSGLmpUcZ4FoY'
const KEYS = ['CHAINS', `AGENT_ECO_PROGRAM__${SUFFIX}`, `TOKEN_MINT__${SUFFIX}`, `RPC_URL__${SUFFIX}`, `FIRST_ESCROW_ID__${SUFFIX}`]

afterEach(() => {
  for (const k of KEYS) delete process.env[k]
  resetChainRegistry()
  resetSolanaRegistry()
})

describe('Solana chain names', () => {
  test('a preset answers to its name, its alias and its CAIP-2 id; nothing else', () => {
    for (const input of ['solana-devnet', 'SOLANA-DEVNET', 'solana', SOLANA_DEVNET_CHAIN_ID]) assert.equal(normalizeSolanaChainId(input), SOLANA_DEVNET_CHAIN_ID, input)
    assert.equal(normalizeSolanaChainId('solana:AnotherCluster111111111111111111111'), null)
    assert.equal(normalizeSolanaChainId('bsc-testnet'), null)
    assert.equal(normalizeAnyChainId('bsc-testnet'), 'eip155:97')
    assert.equal(normalizeAnyChainId('97'), 'eip155:97')
    assert.equal(normalizeAnyChainId('solana-devnet'), SOLANA_DEVNET_CHAIN_ID)
    assert.equal(chainFamily(SOLANA_DEVNET_CHAIN_ID), 'solana')
    assert.equal(chainFamily('eip155:97'), 'evm')
  })
})

describe('configuring a Solana chain from the environment', () => {
  test('the deployment is mandatory, everything else has the preset as its default', () => {
    assert.throws(() => solanaEntry(SOLANA_DEVNET_CHAIN_ID), new RegExp(`AGENT_ECO_PROGRAM__${SUFFIX} must be set`))
    process.env[`AGENT_ECO_PROGRAM__${SUFFIX}`] = PROGRAM
    const { config, rpcUrl, testnet } = solanaEntry(SOLANA_DEVNET_CHAIN_ID)
    assert.equal(config.programId, PROGRAM)
    assert.equal(config.mint, '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
    assert.equal(config.tokenSymbol, 'USDC')
    assert.equal(config.firstEscrowId, BigInt(1))
    assert.equal(rpcUrl, 'https://api.devnet.solana.com')
    assert.equal(testnet, true)
    const adapter = readSolana(SOLANA_DEVNET_CHAIN_ID)
    assert.equal(adapter.explorer.txUrl('abc'), 'https://explorer.solana.com/tx/abc?cluster=devnet')
    assert.equal(adapter.signer, null, 'a shared reader signs nothing')
  })

  test('settings are checked when read, not on the first request', () => {
    process.env[`AGENT_ECO_PROGRAM__${SUFFIX}`] = 'not a pubkey'
    assert.throws(() => solanaEntry(SOLANA_DEVNET_CHAIN_ID), /is not a valid Solana address/)
    process.env[`AGENT_ECO_PROGRAM__${SUFFIX}`] = PROGRAM
    process.env[`FIRST_ESCROW_ID__${SUFFIX}`] = '0'
    resetSolanaRegistry()
    assert.throws(() => solanaEntry(SOLANA_DEVNET_CHAIN_ID), /FIRST_ESCROW_ID/)
    process.env[`FIRST_ESCROW_ID__${SUFFIX}`] = '2001'
    process.env[`RPC_URL__${SUFFIX}`] = 'http://127.0.0.1:8899'
    resetSolanaRegistry()
    const { config, rpcUrl } = solanaEntry(SOLANA_DEVNET_CHAIN_ID)
    assert.equal(config.firstEscrowId, BigInt(2001))
    assert.equal(rpcUrl, 'http://127.0.0.1:8899')
  })
})

describe('serving chains of both families', () => {
  test('CHAINS keeps its order across families; the first is the default', () => {
    process.env[`AGENT_ECO_PROGRAM__${SUFFIX}`] = PROGRAM
    process.env.CHAINS = 'solana-devnet, bsc-testnet'
    assert.deepEqual(servedChainIds(), [SOLANA_DEVNET_CHAIN_ID, 'eip155:97'])
    assert.equal(defaultChainId(), SOLANA_DEVNET_CHAIN_ID)
    assert.equal(resolveServedChainId(), SOLANA_DEVNET_CHAIN_ID)
    assert.equal(resolveServedChainId('97'), 'eip155:97')
    assert.equal(resolveServedChainId('solana'), SOLANA_DEVNET_CHAIN_ID)
    assert.throws(() => resolveServedChainId('base-sepolia'), UnknownChainError)

    // The EVM registry knows the EVM half only and does not trip over the Solana entry.
    assert.deepEqual(servedEvmChainIds(), ['eip155:97'])
  })

  test('a Solana-only deployment is allowed; an unknown name or an unconfigured Solana chain stops startup', () => {
    process.env[`AGENT_ECO_PROGRAM__${SUFFIX}`] = PROGRAM
    process.env.CHAINS = 'solana-devnet'
    assert.deepEqual(servedChainIds(), [SOLANA_DEVNET_CHAIN_ID])
    assert.deepEqual(servedEvmChainIds(), [])

    process.env.CHAINS = 'solana-devnet,nonsense'
    assert.throws(() => servedChainIds(), /CHAINS lists an unknown chain: nonsense/)

    delete process.env[`AGENT_ECO_PROGRAM__${SUFFIX}`]
    resetSolanaRegistry()
    process.env.CHAINS = 'bsc-testnet,solana-devnet'
    assert.throws(() => servedChainIds(), /AGENT_ECO_PROGRAM/)
  })

  test('readAdapter works for both families; the EVM-only call refuses a Solana chain', () => {
    process.env[`AGENT_ECO_PROGRAM__${SUFFIX}`] = PROGRAM
    assert.equal(readAdapter(SOLANA_DEVNET_CHAIN_ID).family, 'solana')
    assert.equal(readAdapter('eip155:97').family, 'evm')
    assert.throws(() => readEvm(SOLANA_DEVNET_CHAIN_ID), UnsupportedOnChainError)
    assert.throws(() => readAdapter('nonsense'), UnknownChainError)
  })
})
