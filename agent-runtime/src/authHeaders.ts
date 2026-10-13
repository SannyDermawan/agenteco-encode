import { normalizeWallet } from './shared/wallets.ts'

/**
 * What proving ownership of a wallet needs, on any chain family: its address and a way to sign text.
 * Every viem local account (`privateKeyToAccount`) has this as is. EIP-191, 0x hex, and so does a
 * Solana wallet wrapped by `solanaWalletAccount` (ed25519, base58). No wallet client or RPC required.
 */
export interface WalletAccount {
  readonly address: string
  signMessage(args: { message: string }): Promise<string>
}

/**
 * Signs proof of wallet ownership for a request, see backend/src/auth.ts
 * for what the server does with these headers. The signed text is
 * `AgentEco:<wallet>:<timestamp>`, the wallet in its stored form (lowercase for EVM, as is for Solana).
 */
export async function buildAuthHeaders(account: WalletAccount): Promise<Record<string, string>> {
  const timestamp = Date.now()
  const message = `AgentEco:${normalizeWallet(account.address)}:${timestamp}`
  const signature = await account.signMessage({ message })
  return {
    'x-owner-wallet': account.address,
    'x-signature': signature,
    'x-timestamp': String(timestamp),
  }
}
