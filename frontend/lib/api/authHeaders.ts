import { normalizeWallet } from '@shared/wallets'
import type { WalletSigner } from '@/lib/wallet/types'

export type { WalletSigner }

/**
 * Signs proof of wallet ownership for a request — see backend/src/auth.ts
 * for what the server does with these headers. `signer.signMessageAsync` is
 * the connected wallet's: wagmi's `useSignMessage().signMessageAsync` (a MetaMask
 * prompt) or a Solana wallet's `signMessage` — free either way, not a transaction.
 * The signed text names the wallet in its stored form: lowercase for EVM, as is for Solana.
 */
export async function buildAuthHeaders(signer: WalletSigner): Promise<Record<string, string>> {
  const timestamp = Date.now()
  const message = `AgentEco:${normalizeWallet(signer.address)}:${timestamp}`
  const signature = await signer.signMessageAsync({ message })
  return {
    'x-owner-wallet': signer.address,
    'x-signature': signature,
    'x-timestamp': String(timestamp),
  }
}
