import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { createPublicClient, createWalletClient, defineChain, http, nonceManager, type Chain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getBase58Decoder } from '@solana/kit'
import { anvilUnavailable, startTestChain, type TestChain } from '../../test-support/anvil.ts'
import { runConformance } from '../../test-support/conformance.ts'
import { solanaUnavailable, startSolanaTestChain, type SolanaTestChain } from '../../test-support/litesvm.ts'
import { EvmAdapter, type EvmChainConfig } from './evm.ts'
import { SOLANA_DEVNET_CHAIN_ID, SolanaAdapter, isSolanaChainId } from './solana.ts'

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
          publicClient: createPublicClient({ chain: viemChain, transport: http(chain.rpcUrl) }),
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

describe('Solana chain ids and addresses', () => {
  test('CAIP-2 shape', () => {
    assert.equal(isSolanaChainId(SOLANA_DEVNET_CHAIN_ID), true)
    assert.equal(isSolanaChainId('eip155:97'), false)
    assert.equal(isSolanaChainId('solana:short'), false)
  })
})
