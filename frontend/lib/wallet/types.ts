/** The two kinds of chain the app can run on; the network picks one (lib/web3/network.ts). */
export type WalletFamily = 'evm' | 'solana'

/**
 * What an API call needs of the connected wallet to prove who is calling: its address and a way to
 * sign text. An EVM wallet answers with an EIP-191 hex signature, a Solana wallet with an ed25519
 * signature in base58, the API tells them apart by the address (backend/src/auth.ts).
 */
export interface WalletSigner {
  address: string
  signMessageAsync: (args: { message: string }) => Promise<string>
}

import type { TransactionModifyingSigner } from '@runtime/chain/kit.ts'

/** A wallet the visitor can pick on Solana (wallets register themselves with the page, wallet-standard). */
export interface WalletChoice {
  name: string
  icon: string
}

/** The connected wallet, whichever family the selected network is. See ./useWallet.ts. */
export interface WalletState {
  family: WalletFamily
  address: string | undefined
  isConnected: boolean
  isConnecting: boolean
  /** The wallet is on the network the app is on (always true on Solana: the app picks the cluster itself). */
  onSelectedNetwork: boolean
  /** Solana only: the wallets found in this browser. Empty means none installed. */
  choices: WalletChoice[]
  /** Why the last connect failed, if it did. */
  error: string | null
  /** EVM: the injected wallet. Solana: the named wallet, or the only one found. */
  connect: (walletName?: string) => void
  disconnect: () => void
  /** Null until connected. */
  signer: WalletSigner | null
  /** Solana only: signs transactions for the escrow program (EVM wallets sign through wagmi's own config). Null until connected. */
  txSigner: TransactionModifyingSigner | null
}
