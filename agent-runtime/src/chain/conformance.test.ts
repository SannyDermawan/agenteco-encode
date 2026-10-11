import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { createPublicClient, createWalletClient, defineChain, http, nonceManager, type Chain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { generateKeyPairSigner, getBase58Decoder } from '@solana/kit'
import { anvilUnavailable, startTestChain, type TestChain } from '../../test-support/anvil.ts'
import { runConformance } from '../../test-support/conformance.ts'
import { solanaUnavailable, startSolanaTestChain, type SolanaTestChain } from '../../test-support/litesvm.ts'
import { VALIDATOR_TIMERS, localValidatorUnavailable, startLocalValidatorChain, type ValidatorChain } from '../../test-support/validator.ts'
import { EvmAdapter, type EvmChainConfig } from './evm.ts'
import { SOLANA_DEVNET_CHAIN_ID, SolanaAdapter, isSolanaChainId } from './solana.ts'
import { clusterAllowed } from './solana-rpc.ts'

const EXECUTION_WINDOW = 300
const REVIEW_WINDOW = 600
const ACCEPT_TIMEOUT = 120
const FEE_BPS = 250

describe('ChainAdapter conformance: the same escrow scenario on every chain', () => {
  describe('EvmAdapter (anvil)', { skip: anvilUnavailable() ?? false }, () => {
    let chain: TestChain
    let viemChain: Chain
    before(async () => {
      chain = await startTestChain({ chainId: 31337, feeBps: FEE_BPS })
      viemChain = defineChain({
        id: 31337,
        name: 'anvil',
        nativeCurrency: { name: 'E', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [chain.rpcUrl] } },
      })
    })
    after(() => chain?.stop())

    test('settle, both rulings and every timeout', async () => {
      const config: EvmChainConfig = {
        chainId: 'eip155:31337',
        chain: viemChain,
        agentEco: chain.agentEco,
        usdt: chain.usdt,
        tokenSymbol: 'mUSDT',
        nativeSymbol: 'ETH',
        explorerUrl: 'https://scan.example',
        explorerName: 'Example Scan',
        executionWindow: BigInt(EXECUTION_WINDOW),
        reviewWindow: BigInt(REVIEW_WINDOW),
        firstEscrowId: BigInt(1),
        legacy: [],
        deploymentBlock: null,
        logRange: BigInt(10000),
        hostedMinGas: '0.001',
        lowGasWarn: '0.01',
        erc8004: null,
      }
      const adapterFor = (role: keyof TestChain['keys']) => {
        const account = privateKeyToAccount(chain.keys[role], { nonceManager })
        return new EvmAdapter(config, {
          publicClient: createPublicClient({ chain: viemChain, transport: http(chain.rpcUrl), pollingInterval: 50 }), // anvil mines at once: do not wait viem's default 4 s per receipt
          walletClient: createWalletClient({ account, chain: viemChain, transport: http(chain.rpcUrl) }),
          account,
        })
      }
      const buyer = adapterFor('buyer')
      assert.equal(buyer.family, 'evm')
      await runConformance({
        buyer,
        seller: adapterFor('seller'),
        arbiter: adapterFor('arbiter'),
        keeper: adapterFor('keeper'),
        treasuryAddress: chain.addresses.deployer,
        feeBps: FEE_BPS,
        decimals: 18,
        executionWindow: EXECUTION_WINDOW,
        reviewWindow: REVIEW_WINDOW,
        acceptTimeout: ACCEPT_TIMEOUT,
        minWindow: 120,
        disputeTimeout: 900,
        signAsBuyer: (message) => privateKeyToAccount(chain.keys.buyer).signMessage({ message }),
        fundBuyer: (amount) => chain.mint(chain.addresses.buyer, amount),
        advance: (seconds) => chain.advance(seconds),
      })
    })
  })

  describe('SolanaAdapter (litesvm)', { skip: solanaUnavailable() ?? false }, () => {
    let chain: SolanaTestChain
    before(async () => {
      chain = await startSolanaTestChain({ feeBps: FEE_BPS })
    })

    test('settle, both rulings and every timeout', async () => {
      const adapterFor = (role: keyof SolanaTestChain['signers']) =>
        new SolanaAdapter(
          {
            chainId: SOLANA_DEVNET_CHAIN_ID,
            programId: chain.programId,
            mint: chain.mint,
            tokenSymbol: 'USDC',
            nativeSymbol: 'SOL',
            explorerUrl: 'https://explorer.solana.com',
            explorerName: 'Solana Explorer',
            executionWindow: BigInt(EXECUTION_WINDOW),
            reviewWindow: BigInt(REVIEW_WINDOW),
            firstEscrowId: BigInt(1),
          },
          chain.backend,
          chain.signers[role]
        )
      const buyer = adapterFor('buyer')
      assert.equal(buyer.family, 'solana')
      assert.ok(isSolanaChainId(buyer.chainId))
      assert.equal(buyer.explorer.txUrl('abc'), 'https://explorer.solana.com/tx/abc')
      await runConformance({
        buyer,
        seller: adapterFor('seller'),
        arbiter: adapterFor('arbiter'),
        keeper: adapterFor('keeper'),
        treasuryAddress: chain.treasury.address,
        feeBps: FEE_BPS,
        decimals: 6,
        executionWindow: EXECUTION_WINDOW,
        reviewWindow: REVIEW_WINDOW,
        acceptTimeout: ACCEPT_TIMEOUT,
        minWindow: 120,
        disputeTimeout: 900,
        signAsBuyer: async (message) => {
          const bytes = new Uint8Array(await crypto.subtle.sign('Ed25519', chain.signers.buyer.keyPair.privateKey, new TextEncoder().encode(message)))
          return getBase58Decoder().decode(bytes)
        },
        fundBuyer: (amount) => chain.mintTo(chain.signers.buyer.address, amount),
        advance: (seconds) => chain.advance(seconds),
      })
    })
  })
})

