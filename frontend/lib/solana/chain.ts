import './polyfills'
import { address, type TransactionSigner } from '@runtime/chain/kit.ts'
import { SolanaAdapter, type SolanaChainConfig } from '@runtime/chain/solana.ts'
import { SolanaRpcBackend } from '@runtime/chain/solana-rpc.ts'
import { EXECUTION_WINDOW_SECONDS, REVIEW_WINDOW_SECONDS } from '@/lib/web3/constants'
import { SOLANA } from '@/lib/web3/network'

/**
 * The escrow program on the selected Solana network, read and written from the browser through the
 * same SolanaAdapter the backend, the SDK and the CLI use. Reads need no wallet; a write is signed by
 * the visitor's wallet (a TransactionModifyingSigner from ./wallet.tsx).
 */

function config(): SolanaChainConfig {
  if (!SOLANA) throw new Error('The selected network is not a Solana network.')
  return {
    chainId: SOLANA.chainKey,
    programId: address(SOLANA.programId),
    mint: address(SOLANA.mint),
    tokenSymbol: SOLANA.tokenSymbol,
    nativeSymbol: SOLANA.nativeSymbol,
    explorerUrl: SOLANA.explorerUrl,
    explorerName: SOLANA.explorerName,
    explorerQuery: SOLANA.explorerQuery,
    // The windows every escrow this app creates uses (the program checks them against its own limits).
    executionWindow: EXECUTION_WINDOW_SECONDS,
    reviewWindow: REVIEW_WINDOW_SECONDS,
    firstEscrowId: SOLANA.firstEscrowId,
  }
}

let shared: { backend: SolanaRpcBackend; reader: SolanaAdapter } | undefined

function backend() {
  if (!shared) {
    if (!SOLANA) throw new Error('The selected network is not a Solana network.')
    const b = new SolanaRpcBackend(SOLANA.rpcUrl)
    shared = { backend: b, reader: new SolanaAdapter(config(), b, null) }
  }
  return shared
}

/** A read-only adapter, shared by every hook. */
export function solanaReader(): SolanaAdapter {
  return backend().reader
}

/** An adapter that signs with the visitor's wallet. */
export function solanaWriter(signer: TransactionSigner): SolanaAdapter {
  return new SolanaAdapter(config(), backend().backend, signer)
}