describe('SolanaAdapter on a real validator (SolanaRpcBackend)', { skip: localValidatorUnavailable() ?? false }, () => {
  let chain: ValidatorChain
  before(async () => {
    chain = await startLocalValidatorChain(FEE_BPS)
  })
  after(() => chain?.stop())

  test('settle, both rulings and every timeout, with the real clock', { timeout: 600_000 }, async () => {
    const buyer = chain.adapterFor('buyer')
    assert.equal(buyer.family, 'solana')
    await runConformance({
      buyer,
      seller: chain.adapterFor('seller'),
      arbiter: chain.adapterFor('arbiter'),
      keeper: chain.adapterFor('keeper'),
      treasuryAddress: chain.treasury.address,
      feeBps: FEE_BPS,
      decimals: chain.decimals,
      executionWindow: VALIDATOR_TIMERS.executionWindow,
      reviewWindow: VALIDATOR_TIMERS.reviewWindow,
      acceptTimeout: VALIDATOR_TIMERS.acceptTimeout,
      minWindow: VALIDATOR_TIMERS.minWindow,
      disputeTimeout: VALIDATOR_TIMERS.disputeTimeout,
      signAsBuyer: async (message) => {
        const bytes = new Uint8Array(await crypto.subtle.sign('Ed25519', chain.signers.buyer.keyPair.privateKey, new TextEncoder().encode(message)))
        return getBase58Decoder().decode(bytes)
      },
      fundBuyer: (amount) => chain.mintTo(chain.signers.buyer.address, amount),
      // The clock of a real validator cannot be moved: wait for it.
      advance: (seconds) => new Promise((resolve) => setTimeout(resolve, (seconds + 1) * 1000)),
    })
  })
})

describe('SolanaAdapter helpers (litesvm)', { skip: solanaUnavailable() ?? false }, () => {
  test('token accounts are created on demand, then receive tokens; the native balance can be swept', async () => {
    const chain = await startSolanaTestChain({ feeBps: FEE_BPS })
    const config = {
      chainId: SOLANA_DEVNET_CHAIN_ID,
      programId: chain.programId,
      mint: chain.mint,
      tokenSymbol: 'USDC',
      nativeSymbol: 'SOL',
      explorerUrl: 'https://explorer.solana.com',
      explorerName: 'Solana Explorer',
      executionWindow: BigInt(EXECUTION_WINDOW),
      reviewWindow: BigInt(REVIEW_WINDOW),
      firstEscrowId: BigInt(1),
    }
    const buyer = new SolanaAdapter(config, chain.backend, chain.signers.buyer)
    const newcomer = await generateKeyPairSigner()
    assert.equal(await buyer.tokenBalance(newcomer.address), BigInt(0), 'no account yet reads as zero')

    const first = await buyer.ensureTokenAccount(newcomer.address)
    assert.equal(first.created, true)
    assert.ok(first.txHash)
    assert.equal(await buyer.tokenBalance(newcomer.address), BigInt(0))
    assert.deepEqual(await buyer.ensureTokenAccount(newcomer.address), { address: first.address, created: false, txHash: null })

    await chain.mintTo(chain.signers.buyer.address, BigInt(5_000_000))
    await buyer.transferToken(newcomer.address, BigInt(1_250_000))
    assert.equal(await buyer.tokenBalance(newcomer.address), BigInt(1_250_000))
    assert.equal(await buyer.tokenBalance(chain.signers.buyer.address), BigInt(3_750_000))

    // Sweeping leaves only the transfer fee behind.
    const before = await buyer.nativeBalance(chain.signers.buyer.address)
    assert.ok(before > BigInt(0))
    assert.ok(await buyer.sweepNative(newcomer.address))
    assert.equal(await buyer.nativeBalance(chain.signers.buyer.address), BigInt(0))
    assert.equal(await buyer.nativeBalance(newcomer.address), before - BigInt(5000))
    assert.equal(await buyer.sweepNative(newcomer.address), null, 'nothing left to sweep')
  })
})

describe('Solana chain ids and addresses', () => {
  test('CAIP-2 shape', () => {
    assert.equal(isSolanaChainId(SOLANA_DEVNET_CHAIN_ID), true)
    assert.equal(isSolanaChainId('eip155:97'), false)
    assert.equal(isSolanaChainId('solana:short'), false)
  })
})

describe('the cluster guard of the Solana setup scripts', () => {
  const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
  const TESTNET = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'
  const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

  test('devnet and testnet are allowed, mainnet-beta and unknown clusters are not', () => {
    assert.equal(clusterAllowed(DEVNET, 'api.devnet.solana.com'), true)
    assert.equal(clusterAllowed(TESTNET, 'api.testnet.solana.com'), true)
    assert.equal(clusterAllowed(MAINNET, 'api.mainnet-beta.solana.com'), false)
    assert.equal(clusterAllowed('SomethingElse11111111111111111111111111111', 'rpc.example.com'), false)
  })

  test('a validator on this machine is allowed whatever its genesis; a remote host claiming a local name is not', () => {
    assert.equal(clusterAllowed('anything', '127.0.0.1'), true)
    assert.equal(clusterAllowed('anything', 'localhost'), true)
    assert.equal(clusterAllowed(MAINNET, 'localhost.example.com'), false)
    assert.equal(clusterAllowed(MAINNET, '10.0.0.5'), false)
  })
})
